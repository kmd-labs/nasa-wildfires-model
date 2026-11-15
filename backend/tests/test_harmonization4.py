"""Tests of harmonization v4 (backend/harmonization4.py): fixed nominal-MODIS unit and the orbit-drift law.

    python -m pytest backend/tests/test_harmonization4.py -q

Synthetic data: Terra's overpass moves earlier from 2021 and Aqua's later from 2022, and each sees fire
according to a known drift law; VIIRS is stable. v4 must recover the law, keep the level of the series
through the drift, and continue it on VIIRS alone. v3 (unit = MODIS of the same month) follows the drift.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from backend import firms, service
from backend import harmonization3 as hz3
from backend import harmonization4 as hz
from backend.firms import FirmsClient, RegionStore
from backend.service import CalendarService

RAW = Path(__file__).resolve().parents[2] / "data" / "raw" / "firms"
BBOX = (-8.5, 39.5, -7.0, 41.0)
START = {"TERRA": "2000-11", "AQUA": "2002-08", "SNPP": "2012-02", "NOAA20": "2018-01", "NOAA21": "2023-03"}
TRUE_EFF = {"TERRA": (0.45, 0.55), "AQUA": (0.55, 0.45), "SNPP": (2.4, 4.2), "NOAA20": (2.7, 4.6), "NOAA21": (2.9, 5.0)}
TRUE_LAW = {("TERRA", 0): 0.10, ("TERRA", 1): -0.05, ("AQUA", 0): -0.05, ("AQUA", 1): -0.20}   # b1 per hour, b2 = 0
ERAS = {"Terra + Aqua": (2003, 2011), "+ S-NPP": (2012, 2017), "+ NOAA-20": (2018, 2020), "drift starts": (2021, 2023),
        "drift grows": (2024, 2026)}


def shift_path(months: pd.PeriodIndex) -> np.ndarray:
    pos = months.year.to_numpy() + (months.month.to_numpy() - 1) / 12
    shift = np.zeros((len(hz.PLATFORMS), len(months)))
    shift[hz.PLATFORMS.index("TERRA")] = np.where(pos > 2021, -1.7 * (pos - 2021) / 5.8, 0.0)
    shift[hz.PLATFORMS.index("AQUA")] = np.where(pos > 2022, 1.8 * (pos - 2022) / 4.8, 0.0)
    return shift


def synthetic(seed: int = 3, n_cells: int = 250, scale: float = 6.0):
    rng = np.random.default_rng(seed)
    months = pd.period_range("2000-11", "2026-10", freq="M")
    cal, years = months.month.to_numpy() - 1, months.year.to_numpy()
    season = np.array([.3, .5, 1, .8, .5, .8, 2, 4, 2.5, 1.5, .5, .3])
    level = rng.gamma(0.6, scale, size=(n_cells, 1)) * season[cal][None, :] * rng.lognormal(0, .6, size=(1, len(months)))
    night = np.clip(0.25 + 0.15 * np.sin(years / 3.0) + rng.normal(0, .05, len(months)), .05, .6)
    truth_s = np.stack([level * (1 - night)[None, :], level * night[None, :]])
    shift = shift_path(months)
    exposure = np.array([(months >= pd.Period(START[p], "M")).astype(float) for p in hz.PLATFORMS])
    counts = np.zeros((len(hz.PLATFORMS), 2, n_cells, len(months)))
    for i, p in enumerate(hz.PLATFORMS):
        for s in range(2):
            mu = truth_s[s] * TRUE_EFF[p][s] * exposure[i][None, :]
            if p in hz.MODIS:
                mu = mu * np.exp(TRUE_LAW[(p, s)] * shift[i])[None, :]
            counts[i, s] = rng.poisson(mu)
    cube = hz.Cube(counts, exposure, [str(i) for i in range(n_cells)], months, cal, years, np.ones(len(months)),
                   counts * 0.5, {}, np.zeros_like(counts))
    cube.shift, cube.shift_measured = shift, np.ones_like(shift, dtype=bool)
    return cube, truth_s.sum(axis=0)


@pytest.fixture(scope="module")
def fitted():
    cube, truth = synthetic()
    model, regional, summary = hz.fit_efficiency(cube)
    return cube, truth, model, regional, summary


def era_ratio(values: np.ndarray, truth: np.ndarray, years: np.ndarray, a: int, b: int) -> float:
    sel = (years >= a) & (years <= b)
    return float(np.nansum(values[:, sel]) / truth[:, sel].sum())


def test_level_holds_through_the_drift_and_v3_follows_it(fitted):
    cube, truth, model, regional, _ = fitted
    v4, _ = hz.harmonize(cube, model, regional)
    for name, (a, b) in ERAS.items():
        r = era_ratio(v4, truth, cube.years, a, b)
        assert abs(r - 1) < 0.03, f"v4 {name}: off by {100 * (r - 1):.1f} %"
    m3, r3, _ = hz3.fit_efficiency(cube, calibrate=False)
    v3, _ = hz3.harmonize(cube, m3, r3)
    drift3 = era_ratio(v3, truth, cube.years, 2024, 2026) / era_ratio(v3, truth, cube.years, 2012, 2019)
    drift4 = era_ratio(v4, truth, cube.years, 2024, 2026) / era_ratio(v4, truth, cube.years, 2012, 2019)
    assert abs(drift4 - 1) < 0.03 and abs(drift3 - 1) > 2 * abs(drift4 - 1), f"v3 {drift3:.3f}, v4 {drift4:.3f}"


def test_viirs_alone_continues_the_nominal_unit(fitted):
    cube, truth, model, regional, _ = fitted
    only, _ = hz.harmonize(cube, model, regional, platforms=hz.VIIRS)
    r = era_ratio(only, truth, cube.years, 2023, 2026)
    assert abs(r - 1) < 0.03, f"VIIRS alone after the drift: {100 * (r - 1):.1f} %"


def test_drift_law_is_recovered(monkeypatch):
    monkeypatch.setattr(hz, "DRIFT_PRIOR_MEAN", {k: (0.0, 0.0) for k in hz.DRIFT_PRIOR_MEAN})
    monkeypatch.setattr(hz, "DRIFT_PRIOR_SD", (2.0, 2.0))
    cube, _ = synthetic(seed=8, n_cells=250)
    _, _, summary = hz.fit_efficiency(cube, calibrate=False)
    drift = summary["model"]["modisDrift"]
    for (name, s), b1 in TRUE_LAW.items():
        fit = drift[name][hz.STRATA[s]]
        assert abs(fit["b1"] - b1) < max(0.03, 3 * fit["se"][0]), f"{name} {hz.STRATA[s]}: {fit}"
        assert abs(fit["b2"]) < 0.06
    assert drift["TERRA"]["latestShiftHours"] < -1.5 and drift["AQUA"]["latestShiftHours"] > 1.5


def test_noaa21_is_chained_to_snpp(fitted):
    *_, summary = fitted
    chain = summary["model"]["viirsChain"]
    for s in range(2):
        true = TRUE_EFF["NOAA21"][s] / TRUE_EFF["SNPP"][s]
        assert abs(chain["NOAA21"][hz.STRATA[s]] / true - 1) < 0.05
    assert summary["model"]["version"] == 4 and "nominal" in summary["model"]["unit"]


def test_validation_predicts_raw_modis_through_the_law(fitted):
    cube, *_ = fitted
    report = hz.validate(cube)
    assert "drift law" in report["design"]
    for era, score in report["byEra"].items():
        assert score is not None and abs(score["totalBiasPct"]) < 5, (era, score)


def test_reversal_guard():
    assert hz._reversal(np.array([-0.3, 0.16]), 0.0, 1.8) > hz.MONOTONE_TOL      # U-shaped inside the range
    assert hz._reversal(np.array([0.1, 0.0]), -1.7, 0.0) == 0.0
    assert hz._reversal(np.array([-0.141, -0.170]), -1.7, 0.0) <= hz.MONOTONE_TOL  # Iberian daytime Terra


# ----------------------------------------------------------------------------------------------
# Overpass clock
# ----------------------------------------------------------------------------------------------

def test_local_solar_time():
    df = pd.DataFrame({"acq_time": ["1030", "1030", "45", "2330"], "longitude": [-15.0, 30.0, 0.0, 15.0]})
    assert np.allclose(hz.local_solar_time(df), [9.5, 12.5, 0.75, 0.5])


def test_overpass_shift_from_detections_and_fallback():
    months = pd.period_range("2015-01", "2026-06", freq="M")
    rows = []
    for m in months:
        lst = 11.0 if m.year < 2020 else 11.0 - 0.25 * (m.year - 2019)      # 2025: one and a half hours early
        n = 12 if m.year != 2024 else 2                                        # 2024 too thin: fallback table
        for k in range(n):
            utc = (lst - (-8.0) / 15) % 24 + 0.01 * k
            rows.append({"platform": "TERRA", "stratum": 0, "date": m.start_time + pd.Timedelta(days=k),
                         "acq_time": f"{int(utc):02d}{int(round(60 * (utc % 1))) % 60:02d}", "longitude": -8.0})
    shift, measured = hz.overpass_shift(pd.DataFrame(rows), months)
    p = hz.PLATFORMS.index("TERRA")
    t = list(months).index(pd.Period("2025-06", "M"))
    assert abs(shift[p, t] + 1.5) < 0.1 and measured[p, t]
    assert abs(shift[p, list(months).index(pd.Period("2017-06", "M"))]) < 0.05
    t24 = list(months).index(pd.Period("2024-06", "M"))
    assert not measured[p, t24] and abs(shift[p, t24] - hz.fallback_shift(months)[p, t24]) < 1e-9
    assert np.all(shift[hz.PLATFORMS.index("SNPP")] == 0)


# ----------------------------------------------------------------------------------------------
# Service with v4 swapped in (real FIRMS files)
# ----------------------------------------------------------------------------------------------

@pytest.mark.skipif(not (RAW / "country").exists(), reason="needs the FIRMS CSVs in data/raw/firms")
def test_service_runs_with_v4_swapped_in(tmp_path, monkeypatch):
    monkeypatch.setattr(firms, "hz", hz)
    monkeypatch.setattr(service, "hz", hz)
    store = RegionStore(tmp_path)
    store.seed(RAW, (-9.6, 36.0, 3.4, 43.8))
    svc = CalendarService(store, FirmsClient(map_key=""))
    payload = svc.calendar(",".join(map(str, BBOX)), "2017-06", "2017-10")
    model = payload["metadata"]["calibration"]["model"]
    assert model["version"] == 4 and model["modisDrift"]["TERRA"]["latestShiftHours"] < -1.0
    harmonized = np.array(payload["series"]["harmonized"], dtype=float)
    csv = svc.hotspots_csv(",".join(map(str, BBOX)), "2017-06-01", "2017-10-31")
    table = pd.read_csv(pd.io.common.StringIO(csv))
    window = slice(payload["months"].index("2017-06"), payload["months"].index("2017-10") + 1)
    assert math.isclose(table.weight.sum(), np.nansum(harmonized[window]), rel_tol=0.02)
