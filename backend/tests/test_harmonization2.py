"""Tests of harmonization v2 (backend/harmonization2.py).

    python -m pytest backend/tests/test_harmonization2.py -q

The synthetic data put in exactly the effects v2 models and v1 does not: VIIRS efficiency that
drifts between eras, a day/night mix that changes from year to year with different day and night
efficiencies, and a VIIRS advantage that depends on fire intensity. v2 must recover the truth and
beat v1 on the same data.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from backend import firms, service
from backend import harmonization as hz1
from backend import harmonization2 as hz
from backend.firms import FirmsClient, RegionStore
from backend.service import CalendarService

RAW = Path(__file__).resolve().parents[2] / "data" / "raw" / "firms"
BBOX = (-8.5, 39.5, -7.0, 41.0)
START = {"TERRA": "2000-11", "AQUA": "2002-08", "SNPP": "2012-02", "NOAA20": "2018-01", "NOAA21": "2023-03"}
# per stratum (day, night); Terra + Aqua = 1 in each stratum, so the truth is in MODIS-equivalent units
TRUE_EFF = {"TERRA": (0.45, 0.55), "AQUA": (0.55, 0.45), "SNPP": (2.4, 4.2), "NOAA20": (2.7, 4.6), "NOAA21": (2.9, 5.0)}
ERA_DRIFT = {0: 1.0, 1: 1.15, 2: 1.3}          # VIIRS / MODIS ratio grows as the MODIS orbits drift
ERAS = {"Terra only": (2000, 2001), "Terra + Aqua": (2003, 2011), "+ S-NPP": (2012, 2017),
        "+ NOAA-20": (2018, 2022), "+ NOAA-21": (2023, 2026)}


def synthetic(seed: int = 3, n_cells: int = 300, scale: float = 6.0, overdispersion: float = 0.0):
    """Cube with known truth [cell, month] in MODIS-equivalent hot spots."""
    rng = np.random.default_rng(seed)
    months = pd.period_range("2000-11", "2026-10", freq="M")
    cal, years = months.month.to_numpy() - 1, months.year.to_numpy()
    season = np.array([.3, .5, 1, .8, .5, .8, 2, 4, 2.5, 1.5, .5, .3])
    level = rng.gamma(0.6, scale, size=(n_cells, 1)) * season[cal][None, :] * rng.lognormal(0, .6, size=(1, len(months)))
    night_share = np.clip(0.25 + 0.15 * np.sin(years / 3.0) + rng.normal(0, .05, len(months)), .05, .6)
    truth_s = np.stack([level * (1 - night_share)[None, :], level * night_share[None, :]])  # [s, c, t]
    intensity = rng.uniform(0, 1, size=(2, n_cells, len(months)))                          # FRP percentile
    small_fire_gain = 1.5 - intensity                                                       # VIIRS sees small fires better
    era = np.searchsorted(np.array(hz.ERA_BREAKS), years, side="right")
    drift = np.array([ERA_DRIFT[e] for e in era])
    exposure = np.array([(months >= pd.Period(START[p], "M")).astype(float) for p in hz.PLATFORMS])
    counts = np.zeros((len(hz.PLATFORMS), 2, n_cells, len(months)))
    pct = np.zeros_like(counts)
    for i, p in enumerate(hz.PLATFORMS):
        for s in range(2):
            mu = truth_s[s] * TRUE_EFF[p][s] * exposure[i][None, :]
            if p in hz.VIIRS:
                mu = mu * drift[None, :] * small_fire_gain[s]
            if overdispersion:
                mu = mu * rng.gamma(1 / overdispersion, overdispersion, size=mu.shape)
            counts[i, s] = rng.poisson(mu)
            pct[i, s] = counts[i, s] * intensity[s]
    cube = hz.Cube(counts, exposure, [str(i) for i in range(n_cells)], months, cal, years, np.ones(len(months)), pct)
    return cube, truth_s.sum(axis=0)


def v1_cube(cube: hz.Cube) -> hz1.Cube:
    return hz1.Cube(cube.counts, cube.exposure, cube.cells, cube.months, cube.cal_month, cube.years, cube.observed.copy())


@pytest.fixture(scope="module")
def fitted():
    cube, truth = synthetic()
    model, regional, summary = hz.fit_efficiency(cube)
    return cube, truth, model, regional, summary


# ----------------------------------------------------------------------------------------------
# Efficiency model
# ----------------------------------------------------------------------------------------------

def test_no_step_when_a_satellite_joins_or_an_orbit_drifts(fitted):
    cube, truth, model, regional, _ = fitted
    harmonized, _ = hz.harmonize(cube, model, regional)
    for name, (a, b) in ERAS.items():
        sel = (cube.years >= a) & (cube.years <= b)
        ratio = np.nansum(harmonized[:, sel]) / truth[:, sel].sum()
        assert abs(ratio - 1) < 0.03, f"{name}: off by {100 * (ratio - 1):.1f} %"


def test_v2_beats_v1_where_the_ratio_drifts(fitted):
    cube, truth, model, regional, _ = fitted
    c1 = v1_cube(cube)
    e1, r1, _ = hz1.fit_efficiency(c1)
    sel = cube.years >= 2020
    only1, _ = hz1.harmonize(c1, e1, r1, platforms=hz1.VIIRS)
    only2, _ = hz.harmonize(cube, model, regional, platforms=hz.VIIRS)
    err1 = abs(np.nansum(only1[:, sel]) / truth[:, sel].sum() - 1)
    err2 = abs(np.nansum(only2[:, sel]) / truth[:, sel].sum() - 1)
    assert err2 < 0.04 and err2 < err1 / 2, f"v1 {100 * err1:.1f} %, v2 {100 * err2:.1f} %"


def test_factors_recover_drift_and_small_fire_gain(fitted):
    _, _, model, _, summary = fitted
    snpp = hz.PLATFORMS.index("SNPP")
    drift = model.era_factor[snpp, :, 2] / model.era_factor[snpp, :, 0]
    assert np.allclose(drift, 1.3, rtol=0.08)
    frp = model.frp_factor[snpp, :, 1:]
    assert (np.diff(frp, axis=1) < 0).all(), "lower intensity class must have a higher VIIRS factor"
    assert summary["SNPP"]["dayNight"]["N"] > summary["SNPP"]["dayNight"]["D"]
    assert summary["model"]["version"] == 2


def test_quiet_area_falls_back_on_the_prior():
    cube, _ = synthetic(n_cells=3, scale=0.02)
    _, regional, summary = hz.fit_efficiency(cube)
    assert summary["SNPP"]["priorWeight"] > 0.5
    assert 1.5 < regional[hz.PLATFORMS.index("SNPP")].mean() < 4.5


# ----------------------------------------------------------------------------------------------
# Uncertainty
# ----------------------------------------------------------------------------------------------

def test_dispersion_is_one_for_poisson_and_larger_for_clustered_counts(fitted):
    _, _, model, _, _ = fitted
    assert model.phi < 1.3
    clustered, _ = synthetic(overdispersion=0.5)
    m2, _, _ = hz.fit_efficiency(clustered)
    assert m2.phi > 1.5


def test_zero_count_has_a_finite_upper_bound(fitted):
    cube, _, model, _, _ = fitted
    r = hz.harmonize_full(cube, model)
    zero = (r.seen.sum(axis=0) == 0) & r.valid[None, :]
    assert zero.any()
    assert np.all(r.lo[zero] == 0) and np.all(r.hi[zero] > 0) and np.all(r.sd[zero] == 0)
    c, t = map(int, np.argwhere(zero)[0])
    expected = sum(model.phi * -np.log(0.05) / r.power[s, c, t] for s in range(2))
    assert np.isclose(r.hi[c, t], expected)


def test_intervals_bracket_the_estimate(fitted):
    cube, _, model, _, _ = fitted
    r = hz.harmonize_full(cube, model)
    ok = ~np.isnan(r.values)
    assert np.all(r.lo[ok] <= r.values[ok] + 1e-9) and np.all(r.values[ok] <= r.hi[ok] + 1e-9)


def test_bootstrap_interval_covers_the_total():
    cube, truth = synthetic(n_cells=60)
    # fire-days: spread every cell-month count over days so the bootstrap has units
    s, c, t = np.nonzero(cube.counts_s.sum(axis=0))
    n = cube.counts_s.sum(axis=0)[s, c, t]
    cube.units = {"s": s, "c": c, "t": t, "n": n}
    model, _, _ = hz.fit_efficiency(cube)
    r = hz.harmonize_full(cube, model)
    lo, hi = hz.bootstrap_interval(cube, r, n_boot=100)
    total = np.nansum(r.values, axis=0)
    busy = total > 20
    assert np.all(lo[busy] <= total[busy]) and np.all(total[busy] <= hi[busy])
    assert np.mean(hi[busy] - lo[busy]) > 0


# ----------------------------------------------------------------------------------------------
# Input data
# ----------------------------------------------------------------------------------------------

def _rows(platform: str, day: str, n: int, lat: float = 40.0, lon: float = -8.0, typ: float = 0) -> pd.DataFrame:
    return pd.DataFrame({"platform": platform, "date": pd.Timestamp(day), "latitude": lat, "longitude": lon,
                         "type": typ, "confidence": "n", "frp": 5.0}, index=range(n))


def test_outage_day_is_found_and_taken_out_of_exposure():
    days = pd.date_range("2022-07-01", "2022-07-31")
    frames = [_rows(p, d, 40) for d in days for p in ("TERRA", "AQUA", "NOAA20")]
    frames += [_rows("SNPP", d, 120) for d in days if d.day not in (26, 27)]
    df = pd.concat(frames, ignore_index=True)
    out = hz.detect_outages(df)
    assert [d.day for d in out["SNPP"]] == [26, 27]
    assert "NOAA20" not in out

    avail = hz.Availability({p: pd.Timestamp("2022-07-01") for p in hz.PLATFORMS}, {p: None for p in hz.PLATFORMS},
                            pd.Timestamp("2022-07-31"), out)
    cube = hz.build_cube(df.assign(stratum=0, frp_pct=0.5), avail, 5)
    assert np.isclose(cube.exposure[hz.PLATFORMS.index("SNPP"), 0], 29 / 31)
    assert hz.Availability.from_json(avail.to_json()).outages["SNPP"] == out["SNPP"]


def test_static_mask_is_dilated_to_neighbouring_pixels():
    known = pd.concat([_rows("SNPP", "2020-01-01", 3, typ=2)], ignore_index=True)
    nrt = _rows("SNPP", "2026-11-01", 1, lat=40.01, lon=-8.01, typ=np.nan)  # one pixel away, no type yet
    df = pd.concat([known, nrt], ignore_index=True)
    assert hz.flag_quality(df).qa_pass.tolist() == [False, False, False, False]
    assert hz.flag_quality(df, static=hz.static_pixels(known, dilate=0)).qa_pass.iloc[-1]


def test_day_night_inferred_from_solar_time_when_missing():
    raw = pd.DataFrame({"latitude": ["40"], "longitude": ["-8"], "satellite": ["N"], "acq_date": ["2025-08-10"],
                        "acq_time": ["0200"], "confidence": ["n"], "frp": ["3"], "type": ["0"]})
    assert hz.normalize(raw).stratum.tolist() == [1]
    assert hz.normalize(raw.assign(daynight="D")).stratum.tolist() == [0]


# ----------------------------------------------------------------------------------------------
# Statistics and validation
# ----------------------------------------------------------------------------------------------

def test_calendar_stats_is_leave_one_out_and_log_consistent():
    values = np.array([10.0, 12, 11, 9, 10, 500])
    cal = np.zeros(6, dtype=int)
    z, pct, mean, std = hz.calendar_stats(values, cal, np.ones(6, dtype=bool))
    z1, _, _, _ = hz1.calendar_stats(values, cal, np.ones(6, dtype=bool))
    assert z[-1] > 3 * z1[-1], "the extreme month must not dampen its own z-score"
    assert pct[-1] == 100 and pct[0] == 30  # 10 vs (12, 11, 9, 10, 500): one below, one tie -> 1.5 / 5
    assert np.isclose(mean[0], np.expm1(np.log1p(values).mean())) and np.isclose(std[0], np.log1p(values).std(ddof=1))


def test_validation_is_blocked_k_fold_and_unbiased(fitted):
    cube, _, _, _, _ = fitted
    v = hz.validate(cube)
    assert v["design"].startswith("blocked 4-fold")
    assert abs(v["allTestYears"]["totalBiasPct"]) < 5
    assert v["allTestYears"]["monthlyPearsonR"] > 0.98
    assert 0.6 < v["allTestYears"]["interval90Coverage"] <= 1


# ----------------------------------------------------------------------------------------------
# Drop-in: the whole API on real data with v2 swapped in
# ----------------------------------------------------------------------------------------------

@pytest.mark.skipif(not (RAW / "country").exists(), reason="data/raw/firms is not downloaded")
def test_service_runs_with_v2_swapped_in(tmp_path, monkeypatch):
    monkeypatch.setattr(firms, "hz", hz)
    monkeypatch.setattr(service, "hz", hz)
    store = RegionStore(tmp_path)
    store.seed(RAW, (-9.6, 36.0, 3.4, 43.8))
    payload = CalendarService(store, FirmsClient(map_key="")).calendar(",".join(map(str, BBOX)), "2017-06", "2017-10")
    assert payload["metadata"]["calibration"]["model"]["version"] == 2
    harmonized = np.array(payload["series"]["harmonized"], dtype=float)
    raw_modis = np.array(payload["series"]["rawModis"], dtype=float)
    both = (np.array([m < "2012-01" for m in payload["months"]])) & ~np.isnan(harmonized)
    # before VIIRS the harmonized series is MODIS itself, up to the Terra/Aqua split
    assert abs(np.nansum(harmonized[both]) / raw_modis[both].sum() - 1) < 0.1
    assert payload["validation"] is None or "interval90Coverage" in payload["validation"]["allTestYears"]
