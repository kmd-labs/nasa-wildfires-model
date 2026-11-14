"""Burned area (MODIS MCD64A1, VIIRS VNP64A1) for any bounding box, downloaded from NASA LP DAAC.

The independent witness of the seam tests: burned area is mapped from surface reflectance by one sensor
family on both sides of a satellite change, so it does not jump when VIIRS joins the hot-spot record.

    python -m backend burned-area --bbox -8.7,39.6,-7.0,41.0 --from 2003 --to 2019

Flow
  1. NASA CMR granule search (no login) for the product, bbox and months.
  2. Each monthly 10 x 10 degree sinusoidal tile (HDF4, ~1.5 MB) is downloaded once with EARTHDATA_TOKEN.
  3. Only the burned pixels are kept (row, column, burn day, uncertainty) in
     data/cache/burned_area/<product>/<granule id>.csv.gz, with tile counts in index.json; the HDF is deleted.
  4. Any bbox inside the cached tiles is summed per month without downloading again.

Products: MCD64A1 v061 (MODIS Terra + Aqua, from Nov 2000) and VNP64A1 v002 (VIIRS Suomi NPP, from Mar 2012),
both 463 m pixels (21.5 ha) on the MODIS sinusoidal grid. Burn Date > 0 is the day of year of the burn,
0 unburned, -1 unmapped, -2 water.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd
import requests

REPO = Path(__file__).resolve().parents[1]
PRODUCTS = {
    "MCD64A1": {"version": "061", "first": dt.date(2000, 11, 1), "sensor": "MODIS Terra + Aqua",
                "citation": "Giglio, L., Justice, C., Boschetti, L., Roy, D. MODIS/Terra+Aqua Burned Area Monthly L3 Global "
                            "500m SIN Grid V061. NASA EOSDIS Land Processes DAAC."},
    "VNP64A1": {"version": "002", "first": dt.date(2012, 3, 1), "sensor": "VIIRS Suomi NPP",
                "citation": "Giglio, L., Boschetti, L., Roy, D., Humber, M., Justice, C. VIIRS/NPP Burned Area Monthly L3 "
                            "Global 500m SIN Grid V002. NASA EOSDIS Land Processes DAAC."},
}
CMR_URL = os.getenv("CMR_URL", "https://cmr.earthdata.nasa.gov/search/granules.json")
CACHE_DIR = Path(os.getenv("BURNED_AREA_CACHE_DIR", REPO / "data" / "cache" / "burned_area"))
WORKERS = int(os.getenv("BURNED_AREA_WORKERS", "4"))
RETRIES, RETRY_WAIT_S = 3, 2.0             # attempts per tile on HTTP 5xx / 429 / dropped connection

EARTH_R = 6371007.181                       # sphere of the MODIS sinusoidal grid
TILE_M = 2 * math.pi * EARTH_R / 36         # 10 degrees at the equator, 1 111 950.52 m
N_PIX = 2400                                # pixels per tile side
PIX_M = TILE_M / N_PIX                      # 463.31 m
PIXEL_KM2 = PIX_M ** 2 / 1e6                # 0.2147 km2 = 21.5 ha
X_MIN, Y_MAX = -18 * TILE_M, 9 * TILE_M
GRANULE_RE = re.compile(r"^(?P<product>[A-Z0-9]+)\.A(?P<year>\d{4})(?P<doy>\d{3})\.h(?P<h>\d{2})v(?P<v>\d{2})\.")


class BurnedAreaError(RuntimeError):
    """Download or read failure. Messages never contain the Earthdata token."""


# ----------------------------------------------------------------------------------------------
# MODIS sinusoidal grid
# ----------------------------------------------------------------------------------------------

def tile_of(lat: float, lon: float) -> tuple[int, int]:
    """(h, v) of the sinusoidal tile that contains a point."""
    lat_r = math.radians(lat)
    x, y = EARTH_R * math.radians(lon) * math.cos(lat_r), EARTH_R * lat_r
    return int((x - X_MIN) // TILE_M), int((Y_MAX - y) // TILE_M)


def tiles_for_bbox(bbox: tuple[float, float, float, float], step: float = 0.05) -> set[tuple[int, int]]:
    """Tiles that touch a bbox (sampled every `step` degrees, edges included)."""
    w, s, e, n = bbox
    lats = np.linspace(s, n, max(2, math.ceil((n - s) / step) + 1))
    lons = np.linspace(w, e, max(2, math.ceil((e - w) / step) + 1))
    return {tile_of(float(la), float(lo)) for la in lats for lo in lons}


def pixel_centers(h: int, v: int, rows: np.ndarray, cols: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Latitude and longitude (degrees) of pixel centres in tile (h, v)."""
    x = X_MIN + h * TILE_M + (np.asarray(cols, float) + 0.5) * PIX_M
    y = Y_MAX - v * TILE_M - (np.asarray(rows, float) + 0.5) * PIX_M
    lat = y / EARTH_R
    lon = x / (EARTH_R * np.cos(lat))
    return np.degrees(lat), np.degrees(lon)


def parse_granule(granule_id: str) -> dict:
    """Product, month and tile from an LP DAAC granule id such as MCD64A1.A2017152.h17v05.061.2021312125712."""
    m = GRANULE_RE.match(granule_id)
    if not m:
        raise ValueError(f"not a burned-area granule id: {granule_id!r}")
    day = dt.date(int(m["year"]), 1, 1) + dt.timedelta(days=int(m["doy"]) - 1)
    return {"product": m["product"], "month": f"{day:%Y-%m}", "h": int(m["h"]), "v": int(m["v"]),
            "tile": f"h{m['h']}v{m['v']}"}


def read_burned_pixels(path: Path | str) -> tuple[pd.DataFrame, dict]:
    """Burned pixels of one HDF4 tile: DataFrame (row, col, doy, unc) and tile counts."""
    try:
        from pyhdf.SD import SD, SDC  # noqa: PLC0415 – optional dependency, only for downloads
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise BurnedAreaError("reading burned-area tiles needs pyhdf (pip install pyhdf)") from exc
    sd = SD(str(path), SDC.READ)
    try:
        burn = sd.select("Burn Date").get()
        unc = sd.select("Burn Date Uncertainty").get()
    finally:
        sd.end()
    rows, cols = np.nonzero(burn > 0)
    pixels = pd.DataFrame({"row": rows.astype(np.int16), "col": cols.astype(np.int16),
                           "doy": burn[rows, cols].astype(np.int16), "unc": unc[rows, cols].astype(np.int16)})
    counts = {"burned": int(len(rows)), "unmapped": int((burn == -1).sum()), "water": int((burn == -2).sum()),
              "pixels": int(burn.size)}
    return pixels, counts


# ----------------------------------------------------------------------------------------------
# Client with a per-granule cache
# ----------------------------------------------------------------------------------------------

def _months(first: str, last: str) -> list[str]:
    return [str(p) for p in pd.period_range(first, last, freq="M")]


class BurnedAreaClient:
    """Search, download and cache burned-area tiles; sum any bbox per month from the cache."""

    def __init__(self, token: str | None = None, cache_dir: Path | None = None, session: requests.Session | None = None):
        self.token = token if token is not None else os.getenv("EARTHDATA_TOKEN", "")
        self.cache_dir = Path(cache_dir if cache_dir is not None else CACHE_DIR)
        self.session = session or requests.Session()
        self._lock = threading.Lock()
        self._pixels: dict[str, pd.DataFrame] = {}

    @property
    def online(self) -> bool:
        return bool(self.token)

    # -- cache ---------------------------------------------------------------------------------

    def _dir(self, product: str) -> Path:
        d = self.cache_dir / product
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _index(self, product: str) -> dict:
        path = self._dir(product) / "index.json"
        for attempt in range(5):  # on Windows another process may be replacing the file right now
            try:
                return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            except (PermissionError, json.JSONDecodeError):
                if attempt == 4:
                    raise
                time.sleep(0.1 * (attempt + 1))
        return {}

    def _record(self, product: str, granule_id: str, entry: dict) -> None:
        with self._lock:
            index = self._index(product)
            index[granule_id] = entry
            path = self._dir(product) / "index.json"
            tmp = path.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_text(json.dumps(index, indent=0, sort_keys=True), encoding="utf-8")
            for attempt in range(10):  # Windows refuses the replace while a reader has the file open
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    if attempt == 9:
                        raise
                    time.sleep(0.05 * (attempt + 1))

    def cached_granules(self, product: str) -> dict[tuple[str, str], str]:
        """(tile, month) -> granule id for every cached tile."""
        out = {}
        for gid, entry in sorted(self._index(product).items()):
            if (self._dir(product) / f"{gid}.csv.gz").exists():
                out[(entry["tile"], entry["month"])] = gid
        return out

    def _load_pixels(self, product: str, gid: str) -> pd.DataFrame:
        with self._lock:
            hit = self._pixels.get(gid)
        if hit is not None:
            return hit
        px = pd.read_csv(self._dir(product) / f"{gid}.csv.gz")
        info = parse_granule(gid)
        lat, lon = pixel_centers(info["h"], info["v"], px.row.to_numpy(), px.col.to_numpy())
        px = px.assign(lat=lat, lon=lon)
        with self._lock:
            self._pixels[gid] = px
        return px

    # -- search and download -------------------------------------------------------------------

    def search(self, product: str, bbox: tuple[float, float, float, float], first: str, last: str) -> list[dict]:
        """Granules of `product` for the tiles touching bbox and the months first..last (YYYY-MM)."""
        if product not in PRODUCTS:
            raise ValueError(f"product must be one of {sorted(PRODUCTS)}")
        start = pd.Period(first, "M").start_time
        end = pd.Period(last, "M").end_time
        params = {"short_name": product, "version": PRODUCTS[product]["version"], "page_size": 2000,
                  "bounding_box": ",".join(f"{v:g}" for v in bbox),
                  "temporal": f"{start:%Y-%m-%dT00:00:00Z},{end:%Y-%m-%dT23:59:59Z}"}
        entries, headers = [], {}
        while True:
            resp = self.session.get(CMR_URL, params=params, headers=headers, timeout=120)
            if resp.status_code != 200:
                raise BurnedAreaError(f"CMR search failed: HTTP {resp.status_code}")
            page = resp.json()["feed"]["entry"]
            entries += page
            after = resp.headers.get("CMR-Search-After")
            if not page or not after or len(page) < params["page_size"]:
                break
            headers = {"CMR-Search-After": after}
        tiles = {f"h{h:02d}v{v:02d}" for h, v in tiles_for_bbox(bbox)}
        months = set(_months(first, last))
        best: dict[tuple[str, str], dict] = {}
        for e in entries:
            gid = (e.get("producer_granule_id") or e.get("title", "")).removesuffix(".hdf")
            try:
                info = parse_granule(gid)
            except ValueError:
                continue
            if info["tile"] not in tiles or info["month"] not in months:
                continue
            url = next((l["href"] for l in e.get("links", []) if l.get("href", "").startswith("https")
                        and l["href"].endswith(".hdf")), None)
            if not url:
                continue
            key = (info["tile"], info["month"])
            if key not in best or gid > best[key]["id"]:  # newest production of a tile-month
                best[key] = {"id": gid, "url": url, **info}
        return sorted(best.values(), key=lambda g: (g["month"], g["tile"]))

    def _download(self, url: str, dest: Path, attempts: int = RETRIES) -> None:
        """Download with the Earthdata token; server errors and dropped connections are retried."""
        name = url.rsplit("/", 1)[-1]
        for attempt in range(attempts):
            try:
                with self.session.get(url, headers={"Authorization": f"Bearer {self.token}"}, stream=True, timeout=300) as resp:
                    if resp.status_code == 200:
                        with open(dest, "wb") as fh:
                            for chunk in resp.iter_content(1 << 20):
                                fh.write(chunk)
                        return
                    error = BurnedAreaError(f"download failed: HTTP {resp.status_code} for {name}")
                    if resp.status_code < 500 and resp.status_code != 429:
                        raise error
            except requests.RequestException as exc:
                error = BurnedAreaError(f"download failed: {type(exc).__name__} for {name}")
            if attempt + 1 < attempts:
                time.sleep(RETRY_WAIT_S * 2 ** attempt)
        raise error

    def _fetch_one(self, product: str, granule: dict) -> str:
        gid = granule["id"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"{gid}.hdf"
            self._download(granule["url"], path)
            pixels, counts = read_burned_pixels(path)
        pixels.to_csv(self._dir(product) / f"{gid}.csv.gz", index=False)
        self._record(product, gid, {"tile": granule["tile"], "month": granule["month"], **counts})
        return gid

    def fetch(self, product: str, bbox: tuple[float, float, float, float], first: str, last: str,
              workers: int = WORKERS, progress: Callable[[int, int], None] | None = None) -> dict:
        """Download every missing tile-month for bbox. Returns counts and the granules that failed."""
        granules = self.search(product, bbox, first, last)
        cached = set(self.cached_granules(product).values())
        todo = [g for g in granules if g["id"] not in cached]
        if todo and not self.online:
            raise BurnedAreaError("EARTHDATA_TOKEN is not set (.env) and some burned-area tiles are not cached")
        failed, done = [], 0
        if progress:
            progress(0, len(todo))
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = {pool.submit(self._fetch_one, product, g): g for g in todo}
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception as exc:  # one bad tile must not stop the others
                    failed.append(f"{futures[fut]['id']}: {type(exc).__name__}: {str(exc)[:120]}")
                done += 1
                if progress:
                    progress(done, len(todo))
        return {"granules": len(granules), "downloaded": len(todo) - len(failed), "alreadyCached": len(granules) - len(todo),
                "failed": failed}

    # -- aggregation ---------------------------------------------------------------------------

    def monthly(self, product: str, bbox: tuple[float, float, float, float], first: str, last: str) -> pd.DataFrame:
        """Burned area inside bbox per month, from the cache only.

        Columns: month, burnedKm2, burnedPixels, tilesNeeded, tilesCached, complete. A month is complete
        when every tile touching the bbox is cached for it; incomplete months have NaN burned area.
        """
        w, s, e, n = bbox
        tiles = sorted(f"h{h:02d}v{v:02d}" for h, v in tiles_for_bbox(bbox))
        cache = self.cached_granules(product)
        rows = []
        for month in _months(first, last):
            gids = [cache.get((t, month)) for t in tiles]
            have = [g for g in gids if g]
            px = 0
            for gid in have:
                p = self._load_pixels(product, gid)
                px += int(((p.lat >= s) & (p.lat <= n) & (p.lon >= w) & (p.lon <= e)).sum())
            complete = len(have) == len(tiles)
            rows.append({"month": month, "burnedKm2": round(px * PIXEL_KM2, 3) if complete else np.nan,
                         "burnedPixels": px if complete else np.nan, "tilesNeeded": len(tiles), "tilesCached": len(have),
                         "complete": complete})
        return pd.DataFrame(rows)
