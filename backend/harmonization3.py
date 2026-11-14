"""Harmonization v3: v2's count engine plus small fires as a separate, explained layer.

Drop-in alternative to `harmonization.py` / `harmonization2.py` (same public functions and call pattern):

    import backend.harmonization3 as hz          # or HARMONIZATION=v3, see harmonization_select.py

Why two layers
  Since 2012 the VIIRS cameras (375 m) report several times more hot spots than MODIS (1 km), mostly
  because they also see small, weak fires MODIS misses. For people the clearest picture is a bar split
  into "fires every camera sees" and "small fires visible only since 2012". Tested on Iberia (fit
  2012-2018, check 2019-2025 against MODIS), counting only VIIRS detections above an FRP threshold had a
  monthly median error of ~43 % and exaggerated extreme months, while one weight per detection had ~15 %.
  So v3 keeps both, with separate jobs:
    * the comparable layer (the official number) comes from v2's efficiency model, unchanged,
    * the small-fire layer and the per-detection `small` flag come from fixed FRP thresholds and are used
      to explain the jump, never to compute the official number.

What v3 adds to v2
  1. Small fires: every VIIRS detection below `SMALL_FRP_MW[day/night]` is flagged `small`; the cube keeps
     their counts and `small_layer` returns small fires per VIIRS satellite and month.
  2. Weight per detection: `detection_weights` returns observed / sensing power, so the weights of any set
     of detections (a drawn polygon, a date range, the CSV) add up to the harmonized value.
  3. Honest intervals: calibration uncertainty of the efficiencies is added to the quasi-Poisson variance,
     and the interval multiplier is calibrated on the blocked k-fold residuals.
  4. `median_stats`: leave-one-out median of the same calendar month, % of median, and a "within normal"
     flag when the 90 % interval contains that median.
  5. `validate` also reports, year by year, how far the threshold layer is from MODIS, so the limits of
     the simple picture stay visible.
  6. `seam_test`: checks against an independent witness (burned area, MCD64A1 / VNP64A1 from
     `burned_area.py`) that the series does not step when a satellite joins.

Experimental, off by default
  * MODIS duplicates (`DEDUPE_MODIS`, `modis_duplicates`): detections of one MODIS overpass closer than half
    a pixel along track counted once (MODIS has no on-board bow-tie deletion). On Portuguese regions it
    raised the monthly median error (2012-2019: 22.9 % vs 19.2 %), so the rule needs work before use.
  * Fixed pre-drift unit (`ANCHOR_UNIT`, or `anchor=True`):
    era factors tied to S-NPP (maintained orbit) instead of the MODIS of each era, so a drifting or retired
    MODIS would not move the series. On Portuguese regions (blocked 4-fold over years) it was not better
    than v2 on 2012-2019 (mean |bias| 4.8 % vs 0.7 %), so it stays opt-in until it beats v2 on held-out data.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import h3
import numpy as np
import pandas as pd

from . import harmonization2 as v2
from .harmonization2 import (  # noqa: F401 – re-exported so this module is a drop-in replacement
    DEFAULT_FIRST_DAY,
    ERA_BREAKS,
    K_FOLDS,
    KAPPA_CELL,
    KAPPA_ERA,
    LEVEL,
    MAX_CELLS,
    MIN_SENSING_POWER,
    MIN_TEST_HOTSPOTS,
    MODIS,
    MODIS_MIN_CONFIDENCE,
    PLATFORMS,
    PRIOR_EFFICIENCY,
    SATELLITE_TO_PLATFORM,
    STATIC_MIN_DETECTIONS,
    STRATA,
    VIIRS,
    Availability,
    HarmonizedResult,
    bootstrap_interval,
    calendar_stats,
    detect_outages,
    normalize,
    pick_h3_resolution,
    static_pixels,
    total_interval,
)

VERSION = 3
ANCHOR = "SNPP"                 # VIIRS platform with a maintained orbit: the reference after MODIS drifts
ANCHOR_ERA_END = ERA_BREAKS[0]  # efficiencies are fitted on years before this (pre-drift MODIS)
# FRP below which a VIIRS detection is a "small fire", by stratum. Fitted on Iberia 2012-2018 so that
# S-NPP detections above it match MODIS (Terra + Aqua) counts: day 8.8 MW, night 7.5 MW.
SMALL_FRP_MW = {"D": 8.8, "N": 7.5}
DEDUPE_TRACK_FRACTION = 0.5     # MODIS detections of one overpass closer than this share of the pixel are one
# Off by default: on Portuguese regions it raised the monthly median error (2012-2019: 22.9 % vs 19.2 %).
DEDUPE_MODIS = False
# Fixed pre-drift unit (era factors tied to S-NPP). Off by default: on Portuguese regions (blocked 4-fold,
# 2012-2019) it was not better than v2 and was worse in small, quiet regions. See docs/harmonization.md.
ANCHOR_UNIT = False
_Z = v2._Z


# ----------------------------------------------------------------------------------------------
# Cleaning: QA, MODIS duplicates, small-fire flag
# ----------------------------------------------------------------------------------------------

def modis_duplicates(df: pd.DataFrame, fraction: float = DEDUPE_TRACK_FRACTION) -> pd.Series:
    """True for MODIS rows that repeat another detection of the same overpass (bow-tie overlap).

    Two detections of one platform with the same date and acquisition time are the same fire when they
    are closer than `fraction` x the smaller along-track pixel size. At nadir (track 1 km) genuine
    neighbours are 1 km apart and stay; at the swath edge (track up to ~2 km) overlapping scans collapse.
    The detection with the highest FRP is kept.
    """
    dup = np.zeros(len(df), dtype=bool)
    if not {"track", "acq_time", "platform"} <= set(df.columns) or not len(df):
        return pd.Series(dup, index=df.index)
    track = pd.to_numeric(df["track"], errors="coerce").to_numpy()
    is_modis = df.platform.isin(MODIS).to_numpy() & ~np.isnan(track)
    if is_modis.sum() < 2:
        return pd.Series(dup, index=df.index)
    lat, lon = df.latitude.to_numpy(float), df.longitude.to_numpy(float)
    frp = pd.to_numeric(df.frp, errors="coerce").fillna(0).to_numpy()
    day = df.acq_date.astype(str).to_numpy() if "acq_date" in df else df.date.astype(str).to_numpy()
    key = pd.Series(df.platform.astype(str).to_numpy() + "|" + day + "|" + df.acq_time.astype(str).to_numpy())
    rows_m = np.flatnonzero(is_modis)
    for _, rows in pd.Series(rows_m).groupby(key.to_numpy()[rows_m]):
        rows = rows.to_numpy()
        if len(rows) < 2:
            continue
        parent = {int(r): int(r) for r in rows}

        def find(r: int) -> int:
            while parent[r] != r:
                parent[r] = parent[parent[r]]
                r = parent[r]
            return r

        buckets: dict[tuple[int, int], list[int]] = {}
        for r in rows:
            buckets.setdefault((math.floor(lat[r] * 100), math.floor(lon[r] * 100)), []).append(int(r))
        for r in rows:
            gy, gx = math.floor(lat[r] * 100), math.floor(lon[r] * 100)
            kx = 111.2 * math.cos(math.radians(lat[r]))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    for q in buckets.get((gy + dy, gx + dx), ()):
                        if q <= r:
                            continue
                        dist = math.hypot((lat[q] - lat[r]) * 111.2, (lon[q] - lon[r]) * kx)
                        if dist < fraction * min(track[r], track[q]):
                            parent[find(q)] = find(int(r))
        groups: dict[int, list[int]] = {}
        for r in rows:
            groups.setdefault(find(int(r)), []).append(int(r))
        for members in groups.values():
            if len(members) > 1:
                keep = max(members, key=lambda m: frp[m])
                dup[[m for m in members if m != keep]] = True
    return pd.Series(dup, index=df.index)


def small_flag(df: pd.DataFrame, thresholds: dict[str, float] | None = None) -> pd.Series:
    """True for VIIRS detections weaker than the small-fire threshold of their stratum (day / night)."""
    if not len(df) or "frp" not in df:
        return pd.Series(False, index=df.index)
    thr = thresholds or SMALL_FRP_MW
    stratum = df["stratum"] if "stratum" in df else pd.Series(0, index=df.index)
    limit = np.where(stratum.to_numpy() == 1, thr["N"], thr["D"])
    frp = pd.to_numeric(df.frp, errors="coerce").to_numpy()
    return pd.Series(df.platform.isin(VIIRS).to_numpy() & (frp < limit), index=df.index)


def flag_quality(df: pd.DataFrame, static: set[int] | None = None, dedupe: bool | None = None) -> pd.DataFrame:
    """v2 QA plus `small` (VIIRS small fire) and `dup` (MODIS bow-tie duplicate, excluded only if `dedupe`)."""
    out = v2.flag_quality(df, static)
    out["dup"] = modis_duplicates(out) if (DEDUPE_MODIS if dedupe is None else dedupe) else False
    out["qa_pass"] = out.qa_pass & ~out.dup
    out["small"] = small_flag(out)
    return out


def fit_small_thresholds(df: pd.DataFrame, years: tuple[int, int] = (2012, 2018)) -> dict[str, float]:
    """FRP threshold per stratum at which S-NPP detections above it match MODIS (Terra + Aqua) counts.

    Use it to refit `SMALL_FRP_MW` on another reference region; QA-passed rows only.
    """
    d = df[df.qa_pass & df.date.dt.year.between(*years)] if "qa_pass" in df else df[df.date.dt.year.between(*years)]
    out = {}
    for s, name in enumerate(STRATA):
        part = d[d.stratum == s]
        target = int(part.platform.isin(MODIS).sum())
        frp = np.sort(pd.to_numeric(part[part.platform == ANCHOR].frp, errors="coerce").dropna().to_numpy())[::-1]
        out[name] = float(frp[min(len(frp), max(target, 1)) - 1]) if len(frp) else SMALL_FRP_MW[name]
    return out


# ----------------------------------------------------------------------------------------------
# Cube
# ----------------------------------------------------------------------------------------------

@dataclass
class Cube(v2.Cube):
    small_s: np.ndarray | None = None   # [platform, stratum, cell, month] VIIRS small-fire detections


def _cells_of(lat: np.ndarray, lon: np.ndarray, res: int) -> np.ndarray:
    """H3 cell per detection, computed once per distinct coordinate pair."""
    pairs = pd.DataFrame({"lat": lat, "lon": lon})
    uniq = pairs.drop_duplicates().copy()
    uniq["cell"] = [h3.latlng_to_cell(a, b, res) for a, b in zip(uniq.lat.to_numpy(), uniq.lon.to_numpy())]
    return pairs.merge(uniq, on=["lat", "lon"], how="left").cell.to_numpy()


def _month_index(dates: pd.Series, months: pd.PeriodIndex) -> np.ndarray:
    return (dates.dt.year.to_numpy() - months[0].year) * 12 + dates.dt.month.to_numpy() - months[0].month


def build_cube(df: pd.DataFrame, avail: Availability, h3_res: int) -> Cube:
    """Bin detections to platform x stratum x H3 cell x month, plus the small-fire counts."""
    if "stratum" not in df:
        df = df.assign(stratum=0)
    if "frp_pct" not in df:
        df = df.assign(frp_pct=0.5)
    if "small" not in df:
        df = df.assign(small=small_flag(df))
    months = pd.period_range(min(avail.first.values()), avail.horizon, freq="M")
    cell_of = _cells_of(df.latitude.to_numpy(float), df.longitude.to_numpy(float), h3_res) if len(df) else np.array([])
    cells = sorted(set(cell_of.tolist()))
    cell_idx = {c: i for i, c in enumerate(cells)}
    p_idx = df.platform.map({p: i for i, p in enumerate(PLATFORMS)}).fillna(-1).to_numpy(dtype=np.int64)
    s_idx = df.stratum.to_numpy(dtype=np.int64)
    c_idx = np.fromiter((cell_idx[c] for c in cell_of), dtype=np.int64, count=len(cell_of))
    m_idx = _month_index(df.date, months).astype(np.int64) if len(df) else np.empty(0, dtype=np.int64)
    inside = (p_idx >= 0) & (m_idx >= 0) & (m_idx < len(months))
    shape = (len(PLATFORMS), len(STRATA), len(cells), len(months))
    counts, pct_sum, small = np.zeros(shape), np.zeros(shape), np.zeros(shape)
    if inside.any():
        at = (p_idx[inside], s_idx[inside], c_idx[inside], m_idx[inside])
        np.add.at(counts, at, 1)
        np.add.at(pct_sum, at, df.frp_pct.to_numpy(dtype=float)[inside])
        np.add.at(small, at, df.small.to_numpy(dtype=float)[inside])

    units = {}
    if inside.any():
        dday = df.date.to_numpy()[inside].astype("datetime64[D]").astype(np.int64)
        u = pd.DataFrame({"s": s_idx[inside], "c": c_idx[inside], "t": m_idx[inside], "d": dday}).value_counts().reset_index(name="n")
        units = {k: u[k].to_numpy() for k in ("s", "c", "t", "n")}

    exposure = np.zeros((len(PLATFORMS), len(months)))
    for i, p in enumerate(PLATFORMS):
        if p not in avail.first:
            continue
        last = avail.horizon if avail.last.get(p) is None else min(avail.last[p], avail.horizon)
        for t, month in enumerate(months):
            start, end = max(month.start_time, avail.first[p]), min(month.end_time.normalize(), last)
            exposure[i, t] = max(0, (end - start).days + 1) / month.days_in_month
        for d in avail.outages.get(p, []):
            if avail.first[p] <= d <= last:
                t = (d.year - months[0].year) * 12 + d.month - months[0].month
                if 0 <= t < len(months):
                    exposure[i, t] = max(0.0, exposure[i, t] - 1 / months[t].days_in_month)
    observed = np.ones(len(months))
    observed[-1] = min(1.0, avail.horizon.day / months[-1].days_in_month)
    return Cube(counts, exposure, cells, months, months.month.to_numpy() - 1, months.year.to_numpy(), observed,
                pct_sum, units, small)


def small_layer(cube: Cube) -> np.ndarray:
    """[cell, month] small-fire detections per operating VIIRS satellite (NaN without VIIRS).

    Divided by the VIIRS sensing time, so a satellite joining does not grow the layer by itself.
    """
    idx = [PLATFORMS.index(p) for p in VIIRS]
    exposure = cube.exposure[idx].sum(axis=0)
    if cube.small_s is None:
        return np.full((len(cube.cells), len(cube.months)), np.nan)
    small = cube.small_s[idx].sum(axis=(0, 1))
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(exposure[None, :] > 0, small / exposure[None, :], np.nan) * cube.observed[None, :]


# ----------------------------------------------------------------------------------------------
# Efficiency model with a fixed unit
# ----------------------------------------------------------------------------------------------

def _anchored_era_factors(cube: Cube, model: v2.EfficiencyModel, fit_months: np.ndarray | None) -> np.ndarray:
    """[platform, stratum, era] factors that tie every era to the anchor and the unit to pre-drift MODIS.

    In era r the anchor's counts, scaled by the base efficiency ratio, predict what platform p should
    report; the shrunk ratio of observed to predicted is p's factor in that era (the anchor's is 1).
    The base efficiencies are fitted on all overlap months, so they carry the average MODIS level of
    the record. Dividing every factor by the combined Terra + Aqua factor of the first era moves the
    unit to MODIS as seen before its orbits drifted, while every platform keeps its relative shape.
    """
    a = PLATFORMS.index(ANCHOR)
    full = cube.exposure >= 0.999
    fit = np.ones(len(cube.months), dtype=bool) if fit_months is None else fit_months
    era = cube.era
    n_p, n_s, n_era = len(PLATFORMS), len(STRATA), len(ERA_BREAKS) + 1
    factor = np.ones((n_p, n_s, n_era))
    modis_obs, modis_exp = np.zeros(n_s), np.zeros(n_s)
    for s in range(n_s):
        base_a = model.base[a, s][:, cube.cal_month]
        for p in range(n_p):
            if p == a:
                continue
            with np.errstate(divide="ignore", invalid="ignore"):
                ratio = model.base[p, s][:, cube.cal_month] / np.where(base_a > 0, base_a, np.nan)
            k = KAPPA_ERA * float(np.nanmean(model.regional[p, s]))
            has = [False] * n_era
            for r in range(n_era):
                sel = full[p] & full[a] & fit & (era == r)
                if not sel.any():
                    continue
                obs = float(cube.counts_s[p, s][:, sel].sum())
                exp = float(np.nansum(cube.counts_s[a, s][:, sel] * ratio[:, sel]))
                factor[p, s, r] = (obs + k) / (exp + k)
                has[r] = True
                if r == 0 and PLATFORMS[p] in MODIS:
                    modis_obs[s] += obs
                    modis_exp[s] += exp
            for r in range(1, n_era):
                if not has[r] and has[r - 1]:
                    factor[p, s, r] = factor[p, s, r - 1]
                    has[r] = True
    for s in range(n_s):  # unit: MODIS before the drift (its first-era factor becomes 1)
        if modis_exp[s] > 0 and modis_obs[s] > 0:
            factor[:, s, :] /= modis_obs[s] / modis_exp[s]
    return factor


def _calibration_rel_var(cube: Cube, model: v2.EfficiencyModel, fit_months: np.ndarray | None) -> np.ndarray:
    """[platform, stratum, cell] relative variance of the shrunk cell efficiency (Gamma-posterior shape)."""
    full, modis_full = v2._overlap(cube, fit_months)
    out = np.zeros((len(PLATFORMS), len(STRATA), len(cube.cells)))
    for p in range(len(PLATFORMS)):
        ref = modis_full & full[p]
        for s in range(len(STRATA)):
            n = cube.counts_s[p, s][:, ref].sum(axis=1)
            out[p, s] = 1.0 / (n + KAPPA_CELL * float(np.nanmean(model.regional[p, s])) + 1.0)
    return out


def fit_efficiency(cube: Cube, fit_months: np.ndarray | None = None, prior: dict[str, float] | None = None,
                   calibrate: bool = True, anchor: bool | None = None) -> tuple[v2.EfficiencyModel, np.ndarray, dict]:
    """Base efficiencies on the pre-drift era, era factors tied to the anchor, no intensity factors.

    Same return shape as v1/v2: (model, regional efficiency [platform, 12], calibration summary).
    With `calibrate`, the interval multiplier `model.z` comes from the blocked k-fold residuals.
    """
    anchor = ANCHOR_UNIT if anchor is None else anchor
    _, modis_full = v2._overlap(cube, fit_months)
    fm = fit_months
    model, _, summary = v2.fit_efficiency(cube, fit_months=fm, prior=prior)  # the count engine is v2's
    model.anchor = anchor
    if anchor:  # experimental: unit fixed to pre-drift MODIS through the anchor platform
        model.frp_factor[:] = 1.0
        model.era_factor = _anchored_era_factors(cube, model, fit_months)
        model.phi = v2._dispersion(cube, model, modis_full)
    model.rel_var = _calibration_rel_var(cube, model, fm)
    model.z = _Z
    if calibrate:
        model.z = interval_multiplier(cube, anchor=anchor)
    regional = (model.regional * model.stratum_weight[None, :, None]).sum(axis=1)

    era_names = [v2._era_name(r) for r in range(len(ERA_BREAKS) + 1)]
    for p, name in enumerate(PLATFORMS):
        if name in summary and anchor:
            summary[name]["eraFactors"] = {era_names[r]: [round(float(model.era_factor[p, s, r]), 3) for s in range(len(STRATA))]
                                           for r in range(len(era_names))}
            summary[name].pop("frpFactors", None)
    summary["model"] = {
        "version": VERSION, "anchor": ANCHOR if anchor else None, "countEngine": "v2" + (" + anchored unit" if anchor else ""),
        "unit": (f"MODIS (Terra + Aqua) hot spots as seen before {ANCHOR_ERA_END}" if anchor else
                 "MODIS (Terra + Aqua) hot spots of the same month") + ", vegetation fires",
        "dispersionPhi": round(float(model.phi), 3), "intervalMultiplier": round(float(model.z), 3),
        "smallFrpMw": SMALL_FRP_MW, "strata": list(STRATA), "eraBreaks": list(ERA_BREAKS),
    }
    return model, regional, summary


# ----------------------------------------------------------------------------------------------
# Harmonization, intervals, weights
# ----------------------------------------------------------------------------------------------

def harmonize_full(cube: Cube, model: v2.EfficiencyModel, platforms: tuple[str, ...] = PLATFORMS) -> HarmonizedResult:
    """H = sum over strata of seen_s / power_s; sd adds the efficiency (calibration) variance.

    `lo` / `hi` widen the per-stratum Garwood bounds by `model.z / 1.645` and add the calibration term,
    so a cell-month without detections still has a finite upper bound.
    """
    n_s, n_c, n_t = len(STRATA), len(cube.cells), len(cube.months)
    cls = v2.intensity_class(cube, model.thresholds, platforms)  # factors are 1 when anchored
    rel_var = getattr(model, "rel_var", np.zeros((len(PLATFORMS), n_s, n_c)))
    z = float(getattr(model, "z", _Z))
    seen, power = np.zeros((n_s, n_c, n_t)), np.zeros((n_s, n_c, n_t))
    cal = np.zeros((n_s, n_c, n_t))
    power_regional = np.zeros(n_t)
    for name in platforms:
        p = PLATFORMS.index(name)
        for s in range(n_s):
            part = model.efficiency(cube, p, s, cls) * cube.exposure[p][None, :]
            seen[s] += cube.counts_s[p, s]
            power[s] += part
            cal[s] += part ** 2 * rel_var[p, s][:, None]
            power_regional += model.regional[p, s][cube.cal_month] * model.era_factor[p, s, cube.era] * cube.exposure[p] * model.stratum_weight[s]
    valid = power_regional >= MIN_SENSING_POWER
    ok = valid[None, None, :] & (power > 0)
    phi = model.phi
    with np.errstate(divide="ignore", invalid="ignore"):
        h_s = np.where(ok, seen / power, np.nan)
        var_pois = np.where(ok, phi * seen / power ** 2, np.nan)
        var_cal = np.where(ok, h_s ** 2 * cal / power ** 2, np.nan)
        lo_g = np.where(ok, phi * v2._gamma_ppf(0.05, seen / phi) / power, np.nan)
        hi_g = np.where(ok, phi * v2._gamma_ppf(0.95, seen / phi + 1) / power, np.nan)
    any_ok = ok.any(axis=0)
    obs = cube.observed[None, :]
    values = np.where(any_ok, np.nansum(h_s, axis=0), np.nan) * obs
    sd = np.where(any_ok, np.sqrt(np.nansum(var_pois + var_cal, axis=0)), np.nan) * obs
    sd_cal = np.where(any_ok, np.sqrt(np.nansum(var_cal, axis=0)), np.nan) * obs
    scale = z / _Z
    down = (values - np.where(any_ok, np.nansum(lo_g, axis=0), np.nan) * obs) * scale
    up = (np.where(any_ok, np.nansum(hi_g, axis=0), np.nan) * obs - values) * scale
    lo = np.clip(values - np.sqrt(down ** 2 + (z * sd_cal) ** 2), 0, None)
    hi = values + np.sqrt(up ** 2 + (z * sd_cal) ** 2)
    return HarmonizedResult(values, sd, lo, hi, seen, power, valid, phi)


def harmonize(cube: Cube, eff: v2.EfficiencyModel, regional: np.ndarray | None = None,
              platforms: tuple[str, ...] = PLATFORMS) -> tuple[np.ndarray, np.ndarray]:
    """v1-compatible: (MODIS-equivalent hot spots [cell, month], sd).

    The sd is scaled by `z / 1.645`, so callers that build a 90 % band as value +- 1.645 x sd (as
    `service.py` does) get the calibrated interval without changes.
    """
    r = harmonize_full(cube, eff, platforms)
    return r.values, r.sd * float(getattr(eff, "z", _Z)) / _Z


def detection_weights(df: pd.DataFrame, cube: Cube, result: HarmonizedResult) -> pd.Series:
    """MODIS-equivalent weight of every row; the weights of a cell-month add up to `result.values` there.

    Rows outside the cube, rows that failed the QA, and months without enough sensing power weigh 0.
    """
    w = np.zeros(len(df))
    if not len(df) or not len(cube.cells):
        return pd.Series(w, index=df.index)
    res = h3.get_resolution(cube.cells[0])
    cell_idx = {c: i for i, c in enumerate(cube.cells)}
    c = pd.Series(_cells_of(df.latitude.to_numpy(float), df.longitude.to_numpy(float), res)).map(cell_idx).to_numpy()
    t = _month_index(df.date, cube.months)
    s = df.stratum.to_numpy().astype(int) if "stratum" in df else np.zeros(len(df), dtype=int)
    ok = ~pd.isna(c) & (t >= 0) & (t < len(cube.months))
    if "qa_pass" in df:
        ok &= df.qa_pass.to_numpy().astype(bool)
    ci, ti, si = c[ok].astype(int), t[ok], s[ok]
    power = result.power[si, ci, ti]
    good = (power > 0) & result.valid[ti]
    w[np.flatnonzero(ok)[good]] = cube.observed[ti[good]] / power[good]
    return pd.Series(w, index=df.index)


def extras(cube: Cube, model: v2.EfficiencyModel, df: pd.DataFrame) -> dict:
    """What `service.py` adds to the payload and the CSV when v3 is active."""
    result = harmonize_full(cube, model)
    return {"weights": detection_weights(df, cube, result), "smallFires": small_layer(cube), "result": result}


# ----------------------------------------------------------------------------------------------
# Calendar statistics
# ----------------------------------------------------------------------------------------------

def median_stats(values: np.ndarray, cal_month: np.ndarray, complete: np.ndarray,
                 lo: np.ndarray | None = None, hi: np.ndarray | None = None) -> dict:
    """Median of the same calendar month in the other years, % of it, and whether the interval contains it.

    Returns {"median": [12] over all complete years, "otherYearsMedian": [t], "pctOfMedian": [t],
    "withinNormal": [t] (1.0 / 0.0, NaN without interval or median)}.
    """
    n = len(values)
    other_med, pct, within = np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
    month_median = np.full(12, np.nan)
    for m in range(12):
        idx = np.flatnonzero((cal_month == m) & ~np.isnan(values) & complete)
        if not len(idx):
            continue
        month_median[m] = float(np.median(values[idx]))
        if len(idx) < 3:
            continue
        for i in np.flatnonzero((cal_month == m) & ~np.isnan(values)):
            med = float(np.median(values[idx[idx != i]]))
            other_med[i] = med
            pct[i] = 100 * values[i] / med if med > 0 else np.nan
            if lo is not None and hi is not None and not np.isnan(lo[i]) and not np.isnan(hi[i]):
                within[i] = float(lo[i] <= med <= hi[i])
    return {"median": month_median, "otherYearsMedian": other_med, "pctOfMedian": pct, "withinNormal": within}


# ----------------------------------------------------------------------------------------------
# Seam test against an independent witness (burned area)
# ----------------------------------------------------------------------------------------------

# Months when a satellite joined the record: the seams a harmonized series must not show.
SEAMS = {p: f"{pd.Timestamp(d):%Y-%m}" for p, d in DEFAULT_FIRST_DAY.items() if p != "TERRA"}
SEAM_Z = 2.0                # |t| of a step at or above this is a seam
SEAM_MIN_DOF = 5            # residual degrees of freedom needed for a verdict
SEAM_MIN_BLOCKS_PER_SIDE = 2  # 12-month blocks needed on each side of the seam for a verdict


def _pct(log_ratio: float) -> float | None:
    return None if math.isnan(log_ratio) else round(100 * math.expm1(log_ratio), 1)


def _seam_fit(values: np.ndarray, witness: np.ndarray, seam_pos: list[int], t: int) -> dict:
    """OLS on 12-month blocks aligned at month t: log(series) = a + beta log(witness) + sum_k gamma_k after_k."""
    rows = []
    for a in range(t % 12, len(values) - 11, 12):
        b = a + 12
        h, w = values[a:b], witness[a:b]
        if np.isnan(h).any() or np.isnan(w).any() or h.sum() <= 0 or w.sum() <= 0:
            continue
        rows.append([math.log(h.sum()), 1.0, math.log(w.sum())] + [max(0, b - max(a, s)) / 12 for s in seam_pos])
    nan = {"gamma": math.nan, "se": math.nan, "beta": math.nan, "sd": math.nan, "n": len(rows), "before": 0, "after": 0, "dof": 0}
    if not rows:
        return nan
    data = np.array(rows)
    y, X = data[:, 0], data[:, 1:]
    tested = 2 + seam_pos.index(t)
    nan.update(before=int((X[:, tested] == 0).sum()), after=int((X[:, tested] == 1).sum()))
    cols = [0, 1] + [c for c in range(2, X.shape[1]) if X[:, c].std() > 0]     # seams outside this record drop out
    if tested not in cols:
        return nan
    X = X[:, cols]
    dof = len(y) - X.shape[1]
    if dof < 1 or np.linalg.matrix_rank(X) < X.shape[1]:
        return nan
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coef
    s2 = float(resid @ resid) / dof
    se = np.sqrt(np.maximum(np.diag(s2 * np.linalg.inv(X.T @ X)), 0))
    k = cols.index(tested)
    return {**nan, "gamma": float(coef[k]), "se": float(se[k]), "beta": float(coef[1]), "sd": math.sqrt(s2), "dof": dof}


def seam_test(months, series: dict[str, np.ndarray], witness: np.ndarray, seams: dict[str, str] | None = None,
              witness_name: str = "witness") -> dict:
    """Does a series step, relative to an independent witness, when a satellite joins?

    The witness is burned area: mapped from surface reflectance by one sensor family, so it does not change
    when VIIRS joins the hot-spot record. For each seam the record is cut into 12-month blocks starting at the
    seam's calendar month and fitted by least squares:

        log(hot spots in block) = a + beta * log(burned area in block) + sum over seams k of gamma_k * after_k

    after_k is the share of the block's months on or after seam k (0 or 1 for the tested seam, a fraction for
    others). beta (about 0.5 on Iberia: a megafire year burns far more area per hot spot) absorbs real changes
    in fire activity, so gamma of the tested seam is the step the satellite change left in the series, and
    its t = gamma / se says whether that step stands out from the year-to-year noise of the hot-spot /
    burned-area relationship. All seams are fitted together, so one seam does not leak into another.

    months   monthly periods (PeriodIndex or "YYYY-MM" strings) shared by `series` and `witness`
    series   name -> monthly values; NaN for months that are missing or incomplete
    witness  monthly witness values (for example burned km2), NaN when missing

    Returns {"witness", "method", "tThreshold", "rows": [...]} with one row per seam and series: seam, month,
    series, stepPct, ci95Pct [low, high] (gamma +- 2 se), t, blocks, blocksBefore, blocksAfter, elasticity
    (beta), residualSdPct, minDetectablePct (smallest step this record can tell from noise) and verdict:
    "noSeam", "seamUp", "seamDown" or "insufficient" (too few blocks on a side or too few degrees of freedom).
    """
    idx = pd.PeriodIndex(months, freq="M")
    seams = SEAMS if seams is None else seams
    pos = {name: (pd.Period(m, "M") - idx[0]).n for name, m in seams.items()}
    seam_pos = list(pos.values())
    witness = np.asarray(witness, float)
    rows = []
    for name, t in sorted(pos.items(), key=lambda kv: kv[1]):
        if not 0 < t < len(idx):
            continue
        for label, values in series.items():
            fit = _seam_fit(np.asarray(values, float), witness, seam_pos, t)
            g, se = fit["gamma"], fit["se"]
            tstat = math.nan if math.isnan(g) else (g / se if se > 1e-12 else 0.0)
            enough = (fit["dof"] >= SEAM_MIN_DOF and min(fit["before"], fit["after"]) >= SEAM_MIN_BLOCKS_PER_SIDE
                      and not math.isnan(tstat))
            verdict = "insufficient" if not enough else (
                "noSeam" if abs(tstat) < SEAM_Z else ("seamUp" if tstat > 0 else "seamDown"))
            rows.append({"seam": name, "month": str(idx[t]), "series": label, "stepPct": _pct(g),
                         "ci95Pct": None if math.isnan(g) else [_pct(g - 2 * se), _pct(g + 2 * se)],
                         "t": None if math.isnan(tstat) else round(tstat, 2), "blocks": fit["n"],
                         "blocksBefore": fit["before"], "blocksAfter": fit["after"],
                         "elasticity": None if math.isnan(fit["beta"]) else round(fit["beta"], 3),
                         "residualSdPct": _pct(fit["sd"]), "minDetectablePct": _pct(SEAM_Z * se), "verdict": verdict})
    return {"witness": witness_name, "method": "log-log regression on 12-month blocks with a step per seam",
            "tThreshold": SEAM_Z, "rows": rows}


# ----------------------------------------------------------------------------------------------
# Validation and interval calibration
# ----------------------------------------------------------------------------------------------

def _drift_corrected_modis(cube: Cube, model: v2.EfficiencyModel) -> np.ndarray:
    """[cell, month] MODIS counts in pre-drift units: each platform and stratum divided by its era factor."""
    out = np.zeros((len(cube.cells), len(cube.months)))
    for name in MODIS:
        p = PLATFORMS.index(name)
        for s in range(len(STRATA)):
            out += cube.counts_s[p, s] / model.era_factor[p, s, cube.era][None, :]
    return out


def _folds(cube: Cube, k: int = K_FOLDS, anchor: bool | None = None) -> dict | None:
    """Blocked k-fold over years, cached on the cube: VIIRS-only predictions of MODIS.

    In anchored mode MODIS is converted to pre-drift units with the fold's era factors.
    """
    anchor = ANCHOR_UNIT if anchor is None else anchor
    cache = cube.__dict__.setdefault("_v3_folds", {})
    key = (k, anchor)
    if key in cache:
        return cache[key]
    full, modis_full = v2._overlap(cube, None)
    viirs_any = cube.exposure[[PLATFORMS.index(p) for p in VIIRS]].max(axis=0) >= 0.999
    test_all = modis_full & viirs_any
    raw_modis = cube.counts[PLATFORMS.index("TERRA")] + cube.counts[PLATFORMS.index("AQUA")]
    if raw_modis[:, test_all].sum() < MIN_TEST_HOTSPOTS:
        cache[key] = None
        return None
    test_years = np.unique(cube.years[test_all])
    kk = min(k, len(test_years))
    if kk < 2:
        cache[key] = None
        return None
    fold_of_year = {int(y): i % kk for i, y in enumerate(test_years)}
    fold = np.array([fold_of_year.get(int(y), -1) for y in cube.years])
    truth = np.full(raw_modis.shape, np.nan)
    pred, pred_sd = np.full(raw_modis.shape, np.nan), np.full(raw_modis.shape, np.nan)
    phis = []
    for f in range(kk):
        train = fold != f
        test = test_all & (fold == f)
        model, _, _ = fit_efficiency(cube, fit_months=train, prior=v2._training_prior(cube, train), calibrate=False, anchor=anchor)
        res = harmonize_full(cube, model, platforms=VIIRS)
        truth[:, test] = (_drift_corrected_modis(cube, model) if anchor else raw_modis)[:, test]
        pred[:, test], pred_sd[:, test] = res.values[:, test], res.sd[:, test]
        phis.append(model.phi)
    out = {"k": kk, "test": test_all, "truth": truth, "pred": pred, "pred_sd": pred_sd, "phi": float(np.mean(phis))}
    cache[key] = out
    return out


def _monthly(folds: dict, sel: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    truth = np.nansum(folds["truth"][:, sel], axis=0)
    est = np.nansum(folds["pred"][:, sel], axis=0)
    var = np.nansum(folds["pred_sd"][:, sel] ** 2, axis=0) + folds["phi"] * np.maximum(est, 0)
    return truth, est, var


def interval_multiplier(cube: Cube, k: int = K_FOLDS, level: float = LEVEL, anchor: bool | None = None) -> float:
    """Multiplier of the sd that makes the k-fold monthly intervals cover `level` (never below 1.645)."""
    folds = _folds(cube, k, anchor)
    if folds is None:
        return _Z
    truth, est, var = _monthly(folds, folds["test"])
    use = (truth > 0) & (var > 0)
    if use.sum() < 10:
        return _Z
    r = np.abs(truth[use] - est[use]) / np.sqrt(var[use])
    return float(max(_Z, np.quantile(r, level)))


def validate(cube: Cube, k: int = K_FOLDS, anchor: bool | None = None) -> dict | None:
    """Blocked k-fold over years (refit on the other years, prior included); VIIRS alone predicts MODIS.

    MODIS is converted to pre-drift units with the fold's era factors, so the score measures the
    harmonization and not the MODIS orbit drift. Also reports the small-fire threshold layer against
    MODIS year by year.
    """
    folds = _folds(cube, k, anchor)
    if folds is None:
        return None
    z = interval_multiplier(cube, k, anchor=anchor)

    def score(sel: np.ndarray) -> dict | None:
        truth, est, var = _monthly(folds, sel)
        if truth.sum() < MIN_TEST_HOTSPOTS:
            return None
        busy = truth >= 50
        cell_truth = np.nansum(folds["truth"][:, sel], axis=1)
        cell_est = np.nansum(folds["pred"][:, sel], axis=1)
        busy_cells = cell_truth >= 20
        return {
            "months": int(sel.sum()), "modisHotspots": round(float(truth.sum()), 1), "viirsOnlyEstimate": round(float(est.sum()), 1),
            "totalBiasPct": round(100 * (est.sum() / truth.sum() - 1), 2),
            "monthlyPearsonR": round(float(np.corrcoef(truth, est)[0, 1]), 4) if sel.sum() > 2 else None,
            "monthlyMedianAbsErrorPct": round(float(np.median(np.abs(est[busy] / truth[busy] - 1)) * 100), 1) if busy.any() else None,
            "interval90CoverageUncalibrated": round(float(np.mean(np.abs(truth - est) <= _Z * np.sqrt(var))), 3),
            "interval90Coverage": round(float(np.mean(np.abs(truth - est) <= z * np.sqrt(var))), 3),
            "cellPearsonR": round(float(np.corrcoef(cell_truth[busy_cells], cell_est[busy_cells])[0, 1]), 4) if busy_cells.sum() > 2 else None,
        }

    eras = {"2012-2019": (2012, 2019), "2020-2022": (2020, 2022), "2023+": (2023, 2100)}
    test = folds["test"]
    out = {
        "design": f"blocked {folds['k']}-fold over years; each fold refits efficiencies and the prior on the other years "
                  "and predicts " + ("drift-corrected " if (ANCHOR_UNIT if anchor is None else anchor) else "") + "MODIS from VIIRS alone",
        "dispersionPhi": round(folds["phi"], 3), "intervalMultiplier": round(z, 3),
        "intervalNote": "the multiplier is calibrated on these folds, so the calibrated coverage is in-sample",
        "allTestYears": score(test),
        "byEra": {name: score(test & (cube.years >= a) & (cube.years <= b)) for name, (a, b) in eras.items()},
    }
    out["thresholdLayer"] = _threshold_layer_report(cube)
    return out


def _threshold_layer_report(cube: Cube) -> dict | None:
    """How far "anchor VIIRS detections above the small-fire threshold" is from raw MODIS, year by year."""
    if cube.small_s is None:
        return None
    a = PLATFORMS.index(ANCHOR)
    full = cube.exposure >= 0.999
    sel = full[PLATFORMS.index("TERRA")] & full[PLATFORMS.index("AQUA")] & full[a]
    if not sel.any():
        return None
    big = (cube.counts_s[a] - cube.small_s[a]).sum(axis=(0, 1))
    modis = (cube.counts_s[PLATFORMS.index("TERRA")] + cube.counts_s[PLATFORMS.index("AQUA")]).sum(axis=(0, 1))
    if modis[sel].sum() < MIN_TEST_HOTSPOTS:
        return None
    by_year = {}
    for y in np.unique(cube.years[sel]):
        m = sel & (cube.years == y)
        if modis[m].sum() > 0:
            by_year[int(y)] = round(float(big[m].sum() / modis[m].sum()), 3)
    busy = sel & (modis >= 50)
    return {
        "thresholdsMw": SMALL_FRP_MW,
        "totalRatio": round(float(big[sel].sum() / modis[sel].sum()), 3),
        "byYear": by_year,
        "monthlyMedianAbsErrorPct": round(float(np.median(np.abs(big[busy] / modis[busy] - 1)) * 100), 1) if busy.any() else None,
        "note": "explanatory layer only; the official harmonized count comes from the efficiency model",
    }
