"""Tests of the backend.

    python -m pytest backend/tests -q

The estimator tests use synthetic data. The download tests replace FIRMS with a fake server that
answers Area API requests from the CSVs in data/raw/firms (they are skipped when those are absent),
so the planning, chunking, caching and refresh logic runs end to end without network or MAP_KEY.
"""
from __future__ import annotations

import datetime as dt
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from backend import firms
from backend import harmonization as hz
from backend.firms import FirmsClient, RegionStore
from backend.service import BadRequest, CalendarService, NotReady

RAW = Path(__file__).resolve().parents[2] / "data" / "raw" / "firms"
BBOX = (-8.5, 39.5, -7.0, 41.0)       # central Portugal, away from borders
BBOX_TEXT = ",".join(map(str, BBOX))
TODAY = dt.date(2026, 11, 14)          # last day of the CSVs in the repo

# ----------------------------------------------------------------------------------------------
# Estimator on synthetic data: known truth in, same truth out
# ----------------------------------------------------------------------------------------------

TRUE_EFFICIENCY = {"TERRA": 0.48, "AQUA": 0.52, "SNPP": 3.0, "NOAA20": 3.4, "NOAA21": 3.6}
START = {"TERRA": "2000-11", "AQUA": "2002-08", "SNPP": "2012-02", "NOAA20": "2018-01", "NOAA21": "2023-03"}


def synthetic_cube(seed: int = 7, n_cells: int = 300, scale: float = 6.0) -> tuple[hz.Cube, np.ndarray]:
    rng = np.random.default_rng(seed)
    months = pd.period_range("2000-11", "2026-10", freq="M")
    cal, years = months.month.to_numpy() - 1, months.year.to_numpy()
    season = np.array([.3, .5, 1, .8, .5, .8, 2, 4, 2.5, 1.5, .5, .3])
    truth = rng.gamma(0.6, scale, size=(n_cells, 1)) * season[cal][None, :] * rng.lognormal(0, .6, size=(1, len(months)))
    viirs_advantage = rng.lognormal(0, .25, size=n_cells)  # VIIRS gains more where fires are small
    exposure = np.array([(months >= pd.Period(START[p], "M")).astype(float) for p in hz.PLATFORMS])
    counts = np.zeros((len(hz.PLATFORMS), n_cells, len(months)))
    for i, p in enumerate(hz.PLATFORMS):
        eff = TRUE_EFFICIENCY[p] * (viirs_advantage[:, None] if p in hz.VIIRS else 1)
        counts[i] = rng.poisson(truth * eff * exposure[i][None, :])
    return hz.Cube(counts, exposure, [str(i) for i in range(n_cells)], months, cal, years, np.ones(len(months))), truth


ERAS = {"Terra only": (2000, 2001), "Terra + Aqua": (2003, 2011), "+ S-NPP": (2012, 2017), "+ NOAA-20": (2018, 2022), "+ NOAA-21": (2023, 2026)}


def test_no_step_when_a_satellite_joins():
    cube, truth = synthetic_cube()
    eff, regional, _ = hz.fit_efficiency(cube)
    harmonized, _ = hz.harmonize(cube, eff, regional)
    for name, (a, b) in ERAS.items():
        sel = (cube.years >= a) & (cube.years <= b)
        ratio = np.nansum(harmonized[:, sel]) / truth[:, sel].sum()
        assert abs(ratio - 1) < 0.03, f"{name}: harmonized series is off by {100 * (ratio - 1):.1f} %"
    assert np.corrcoef(truth.sum(axis=0), np.nansum(harmonized, axis=0))[0, 1] > 0.995


def test_viirs_alone_continues_the_modis_series():
    cube, truth = synthetic_cube()
    eff, regional, _ = hz.fit_efficiency(cube)
    viirs_only, _ = hz.harmonize(cube, eff, regional, platforms=hz.VIIRS)
    sel = cube.years >= 2019
    assert abs(np.nansum(viirs_only[:, sel]) / truth[:, sel].sum() - 1) < 0.03


def test_quiet_area_falls_back_on_the_prior():
    """With almost no MODIS hot spots in the overlap, efficiencies must stay near the prior, not explode."""
    cube, _ = synthetic_cube(n_cells=3, scale=0.02)
    _, regional, summary = hz.fit_efficiency(cube)
    assert summary["SNPP"]["priorWeight"] > 0.5
    assert 1.5 < regional[hz.PLATFORMS.index("SNPP")].mean() < 4.5
    assert abs(regional[hz.PLATFORMS.index("TERRA")] + regional[hz.PLATFORMS.index("AQUA")] - 1).max() < 1e-9


def test_month_in_progress_is_not_projected():
    cube, _ = synthetic_cube()
    eff, regional, _ = hz.fit_efficiency(cube)
    full, _ = hz.harmonize(cube, eff, regional)
    cube.observed[-1] = 0.5
    half, _ = hz.harmonize(cube, eff, regional)
    assert np.allclose(np.nansum(half[:, -1]), 0.5 * np.nansum(full[:, -1]))


def test_h3_resolution_follows_bbox_size():
    assert hz.pick_h3_resolution((-9.6, 36.0, 3.4, 43.8)) == 5
    assert hz.pick_h3_resolution((-8.11, 40.0, -7.62, 40.43)) == 7


# ----------------------------------------------------------------------------------------------
# Download path against a fake FIRMS built from the repo's CSVs
# ----------------------------------------------------------------------------------------------

class FakeFirms:
    """Answers /api/data_availability and /api/area like FIRMS does, from local CSVs clipped to BBOX."""

    AREA = re.compile(r"/api/area/csv/[^/]+/(?P<source>[A-Z0-9_]+)/(?P<bbox>[-0-9.,]+)/(?P<days>\d+)/(?P<date>\d{4}-\d{2}-\d{2})$")

    def __init__(self, raw_dir: Path):
        frames = []
        for path in sorted(raw_dir.glob("country/*/*.csv")) + sorted(raw_dir.glob("api_iberia/*.csv")):
            df = pd.read_csv(path, dtype=str)
            frames.append(df.drop(columns=[c for c in ("source", "sensor", "acq_datetime_utc") if c in df]))
        df = pd.concat(frames, ignore_index=True).drop_duplicates(["satellite", "latitude", "longitude", "acq_date", "acq_time"])
        sensor = df.satellite.str.lower().map(hz.SATELLITE_TO_PLATFORM).map(firms.PLATFORM_SENSOR)
        kind = np.where(df.version.fillna("").str.upper().str.contains("RT"), "NRT", "SP")
        df["source_id"] = sensor + "_" + kind
        # availability is a property of the archive, not of the bbox, so it is taken before clipping
        self.availability = {sid: (part.acq_date.min(), part.acq_date.max()) for sid, part in df.groupby("source_id")}
        lat, lon = df.latitude.astype(float), df.longitude.astype(float)
        df = df[lat.between(BBOX[1], BBOX[3]) & lon.between(BBOX[0], BBOX[2])].sort_values("acq_date")
        self.by_source = {}
        for sid, part in df.groupby("source_id"):
            part = part.drop(columns="source_id").reset_index(drop=True)
            self.by_source[sid] = (part, part.acq_date.to_numpy(dtype=str), part.latitude.astype(float).to_numpy(), part.longitude.astype(float).to_numpy())
        self.total_rows = len(df)
        self.area_requests = 0
        self.max_days = 0

    def __call__(self, url: str, timeout: float) -> tuple[int, str]:
        if "/api/data_availability/" in url:
            lines = ["data_id,min_date,max_date"] + [f"{sid},{a},{b}" for sid, (a, b) in self.availability.items()]
            return 200, "\n".join(lines) + "\n"
        m = self.AREA.search(url)
        if not m or m["source"] not in self.availability:
            return 400, "Invalid request"
        self.area_requests += 1
        self.max_days = max(self.max_days, int(m["days"]))
        w, s, e, n = (float(v) for v in m["bbox"].split(","))
        first = dt.date.fromisoformat(m["date"])
        last = first + dt.timedelta(days=int(m["days"]) - 1)
        part, dates, lat, lon = self.by_source[m["source"]]
        i, j = np.searchsorted(dates, f"{first}", "left"), np.searchsorted(dates, f"{last}", "right")
        keep = np.flatnonzero((lat[i:j] >= s) & (lat[i:j] <= n) & (lon[i:j] >= w) & (lon[i:j] <= e)) + i
        cols = [c for c in part.columns if not (m["source"].endswith("_NRT") and c == "type")]  # NRT has no type column
        return 200, part.iloc[keep][cols].to_csv(index=False)


needs_raw = pytest.mark.skipif(not (RAW / "country").exists(), reason="data/raw/firms is not downloaded")


@pytest.fixture(scope="module")
def fake() -> FakeFirms:
    return FakeFirms(RAW)


@pytest.fixture()
def frozen_today(monkeypatch):
    monkeypatch.setattr(firms, "today_utc", lambda: TODAY)


@needs_raw
def test_download_cache_and_refresh(fake, frozen_today, tmp_path):
    client = FirmsClient(map_key="TESTKEY", http_get=fake)
    region = RegionStore(tmp_path).get_or_create(BBOX)
    planned = region.plan(client.availability(), TODAY)
    assert {t.sensor for t in planned} == set(firms.SENSOR_EPOCH)

    fake.area_requests = 0
    outcome = region.sync(client, workers=8)
    assert outcome["failed"] == []
    assert fake.max_days <= firms.CHUNK_DAYS
    assert fake.area_requests == sum(len(t.runs) for t in planned)
    assert region.manifest["rows"] == fake.total_rows, "every hot spot the fake holds must be in the cache exactly once"
    assert "TESTKEY" not in (region.path / "manifest.json").read_text()

    # second call: nothing is stale, so no request reaches FIRMS
    fake.area_requests = 0
    region.sync(client)
    assert fake.area_requests == 0

    # a day later only the chunks that are not final (near-real-time, current chunk) are asked again
    for entry in region.manifest["chunks"].values():
        entry["fetched"] -= 24 * 3600
    stale = region.plan(client.availability(), TODAY)
    assert 0 < len(stale) < 0.05 * len(planned)
    assert all(not region.manifest["chunks"][f"{t.sensor}|{t.start}"]["final"] for t in stale)
    region.sync(client)
    assert region.manifest["rows"] == fake.total_rows


@needs_raw
def test_download_and_seed_give_the_same_calendar(fake, frozen_today, tmp_path):
    downloaded = CalendarService(RegionStore(tmp_path / "a"), FirmsClient(map_key="TESTKEY", http_get=fake))
    a = downloaded.calendar(BBOX_TEXT, "2017-06", "2017-10", wait=True)

    store = RegionStore(tmp_path / "b")
    store.seed(RAW, (-9.6, 36.0, 3.4, 43.8))
    seeded = CalendarService(store, FirmsClient(map_key=""))  # no key: offline, served from the seed
    b = seeded.calendar(BBOX_TEXT, "2017-06", "2017-10")

    assert a["series"]["rawModis"] == b["series"]["rawModis"]
    assert a["series"]["rawViirs"] == b["series"]["rawViirs"]
    # v2 outage detection & region-wide FRP/static quantiles run on the full seeded peninsula,
    # whereas the small bbox download sees too few detections per day to detect outages.
    assert np.allclose(np.array(a["series"]["harmonized"], dtype=float), np.array(b["series"]["harmonized"], dtype=float), rtol=0.25, atol=2.0, equal_nan=True)
    assert a["selection"]["hotspots"]["rawModis"] > 0
    assert any(p["sensor"] == "MODIS" for p in a["selection"]["pixels"])
    assert any(p["sensor"] == "VIIRS" for p in a["selection"]["pixels"])
    assert a["selection"]["comparedWithSameMonthsInOtherYears"]["rank"] == b["selection"]["comparedWithSameMonthsInOtherYears"]["rank"]
    assert len(a["calendar"]["harmonized"]) == len(a["calendar"]["years"]) and len(a["calendar"]["harmonized"][0]) == 12
    assert "2017" in a["selection"]["dailyByYear"] and len(a["selection"]["dailyByYear"]["2017"]) > 0

    csv = downloaded.hotspots_csv(BBOX_TEXT, "2017-10-14", "2017-10-16", wait=True).splitlines()
    assert csv[0].endswith("platform,used_in_calendar") and len(csv) > 100
    assert all(line.split(",")[2] in ("2017-10-14", "2017-10-15", "2017-10-16") for line in csv[1:])


def test_offline_without_cache_is_refused(tmp_path):
    service = CalendarService(RegionStore(tmp_path), FirmsClient(map_key=""))
    with pytest.raises(BadRequest):
        service.calendar("10,10,11,11")


@pytest.mark.parametrize("bbox", ["1,2,3", "5,5,4,6", "-200,0,10,10", "-60,-40,60,40"])
def test_bad_bbox_is_refused(bbox, tmp_path):
    with pytest.raises(BadRequest):
        CalendarService(RegionStore(tmp_path), FirmsClient(map_key="")).calendar(bbox)


def test_parse_multipolygon_bboxes():
    from backend.service import parse_bboxes

    boxes = parse_bboxes("-9.5,37.0,-7.5,42.0;-3.5,38.0,1.0,42.5")
    assert len(boxes) == 2
    assert boxes[0] == (-9.5, 37.0, -7.5, 42.0)
    assert boxes[1] == (-3.5, 38.0, 1.0, 42.5)


@needs_raw
def test_http_api_answers_202_then_200(fake, frozen_today, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from backend import server

    def slow(url: str, timeout: float) -> tuple[int, str]:
        time.sleep(0.0005)
        return fake(url, timeout)

    monkeypatch.setattr(server, "service", CalendarService(RegionStore(tmp_path), FirmsClient(map_key="TESTKEY", http_get=slow)))
    api = TestClient(server.app)
    url = f"/api/calendar?bbox={BBOX_TEXT}&from=2025-08&to=2025-08"
    first = api.get(url)
    assert first.status_code == 202 and first.json()["status"] == "downloading"
    deadline = time.time() + 120
    while (response := api.get(url)).status_code == 202 and time.time() < deadline:
        time.sleep(0.5)
    assert response.status_code == 200
    body = response.json()
    assert body["selection"]["from"] == "2025-08" and body["metadata"]["dataThrough"] == "2026-11-14"
    assert body["metadata"]["monthInProgress"] == "2026-11"

    csv = api.get(f"/api/hotspots.csv?bbox={BBOX_TEXT}&from=2025-08-01&to=2025-08-31")
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    assert api.get("/api/calendar?bbox=1,2,3").status_code == 400
    assert api.get("/api/health").json()["cachedRegions"][0]["rows"] > 0


def test_empty_detections_calendar_and_build_cube(tmp_path):
    from backend import harmonization2 as hz2, harmonization3 as hz3

    empty_df = pd.DataFrame(columns=["platform", "date", "latitude", "longitude"])
    empty_df["date"] = pd.to_datetime(empty_df["date"])
    for mod in (hz, hz2, hz3):
        cube = mod.build_cube(empty_df, mod.Availability.default(pd.Timestamp("2026-11-14")), 7)
        assert len(cube.cells) == 0
        assert float(cube.counts.sum()) == 0.0

    avail_csv = (
        "data_id,min_date,max_date\n"
        "MODIS_SP,2000-11-01,2026-06-30\n"
        "MODIS_NRT,2026-07-01,2026-11-14\n"
        "VIIRS_SNPP_SP,2012-01-20,2026-06-30\n"
        "VIIRS_SNPP_NRT,2026-07-01,2026-11-14\n"
        "VIIRS_NOAA20_SP,2018-01-01,2026-06-30\n"
        "VIIRS_NOAA20_NRT,2026-07-01,2026-11-14\n"
        "VIIRS_NOAA21_SP,2023-01-01,2026-06-30\n"
        "VIIRS_NOAA21_NRT,2026-07-01,2026-11-14\n"
    )

    def empty_http(url: str, timeout: float) -> tuple[int, str]:
        if "/data_availability/" in url:
            return 200, avail_csv
        return 200, "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n"

    svc = CalendarService(RegionStore(tmp_path), FirmsClient(map_key="TESTKEY", http_get=empty_http))
    res = svc.calendar("16.76,50.87,17.4,51.24", "2000-11", "2026-11", wait=True)
    assert res["selection"]["hotspots"] == {"harmonized": 0.0, "rawModis": 0, "rawViirs": 0}
    assert res["selection"]["cells"] == []
    assert res["selection"]["pixels"] == []


def test_http_500_preserves_cors_header(monkeypatch):
    from fastapi.testclient import TestClient

    from backend import server

    def boom(*_args, **_kwargs):
        raise RuntimeError("unexpected failure")

    monkeypatch.setattr(server.service, "calendar", boom)
    api = TestClient(server.app)
    res = api.get("/api/calendar?bbox=16.76,50.87,17.4,51.24&from=2000-11&to=2026-11", headers={"Origin": "http://localhost:4200"})
    assert res.status_code == 500
    assert res.headers.get("access-control-allow-origin") == "http://localhost:4200"


def test_partial_boundary_dates_exclude_out_of_range_days(tmp_path):
    avail_csv = (
        "data_id,min_date,max_date\n"
        "MODIS_SP,2024-06-01,2025-10-31\n"
        "VIIRS_SNPP_SP,2024-06-01,2025-10-31\n"
    )
    rows_modis = [
        "51.05,17.05,320.0,0.4,0.4,2024-07-10,1200,T,n,6.1,290.0,15.0,D",
        "51.05,17.05,320.0,0.4,0.4,2025-07-10,1200,T,n,6.1,290.0,15.0,D",
    ]
    rows_viirs = [
        "51.05,17.05,330.0,0.4,0.4,2024-07-10,1205,N,n,2,295.0,20.0,D",
        "51.06,17.06,330.0,0.4,0.4,2024-10-01,1210,N,n,2,295.0,12.0,D",
        *[f"51.{10 + i},17.10,330.0,0.4,0.4,2024-10-20,1210,N,n,2,295.0,12.0,D" for i in range(5)],
        "51.05,17.05,330.0,0.4,0.4,2025-07-10,1205,N,n,2,295.0,20.0,D",
        "51.06,17.06,330.0,0.4,0.4,2025-10-01,1210,N,n,2,295.0,14.0,D",
        *[f"51.{20 + i},17.20,330.0,0.4,0.4,2025-10-15,1210,N,n,2,295.0,14.0,D" for i in range(10)],
    ]
    header = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight"

    def fake_http(url: str, timeout: float) -> tuple[int, str]:
        if "/data_availability/" in url:
            return 200, avail_csv
        m = re.search(r"/csv/[^/]+/([^/]+)/[^/]+/\d+/(\d{4}-\d{2}-\d{2})$", url)
        assert m, url
        sensor, end_s = m.group(1), m.group(2)
        end_d = dt.date.fromisoformat(end_s)
        span_m = re.search(r"/(\d+)/\d{4}-\d{2}-\d{2}$", url)
        days = int(span_m.group(1))
        start_d = end_d - dt.timedelta(days=days - 1)
        src = rows_modis if sensor == "MODIS_SP" else rows_viirs
        picked = [r for r in src if start_d <= dt.date.fromisoformat(r.split(",")[5]) <= end_d]
        return 200, "\n".join([header, *picked])

    svc = CalendarService(RegionStore(tmp_path), FirmsClient(map_key="TESTKEY", http_get=fake_http))
    bbox = "16.76,50.87,17.4,51.35"
    part = svc.calendar(bbox, "2025-06-01", "2025-10-01", wait=True)
    full = svc.calendar(bbox, "2025-06-01", "2025-10-31", wait=True)

    assert part["selection"]["fromDate"] == "2025-06-01"
    assert part["selection"]["toDate"] == "2025-10-01"
    assert part["selection"]["hotspots"]["rawViirs"] == 2  # July 10 + Oct 1 only
    assert full["selection"]["hotspots"]["rawViirs"] == 12  # includes 10 detections on Oct 15
    assert part["selection"]["hotspots"]["harmonized"] < full["selection"]["hotspots"]["harmonized"]

    mmdds = {b["mmdd"] for b in part["selection"]["daily"]}
    assert mmdds == {"07-10", "10-01"}
    assert sum(c["rawViirs"] for c in part["selection"]["cells"]) == part["selection"]["hotspots"]["rawViirs"]

    part_top = {r["year"]: r["harmonized"] for r in part["selection"]["comparedWithSameMonthsInOtherYears"]["top5"]}
    full_top = {r["year"]: r["harmonized"] for r in full["selection"]["comparedWithSameMonthsInOtherYears"]["top5"]}
    assert part_top[2024] < full_top[2024]
    assert part_top[2025] < full_top[2025]

