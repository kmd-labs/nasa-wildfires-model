"""Burned area (MCD64A1 / VNP64A1) and the seam test.

    python -m pytest backend/tests/test_burned_area.py -q

Grid math, HDF4 reading, search, download and cache run against a fake LP DAAC (synthetic HDF4 tiles
written with pyhdf), so no network or token is needed. The seam test runs on synthetic series with a
known jump. `RUN_NETWORK_TESTS=1` plus EARTHDATA_TOKEN also downloads two real tiles.
"""
from __future__ import annotations

import io
import json
import math
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from backend import burned_area as ba
from backend import firms, service
from backend import harmonization3 as hz
from backend.burned_area import BurnedAreaClient, BurnedAreaError
from backend.firms import FirmsClient, RegionStore
from backend.service import BadRequest, CalendarService, NotReady

RAW = Path(__file__).resolve().parents[2] / "data" / "raw" / "firms"
LISBON_BBOX = (-9.3, 38.5, -8.6, 39.0)    # inside tile h17v05


def rowcol(lat: float, lon: float) -> tuple[int, int, int, int]:
    """(h, v, row, col) of the pixel containing a point, the inverse of pixel_centers."""
    x = ba.EARTH_R * math.radians(lon) * math.cos(math.radians(lat))
    y = ba.EARTH_R * math.radians(lat)
    gx, gy = int((x - ba.X_MIN) // ba.PIX_M), int((ba.Y_MAX - y) // ba.PIX_M)
    return gx // ba.N_PIX, gy // ba.N_PIX, gy % ba.N_PIX, gx % ba.N_PIX


# ----------------------------------------------------------------------------------------------
# Sinusoidal grid
# ----------------------------------------------------------------------------------------------

@pytest.mark.parametrize("lat, lon, tile", [(38.72, -9.14, (17, 5)), (41.15, -8.61, (17, 4)),
                                            (40.42, -3.70, (17, 4)), (41.39, 2.17, (18, 4))])
def test_tile_of_known_cities(lat, lon, tile):
    assert ba.tile_of(lat, lon) == tile


def test_pixel_centres_invert_the_grid():
    assert math.isclose(ba.PIX_M, 463.3127, rel_tol=1e-6) and math.isclose(ba.PIXEL_KM2, 0.21466, rel_tol=1e-4)
    for lat, lon in [(38.72, -9.14), (41.15, -8.61), (37.02, -7.93)]:
        h, v, row, col = rowcol(lat, lon)
        clat, clon = ba.pixel_centers(h, v, np.array([row]), np.array([col]))
        assert abs(clat[0] - lat) < 0.005 and abs(clon[0] - lon) < 0.006
        assert ba.tile_of(float(clat[0]), float(clon[0])) == (h, v)
    lat, _ = ba.pixel_centers(17, 5, np.array([0]), np.array([0]))      # upper-left pixel of h17v05
    assert math.isclose(lat[0], 40 - math.degrees(ba.PIX_M / 2 / ba.EARTH_R), abs_tol=1e-9)


def test_tiles_for_bbox_and_granule_ids():
    assert ba.tiles_for_bbox((-8.7, 39.6, -7.0, 41.0)) == {(17, 4), (17, 5)}
    assert ba.tiles_for_bbox(LISBON_BBOX) == {(17, 5)}
    g = ba.parse_granule("MCD64A1.A2017152.h17v05.061.2021312125712")
    assert g == {"product": "MCD64A1", "month": "2017-06", "h": 17, "v": 5, "tile": "h17v05"}
    assert ba.parse_granule("VNP64A1.A2016153.h17v04.002.2024056115716.hdf")["month"] == "2016-06"   # leap year
    with pytest.raises(ValueError):
        ba.parse_granule("MOD14A1.2017.h17v05")


# ----------------------------------------------------------------------------------------------
# HDF4 tiles, search, download and cache against a fake LP DAAC
# ----------------------------------------------------------------------------------------------

def write_tile(path: Path, burned: dict[tuple[int, int], int]) -> None:
    from pyhdf.SD import SD, SDC
    burn = np.zeros((ba.N_PIX, ba.N_PIX), np.int16)
    burn[:100, :100] = -2                      # water
    burn[100:110, :50] = -1                    # unmapped
    unc = np.zeros_like(burn)
    for (row, col), doy in burned.items():
        burn[row, col], unc[row, col] = doy, 3
    sd = SD(str(path), SDC.WRITE | SDC.CREATE | SDC.TRUNC)
    for name, data in [("Burn Date", burn), ("Burn Date Uncertainty", unc)]:
        ds = sd.create(name, SDC.INT16, data.shape)
        ds[:] = data
        ds.endaccess()
    sd.end()


INSIDE = [(38.72, -9.14), (38.80, -9.00), (38.60, -8.80)]     # in LISBON_BBOX
OUTSIDE = [(37.50, -8.00)]                                    # same tile, outside the bbox


@pytest.fixture(scope="module")
def tiles(tmp_path_factory) -> dict[str, bytes]:
    """HDF4 bytes per granule id: 2017-07 burned 3 pixels in the bbox and 1 outside, 2017-08 one, 2017-09 none."""
    d = tmp_path_factory.mktemp("hdf")
    px = {p: rowcol(*p)[2:] for p in INSIDE + OUTSIDE}
    plan = {"MCD64A1.A2017182.h17v05.061.2021312132008": {px[p]: 190 for p in INSIDE + OUTSIDE},
            "MCD64A1.A2017213.h17v05.061.2021312134033": {px[INSIDE[0]]: 220},
            "MCD64A1.A2017244.h17v05.061.2021312140055": {}}
    out = {}
    for gid, burned in plan.items():
        write_tile(d / f"{gid}.hdf", burned)
        out[gid] = (d / f"{gid}.hdf").read_bytes()
    return out


class FakeResponse:
    def __init__(self, status: int, body: bytes = b"", headers: dict | None = None):
        self.status_code, self.body, self.headers = status, body, headers or {}

    def json(self):
        return json.loads(self.body)

    def iter_content(self, size: int):
        stream = io.BytesIO(self.body)
        while chunk := stream.read(size):
            yield chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeLpDaac:
    """CMR search plus authenticated downloads, like cmr.earthdata.nasa.gov and data.lpdaac.earthdatacloud."""

    def __init__(self, tiles: dict[str, bytes]):
        self.tiles, self.downloads, self.searches = tiles, [], []
        extra = ["MCD64A1.A2017152.h17v05.061.2021312125712",   # previous month, returned by CMR's temporal overlap
                 "MCD64A1.A2017182.h18v05.061.2021312132011"]   # neighbouring tile
        self.entries = [{"title": gid, "producer_granule_id": f"{gid}.hdf",
                         "links": [{"href": f"https://data.example/{gid}.hdf"}, {"href": f"s3://bucket/{gid}.hdf"}]}
                        for gid in list(tiles) + extra]

    def get(self, url, params=None, headers=None, stream=False, timeout=None):
        if url == ba.CMR_URL:
            self.searches.append(params)
            return FakeResponse(200, json.dumps({"feed": {"entry": self.entries}}).encode())
        if (headers or {}).get("Authorization") != "Bearer TOKEN":
            return FakeResponse(401)
        gid = url.rsplit("/", 1)[-1].removesuffix(".hdf")
        self.downloads.append(gid)
        return FakeResponse(200, self.tiles[gid]) if gid in self.tiles else FakeResponse(404)


def test_read_burned_pixels(tiles, tmp_path):
    path = tmp_path / "t.hdf"
    path.write_bytes(tiles["MCD64A1.A2017182.h17v05.061.2021312132008"])
    pixels, counts = ba.read_burned_pixels(path)
    assert len(pixels) == 4 and set(pixels.doy) == {190} and set(pixels.unc) == {3}
    assert counts == {"burned": 4, "unmapped": 500, "water": 10000, "pixels": ba.N_PIX ** 2}


def test_search_download_cache_and_monthly(tiles, tmp_path):
    lpdaac = FakeLpDaac(tiles)
    client = BurnedAreaClient(token="TOKEN", cache_dir=tmp_path, session=lpdaac)
    found = client.search("MCD64A1", LISBON_BBOX, "2017-07", "2017-09")
    assert [g["month"] for g in found] == ["2017-07", "2017-08", "2017-09"] and {g["tile"] for g in found} == {"h17v05"}
    assert all(g["url"].startswith("https://") for g in found)
    assert lpdaac.searches[0]["bounding_box"] == "-9.3,38.5,-8.6,39" and lpdaac.searches[0]["version"] == "061"

    outcome = client.fetch("MCD64A1", LISBON_BBOX, "2017-07", "2017-09", workers=2)
    assert outcome == {"granules": 3, "downloaded": 3, "alreadyCached": 0, "failed": []}
    assert not list(tmp_path.rglob("*.hdf"))                       # only the burned pixels are kept
    again = client.fetch("MCD64A1", LISBON_BBOX, "2017-07", "2017-09")
    assert again["downloaded"] == 0 and again["alreadyCached"] == 3 and len(lpdaac.downloads) == 3

    frame = BurnedAreaClient(token="", cache_dir=tmp_path).monthly("MCD64A1", LISBON_BBOX, "2017-06", "2017-09")
    assert frame.month.tolist() == ["2017-06", "2017-07", "2017-08", "2017-09"]
    assert frame.complete.tolist() == [False, True, True, True] and np.isnan(frame.burnedKm2[0])
    assert frame.burnedPixels[1:].tolist() == [3, 1, 0]
    assert math.isclose(frame.burnedKm2[1], round(3 * ba.PIXEL_KM2, 3))
    index = json.loads((tmp_path / "MCD64A1" / "index.json").read_text())
    assert index["MCD64A1.A2017182.h17v05.061.2021312132008"]["burned"] == 4


def test_missing_token_and_failed_tiles(tiles, tmp_path):
    with pytest.raises(BurnedAreaError, match="EARTHDATA_TOKEN"):
        BurnedAreaClient(token="", cache_dir=tmp_path, session=FakeLpDaac(tiles)).fetch("MCD64A1", LISBON_BBOX, "2017-07", "2017-07")
    outcome = BurnedAreaClient(token="WRONG", cache_dir=tmp_path, session=FakeLpDaac(tiles)).fetch("MCD64A1", LISBON_BBOX, "2017-07", "2017-08")
    assert outcome["downloaded"] == 0 and len(outcome["failed"]) == 2 and "HTTP 401" in outcome["failed"][0]
    assert "WRONG" not in " ".join(outcome["failed"])
    with pytest.raises(ValueError):
        BurnedAreaClient(token="TOKEN", cache_dir=tmp_path, session=FakeLpDaac(tiles)).search("MOD14A1", LISBON_BBOX, "2017-07", "2017-07")


def test_server_errors_are_retried(tiles, tmp_path, monkeypatch):
    monkeypatch.setattr(ba, "RETRY_WAIT_S", 0.0)

    class Flaky(FakeLpDaac):
        def get(self, url, **kw):
            if url != ba.CMR_URL and url not in self.seen:
                self.seen.add(url)
                return FakeResponse(502)
            return super().get(url, **kw)

    lpdaac = Flaky(tiles)
    lpdaac.seen = set()
    outcome = BurnedAreaClient(token="TOKEN", cache_dir=tmp_path, session=lpdaac).fetch("MCD64A1", LISBON_BBOX, "2017-07", "2017-08")
    assert outcome["downloaded"] == 2 and outcome["failed"] == []


@pytest.mark.skipif(not (os.getenv("RUN_NETWORK_TESTS") and os.getenv("EARTHDATA_TOKEN")),
                    reason="set RUN_NETWORK_TESTS=1 and EARTHDATA_TOKEN to download real tiles")
def test_real_lp_daac(tmp_path):
    client = BurnedAreaClient(cache_dir=tmp_path)
    assert client.fetch("MCD64A1", (-8.7, 39.6, -7.0, 41.0), "2017-06", "2017-06")["downloaded"] == 2
    frame = client.monthly("MCD64A1", (-8.7, 39.6, -7.0, 41.0), "2017-06", "2017-06")
    assert 300 < frame.burnedKm2[0] < 800          # Pedrogao Grande, June 2017


# ----------------------------------------------------------------------------------------------
# Seam test
# ----------------------------------------------------------------------------------------------

def synthetic_record(seed: int = 3, jump: float = 4.0):
    """Witness (burned km2) and hot-spot series sharing real year-to-year activity; naive jumps at S-NPP."""
    rng = np.random.default_rng(seed)
    months = pd.period_range("2001-01", "2025-12", freq="M")
    season = np.array([.1, .2, .5, .4, .3, .6, 2, 4, 3, 1.5, .4, .1])
    activity = rng.lognormal(0, .6, size=months.year.nunique())[months.year - 2001]
    witness = 50 * activity * season[months.month - 1] * rng.lognormal(0, .3, len(months))
    ratio = rng.lognormal(0, .12, size=months.year.nunique())[months.year - 2001]       # hot spots per km2 drift
    harmonized = 3 * witness * ratio * rng.lognormal(0, .2, len(months))
    naive = harmonized * np.where(months >= pd.Period("2012-01", "M"), jump, 1.0)
    return months, {"harmonized": harmonized, "naiveSum": naive}, witness


def rows_of(result: dict, seam: str) -> dict:
    return {r["series"]: r for r in result["rows"] if r["seam"] == seam}


def test_seam_test_finds_the_naive_jump_and_not_the_harmonized():
    months, series, witness = synthetic_record()
    result = hz.seam_test(months, series, witness, witness_name="MCD64A1")
    assert result["witness"] == "MCD64A1" and result["tThreshold"] == 2.0
    assert {r["seam"] for r in result["rows"]} == {"AQUA", "SNPP", "NOAA20", "NOAA21"}
    snpp = rows_of(result, "SNPP")["naiveSum"]
    assert snpp["blocks"] == 25 and snpp["blocksBefore"] == 11 and snpp["blocksAfter"] == 14
    assert 0.8 < snpp["elasticity"] < 1.2                               # synthetic hot spots are proportional to burned area
    assert snpp["ci95Pct"][0] < snpp["stepPct"] < snpp["ci95Pct"][1]
    assert rows_of(result, "AQUA")["harmonized"]["verdict"] == "insufficient"   # one 12-month block before Aqua
    assert all(r["minDetectablePct"] is None or r["minDetectablePct"] > 0 for r in result["rows"])
    # over many records: the x4 jump is always found, a series without a jump is flagged about as often as |z| >= 2 allows
    naive_found, false_alarms, steps = 0, 0, []
    for seed in range(20):
        one = rows_of(hz.seam_test(*synthetic_record(seed)), "SNPP")
        naive_found += one["naiveSum"]["verdict"] == "seamUp"
        false_alarms += one["harmonized"]["verdict"] != "noSeam"
        steps.append(one["naiveSum"]["stepPct"])
    assert naive_found == 20 and false_alarms <= 3
    assert 200 < np.median(steps) < 400                              # x4 = +300 %


def test_seam_test_without_enough_witness_is_insufficient():
    months, series, witness = synthetic_record()
    gap = witness.copy()
    gap[months < pd.Period("2012-01", "M")] = np.nan               # witness starts at the seam (like VNP64A1)
    snpp = rows_of(hz.seam_test(months, series, gap), "SNPP")
    assert snpp["harmonized"]["verdict"] == "insufficient" and snpp["harmonized"]["stepPct"] is None
    short = slice(0, 60)                                           # 2001-2005: too few blocks for a verdict
    rows = hz.seam_test(months[short], {k: v[short] for k, v in series.items()}, witness[short])["rows"]
    assert all(r["verdict"] == "insufficient" for r in rows)


# ----------------------------------------------------------------------------------------------
# Service and HTTP API
# ----------------------------------------------------------------------------------------------

class FakeBurned:
    """Stands in for BurnedAreaClient: monthly values per product, a download that takes `delay` seconds."""

    def __init__(self, online: bool = True, data: dict[str, pd.Series] | None = None, delay: float = 0.0):
        self.token, self.data, self.delay = ("TOKEN" if online else ""), dict(data or {}), delay

    @property
    def online(self) -> bool:
        return bool(self.token)

    def fetch(self, product, bbox, first, last, workers=4, progress=None):
        months = ba._months(first, last)
        if progress:
            progress(0, len(months))
        time.sleep(self.delay)
        self.data[product] = pd.Series(np.arange(len(months), dtype=float), index=months)
        return {"granules": len(months), "downloaded": len(months), "alreadyCached": 0, "failed": []}

    def monthly(self, product, bbox, first, last):
        months = ba._months(first, last)
        km2 = self.data.get(product, pd.Series(dtype=float)).reindex(months).to_numpy(float)
        return pd.DataFrame({"month": months, "burnedKm2": km2, "burnedPixels": km2 / ba.PIXEL_KM2, "tilesNeeded": 1,
                             "tilesCached": (~np.isnan(km2)).astype(int), "complete": ~np.isnan(km2)})


def test_burned_area_endpoint_202_then_200(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from backend import server

    fake = FakeBurned(delay=0.3)
    monkeypatch.setattr(server, "service", CalendarService(RegionStore(tmp_path), FirmsClient(map_key=""), fake))
    api = TestClient(server.app)
    url = "/api/burned-area?bbox=-8.7,39.6,-7.0,41.0&from=2016-01&to=2017-12"
    first = api.get(url)
    assert first.status_code == 202 and first.json()["status"] == "downloading"
    deadline = time.time() + 30
    while (response := api.get(url)).status_code == 202 and time.time() < deadline:
        time.sleep(0.1)
    assert response.status_code == 200
    body = response.json()
    assert body["months"][0] == "2016-01" and len(body["series"]["burnedKm2"]) == 24
    assert body["metadata"]["tiles"] == ["h17v04", "h17v05"] and body["metadata"]["product"] == "MCD64A1"
    assert [y["year"] for y in body["yearly"]] == [2016, 2017] and body["seamTest"] is None   # no FIRMS data cached
    assert api.get("/api/burned-area?bbox=-8.7,39.6,-7.0,41.0&product=MOD14").status_code == 400
    assert api.get("/api/health").json()["earthdataTokenConfigured"] is True


def test_burned_area_offline_without_cache_is_refused(tmp_path):
    svc = CalendarService(RegionStore(tmp_path), FirmsClient(map_key=""), FakeBurned(online=False))
    with pytest.raises(BadRequest, match="EARTHDATA_TOKEN"):
        svc.burned_area("-8.7,39.6,-7.0,41.0")
    with pytest.raises(NotReady):
        CalendarService(RegionStore(tmp_path), FirmsClient(map_key=""), FakeBurned(delay=1)).burned_area("-8.7,39.6,-7.0,41.0", date_from="2017-01", date_to="2017-12")


@pytest.mark.skipif(not (RAW / "country").exists(), reason="needs the FIRMS CSVs in data/raw/firms")
def test_calendar_carries_the_seam_test(tmp_path, monkeypatch):
    monkeypatch.setattr(firms, "hz", hz)
    monkeypatch.setattr(service, "hz", hz)
    store = RegionStore(tmp_path)
    store.seed(RAW, (-9.6, 36.0, 3.4, 43.8))
    fake = FakeBurned(online=False)
    svc = CalendarService(store, FirmsClient(map_key=""), fake)
    bbox = "-8.5,39.5,-7.0,41.0"
    payload = svc.calendar(bbox)
    assert payload["seamTest"] is None                              # nothing cached for the witness yet
    # stand-in witness that follows MODIS: then MODIS-unit series show no seam and the naive sum does
    modis = pd.Series(payload["series"]["rawModis"], index=payload["months"], dtype=float)
    fake.data["MCD64A1"] = modis.where(modis.index < payload["months"][-1])
    seam = svc.calendar(bbox)["seamTest"]["MCD64A1"]
    snpp = rows_of(seam, "SNPP")
    assert snpp["naiveSum"]["verdict"] == "seamUp" and snpp["naiveSum"]["stepPct"] > 150
    assert abs(snpp["harmonized"]["stepPct"]) < 25 and abs(snpp["rawModis"]["stepPct"]) < 1
    assert svc.burned_area(bbox)["seamTest"]["witness"] == "MCD64A1"


def test_overlapping_bboxes_and_large_bbox(tmp_path):
    assert service._overlapping(((-9, 37, -8, 38), (-8.5, 37.5, -7, 39)))
    assert not service._overlapping(((-9, 37, -8, 38), (-8, 37, -7, 38)))       # touching edges only
    svc = CalendarService(RegionStore(tmp_path), FirmsClient(map_key=""), FakeBurned())
    with pytest.raises(BadRequest, match="burned area"):
        svc.burned_area("-30,30,0,50")
