"""Harmonization v4: v3 plus a physical model of the MODIS orbit drift.

Drop-in alternative to `harmonization3.py` (same public functions, `HARMONIZATION=v4`).

Why
  Terra and Aqua ran out of fuel for orbit maintenance. Over Iberia, Terra's daytime overpass moved from
  about 11:00 local solar time (2012-2020) to 9:20 in 2026 and Aqua's from 13:05 to 14:55, while the VIIRS
  satellites stayed near 12:55. Fires burn most in the afternoon, so an earlier overpass sees fewer of them:
  relative to Suomi NPP, Terra's daytime count fell by about 30 %. v2/v3 express everything in "MODIS of the
  same month" and absorb the drift in two era factors, so the harmonized series slowly follows the drifting
  sensor. v4 fixes the unit instead.

What v4 changes
  1. Fixed unit: Terra + Aqua as they saw fire on their nominal orbits. Base efficiencies (cell x calendar
     month, day and night, FRP classes) are fitted only on years before `NOMINAL_END`.
  2. Overpass clock: for every month the local solar time of each MODIS platform's detections is compared
     with its nominal time (median before `NOMINAL_END`), from `acq_time` and longitude. Areas with too
     few detections fall back on the shift measured over Iberia (`SHIFT_FALLBACK`).
  3. Drift law: MODIS efficiency = nominal efficiency x d(shift), d = exp(b1 shift + b2 shift^2), one law
     per platform and day/night, fitted by quasi-Poisson ridge regression of MODIS counts on what VIIRS
     (which does not drift) implies. The prior mean is the law fitted over Iberia, so a small area borrows
     it and a large area overrides it. The law is physical, so it extrapolates as the drift grows.
  4. VIIRS chain: NOAA-20 and NOAA-21 are calibrated to Suomi NPP (VIIRS to VIIRS, no drift), and only Suomi
     NPP to nominal MODIS. NOAA-21 never saw an undrifted MODIS, and Suomi NPP stopped on 2 Nov 2026, so the
     record continues on NOAA-20 and NOAA-21 without a step.
  5. Validation predicts raw MODIS out of sample through the drift law (`validate`), so the drifting
     sensor stays the test, not something the model is allowed to fit away.

On four Portuguese regions (docs/harmonization.md) v4 removes the post-2023 overestimate of raw MODIS
(Centro: +14 % -> 0 %) and predicts 2025-2026 far better when trained up to 2023 (Centro: +22 % / +30 %
-> -6 % / +2 %), at the cost of a larger monthly error after 2023. `BASE_YEARS = "corrected"` refits the
base on every year with drift-corrected MODIS: lower monthly error, but part of the drift leaks back.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, fields, replace

import numpy as np
import pandas as pd

from . import harmonization2 as v2
from . import harmonization3 as v3
from .harmonization3 import (  # noqa: F401 – re-exported so this module is a drop-in replacement
    DEFAULT_FIRST_DAY,
    ERA_BREAKS,
    K_FOLDS,
    KAPPA_CELL,
    LEVEL,
    MIN_SENSING_POWER,
    MIN_TEST_HOTSPOTS,
    MODIS,
    PLATFORMS,
    PRIOR_EFFICIENCY,
    SATELLITE_TO_PLATFORM,
    SEAMS,
    SMALL_FRP_MW,
    STRATA,
    VIIRS,
    Availability,
    Cube,
    HarmonizedResult,
    bootstrap_interval,
    calendar_stats,
    detect_outages,
    detection_weights,
    fit_small_thresholds,
    flag_quality,
    median_stats,
    normalize,
    pick_h3_resolution,
    seam_test,
    small_layer,
    static_pixels,
    total_interval,
)

VERSION = 4
_Z = v2._Z
NOMINAL_END = ERA_BREAKS[0]      # years before this are on nominal orbits; the unit is fitted there
VIIRS_REF = "SNPP"               # VIIRS platform calibrated directly to nominal MODIS; the others chain to it
LST_MIN_DETECTIONS = 8           # detections a month needs for its own overpass-time estimate
LST_MIN_NOMINAL = 60             # detections the nominal years need for an area-specific nominal time
SHIFT_SMOOTH_MONTHS = 5          # centred rolling median of the monthly shift
DRIFT_CLIP = (0.25, 4.0)         # a drift factor outside this range is treated as a fit failure
KAPPA_CHAIN = 50                 # shrinkage of a VIIRS-to-VIIRS cell ratio towards its region, in S-NPP hot spots

# Nominal local solar time (hours) of each platform's detections, Iberia 2003-2019; used when an area has
# too few nominal-year detections of its own.
NOMINAL_LST = {("TERRA", "D"): 11.02, ("TERRA", "N"): 21.96, ("AQUA", "D"): 13.09, ("AQUA", "N"): 2.01}
# Overpass shift (hours, mid-year) measured over Iberia; months between are interpolated, later ones hold.
SHIFT_FALLBACK = {
    "TERRA": {2020: 0.0, 2021: -0.05, 2022: -0.19, 2023: -0.38, 2024: -0.66, 2025: -1.11, 2026: -1.65},
    "AQUA": {2022: 0.0, 2023: 0.24, 2024: 0.52, 2025: 1.06, 2026: 1.77},
}
# Drift law prior: mean (b1, b2) per platform and stratum, fitted over Iberia 2012-2026 (b2 = 0 where the
# quadratic was not monotonic there), and its sd. Daytime Terra loses fire faster the earlier it passes.
DRIFT_PRIOR_MEAN = {("TERRA", "D"): (-0.141, -0.170), ("TERRA", "N"): (0.049, 0.0),
                    ("AQUA", "D"): (-0.056, 0.0), ("AQUA", "N"): (-0.178, -0.023)}
DRIFT_PRIOR_SD = (0.10, 0.08)
# Base efficiencies: "nominal" fits them on the nominal years only; "corrected" refits them on every overlap
# year after dividing MODIS by its drift factor (same fixed unit, about twice the data).
BASE_YEARS = "nominal"
MONOTONE_TOL = 0.03              # a law that reverses by more than this (log units) inside its range is refitted linear


# ----------------------------------------------------------------------------------------------
# Overpass clock
# ----------------------------------------------------------------------------------------------

def local_solar_time(df: pd.DataFrame) -> np.ndarray:
    """Hours (0-24) of each detection: UTC acquisition time plus longitude / 15."""
    t = df.acq_time.astype(str).str.replace(":", "", regex=False).str.zfill(4)
    utc = t.str[:2].astype(int).to_numpy() + t.str[2:4].astype(int).to_numpy() / 60
    return (utc + df.longitude.to_numpy(float) / 15) % 24


def _wrap(hours: np.ndarray) -> np.ndarray:
    return (hours + 12) % 24 - 12


def fallback_shift(months: pd.PeriodIndex) -> np.ndarray:
    """[platform, month] overpass shift from `SHIFT_FALLBACK` (0 for VIIRS)."""
    out = np.zeros((len(PLATFORMS), len(months)))
    pos = months.year.to_numpy() + (months.month.to_numpy() - 0.5) / 12
    for name, table in SHIFT_FALLBACK.items():
        years = sorted(table)
        xs = np.array([y + 0.5 for y in years])
        ys = np.array([table[y] for y in years])
        out[PLATFORMS.index(name)] = np.interp(pos, xs, ys, left=0.0, right=ys[-1])
    return out


def overpass_shift(df: pd.DataFrame, months: pd.PeriodIndex) -> tuple[np.ndarray, np.ndarray]:
    """[platform, month] shift of the MODIS overpass from its nominal time, in hours, and [platform, month]
    True where the area's own detections measured it (False: Iberian fallback)."""
    shift, measured = fallback_shift(months), np.zeros((len(PLATFORMS), len(months)), dtype=bool)
    if not len(df) or "acq_time" not in df:
        return shift, measured
    lst = local_solar_time(df)
    m_idx = v3._month_index(df.date, months)
    years = df.date.dt.year.to_numpy()
    strata = df.stratum.to_numpy().astype(int) if "stratum" in df else np.zeros(len(df), dtype=int)
    for name in MODIS:
        p = PLATFORMS.index(name)
        rows = (df.platform.to_numpy() == name) & (m_idx >= 0) & (m_idx < len(months))
        off = np.full(len(df), np.nan)
        for s, sname in enumerate(STRATA):
            r = rows & (strata == s)
            ref = NOMINAL_LST[(name, sname)]
            nom_rows = r & (years < NOMINAL_END) & (years >= 2003)
            if nom_rows.sum() >= LST_MIN_NOMINAL:
                ref = ref + float(np.median(_wrap(lst[nom_rows] - ref)))
            off[r] = _wrap(lst[r] - ref)
        ok = rows & ~np.isnan(off)
        if not ok.any():
            continue
        g = pd.DataFrame({"t": m_idx[ok], "o": off[ok]}).groupby("t").o.agg(["median", "size"])
        g = g[g["size"] >= LST_MIN_DETECTIONS]["median"]
        if g.empty:
            continue
        series = pd.Series(np.nan, index=range(len(months)))
        series[g.index] = g.to_numpy()
        smooth = series.rolling(SHIFT_SMOOTH_MONTHS, center=True, min_periods=1).median()
        have = ~series.isna().to_numpy()
        shift[p, have] = smooth.to_numpy()[have]
        measured[p] = have
    return shift, measured


def build_cube(df: pd.DataFrame, avail: Availability, h3_res: int) -> Cube:
    """v3's cube plus the overpass shift of Terra and Aqua (`cube.shift`, `cube.shift_measured`)."""
    cube = v3.build_cube(df, avail, h3_res)
    cube.shift, cube.shift_measured = overpass_shift(df, cube.months)
    return cube


def _shift_of(cube: Cube) -> np.ndarray:
    if getattr(cube, "shift", None) is None:
        cube.shift, cube.shift_measured = fallback_shift(cube.months), np.zeros((len(PLATFORMS), len(cube.months)), dtype=bool)
    return cube.shift


# ----------------------------------------------------------------------------------------------
# Model
# ----------------------------------------------------------------------------------------------

@dataclass
class DriftModel(v2.EfficiencyModel):
    drift: np.ndarray | None = None   # [platform, stratum, month] multiplier of the nominal efficiency

    def efficiency(self, cube: Cube, p: int, s: int, cls: np.ndarray) -> np.ndarray:
        e = super().efficiency(cube, p, s, cls)
        return e if self.drift is None else e * self.drift[p, s][None, :]

    def regional_efficiency(self, cube: Cube, p: int, s: int) -> np.ndarray:
        r = self.regional[p, s][cube.cal_month] * self.era_factor[p, s, cube.era]
        return r if self.drift is None else r * self.drift[p, s]


def _poisson_ridge(y: np.ndarray, expected: np.ndarray, X: np.ndarray, mean: np.ndarray, sd: np.ndarray,
                   dispersion: float = 1.0, iters: int = 50) -> tuple[np.ndarray, np.ndarray]:
    """MAP estimate of b in y ~ quasi-Poisson(expected * exp(X b)), b ~ N(mean, sd^2). Returns (b, cov)."""
    b = mean.astype(float).copy()
    prec = np.diag(1.0 / sd ** 2)
    hess = prec
    for _ in range(iters):
        mu = expected * np.exp(np.clip(X @ b, -20, 20))
        grad = X.T @ (y - mu) / dispersion - prec @ (b - mean)
        hess = X.T @ (X * mu[:, None]) / dispersion + prec
        step = np.linalg.solve(hess, grad)
        b += step
        if np.max(np.abs(step)) < 1e-9:
            break
    return b, np.linalg.inv(hess)


def _reversal(b: np.ndarray, lo: float, hi: float) -> float:
    """How far log d = b1 x + b2 x^2 turns back on itself between 0 and the far end of [lo, hi]."""
    worst = 0.0
    for end in (lo, hi):
        if abs(end) < 1e-6:
            continue
        x = np.linspace(0.0, end, 101)
        f = b[0] * x + b[1] * x ** 2
        sign = np.sign(f[-1] - f[0]) or 1.0
        g = sign * f
        worst = max(worst, float(np.max(np.maximum.accumulate(g) - g)))
    return worst


def _viirs_reference(cube: Cube, model: DriftModel, cls: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per stratum, VIIRS-only harmonized value [s, cell, month] and its power (nominal unit)."""
    n_s = len(STRATA)
    seen, power = np.zeros((n_s, len(cube.cells), len(cube.months))), np.zeros((n_s, len(cube.cells), len(cube.months)))
    for name in VIIRS:
        p = PLATFORMS.index(name)
        for s in range(n_s):
            seen[s] += cube.counts_s[p, s]
            power[s] += model.efficiency(cube, p, s, cls) * cube.exposure[p][None, :]
    with np.errstate(divide="ignore", invalid="ignore"):
        h = np.where(power > 0, seen / power, 0.0)
    return h, power


def _fit_drift(cube: Cube, model: DriftModel, fit_months: np.ndarray | None) -> dict:
    """Fit d(shift) for Terra and Aqua against the VIIRS reference; fills `model.drift`. Returns the summary."""
    shift = _shift_of(cube)
    n_t = len(cube.months)
    model.drift = np.ones((len(PLATFORMS), len(STRATA), n_t))
    full = cube.exposure >= 0.999
    viirs_full = full[[PLATFORMS.index(q) for q in VIIRS]].any(axis=0)
    use = viirs_full & (cube.years >= 2012)
    if fit_months is not None:
        use &= fit_months
    cls = v2.intensity_class(cube, model.thresholds)
    h_v, power_v = _viirs_reference(cube, model, cls)
    out = {}
    for name in MODIS:
        p = PLATFORMS.index(name)
        X_all = np.stack([shift[p], shift[p] ** 2], axis=1)
        out[name] = {}
        for s, sname in enumerate(STRATA):
            eff = model.efficiency(cube, p, s, cls) * cube.exposure[p][None, :]
            expected = np.where(power_v[s] > 0, eff * h_v[s], 0.0).sum(axis=0)
            y = np.where(power_v[s] > 0, cube.counts_s[p, s], 0.0).sum(axis=0)
            sel = use & full[p] & (expected > 0)
            mean = np.array(DRIFT_PRIOR_MEAN[(name, sname)], dtype=float)
            sd = np.array(DRIFT_PRIOR_SD, dtype=float)
            b, cov, disp, form = mean, np.diag(sd ** 2), 1.0, "prior"
            span = shift[p][cube.exposure[p] > 0]
            lo, hi = (float(span.min()), float(span.max())) if span.size else (0.0, 0.0)
            if sel.sum() >= 12 and expected[sel].sum() >= 30:
                b, cov = _poisson_ridge(y[sel], expected[sel], X_all[sel], mean, sd)
                mu = expected[sel] * np.exp(X_all[sel] @ b)
                disp = max(1.0, float(np.sum((y[sel] - mu) ** 2 / np.maximum(mu, 1e-9)) / max(sel.sum() - 2, 1)))
                b, cov = _poisson_ridge(y[sel], expected[sel], X_all[sel], mean, sd, dispersion=disp)
                form = "quadratic"
                if _reversal(b, lo, hi) > MONOTONE_TOL:  # not physical inside the drift range: keep it linear
                    lin_mean, lin_sd = np.array([mean[0], 0.0]), np.array([sd[0], 1e-4])
                    b, cov = _poisson_ridge(y[sel], expected[sel], X_all[sel], lin_mean, lin_sd, dispersion=disp)
                    form = "linear"
            d = np.exp(X_all @ b)
            if not (np.all(np.isfinite(d)) and DRIFT_CLIP[0] <= d.min() and d.max() <= DRIFT_CLIP[1]):
                b, cov = mean, np.diag(sd ** 2)
                d = np.exp(X_all @ b)
            model.drift[p, s] = d
            last = int(np.flatnonzero(cube.exposure[p] > 0).max()) if (cube.exposure[p] > 0).any() else n_t - 1
            out[name][sname] = {"form": form, "b1": round(float(b[0]), 4), "b2": round(float(b[1]), 4),
                                "se": [round(float(math.sqrt(cov[0, 0])), 4), round(float(math.sqrt(cov[1, 1])), 4)],
                                "dispersion": round(disp, 2), "months": int(sel.sum()),
                                "latestFactor": round(float(d[last]), 3)}
        last = int(np.flatnonzero(cube.exposure[p] > 0).max()) if (cube.exposure[p] > 0).any() else n_t - 1
        out[name]["latestShiftHours"] = round(float(shift[p, last]), 2)
        out[name]["latestMonth"] = str(cube.months[last])
        out[name]["shiftFromThisArea"] = bool(getattr(cube, "shift_measured", np.zeros_like(shift, dtype=bool))[p, last])
    return out


def _chain_viirs(cube: Cube, model: DriftModel, fit_months: np.ndarray | None, prior: dict[str, float]) -> dict:
    """Recalibrate NOAA-20 and NOAA-21 to Suomi NPP: base_q = ratio(q / S-NPP) x base_S-NPP, shrunk like v2."""
    a = PLATFORMS.index(VIIRS_REF)
    full = cube.exposure >= 0.999
    fit = np.ones(len(cube.months), dtype=bool) if fit_months is None else fit_months
    out = {}
    for name in VIIRS:
        if name == VIIRS_REF:
            continue
        q = PLATFORMS.index(name)
        both = full[q] & full[a] & fit
        prior_ratio = prior[name] / prior[VIIRS_REF]
        out[name] = {"overlapMonths": int(both.sum())}
        for s, sname in enumerate(STRATA):
            num_all, den_all = float(cube.counts_s[q, s][:, both].sum()), float(cube.counts_s[a, s][:, both].sum())
            whole = (num_all + v2.KAPPA_REGION * prior_ratio) / (den_all + v2.KAPPA_REGION)
            for m in range(12):
                sel = both & (cube.cal_month == m)
                num, den = cube.counts_s[q, s][:, sel].sum(axis=1), cube.counts_s[a, s][:, sel].sum(axis=1)
                reg = (num.sum() + v2.KAPPA_MONTH * whole) / (den.sum() + v2.KAPPA_MONTH)
                ratio = (num + KAPPA_CHAIN * reg) / (den + KAPPA_CHAIN)
                model.base[q, s, :, m] = ratio * model.base[a, s, :, m]
                model.regional[q, s, m] = reg * model.regional[a, s, m]
            model.frp_factor[q, s] = model.frp_factor[a, s]
            out[name][sname] = round(whole, 3)
    return out


def _drift_corrected_cube(cube: Cube, drift: np.ndarray) -> Cube:
    """Copy of the cube with Terra and Aqua counts divided by their drift factor (nominal-orbit counts)."""
    counts = cube.counts_s.copy()
    for name in MODIS:
        p = PLATFORMS.index(name)
        counts[p] = counts[p] / drift[p][:, None, :]
    out = replace(cube, counts_s=counts)
    out.shift, out.shift_measured = cube.shift, getattr(cube, "shift_measured", None)
    return out


def _fit_nominal(cube: Cube, fit_months: np.ndarray | None, prior: dict[str, float], base_fit: np.ndarray | None) -> tuple[DriftModel, dict, dict]:
    base_model, _, summary = v2.fit_efficiency(cube, fit_months=base_fit, prior=prior)
    model = DriftModel(**{f.name: getattr(base_model, f.name) for f in fields(base_model)})
    model.era_factor = np.ones_like(model.era_factor)
    chain = _chain_viirs(cube, model, fit_months, prior)
    return model, summary, chain


def fit_efficiency(cube: Cube, fit_months: np.ndarray | None = None, prior: dict[str, float] | None = None,
                   calibrate: bool = True) -> tuple[DriftModel, np.ndarray, dict]:
    """Nominal-unit efficiencies, VIIRS chain, MODIS drift law. Same return shape as v1-v3."""
    _shift_of(cube)
    nominal = cube.years < NOMINAL_END
    fm = nominal if fit_months is None else (fit_months & nominal)
    prior = prior or PRIOR_EFFICIENCY
    model, summary, chain = _fit_nominal(cube, fit_months, prior, fm)
    drift = _fit_drift(cube, model, fit_months)
    if BASE_YEARS == "corrected":  # refit the base on every overlap year with drift-corrected MODIS, then the law again
        corrected = _drift_corrected_cube(cube, model.drift)
        model, summary, chain = _fit_nominal(corrected, fit_months, prior, fit_months)
        drift = _fit_drift(cube, model, fit_months)
    _, modis_full = v2._overlap(cube, fm)
    model.phi = v2._dispersion(cube, model, modis_full)
    model.rel_var = v3._calibration_rel_var(cube, model, fm)
    model.anchor = False
    model.z = _Z
    if calibrate:
        model.z = interval_multiplier(cube)
    regional = (model.regional * model.stratum_weight[None, :, None]).sum(axis=1)
    for name in PLATFORMS:
        if name in summary:
            summary[name].pop("eraFactors", None)
    summary["model"] = {
        "version": VERSION, "countEngine": "v2 base (" + ("drift-corrected, all overlap years" if BASE_YEARS == "corrected" else "nominal years") + ") + VIIRS chain + MODIS drift law",
        "unit": f"MODIS (Terra + Aqua) hot spots on nominal orbits (as before {NOMINAL_END}), vegetation fires",
        "nominalYearsBefore": NOMINAL_END, "viirsReference": VIIRS_REF, "viirsChain": chain, "modisDrift": drift,
        "dispersionPhi": round(float(model.phi), 3), "intervalMultiplier": round(float(model.z), 3),
        "smallFrpMw": SMALL_FRP_MW, "strata": list(STRATA),
    }
    return model, regional, summary


# ----------------------------------------------------------------------------------------------
# Harmonization
# ----------------------------------------------------------------------------------------------

def harmonize_full(cube: Cube, model: DriftModel, platforms: tuple[str, ...] = PLATFORMS) -> HarmonizedResult:
    """v3's estimator with drift-aware efficiencies (also in the sensing-power floor)."""
    result = v3.harmonize_full(cube, model, platforms)
    if getattr(model, "drift", None) is None:
        return result
    power_regional = np.zeros(len(cube.months))
    for name in platforms:
        p = PLATFORMS.index(name)
        for s in range(len(STRATA)):
            power_regional += model.regional_efficiency(cube, p, s) * cube.exposure[p] * model.stratum_weight[s]
    valid = power_regional >= MIN_SENSING_POWER
    if np.array_equal(valid, result.valid):
        return result
    keep = valid[None, :]
    return HarmonizedResult(np.where(keep, result.values, np.nan), np.where(keep, result.sd, np.nan),
                            np.where(keep, result.lo, np.nan), np.where(keep, result.hi, np.nan),
                            result.seen, result.power, valid, result.phi)


def harmonize(cube: Cube, eff: DriftModel, regional: np.ndarray | None = None,
              platforms: tuple[str, ...] = PLATFORMS) -> tuple[np.ndarray, np.ndarray]:
    """v1-compatible: (nominal-MODIS-equivalent hot spots [cell, month], sd scaled for a calibrated 90 % band)."""
    r = harmonize_full(cube, eff, platforms)
    return r.values, r.sd * float(getattr(eff, "z", _Z)) / _Z


def extras(cube: Cube, model: DriftModel, df: pd.DataFrame) -> dict:
    """What `service.py` adds when v4 is active (same as v3)."""
    result = harmonize_full(cube, model)
    return {"weights": detection_weights(df, cube, result), "smallFires": small_layer(cube), "result": result}


def predicted_raw_modis(cube: Cube, model: DriftModel, result: HarmonizedResult) -> tuple[np.ndarray, np.ndarray]:
    """[cell, month] raw Terra + Aqua counts implied by a (VIIRS-only) result through the drift law, and sd."""
    cls = v2.intensity_class(cube, model.thresholds)
    pred, var = np.zeros((len(cube.cells), len(cube.months))), np.zeros((len(cube.cells), len(cube.months)))
    for s in range(len(STRATA)):
        mp = sum(model.efficiency(cube, PLATFORMS.index(n), s, cls) * cube.exposure[PLATFORMS.index(n)][None, :] for n in MODIS)
        with np.errstate(divide="ignore", invalid="ignore"):
            h = np.where(result.power[s] > 0, result.seen[s] / result.power[s], np.nan)
            v = np.where(result.power[s] > 0, result.phi * result.seen[s] / result.power[s] ** 2, np.nan)
        pred += np.nan_to_num(h * mp)
        var += np.nan_to_num(v * mp ** 2)
    bad = ~result.valid[None, :] | (result.power.sum(axis=0) <= 0)
    return np.where(bad, np.nan, pred), np.where(bad, np.nan, np.sqrt(var))


# ----------------------------------------------------------------------------------------------
# Validation: VIIRS alone + drift law predict raw MODIS out of sample
# ----------------------------------------------------------------------------------------------

def _folds(cube: Cube, k: int = K_FOLDS) -> dict | None:
    cache = cube.__dict__.setdefault("_v4_folds", {})
    if k in cache:
        return cache[k]
    full, modis_full = v2._overlap(cube, None)
    viirs_any = cube.exposure[[PLATFORMS.index(p) for p in VIIRS]].max(axis=0) >= 0.999
    test_all = modis_full & viirs_any
    raw_modis = cube.counts[PLATFORMS.index("TERRA")] + cube.counts[PLATFORMS.index("AQUA")]
    if raw_modis[:, test_all].sum() < MIN_TEST_HOTSPOTS:
        cache[k] = None
        return None
    test_years = np.unique(cube.years[test_all])
    kk = min(k, len(test_years))
    if kk < 2:
        cache[k] = None
        return None
    fold_of_year = {int(y): i % kk for i, y in enumerate(test_years)}
    fold = np.array([fold_of_year.get(int(y), -1) for y in cube.years])
    truth = np.full(raw_modis.shape, np.nan)
    pred, pred_sd = np.full(raw_modis.shape, np.nan), np.full(raw_modis.shape, np.nan)
    phis = []
    for f in range(kk):
        train = fold != f
        test = test_all & (fold == f)
        model, _, _ = fit_efficiency(cube, fit_months=train, prior=v2._training_prior(cube, train & (cube.years < NOMINAL_END)), calibrate=False)
        res = harmonize_full(cube, model, platforms=VIIRS)
        p_raw, p_sd = predicted_raw_modis(cube, model, res)
        truth[:, test] = raw_modis[:, test]
        pred[:, test], pred_sd[:, test] = p_raw[:, test], p_sd[:, test]
        phis.append(model.phi)
    out = {"k": kk, "test": test_all, "truth": truth, "pred": pred, "pred_sd": pred_sd, "phi": float(np.mean(phis))}
    cache[k] = out
    return out


# Interval multiplier guards (#83). With on-demand download a fit may see only a few months per
# year, and the 90 % quantile of a handful of k-fold residuals is unstable (values of 5-9 were seen).
# Below MIN_CALIBRATION_MONTHS test months the typical multiplier of fits on the full Iberian
# record (2.48-2.78 in three regions, 2026-11-15) is used instead, and the result is capped.
MIN_CALIBRATION_MONTHS = 24
TYPICAL_INTERVAL_MULTIPLIER = 2.6
MAX_INTERVAL_MULTIPLIER = 3.5


def interval_multiplier(cube: Cube, k: int = K_FOLDS, level: float = LEVEL) -> float:
    folds = _folds(cube, k)
    if folds is None:
        return TYPICAL_INTERVAL_MULTIPLIER
    truth, est, var = v3._monthly(folds, folds["test"])
    use = (truth > 0) & (var > 0)
    if use.sum() < MIN_CALIBRATION_MONTHS:
        return TYPICAL_INTERVAL_MULTIPLIER
    z = float(np.quantile(np.abs(truth[use] - est[use]) / np.sqrt(var[use]), level))
    return float(min(MAX_INTERVAL_MULTIPLIER, max(_Z, z)))


def validate(cube: Cube, k: int = K_FOLDS) -> dict | None:
    """Blocked k-fold over years: refit on the other years, predict raw MODIS from VIIRS + the drift law."""
    folds = _folds(cube, k)
    if folds is None:
        return None
    z = interval_multiplier(cube, k)

    def score(sel: np.ndarray) -> dict | None:
        truth, est, var = v3._monthly(folds, sel)
        if truth.sum() < MIN_TEST_HOTSPOTS:
            return None
        busy = truth >= 50
        return {
            "months": int(sel.sum()), "modisHotspots": round(float(truth.sum()), 1), "viirsOnlyEstimate": round(float(est.sum()), 1),
            "totalBiasPct": round(100 * (est.sum() / truth.sum() - 1), 2),
            "monthlyPearsonR": round(float(np.corrcoef(truth, est)[0, 1]), 4) if sel.sum() > 2 else None,
            "monthlyMedianAbsErrorPct": round(float(np.median(np.abs(est[busy] / truth[busy] - 1)) * 100), 1) if busy.any() else None,
            "interval90CoverageUncalibrated": round(float(np.mean(np.abs(truth - est) <= _Z * np.sqrt(var))), 3),
            "interval90Coverage": round(float(np.mean(np.abs(truth - est) <= z * np.sqrt(var))), 3),
        }

    eras = {"2012-2019": (2012, 2019), "2020-2022": (2020, 2022), "2023+": (2023, 2100)}
    test = folds["test"]
    out = {
        "design": f"blocked {folds['k']}-fold over years; each fold refits the nominal efficiencies, the VIIRS chain and the "
                  "MODIS drift law on the other years and predicts raw MODIS from VIIRS alone through the drift law",
        "dispersionPhi": round(folds["phi"], 3), "intervalMultiplier": round(z, 3),
        "intervalNote": "the multiplier is calibrated on these folds, so the calibrated coverage is in-sample",
        "allTestYears": score(test),
        "byEra": {name: score(test & (cube.years >= a) & (cube.years <= b)) for name, (a, b) in eras.items()},
    }
    out["thresholdLayer"] = v3._threshold_layer_report(cube)
    return out
