#!/usr/bin/env python3
"""
Pobiera dane bazowe (OSM, ortofoto, mapa topo, DEM) dla obszarów AOI z `aoi.csv`
– czyli dla miejsc, gdzie wystąpiły duże pożary na Półwyspie Iberyjskim.

Dla każdego wiersza AOI powstaje katalog `<out>/<aoi_id>/`:

    aoi.geojson                     bbox AOI + punkt zapłonu (atrybuty z CSV)
    osm/<warstwa>.geojson           wektory OSM z Overpass API (drogi, cieki, wody,
                                    landuse, pokrycie naturalne, budynki, miejscowości,
                                    szczyty, linie energetyczne, obszary chronione,
                                    infrastruktura ppoż.)
    ortho/<źródło>.tif              mozaika ortofoto jako GeoTIFF (EPSG:3857)
                                      - pnoa        : IGN PNOA (Hiszpania, CC BY 4.0)
                                      - dgt2023     : DGT OrtoSat 2023 (Portugalia)
                                      - s2c_<rok>   : EOX Sentinel-2 cloudless, kompozyt roczny
                                                      z roku przed pożarem (stan przed) oraz
                                                      z roku pożaru, jeśli istnieje (stan po)
    topo/opentopomap_z<zoom>.tif    mapa topograficzna OpenTopoMap (EPSG:3857)
    dem/Copernicus_DSM_*.tif        kafle Copernicus DEM GLO-30 (1°x1°, EPSG:4326, COG)
    manifest.json                   źródła, licencje, parametry, statystyki

Wymagania: Python 3.9+, `requests`, `Pillow` (główny requirements.txt). GDAL nie jest potrzebny.

Przykłady:
    python scripts/data-pipeline/fetch_aoi_basemaps.py
    python scripts/data-pipeline/fetch_aoi_basemaps.py --only larouco_2025 --what osm,ortho
    python scripts/data-pipeline/fetch_aoi_basemaps.py --ortho-res 2.5 --topo-zoom 14
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import requests
from PIL import Image, TiffImagePlugin, TiffTags

Image.MAX_IMAGE_PIXELS = None  # duże mozaiki są zamierzone

REPO_ROOT = Path(__file__).resolve().parents[2]
USER_AGENT = "kmd-labs-nasa-wildfires-model/0.1 (+https://kmd-labs.org)"
SESSION = requests.Session()
SESSION.headers["User-Agent"] = USER_AGENT

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# ---------------------------------------------------------------------------
# Warstwy OSM. `area=True` → zamknięte linie zamieniane na poligony.
# `{bbox}` jest podstawiany jako (s,w,n,e).
# ---------------------------------------------------------------------------
OSM_LAYERS: dict[str, dict] = {
    "roads": {"area": False, "q": 'way["highway"]({bbox});'},
    "railways": {"area": False, "q": 'way["railway"]({bbox});'},
    "waterways": {"area": False, "q": 'way["waterway"~"^(river|stream|canal|ditch|drain)$"]({bbox});'},
    "water": {
        "area": True,
        "q": 'way["natural"="water"]({bbox}); rel["natural"="water"]({bbox}); '
        'way["waterway"="riverbank"]({bbox}); way["landuse"="reservoir"]({bbox});',
    },
    "landuse": {"area": True, "q": 'way["landuse"]({bbox}); rel["landuse"]({bbox});'},
    "natural": {
        "area": True,
        "q": 'way["natural"~"^(wood|scrub|heath|grassland|bare_rock|scree|shingle|sand|wetland|fell)$"]({bbox}); '
        'rel["natural"~"^(wood|scrub|heath|grassland|bare_rock|scree|shingle|sand|wetland|fell)$"]({bbox});',
    },
    "buildings": {"area": True, "q": 'way["building"]({bbox}); rel["building"]({bbox});'},
    "places": {"area": False, "q": 'node["place"~"^(city|town|village|hamlet|isolated_dwelling|locality)$"]({bbox});'},
    "peaks": {"area": False, "q": 'node["natural"~"^(peak|saddle|ridge)$"]({bbox}); way["natural"="ridge"]({bbox});'},
    "power": {"area": False, "q": 'way["power"~"^(line|minor_line)$"]({bbox}); node["power"="tower"]({bbox});'},
    "protected_areas": {
        "area": True,
        "q": 'way["boundary"="protected_area"]({bbox}); rel["boundary"="protected_area"]({bbox}); '
        'way["leisure"="nature_reserve"]({bbox}); rel["leisure"="nature_reserve"]({bbox});',
    },
    "fire_infrastructure": {
        "area": True,
        "q": 'nwr["amenity"="fire_station"]({bbox}); '
        'nwr["emergency"~"^(fire_hydrant|water_tank|fire_water_pond|suction_point|lookout)$"]({bbox}); '
        'nwr["man_made"~"^(tower|water_tank)$"]["tower:type"~"fire|observation"]({bbox}); '
        'way["man_made"="firebreak"]({bbox}); way["firebreak"]({bbox});',
    },
}

AREA_TAG_KEYS = {"building", "landuse", "natural", "water", "leisure", "boundary", "amenity", "area", "place"}

ATTRIBUTION = {
    "osm": "© OpenStreetMap contributors, ODbL 1.0",
    "pnoa": "PNOA cedido por © Instituto Geográfico Nacional de España (CC BY 4.0, scne.es)",
    "dgt2023": "© Direção-Geral do Território (DGT), OrtoSat 2023 (CC BY 4.0)",
    "s2c": "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH "
    "(contains modified Copernicus Sentinel data); 2016: CC BY 4.0, 2017+: CC BY-NC-SA 4.0",
    "opentopomap": "Map data © OpenStreetMap contributors, SRTM | Style © OpenTopoMap (CC BY-SA 3.0)",
    "dem": "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 "
    "provided under COPERNICUS by the European Union and ESA",
}


# ---------------------------------------------------------------------------
# Pomocnicze
# ---------------------------------------------------------------------------
@dataclass
class Aoi:
    id: str
    row: dict
    w: float
    s: float
    e: float
    n: float
    kraj: str
    rok: int

    @property
    def is_portugal(self) -> bool:
        return self.kraj.strip().lower().startswith("portug")


def log(msg: str) -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:  # konsola Windows (cp1250) bez UTF-8
        enc = sys.stdout.encoding or "ascii"
        print(msg.encode(enc, errors="replace").decode(enc), flush=True)


def http_get(url: str, *, params=None, timeout=120, retries=4, ok404=False, stream=False) -> requests.Response | None:
    delay = 5.0
    for attempt in range(1, retries + 1):
        try:
            r = SESSION.get(url, params=params, timeout=timeout, stream=stream)
            if r.status_code == 404 and ok404:
                return None
            if r.status_code in (429, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r
        except (requests.RequestException,) as exc:
            if attempt == retries:
                raise
            log(f"    ! {exc} – ponawiam za {delay:.0f}s ({attempt}/{retries})")
            time.sleep(delay)
            delay *= 2
    return None


def read_aois(csv_path: Path) -> list[Aoi]:
    with csv_path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        out.append(
            Aoi(
                id=r["aoi_id"].strip(),
                row=r,
                w=float(r["bbox_w"]),
                s=float(r["bbox_s"]),
                e=float(r["bbox_e"]),
                n=float(r["bbox_n"]),
                kraj=r.get("kraj", ""),
                rok=int(r["rok"]),
            )
        )
    return out


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# AOI → GeoJSON
# ---------------------------------------------------------------------------
def write_aoi_geojson(aoi: Aoi, out_dir: Path) -> None:
    props = {k: v for k, v in aoi.row.items() if k != "wkt_epsg4326"}
    ring = [[aoi.w, aoi.s], [aoi.e, aoi.s], [aoi.e, aoi.n], [aoi.w, aoi.n], [aoi.w, aoi.s]]
    fc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {**props, "kind": "aoi_bbox"}, "geometry": {"type": "Polygon", "coordinates": [ring]}},
            {
                "type": "Feature",
                "properties": {"aoi_id": aoi.id, "kind": "ignition_point", "pozar": aoi.row.get("pozar")},
                "geometry": {"type": "Point", "coordinates": [float(aoi.row["zaplon_lon"]), float(aoi.row["zaplon_lat"])]},
            },
        ],
    }
    write_json(out_dir / "aoi.geojson", fc)


# ---------------------------------------------------------------------------
# OSM / Overpass
# ---------------------------------------------------------------------------
def overpass(query: str) -> dict:
    last: Exception | None = None
    for ep in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                log(f"    → {ep.split('/')[2]} (próba {attempt + 1})")
                r = SESSION.post(ep, data={"data": query}, timeout=(20, 360))
                if r.status_code in (429, 502, 503, 504):
                    raise requests.HTTPError(f"HTTP {r.status_code}")
                r.raise_for_status()
                data = r.json()
                remark = data.get("remark", "")
                if "runtime error" in remark or "timed out" in remark:
                    raise RuntimeError(remark)
                return data
            except Exception as exc:  # noqa: BLE001 – przełączamy się na kolejny serwer
                last = exc
                wait = 15 * (attempt + 1)
                log(f"    ! Overpass {ep.split('/')[2]}: {exc} – czekam {wait}s")
                time.sleep(wait)
    raise RuntimeError(f"Overpass niedostępny: {last}")


def _coords(geom: list[dict]) -> list[list[float]]:
    return [[round(p["lon"], 7), round(p["lat"], 7)] for p in geom if p]


def _merge_rings(segments: list[list[list[float]]]) -> list[list[list[float]]]:
    """Skleja fragmenty (way) relacji multipolygon w zamknięte pierścienie."""
    segs = [s[:] for s in segments if len(s) >= 2]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if ring[0] != ring[-1]:
            ring.append(ring[0])  # domknięcie (relacja przycięta przez bbox)
        if len(ring) >= 4:
            rings.append(ring)
    return rings


def _point_in_ring(pt, ring) -> bool:
    x, y = pt
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1:
            inside = not inside
    return inside


def element_to_feature(el: dict, area_layer: bool) -> dict | None:
    tags = el.get("tags", {})
    props = {"osm_type": el["type"], "osm_id": el["id"], **tags}
    t = el["type"]
    if t == "node":
        geom = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}
    elif t == "way":
        coords = _coords(el.get("geometry", []))
        if len(coords) < 2:
            return None
        closed = coords[0] == coords[-1] and len(coords) >= 4
        is_area = closed and (
            tags.get("area") == "yes"
            or (area_layer and tags.get("area") != "no" and (AREA_TAG_KEYS & tags.keys()) and "highway" not in tags)
        )
        geom = {"type": "Polygon", "coordinates": [coords]} if is_area else {"type": "LineString", "coordinates": coords}
    elif t == "relation":
        outers, inners = [], []
        for m in el.get("members", []):
            if m.get("type") != "way" or "geometry" not in m:
                continue
            (inners if m.get("role") == "inner" else outers).append(_coords(m["geometry"]))
        outer_rings = _merge_rings(outers)
        if not outer_rings:
            return None
        polys = [[r] for r in outer_rings]
        for inner in _merge_rings(inners):
            for poly in polys:
                if _point_in_ring(inner[0], poly[0]):
                    poly.append(inner)
                    break
        geom = {"type": "MultiPolygon", "coordinates": polys}
    else:
        return None
    return {"type": "Feature", "properties": props, "geometry": geom}


def fetch_osm(aoi: Aoi, out_dir: Path, layers: list[str], force: bool) -> dict:
    bbox = f"{aoi.s},{aoi.w},{aoi.n},{aoi.e}"
    stats = {}
    for name in layers:
        spec = OSM_LAYERS[name]
        path = out_dir / "osm" / f"{name}.geojson"
        if path.exists() and not force:
            log(f"  osm/{name}: istnieje – pomijam")
            continue
        query = f"[out:json][timeout:300][maxsize:536870912];({spec['q'].format(bbox=bbox)});out geom;"
        log(f"  osm/{name}: Overpass…")
        data = overpass(query)
        feats = [f for el in data.get("elements", []) if (f := element_to_feature(el, spec["area"]))]
        write_json(path, {"type": "FeatureCollection", "features": feats})
        stats[name] = len(feats)
        log(f"  osm/{name}: {len(feats)} obiektów")
        time.sleep(2)  # grzecznie wobec publicznego Overpass
    return stats


# ---------------------------------------------------------------------------
# Web Mercator + GeoTIFF bez GDAL
# ---------------------------------------------------------------------------
R_MERC = 6378137.0


def lonlat_to_merc(lon: float, lat: float) -> tuple[float, float]:
    x = math.radians(lon) * R_MERC
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R_MERC
    return x, y


def save_geotiff_3857(img: Image.Image, path: Path, x0: float, y0: float, px: float, py: float) -> None:
    """Zapisuje obraz jako GeoTIFF EPSG:3857 (lewy górny róg x0,y0; rozmiar piksela px,py)
    + plik world (.tfw) i .prj jako zabezpieczenie dla programów ignorujących geotagi."""
    path.parent.mkdir(parents=True, exist_ok=True)
    ifd = TiffImagePlugin.ImageFileDirectory_v2()
    ifd[33550] = (float(px), float(py), 0.0)  # ModelPixelScale
    ifd.tagtype[33550] = TiffTags.DOUBLE
    ifd[33922] = (0.0, 0.0, 0.0, float(x0), float(y0), 0.0)  # ModelTiepoint
    ifd.tagtype[33922] = TiffTags.DOUBLE
    # GeoKeyDirectory: ModelTypeProjected, RasterPixelIsArea, ProjectedCSType=3857
    ifd[34735] = (1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857)
    ifd.tagtype[34735] = TiffTags.SHORT
    tmp = path.with_suffix(".part.tif")
    img.convert("RGB").save(tmp, format="TIFF", compression="tiff_deflate", tiffinfo=ifd)
    tmp.replace(path)
    path.with_suffix(".tfw").write_text(
        f"{px}\n0\n0\n{-py}\n{x0 + px / 2}\n{y0 - py / 2}\n", encoding="ascii"
    )
    path.with_suffix(".prj").write_text(
        'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],'
        'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],'
        'PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],'
        'PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3857"]]',
        encoding="ascii",
    )


# ---------------------------------------------------------------------------
# Ortofoto (WMS → mozaika)
# ---------------------------------------------------------------------------
@dataclass
class WmsSource:
    key: str
    url: str
    layer: str
    attribution: str
    max_px: int = 2048
    fmt: str = "image/jpeg"


def ortho_sources(aoi: Aoi, which: str, available_s2_years: set[int]) -> list[WmsSource]:
    srcs: list[WmsSource] = []
    if which in ("auto", "national"):
        if aoi.is_portugal:
            srcs.append(WmsSource("dgt2023", "https://ortos.dgterritorio.gov.pt/wms/ortosat2023",
                                  "ortoSat2023-CorVerdadeira", ATTRIBUTION["dgt2023"]))
        else:
            srcs.append(WmsSource("pnoa", "https://www.ign.es/wms-inspire/pnoa-ma",
                                  "OI.OrthoimageCoverage", ATTRIBUTION["pnoa"]))
    if which in ("auto", "s2cloudless"):
        # Kompozyt z roku przed pożarem = stan "przed"; z roku pożaru (jeśli już opublikowany) = "po".
        for year in (aoi.rok - 1, aoi.rok):
            if year in available_s2_years:
                srcs.append(WmsSource(f"s2c_{year}", "https://tiles.maps.eox.at/wms",
                                      f"s2cloudless-{year}_3857", ATTRIBUTION["s2c"]))
    return srcs


def s2cloudless_years() -> set[int]:
    try:
        r = http_get("https://tiles.maps.eox.at/wms", params={"service": "WMS", "request": "GetCapabilities"}, timeout=60)
        import re

        return {int(y) for y in re.findall(r"<Name>s2cloudless-(\d{4})_3857</Name>", r.text)}
    except Exception as exc:  # noqa: BLE001
        log(f"! nie udało się pobrać listy lat s2cloudless ({exc}); zakładam 2016–2024")
        return set(range(2016, 2025))


def fetch_wms_mosaic(aoi: Aoi, src: WmsSource, res_m: float, out_path: Path) -> dict:
    x0, y0 = lonlat_to_merc(aoi.w, aoi.n)
    x1, y1 = lonlat_to_merc(aoi.e, aoi.s)
    # rozmiar piksela w metrach Mercatora; skala Mercatora na tej szerokości ~1/cos(lat)
    k = 1 / math.cos(math.radians((aoi.s + aoi.n) / 2))
    px = res_m * k
    W = int(math.ceil((x1 - x0) / px))
    H = int(math.ceil((y0 - y1) / px))
    mosaic = Image.new("RGB", (W, H), (255, 255, 255))
    step = src.max_px
    n_tiles = math.ceil(W / step) * math.ceil(H / step)
    log(f"  ortho/{src.key}: {W}x{H} px @ {res_m} m ({n_tiles} zapytań WMS)")
    done = 0
    for oy in range(0, H, step):
        for ox in range(0, W, step):
            w = min(step, W - ox)
            h = min(step, H - oy)
            bx0 = x0 + ox * px
            by1 = y0 - oy * px
            bbox = f"{bx0},{by1 - h * px},{bx0 + w * px},{by1}"
            params = {
                "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": src.layer, "STYLES": "",
                "CRS": "EPSG:3857", "BBOX": bbox, "WIDTH": w, "HEIGHT": h, "FORMAT": src.fmt,
            }
            r = http_get(src.url, params=params, timeout=180)
            ctype = r.headers.get("content-type", "")
            if not ctype.startswith("image/"):
                raise RuntimeError(f"WMS {src.key} zwrócił {ctype}: {r.text[:300]}")
            mosaic.paste(Image.open(io.BytesIO(r.content)).convert("RGB"), (ox, oy))
            done += 1
            if done % 10 == 0 or done == n_tiles:
                log(f"    {done}/{n_tiles}")
    save_geotiff_3857(mosaic, out_path, x0, y0, px, px)
    return {"layer": src.layer, "url": src.url, "res_m": res_m, "pixel_merc_m": px, "size": [W, H],
            "attribution": src.attribution}


# ---------------------------------------------------------------------------
# Mapa topograficzna (XYZ → mozaika)
# ---------------------------------------------------------------------------
def _tile_xy(lon: float, lat: float, z: int) -> tuple[float, float]:
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch_topo(aoi: Aoi, zoom: int, out_dir: Path, cache_dir: Path) -> dict:
    fx0, fy0 = _tile_xy(aoi.w, aoi.n, zoom)
    fx1, fy1 = _tile_xy(aoi.e, aoi.s, zoom)
    tx0, ty0, tx1, ty1 = int(fx0), int(fy0), int(fx1), int(fy1)
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    log(f"  topo/opentopomap z{zoom}: {nx * ny} kafli")
    canvas = Image.new("RGB", (nx * 256, ny * 256), (255, 255, 255))
    servers = "abc"
    i = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            cache = cache_dir / f"{zoom}" / f"{tx}" / f"{ty}.png"
            if not cache.exists():
                url = f"https://{servers[i % 3]}.tile.opentopomap.org/{zoom}/{tx}/{ty}.png"
                r = http_get(url, timeout=60, ok404=True)
                cache.parent.mkdir(parents=True, exist_ok=True)
                if r is None:
                    continue
                cache.write_bytes(r.content)
                time.sleep(0.15)  # polityka OpenTopoMap: bez masowego pobierania
            canvas.paste(Image.open(cache).convert("RGB"), ((tx - tx0) * 256, (ty - ty0) * 256))
            i += 1
            if i % 50 == 0:
                log(f"    {i}/{nx * ny}")
    # przycięcie do bbox AOI
    crop = (int((fx0 - tx0) * 256), int((fy0 - ty0) * 256), int(math.ceil((fx1 - tx0) * 256)), int(math.ceil((fy1 - ty0) * 256)))
    img = canvas.crop(crop)
    world = 2 * math.pi * R_MERC
    px = world / (256 * 2 ** zoom)
    x_left = -world / 2 + (tx0 * 256 + crop[0]) * px
    y_top = world / 2 - (ty0 * 256 + crop[1]) * px
    out = out_dir / "topo" / f"opentopomap_z{zoom}.tif"
    save_geotiff_3857(img, out, x_left, y_top, px, px)
    return {"zoom": zoom, "pixel_merc_m": px, "size": list(img.size), "attribution": ATTRIBUTION["opentopomap"]}


# ---------------------------------------------------------------------------
# DEM – Copernicus GLO-30 (publiczny bucket AWS, bez logowania)
# ---------------------------------------------------------------------------
def fetch_dem(aoi: Aoi, out_dir: Path, cache_dir: Path) -> dict:
    tiles = []
    for lat in range(math.floor(aoi.s), math.ceil(aoi.n)):
        for lon in range(math.floor(aoi.w), math.ceil(aoi.e)):
            ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}_00"
            ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}_00"
            name = f"Copernicus_DSM_COG_10_{ns}_{ew}_DEM"
            cached = cache_dir / f"{name}.tif"
            if not cached.exists():
                url = f"https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif"
                log(f"  dem: pobieram {name}")
                r = http_get(url, timeout=600, ok404=True, stream=True)
                if r is None:
                    log(f"  dem: {name} – brak kafla (morze?)")
                    continue
                cached.parent.mkdir(parents=True, exist_ok=True)
                tmp = cached.with_suffix(".part")
                with tmp.open("wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
                tmp.replace(cached)
            dst = out_dir / "dem" / cached.name
            dst.parent.mkdir(parents=True, exist_ok=True)
            if not dst.exists():
                try:
                    dst.hardlink_to(cached)
                except OSError:
                    dst.write_bytes(cached.read_bytes())
            tiles.append(cached.name)
    log(f"  dem: {len(tiles)} kafli")
    return {"tiles": tiles, "crs": "EPSG:4326 (EGM2008 heights)", "attribution": ATTRIBUTION["dem"],
            "note": "kafle 1°x1° nie są przycięte do AOI – użyj np. gdalwarp -te w s e n"}


# ---------------------------------------------------------------------------
def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # konsola Windows (cp1250)
        except AttributeError:
            pass
    p =argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--aoi-csv", type=Path, default=REPO_ROOT / "aoi.csv")
    p.add_argument("--out", type=Path, default=REPO_ROOT / "data" / "raw" / "aoi")
    p.add_argument("--only", help="lista aoi_id rozdzielona przecinkami")
    p.add_argument("--what", default="osm,ortho,topo,dem", help="co pobrać: osm,ortho,topo,dem")
    p.add_argument("--osm-layers", default=",".join(OSM_LAYERS), help="warstwy OSM (domyślnie wszystkie)")
    p.add_argument("--ortho-source", choices=["auto", "national", "s2cloudless"], default="auto")
    p.add_argument("--ortho-res", type=float, default=5.0, help="rozdzielczość ortofoto krajowego [m] (domyślnie 5)")
    p.add_argument("--s2-res", type=float, default=10.0, help="rozdzielczość Sentinel-2 cloudless [m] (domyślnie 10)")
    p.add_argument("--topo-zoom", type=int, default=13, help="zoom OpenTopoMap (13 ≈ 15 m/px, max 17)")
    p.add_argument("--force", action="store_true", help="nadpisz istniejące pliki")
    args = p.parse_args()

    what = {w.strip() for w in args.what.split(",") if w.strip()}
    layers = [l.strip() for l in args.osm_layers.split(",") if l.strip()]
    unknown = set(layers) - OSM_LAYERS.keys()
    if unknown:
        p.error(f"nieznane warstwy OSM: {', '.join(sorted(unknown))}")

    aois = read_aois(args.aoi_csv)
    if args.only:
        wanted = {a.strip() for a in args.only.split(",")}
        aois = [a for a in aois if a.id in wanted]
        missing = wanted - {a.id for a in aois}
        if missing:
            p.error(f"brak w {args.aoi_csv.name}: {', '.join(sorted(missing))}")

    s2_years = s2cloudless_years() if "ortho" in what and args.ortho_source != "national" else set()
    cache = args.out / "_cache"
    failures: list[str] = []

    for aoi in aois:
        log(f"\n=== {aoi.id} – {aoi.row.get('pozar')} ({aoi.kraj}, {aoi.rok}) bbox W{aoi.w} S{aoi.s} E{aoi.e} N{aoi.n}")
        out_dir = args.out / aoi.id
        out_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = out_dir / "manifest.json"
        base = {"aoi_id": aoi.id, "bbox_wsen": [aoi.w, aoi.s, aoi.e, aoi.n], "source_csv": args.aoi_csv.name}
        write_aoi_geojson(aoi, out_dir)

        steps = []
        if "osm" in what:
            steps.append(("osm", lambda: {"layers": fetch_osm(aoi, out_dir, layers, args.force),
                                          "attribution": ATTRIBUTION["osm"]}))
        if "ortho" in what:
            for src in ortho_sources(aoi, args.ortho_source, s2_years):
                path = out_dir / "ortho" / f"{src.key}.tif"
                res = args.s2_res if src.key.startswith("s2c") else args.ortho_res
                if path.exists() and not args.force:
                    log(f"  ortho/{src.key}: istnieje – pomijam")
                    continue
                steps.append((f"ortho.{src.key}", lambda src=src, path=path, res=res: fetch_wms_mosaic(aoi, src, res, path)))
        if "topo" in what:
            if (out_dir / "topo" / f"opentopomap_z{args.topo_zoom}.tif").exists() and not args.force:
                log("  topo: istnieje – pomijam")
            else:
                steps.append(("topo", lambda: fetch_topo(aoi, args.topo_zoom, out_dir, cache / "opentopomap")))
        if "dem" in what:
            steps.append(("dem", lambda: fetch_dem(aoi, out_dir, cache / "copernicus-dem")))

        for key, fn in steps:
            try:
                info = fn()
            except Exception as exc:  # noqa: BLE001 – jedna porażka nie zatrzymuje reszty
                log(f"  ✗ {key}: {exc}")
                failures.append(f"{aoi.id}:{key}")
                continue
            info["fetched_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            # Manifest czytamy z dysku tuż przed zapisem, żeby równoległe procesy
            # (np. osobno OSM i rastry) nie nadpisywały sobie wpisów.
            manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
            manifest.update(base)
            if key == "osm" and "osm" in manifest:
                info["layers"] = {**manifest["osm"].get("layers", {}), **info["layers"]}
            manifest[key] = info
            write_json(manifest_path, manifest)

    log("\nGotowe." if not failures else f"\nZakończono z błędami: {', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
