"""Tests of harmonization v3 (backend/harmonization3.py).

    python -m pytest backend/tests/test_harmonization3.py -q

By default v3 counts exactly like v2 and adds the small-fire layer, weights, median stats and calibrated
intervals. The anchored-unit tests use synthetic data where MODIS (Terra, Aqua) sees fewer hot spots once
its orbits drift (2020+) while VIIRS stays put: with `anchor=True` v3 must keep the pre-drift level.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from backend import firms, service
from backend import harmonization2 as hz2
from backend import harmonization3 as hz
from backend.firms import FirmsClient, RegionStore
from backend.service import CalendarService

RAW = Path(__file__).resolve().parents[2] / "data" / "raw" / "firms"
BBOX = (-8.5, 39.5, -7.0, 41.0)
START = {"TERRA": "2000-11", "AQUA": "2002-08", "SNPP": "2012-02", "NOAA20": "2018-01", "NOAA21": "2023-03"}
TRUE_EFF = {"TERRA": (0.45, 0.55), "AQUA": (0.55, 0.45), "SNPP": (2.4, 4.2), "NOAA20": (2.7, 4.6), "NOAA21": (2.9, 5.0)}
MODIS_DRIFT = {0: 1.0, 1: 0.87, 2: 0.77}       # MODIS sees less as its orbits drift; VIIRS is stable
SMALL_SHARE = 0.65                              # share of VIIRS detections below the small-fire threshold
ERAS = {"Terra only": (2000, 2001), "Terra + Aqua": (2003, 2011), "+ S-NPP": (2012, 2017),
        "+ NOAA-20": (2018, 2019), "MODIS drifts": (2020, 2022), "+ NOAA-21": (2023, 2026)}


def synthetic(seed: int = 5, n_cells: int = 300, scale: float = 6.0, overdispersion: float = 0.0):
    rng = np.random.default_rng(seed)
    months = pd.period_range("2000-11", "2026-10", freq="M")
    cal, years = months.month.to_numpy() - 1, months.year.to_numpy()
    season = np.array([.3, .5, 1, .8, .5, .8, 2, 4, 2.5, 1.5, .5, .3])
    level = rng.gamma(0.6, scale, size=(n_cells, 1)) * season[cal][None, :] * rng.lognormal(0, .6, size=(1, len(months)))
    night = np.clip(0.25 + 0.15 * np.sin(years / 3.0) + rng.normal(0, .05, len(months)), .05, .6)
    truth_s = np.stack([level * (1 - night)[None, :], level * night[None, :]])
    era = np.searchsorted(np.array(hz.ERA_BREAKS), years, side="right")
    drift = np.array([MODIS_DRIFT[e] for e in era])
    exposure = np.array([(months >= pd.Period(START[p], "M")).astype(float) for p in hz.PLATFORMS])
    counts = np.zeros((len(hz.PLATFORMS), 2, n_cells, len(months)))
    for i, p in enumerate(hz.PLATFORMS):
        for s in range(2):
            mu = truth_s[s] * TRUE_EFF[p][s] * exposure[i][None, :]
            if p in hz.MODIS:
                mu = mu * drift[None, :]
            if overdispersion:
                mu = mu * rng.gamma(1 / overdispersion, overdispersion, size=mu.shape)
            counts[i, s] = rng.poisson(mu)
    small = np.zeros_like(counts)
    for p in hz.VIIRS:
        i = hz.PLATFORMS.index(p)
        small[i] = rng.binomial(counts[i].astype(int), SMALL_SHARE)
    cube = hz.Cube(counts, exposure, [str(i) for i in range(n_cells)], months, cal, years, np.ones(len(months)),
                   counts * 0.5, {}, small)
    return cube, truth_s.sum(axis=0)


@pytest.fixture(scope="module")
def fitted():
    """Anchored mode (experimental) on drifting-MODIS data."""
    cube, truth = synthetic()
    model, regional, summary = hz.fit_efficiency(cube, anchor=True)
    return cube, truth, model, regional, summary


def test_default_counts_are_v2s():
    cube, _ = synthetic(seed=11, n_cells=80)
    m3, r3, s3 = hz.fit_efficiency(cube, calibrate=False)
    m2, r2, _ = hz2.fit_efficiency(cube)
    assert s3["model"]["countEngine"] == "v2" and not hz.ANCHOR_UNIT
    v3, _ = hz.harmonize(cube, m3, r3)
    v2_, _ = hz2.harmonize(cube, m2, r2)
    assert np.allclose(np.nan_to_num(v3), np.nan_to_num(v2_))


# ----------------------------------------------------------------------------------------------
# Fixed unit
# ----------------------------------------------------------------------------------------------

def test_level_holds_through_satellite_changes_and_modis_drift(fitted):
    cube, truth, model, regional, _ = fitted
    harmonized, _ = hz.harmonize(cube, model, regional)
    for name, (a, b) in ERAS.items():
        sel = (cube.years >= a) & (cube.years <= b)
        ratio = np.nansum(harmonized[:, sel]) / truth[:, sel].sum()
        assert abs(ratio - 1) < 0.03, f"{name}: off by {100 * (ratio - 1):.1f} %"


def test_after_modis_ends_viirs_alone_keeps_the_unit_and_v2_does_not(fitted):
    cube, truth, model, regional, _ = fitted
    sel = cube.years >= 2023
    only3, _ = hz.harmonize(cube, model, regional, platforms=hz.VIIRS)
    err3 = abs(np.nansum(only3[:, sel]) / truth[:, sel].sum() - 1)
    m2, r2, _ = hz2.fit_efficiency(cube)
    only2, _ = hz2.harmonize(cube, m2, r2, platforms=hz2.VIIRS)
    err2 = abs(np.nansum(only2[:, sel]) / truth[:, sel].sum() - 1)
    assert err3 < 0.04 and err3 < err2 / 2, f"v2 {100 * err2:.1f} %, v3 {100 * err3:.1f} %"


def test_drift_goes_to_modis_and_the_anchor_stays_flat(fitted):
    _, _, model, _, summary = fitted
    snpp, terra = hz.PLATFORMS.index("SNPP"), hz.PLATFORMS.index("TERRA")
    assert np.allclose(model.era_factor[snpp], model.era_factor[snpp, :, :1])   # same factor in every era
    drift = model.era_factor[terra, :, 2] / model.era_factor[terra, :, 0]
    assert np.allclose(drift, MODIS_DRIFT[2], rtol=0.06)
    assert np.allclose(model.frp_factor, 1.0)
    assert summary["model"]["version"] == 3 and summary["model"]["anchor"] == "SNPP"


# ----------------------------------------------------------------------------------------------
# Small-fire layer, weights, cleaning
# ----------------------------------------------------------------------------------------------

def test_small_layer_is_per_viirs_satellite(fitted):
    cube, _, _, _, _ = fitted
    layer = hz.small_layer(cube)
    viirs = [hz.PLATFORMS.index(p) for p in hz.VIIRS]
    t = int(np.flatnonzero(cube.years == 2024)[6])
    expected = cube.small_s[viirs][:, :, :, t].sum() / cube.exposure[viirs, t].sum()
    assert np.isclose(np.nansum(layer[:, t]), expected)
    assert np.isnan(layer[:, cube.years < 2012]).all()


def _detections(n: int = 4000, seed: int = 1) -> tuple[pd.DataFrame, hz.Availability]:
    rng = np.random.default_rng(seed)
    days = pd.date_range("2018-01-01", "2021-12-31")
    rows = []
    for p in hz.PLATFORMS[:4]:
        k = n if p in hz.VIIRS else n // 3
        rows.append(pd.DataFrame({"platform": p, "date": days[rng.integers(0, len(days), k)],
                                  "latitude": rng.uniform(39.6, 40.9, k), "longitude": rng.uniform(-8.4, -7.1, k),
                                  "stratum": rng.integers(0, 2, k), "frp": rng.gamma(1.0, 15, k), "frp_pct": 0.5}))
    df = pd.concat(rows, ignore_index=True)
    df["small"] = hz.small_flag(df)
    avail = hz.Availability({p: pd.Timestamp("2018-01-01") for p in hz.PLATFORMS[:4]}, {p: None for p in hz.PLATFORMS},
                            pd.Timestamp("2021-12-31"))
    return df, avail


def test_detection_weights_add_up_to_the_harmonized_values():
    df, avail = _detections()
    cube = hz.build_cube(df, avail, 5)
    model, _, _ = hz.fit_efficiency(cube, calibrate=False)
    result = hz.harmonize_full(cube, model)
    w = hz.detection_weights(df, cube, result)
    assert (w >= 0).all() and w.sum() > 0
    assert np.isclose(w.sum(), np.nansum(result.values), rtol=1e-9)
    # any subset (e.g. a drawn polygon) adds up to the same cells' harmonized values
    cell = hz._cells_of(df.latitude.to_numpy(), df.longitude.to_numpy(), 5)
    one = cube.cells[0]
    assert np.isclose(w[cell == one].sum(), np.nansum(result.values[0]), rtol=1e-9)


def test_small_flag_uses_day_and_night_thresholds():
    df = pd.DataFrame({"platform": ["SNPP", "SNPP", "SNPP", "AQUA"], "stratum": [0, 0, 1, 0], "frp": [8.0, 9.5, 8.0, 1.0]})
    assert hz.small_flag(df).tolist() == [True, False, False, False]


def test_modis_bow_tie_duplicates_are_counted_once():
    base = {"platform": "AQUA", "acq_date": "2022-07-18", "acq_time": "1330", "date": pd.Timestamp("2022-07-18")}
    df = pd.DataFrame([
        {**base, "latitude": 40.000, "longitude": -8.000, "track": 2.0, "frp": 50.0},   # swath edge
        {**base, "latitude": 40.006, "longitude": -8.000, "track": 2.0, "frp": 30.0},   # 0.67 km away: duplicate
        {**base, "latitude": 41.000, "longitude": -8.000, "track": 1.0, "frp": 20.0},   # nadir
        {**base, "latitude": 41.009, "longitude": -8.000, "track": 1.0, "frp": 25.0},   # 1.0 km away: real neighbour
        {**base, "latitude": 40.006, "longitude": -8.000, "track": 2.0, "frp": 30.0, "acq_time": "1505"},  # other overpass
    ])
    assert hz.modis_duplicates(df).tolist() == [False, True, False, False, False]


# ----------------------------------------------------------------------------------------------
# Intervals and statistics
# ----------------------------------------------------------------------------------------------

def test_calibrated_multiplier_widens_intervals_for_clustered_counts():
    clustered, _ = synthetic(seed=7, overdispersion=0.5)
    model, _, _ = hz.fit_efficiency(clustered)
    assert model.z >= hz._Z
    v = hz.validate(clustered)
    assert v["allTestYears"]["interval90Coverage"] >= 0.85
    assert v["allTestYears"]["interval90Coverage"] >= v["allTestYears"]["interval90CoverageUncalibrated"]


def test_intervals_bracket_the_estimate_and_zero_has_finite_upper_bound(fitted):
    cube, _, model, _, _ = fitted
    r = hz.harmonize_full(cube, model)
    ok = ~np.isnan(r.values)
    assert np.all(r.lo[ok] <= r.values[ok] + 1e-9) and np.all(r.values[ok] <= r.hi[ok] + 1e-9)
    zero = (r.seen.sum(axis=0) == 0) & r.valid[None, :]
    assert zero.any() and np.all(r.hi[zero] > 0) and np.all(r.lo[zero] == 0)


def test_median_stats_leave_one_out_and_within_normal():
    values = np.array([10.0, 12, 11, 9, 10, 500])
    cal = np.zeros(6, dtype=int)
    lo, hi = values * 0.8, values * 1.2
    ms = hz.median_stats(values, cal, np.ones(6, dtype=bool), lo, hi)
    assert ms["median"][0] == 10.5
    assert ms["otherYearsMedian"][-1] == 10 and np.isclose(ms["pctOfMedian"][-1], 5000)
    assert ms["withinNormal"][0] == 1.0 and ms["withinNormal"][-1] == 0.0


def test_validation_scores_against_drift_corrected_modis_and_reports_threshold_layer(fitted):
    cube, _, _, _, _ = fitted
    v = hz.validate(cube, anchor=True)
    assert v["design"].startswith("blocked 4-fold") and "drift-corrected" in v["design"]
    assert abs(v["allTestYears"]["totalBiasPct"]) < 5
    for era, score in v["byEra"].items():
        assert abs(score["totalBiasPct"]) < 6, era
    layer = v["thresholdLayer"]
    assert set(layer) >= {"totalRatio", "byYear", "monthlyMedianAbsErrorPct"}


# ----------------------------------------------------------------------------------------------
# Drop-in: the whole API on real data with v3 swapped in
# ----------------------------------------------------------------------------------------------

@pytest.mark.skipif(not (RAW / "country").exists(), reason="data/raw/firms is not downloaded")
def test_service_runs_with_v3_swapped_in(tmp_path, monkeypatch):
    monkeypatch.setattr(firms, "hz", hz)
    monkeypatch.setattr(service, "hz", hz)
    store = RegionStore(tmp_path)
    store.seed(RAW, (-9.6, 36.0, 3.4, 43.8))
    svc = CalendarService(store, FirmsClient(map_key=""))
    payload = svc.calendar(",".join(map(str, BBOX)), "2017-06", "2017-10")
    assert payload["metadata"]["calibration"]["model"]["version"] == 3
    series = payload["series"]
    assert {"smallFiresPerViirsSatellite", "pctOfMedian", "withinNormal"} <= set(series)
    harmonized = np.array(series["harmonized"], dtype=float)
    raw_modis = np.array(series["rawModis"], dtype=float)
    before = np.array([m < "2012-01" for m in payload["months"]]) & ~np.isnan(harmonized)
    assert abs(np.nansum(harmonized[before]) / raw_modis[before].sum() - 1) < 0.1
    csv = svc.hotspots_csv(",".join(map(str, BBOX)), "2017-06-01", "2017-10-31")
    table = pd.read_csv(pd.io.common.StringIO(csv))
    assert {"weight", "small_fire"} <= set(table.columns)
    window = slice(payload["months"].index("2017-06"), payload["months"].index("2017-10") + 1)
    assert np.isclose(table.weight.sum(), np.nansum(harmonized[window]), rtol=0.02)
