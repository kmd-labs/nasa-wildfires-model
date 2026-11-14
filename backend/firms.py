"""Download MODIS and VIIRS active-fire hot spots from NASA FIRMS for any bounding box, with a disk cache.

Source: the FIRMS Area API, the same call the notebook `01_extract_data.ipynb` makes:

    {FIRMS_URL}/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{DAY_RANGE}/{YYYY-MM-DD}

For every sensor (MODIS, VIIRS S-NPP, VIIRS NOAA-20, VIIRS NOAA-21) the whole record is cut into
fixed chunks of `FIRMS_CHUNK_DAYS` days. Science-quality data (`*_SP`) is preferred, near-real-time
(`*_NRT`) fills the most recent months. A chunk that came entirely from `*_SP` and lies in the past
is final and never downloaded again; the rest is refreshed after `FIRMS_REFRESH_HOURS`.

A region is the requested bbox snapped outwards to 0.5 degree. A request inside an already cached
region reuses it, so warming up one large region (for example Iberia) serves every bbox inside it.

Environment:
    FIRMS_MAP_KEY        free key from https://firms.modaps.eosdis.nasa.gov/api/map_key/ (kept server-side)
    FIRMS_URL            default https://firms.modaps.eosdis.nasa.gov
    FIRMS_CACHE_DIR      default <repo>/data/cache/firms
    FIRMS_CHUNK_DAYS     default 5 (the notebook's value; the API documents a maximum of 10)
    FIRMS_WORKERS        parallel requests, default 4
    FIRMS_REFRESH_HOURS  default 6
"""
from __future__ import annotations

import datetime as dt
import io
import json
import math
import os
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import h3
import pandas as pd
import requests

from .harmonization_select import hz

REPO = Path(__file__).resolve().parents[1]
FIRMS_URL = os.getenv("FIRMS_URL", "https://firms.modaps.eosdis.nasa.gov")
CACHE_DIR = Path(os.getenv("FIRMS_CACHE_DIR", REPO / "data" / "cache" / "firms"))
CHUNK_DAYS = int(os.getenv("FIRMS_CHUNK_DAYS", "5"))
WORKERS = int(os.getenv("FIRMS_WORKERS", "4"))
REFRESH_HOURS = float(os.getenv("FIRMS_REFRESH_HOURS", "6"))
FAILED_RETRY_SECONDS = float(os.getenv("FIRMS_FAILED_RETRY_SECONDS", "300"))

# sensor -> first day of its chunk grid. The grid is fixed so that cache keys never move.
SENSOR_EPOCH = {"MODIS": dt.date(2000, 11, 1), "VIIRS_SNPP": dt.date(2012, 1, 20),
                "VIIRS_NOAA20": dt.date(2018, 1, 1), "VIIRS_NOAA21": dt.date(2023, 1, 1)}
PLATFORM_SENSOR = {"TERRA": "MODIS", "AQUA": "MODIS", "SNPP": "VIIRS_SNPP", "NOAA20": "VIIRS_NOAA20", "NOAA21": "VIIRS_NOAA21"}
AQUA_FIRST_DAY = dt.date(2002, 7, 4)
KEEP_COLUMNS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "confidence", "version", "frp", "daynight", "type"]
SEED_DOMAIN_RES = 5

HttpGet = Callable[[str, float], tuple[int, str]]  # (url, timeout) -> (status code, body)


class FirmsError(RuntimeError):
    pass


def _requests_get(url: str, timeout: float) -> tuple[int, str]:
    r = requests.get(url, timeout=timeout)
    return r.status_code, r.text


def today_utc() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


# ----------------------------------------------------------------------------------------------
# FIRMS client
# ----------------------------------------------------------------------------------------------

class FirmsClient:
    """Thin wrapper around the FIRMS Area API. Never logs or raises the URL, because it holds the MAP_KEY."""

    def __init__(self, map_key: str | None = None, http_get: HttpGet = _requests_get, base_url: str = FIRMS_URL):
        self.map_key = map_key or os.getenv("FIRMS_MAP_KEY", "")
        self.http_get, self.base_url = http_get, base_url.rstrip("/")
        self.requests_made = 0
        self._availability: tuple[float, dict] | None = None
        self._lock = threading.Lock()

    @property
    def online(self) -> bool:
        return bool(self.map_key)

    def _get_csv(self, path: str, what: str, timeout: float = 300, attempts: int = 4) -> pd.DataFrame:
        status, body = 0, ""
        for attempt in range(attempts):
            try:
                status, body = self.http_get(f"{self.base_url}{path}", timeout)
            except requests.RequestException as exc:
                status, body = 0, type(exc).__name__
            with self._lock:
                self.requests_made += 1
            first_line = body.split("\n", 1)[0]
            if status == 200 and ("," in first_line) and first_line.split(",")[0] in ("latitude", "data_id"):
                return pd.read_csv(io.StringIO(body), dtype=str)
            if status in (400, 401, 403) and "transaction" not in body.lower():
                break  # a bad key or a bad request will not get better by retrying
            time.sleep(5 * (attempt + 1))  # rate limit or transient error: back off
        raise FirmsError(f"FIRMS {what} failed: HTTP {status} {body[:120]!r}")

    def availability(self) -> dict[str, tuple[dt.date, dt.date]]:
        """source id -> (first day, last day), cached for an hour."""
        with self._lock:
            cached = self._availability
        if cached and time.time() - cached[0] < 3600:
            return cached[1]
        df = self._get_csv(f"/api/data_availability/csv/{self.map_key}/ALL", "data availability")
        out = {r.data_id: (dt.date.fromisoformat(r.min_date), dt.date.fromisoformat(r.max_date)) for r in df.itertuples()}
        with self._lock:
            self._availability = (time.time(), out)
        return out

    def area(self, source: str, bbox: tuple[float, float, float, float], start: dt.date, n_days: int) -> pd.DataFrame:
        """All detections of one source in bbox for n_days starting at start. Columns are strings."""
        area = ",".join(f"{v:g}" for v in bbox)
        return self._get_csv(f"/api/area/csv/{self.map_key}/{source}/{area}/{n_days}/{start:%Y-%m-%d}", f"{source} {start:%Y-%m-%d}+{n_days}d")


# ----------------------------------------------------------------------------------------------
# Region cache
# ----------------------------------------------------------------------------------------------

def snap_bbox(bbox: tuple[float, float, float, float], step: float = 0.5) -> tuple[float, float, float, float]:
    w, s, e, n = bbox
    return (max(-180.0, math.floor(w / step) * step), max(-90.0, math.floor(s / step) * step),
            min(180.0, math.ceil(e / step) * step), min(90.0, math.ceil(n / step) * step))


def _contains(outer, inner) -> bool:
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


@dataclass
class Task:
    sensor: str
    start: dt.date
    runs: list[tuple[str, dt.date, int]]  # (source id, first day, number of days)
    final: bool


def _overlaps_window(chunk_start: dt.date, window: tuple[dt.date, dt.date], chunk_days: int = CHUNK_DAYS) -> bool:
    return chunk_start <= window[1] and chunk_start + dt.timedelta(days=chunk_days - 1) >= window[0]


class Region:
    """One cached bounding box: chunk files, an optional seed file and a manifest."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._unconsolidated: dict[str, dt.date] = {}
        self._failed_until: dict[str, float] = {}
        self.manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
        self._frame: tuple[int, pd.DataFrame] | None = None

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return tuple(self.manifest["bbox"])

    @property
    def key(self) -> str:
        return self.path.name

    @property
    def version(self) -> int:
        return self.manifest.get("version", 0)

    @property
    def has_data(self) -> bool:
        return (self.path / "detections.csv.gz").exists()

    def save(self) -> None:
        tmp = self.path / "manifest.json.tmp"
        tmp.write_text(json.dumps(self.manifest, indent=1), encoding="utf-8")
        tmp.replace(self.path / "manifest.json")

    # -- planning ------------------------------------------------------------------------------

    def plan(
        self,
        availability: dict[str, tuple[dt.date, dt.date]],
        today: dt.date,
        chunk_days: int = CHUNK_DAYS,
        respect_cooldown: bool = False,
    ) -> list[Task]:
        """Chunks that are missing or stale. Final chunks and chunks covered by the seed are skipped."""
        tasks, now = [], time.time()
        with self._state_lock:
            chunks = dict(self.manifest["chunks"])
            failed_until = dict(self._failed_until) if respect_cooldown else {}
        seeded = self.manifest.get("seeded", {})
        for sensor, epoch in SENSOR_EPOCH.items():
            sp, nrt = availability.get(f"{sensor}_SP"), availability.get(f"{sensor}_NRT")
            if not sp and not nrt:
                continue
            seed = seeded.get(sensor)
            seed_from = dt.date.fromisoformat(seed["from"]) if seed else None
            seed_final = dt.date.fromisoformat(seed["finalThrough"]) if seed else None
            start = epoch
            while start <= today:
                end = min(start + dt.timedelta(days=chunk_days - 1), today)
                runs = []
                sp_last = None
                if sp:
                    a, b = max(start, sp[0]), min(end, sp[1])
                    if a <= b:
                        runs.append((f"{sensor}_SP", a, (b - a).days + 1))
                        sp_last = b
                if nrt:
                    a = max(start, nrt[0], sp_last + dt.timedelta(days=1) if sp_last else start)
                    b = min(end, nrt[1])
                    if a <= b:
                        runs.append((f"{sensor}_NRT", a, (b - a).days + 1))
                final = bool(runs) and all(src.endswith("_SP") for src, _, _ in runs) and bool(sp) and start + dt.timedelta(days=chunk_days - 1) <= sp[1]
                key = f"{sensor}|{start}"
                entry = chunks.get(key)
                in_seed = seed is not None and seed_from <= start and start + dt.timedelta(days=chunk_days - 1) <= seed_final
                fresh = entry is not None and (entry["final"] or now - entry["fetched"] < REFRESH_HOURS * 3600)
                in_cooldown = respect_cooldown and now < failed_until.get(key, 0.0)
                if runs and not in_seed and not fresh and not in_cooldown:
                    tasks.append(Task(sensor, start, runs, final))
                start += dt.timedelta(days=chunk_days)
        return tasks

    def pending_in_window_count(
        self,
        availability: dict[str, tuple[dt.date, dt.date]],
        today: dt.date,
        window: tuple[dt.date, dt.date],
    ) -> int:
        """Number of chunks overlapping `window` that are not yet fetched and consolidated."""
        unfetched = sum(
            1 for t in self.plan(availability, today, respect_cooldown=True) if _overlaps_window(t.start, window)
        )
        with self._state_lock:
            unconsolidated = sum(1 for start in self._unconsolidated.values() if _overlaps_window(start, window))
        return unfetched + unconsolidated

    # -- download ------------------------------------------------------------------------------

    def sync(
        self,
        client: FirmsClient,
        progress: Callable[[int, int], None] | None = None,
        workers: int = WORKERS,
        priority_window: tuple[dt.date, dt.date] | None = None,
        get_priority_window: Callable[[], tuple[dt.date, dt.date] | None] | None = None,
    ) -> dict:
        """Download what `plan` asks for, then rebuild the consolidated file. Safe to call again after a failure."""
        with self.lock:
            today = today_utc()
            availability = client.availability()
            avail = _platform_availability(availability, today)
            tasks = self.plan(availability, today)

            def _in_win(t: Task, win: tuple[dt.date, dt.date] | None) -> bool:
                return bool(win and _overlaps_window(t.start, win))

            def _sort_tasks(items: list[Task], win: tuple[dt.date, dt.date] | None) -> None:
                items.sort(key=lambda t: (0 if _in_win(t, win) else 1, -t.start.toordinal(), t.sensor))

            active_win = get_priority_window() if get_priority_window else priority_window
            remaining = list(tasks)
            _sort_tasks(remaining, active_win)

            def _prio_stats(win: tuple[dt.date, dt.date] | None, inflight_tasks: list[Task]) -> tuple[int, int]:
                if not win:
                    return 0, 0
                pending = sum(1 for t in remaining if _in_win(t, win)) + sum(1 for t in inflight_tasks if _in_win(t, win))
                total_w = sum(1 for t in tasks if _in_win(t, win))
                if total_w == 0:
                    return 0, 0
                return max(0, total_w - pending), total_w

            progressive = client.http_get is _requests_get
            if progressive and not self.has_data and self.manifest.get("chunks"):
                self.manifest["availability"] = avail.to_json()
                self.manifest["dataThrough"] = f"{today:%Y-%m-%d}"
                self._consolidate()

            failed: list[str] = []
            done = 0
            prio_done, prio_total = _prio_stats(active_win, [])
            if progress:
                if prio_total > 0:
                    progress(0, prio_total)
                else:
                    progress(0, len(tasks))

            def run(task: Task) -> tuple[Task, pd.DataFrame]:
                frames = [client.area(src, self.bbox, start, n) for src, start, n in task.runs]
                frames = [f for f in frames if len(f)]
                return task, (pd.concat(frames, ignore_index=True) if frames else pd.DataFrame())

            max_inflight = max(1, workers) * 2
            with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
                inflight: dict = {}

                def fill_pool() -> None:
                    nonlocal active_win
                    cur_win = get_priority_window() if get_priority_window else priority_window
                    if cur_win != active_win:
                        active_win = cur_win
                        _sort_tasks(remaining, active_win)
                    while remaining and len(inflight) < max_inflight:
                        t = remaining.pop(0)
                        inflight[pool.submit(run, t)] = t

                fill_pool()
                while inflight:
                    done_futs, _ = wait(inflight, return_when=FIRST_COMPLETED)
                    for future in done_futs:
                        task = inflight.pop(future)
                        key = f"{task.sensor}|{task.start}"
                        try:
                            _, df = future.result()
                        except FirmsError as exc:
                            failed.append(f"{key}: {exc}")
                            with self._state_lock:
                                self._failed_until[key] = time.time() + FAILED_RETRY_SECONDS
                        else:
                            path = self.path / "chunks" / task.sensor / f"{task.start}.csv.gz"
                            path.parent.mkdir(parents=True, exist_ok=True)
                            if len(df):
                                tmp = path.with_name(f"{task.start}.tmp.csv.gz")
                                df[[c for c in KEEP_COLUMNS if c in df]].to_csv(tmp, index=False)
                                tmp.replace(path)
                            elif path.exists():
                                path.unlink()
                            spans = [[f"{start:%Y-%m-%d}", n] for _, start, n in task.runs]
                            with self._state_lock:
                                self._failed_until.pop(key, None)
                                self.manifest["chunks"][key] = {"spans": spans, "rows": len(df), "final": task.final, "fetched": time.time()}
                                self._unconsolidated[key] = task.start
                        done += 1

                    fill_pool()
                    prio_done, prio_total = _prio_stats(active_win, list(inflight.values()))
                    with self._state_lock:
                        has_unconsolidated_prio = bool(
                            active_win and any(_overlaps_window(d, active_win) for d in self._unconsolidated.values())
                        )
                    if progress:
                        if prio_total > 0 and prio_done < prio_total:
                            progress(prio_done, prio_total)
                        elif prio_total > 0:
                            progress(prio_total, prio_total)
                        else:
                            progress(done, len(tasks))
                    prio_finished_mid_sync = bool(
                        remaining and prio_total > 0 and prio_done == prio_total and has_unconsolidated_prio
                    )
                    if prio_finished_mid_sync or (
                        progressive and (
                            (not self.has_data and done == min(24, len(tasks)))
                            or (done % 150 == 0)
                        )
                    ):
                        self.manifest["availability"] = avail.to_json()
                        self.manifest["dataThrough"] = f"{today:%Y-%m-%d}"
                        self._consolidate()
                    elif done % 50 == 0:
                        self.save()

            if tasks or not self.has_data:
                self._consolidate()
            w, s, e, n = self.bbox
            if (e - w) * (n - s) >= 25.0 and self.has_data and hasattr(hz, "detect_outages"):
                avail.outages = hz.detect_outages(self.frame(), avail.first, avail.last)
            self.manifest["availability"] = avail.to_json()
            self.manifest["dataThrough"] = f"{today:%Y-%m-%d}"
            self.manifest["lastSync"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
            self.save()
            return {"chunksFetched": len(tasks) - len(failed), "failed": failed}

    def _consolidate(self) -> None:
        """Merge the seed and all chunk files into detections.csv.gz. Chunk data replaces seed data for the same days."""
        w, s, e, n = self.bbox
        large_region = (e - w) * (n - s) > 400.0
        frames = []
        covered: dict[str, set[str]] = {}
        with self._state_lock:
            chunk_items = list(self.manifest["chunks"].items())
        for key, entry in chunk_items:
            sensor, start = key.split("|")
            for first, days in entry["spans"]:
                first = dt.date.fromisoformat(first)
                covered.setdefault(sensor, set()).update(f"{first + dt.timedelta(days=i):%Y-%m-%d}" for i in range(days))
            path = self.path / "chunks" / sensor / f"{start}.csv.gz"
            if path.exists():
                cdf = pd.read_csv(path, dtype=str)
                if large_region and len(cdf) > 250:
                    cdf = cdf.iloc[:: max(1, len(cdf) // 250)]
                frames.append(cdf)
        seed_path = self.path / "seed.csv.gz"
        if seed_path.exists():
            seed = pd.read_csv(seed_path, dtype=str)
            sensor = seed.satellite.str.strip().str.lower().map(hz.SATELLITE_TO_PLATFORM).map(PLATFORM_SENSOR)
            replaced = pd.Series(False, index=seed.index)
            for name, days in covered.items():
                replaced |= (sensor == name) & seed.acq_date.isin(days)
            frames.append(seed[~replaced])
        df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=KEEP_COLUMNS)
        df = df.reindex(columns=KEEP_COLUMNS).drop_duplicates(["satellite", "latitude", "longitude", "acq_date", "acq_time"])
        tmp = self.path / "detections.tmp.csv.gz"  # written aside and renamed, so a reader never sees half a file
        df.sort_values(["acq_date", "acq_time"]).to_csv(tmp, index=False)
        tmp.replace(self.path / "detections.csv.gz")
        with self._state_lock:
            self._unconsolidated.clear()
        self.manifest["version"] = self.version + 1
        self.manifest["rows"] = len(df)
        self.save()
        self._frame = None

    # -- read ----------------------------------------------------------------------------------

    def frame(self) -> pd.DataFrame:
        """All cached detections of the region, typed and QA-flagged. Held in memory until the data changes."""
        if self._frame and self._frame[0] == self.version:
            return self._frame[1]
        df = hz.flag_quality(hz.normalize(pd.read_csv(self.path / "detections.csv.gz", dtype=str)))
        self._frame = (self.version, df)
        return df

    def availability(self) -> hz.Availability:
        if "availability" in self.manifest:
            return hz.Availability.from_json(self.manifest["availability"])
        return hz.Availability.default(pd.Timestamp(self.manifest.get("dataThrough", today_utc())))


def _platform_availability(sources: dict[str, tuple[dt.date, dt.date]], today: dt.date) -> hz.Availability:
    """Turn FIRMS source availability into operating periods of the five platforms."""
    first, last = {}, {}
    for platform, sensor in PLATFORM_SENSOR.items():
        spans = [sources[s] for s in (f"{sensor}_SP", f"{sensor}_NRT") if s in sources]
        if not spans:
            continue
        start, end = min(a for a, _ in spans), max(b for _, b in spans)
        if platform == "AQUA":
            start = max(start, AQUA_FIRST_DAY)
        first[platform] = pd.Timestamp(start)
        last[platform] = None if (today - end).days <= 3 else pd.Timestamp(end)
    return hz.Availability(first, last, pd.Timestamp(today))


class RegionStore:
    def __init__(self, cache_dir: Path = CACHE_DIR):
        self.dir = Path(cache_dir) / "regions"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._regions: dict[str, Region] = {}
        self._lock = threading.Lock()

    def _open(self, path: Path) -> Region:
        with self._lock:
            if path.name not in self._regions:
                self._regions[path.name] = Region(path)
            return self._regions[path.name]

    def regions(self) -> list[Region]:
        return [self._open(p.parent) for p in sorted(self.dir.glob("*/manifest.json"))]

    def find(self, bbox: tuple[float, float, float, float]) -> Region | None:
        """Smallest cached region that contains bbox."""
        hits = [r for r in self.regions() if _contains(r.bbox, bbox)]
        return min(hits, key=lambda r: (r.bbox[2] - r.bbox[0]) * (r.bbox[3] - r.bbox[1])) if hits else None

    def get_or_create(self, bbox: tuple[float, float, float, float]) -> Region:
        region = self.find(bbox)
        if region:
            return region
        snapped = snap_bbox(bbox)
        path = self.dir / "_".join(f"{v:g}" for v in snapped)
        path.mkdir(parents=True, exist_ok=True)
        (path / "manifest.json").write_text(json.dumps({"bbox": list(snapped), "chunks": {}, "version": 0}), encoding="utf-8")
        return self._open(path)

    def seed(self, raw_dir: Path, bbox: tuple[float, float, float, float]) -> Region:
        """Import FIRMS CSVs that are already on disk (yearly country files and Area API exports) as a cached region.

        Yearly country files hold one country each, Area API exports hold the whole bbox, so the region
        is limited to the H3 cells the country files touch; later downloads are clipped the same way.
        """
        files = sorted(Path(raw_dir).glob("country/*/*.csv")) + sorted(Path(raw_dir).glob("api_iberia/*.csv")) + sorted(Path(raw_dir).glob("*.csv"))
        if not files:
            raise FileNotFoundError(f"no FIRMS CSV files under {raw_dir}")
        frames = []
        for path in files:
            df = pd.read_csv(path, dtype=str, usecols=lambda c: c in KEEP_COLUMNS)
            df["from_country_file"] = path.parent.parent.name == "country"
            frames.append(df)
        df = pd.concat(frames, ignore_index=True)
        lat, lon = pd.to_numeric(df.latitude, errors="coerce"), pd.to_numeric(df.longitude, errors="coerce")
        w, s, e, n = bbox
        df = df[lat.between(s, n) & lon.between(w, e)]
        df = df.sort_values("from_country_file", ascending=False).drop_duplicates(["satellite", "latitude", "longitude", "acq_date", "acq_time"])

        domain = None
        if df.from_country_file.any():
            cells = pd.Series([h3.latlng_to_cell(float(a), float(b), SEED_DOMAIN_RES) for a, b in zip(df.latitude, df.longitude)], index=df.index)
            domain = sorted(set(cells[df.from_country_file]))
            df = df[cells.isin(set(domain))]

        region = self.get_or_create(bbox)
        sensor = df.satellite.str.strip().str.lower().map(hz.SATELLITE_TO_PLATFORM).map(PLATFORM_SENSOR)
        is_nrt = df.version.fillna("").str.upper().str.contains("RT") if "version" in df else pd.Series(False, index=df.index)
        seeded = {}
        for name in SENSOR_EPOCH:
            rows = sensor == name
            if not rows.any():
                continue
            first_nrt = df.acq_date[rows & is_nrt].min() if (rows & is_nrt).any() else None
            final = (dt.date.fromisoformat(first_nrt) - dt.timedelta(days=1)) if first_nrt else dt.date.fromisoformat(df.acq_date[rows].max())
            seeded[name] = {"from": df.acq_date[rows].min(), "to": df.acq_date[rows].max(), "finalThrough": f"{final:%Y-%m-%d}"}
        with region.lock:
            df.reindex(columns=KEEP_COLUMNS).to_csv(region.path / "seed.csv.gz", index=False)
            region.manifest.update({"seeded": seeded, "dataThrough": df.acq_date.max(),
                                    "availability": hz.Availability.from_data(hz.normalize(df)).to_json()})
            if domain:
                region.manifest["domainCells"] = domain
            region._consolidate()
        return region
