"""Harmonization v2: MODIS + VIIRS hot spots in MODIS-equivalent units, with a richer efficiency model.

Drop-in alternative to `harmonization.py` (same public functions, same call pattern in `service.py`):

    import backend.harmonization2 as hz

The estimator is the same Poisson maximum-likelihood idea as v1 (harmonized activity = hot spots seen /
sensing power in orbit), with these changes:

Efficiency model
  * Day / night strata. Every detection is in the day or the night stratum (`daynight`, or solar time
    when the column is missing). Each stratum has its own efficiencies and its own latent activity,
    and the harmonized value is their sum. VIIRS (01:30 / 13:30) and Terra (10:30 / 22:30) see a very
    different share of night burning, so a change in the day/night mix no longer moves the series.
  * Time-varying efficiency. A multiplicative factor per era (`ERA_BREAKS`, by default <2020,
    2020-2022 Terra orbit drift, 2023+ Aqua drift and NOAA-21) is shrunk towards 1 with `KAPPA_ERA`.
    An era without MODIS overlap (after MODIS ends) inherits the factor of the last era that had one.
  * Intensity classes. Every detection gets the percentile of its FRP within its sensor family
    (MODIS or VIIRS), so the two sensors are comparable. A cell-month-stratum gets the mean percentile
    of its VIIRS detections (or of its MODIS detections when VIIRS saw nothing) and falls into one of
    `N_FRP_CLASSES` classes. A factor per class, shrunk towards 1 with `KAPPA_FRP`, corrects the
    VIIRS/MODIS ratio for fire size: VIIRS (375 m) sees small fires MODIS (1 km) misses.

    e[p, s, cell, month] = base[p, s, cell, calendar month] * era[p, s, era(month)] * frp[p, s, class]

Uncertainty
  * Overdispersion: a quasi-Poisson factor `phi` (Pearson chi^2 of the platforms against the fitted
    model on the overlap months, at least 1) widens every interval. Hot spots come in clusters, so
    pure Poisson intervals are too narrow.
  * Intervals at zero: `HarmonizedResult.lo/hi` are Garwood (exact Poisson) 90 % bounds per stratum,
    so a cell-month without detections has a finite upper bound instead of a zero-width interval.
  * `bootstrap_interval` resamples fire-days (cell x day x stratum) with Poisson weights, for the
    regional monthly series. Slower than quasi-Poisson, but it does not assume a variance model.

Input data
  * Satellite outages: `detect_outages` finds days when a platform reported nothing while the others
    reported enough that it should have; those days are taken out of the exposure. Run it on a large
    region (it is part of `Availability.from_data`), not on a small bounding box.
  * Static heat sources: `static_pixels` can be computed on the whole cached region and passed to
    `flag_quality`; the mask is dilated by one 0.01 degree pixel, because near-real-time positions of
    the same source jitter between neighbouring pixels.

Statistics and validation
  * `calendar_stats` is leave-one-out and log-consistent: a month is compared with the same calendar
    month in the *other* years, on log(1 + value). The climatology is returned on the same scale.
  * `validate` is a blocked k-fold over years (`K_FOLDS`). Each fold refits everything on the other
    years, including the prior, so the Iberian `PRIOR_EFFICIENCY` does not leak into the score. It also
    reports the coverage of the 90 % interval and a cell-level correlation.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .harmonization import (  # noqa: F401 – re-exported so this module is a drop-in replacement
    DEFAULT_FIRST_DAY,
    MAX_CELLS,
    MIN_SENSING_POWER,
    MIN_TEST_HOTSPOTS,
    MODIS,
    MODIS_MIN_CONFIDENCE,
    PLATFORMS,
    PRIOR_EFFICIENCY,
    SATELLITE_TO_PLATFORM,
    STATIC_MIN_DETECTIONS,
    VIIRS,
)
from .harmonization import normalize as _normalize_v1

import h3


def pick_h3_resolution(bbox: tuple[float, float, float, float]) -> int:
    """Finest H3 resolution from 2 to 7 that keeps the bounding box under MAX_CELLS cells."""
    w, s, e, n = bbox
    area_km2 = (e - w) * 111.32 * math.cos(math.radians((s + n) / 2)) * (n - s) * 110.57
    for res in (7, 6, 5, 4, 3):
        if area_km2 / h3.average_hexagon_area(res, unit="km^2") <= MAX_CELLS:
            return res
    return 2

STRATA = ("D", "N")
ERA_BREAKS = (2020, 2023)      # eras: [..2019], [2020..2022], [2023..]
N_FRP_CLASSES = 3
KAPPA_CELL = 50                # shrinkage of a cell towards its region, in MODIS hot spots
KAPPA_MONTH = 30               # shrinkage of a calendar month towards the whole year
KAPPA_REGION = 200             # shrinkage of the region towards the prior
KAPPA_ERA = 300                # shrinkage of an era factor towards 1, in MODIS hot spots
KAPPA_FRP = 300                # shrinkage of an intensity-class factor towards 1, in MODIS hot spots
STATIC_DILATE = 1              # static-source mask grows by this many 0.01 degree pixels
OUTAGE_MIN_EXPECTED = 25       # a silent day is an outage only if the platform should have seen this many
K_FOLDS = 4
LEVEL = 0.90
_Z = 1.6448536269514722        # standard normal quantile for a two-sided 90 % interval


# ----------------------------------------------------------------------------------------------
# Cleaning
# ----------------------------------------------------------------------------------------------

def normalize(df: pd.DataFrame) -> pd.DataFrame:
    """v1 normalization plus a `stratum` column (0 day, 1 night)."""
    df = _normalize_v1(df)
    dn = df["daynight"].astype(str).str.strip().str.upper().str[:1] if "daynight" in df else pd.Series("", index=df.index)
    # solar time where FIRMS did not say: UTC hour + longitude / 15
    hour = df.acq_time.str[:2].astype(int) + df.acq_time.str[2:].astype(int) / 60
    solar = (hour + df.longitude / 15) % 24
    inferred = np.where((solar >= 6) & (solar < 18), "D", "N")
    df["stratum"] = np.where(dn.isin(["D", "N"]), dn, inferred)
    df["stratum"] = (df["stratum"] == "N").astype(np.int8)
    return df


def _pixel(lat: pd.Series, lon: pd.Series) -> pd.Series:
    return (np.round(lat * 100).astype(np.int64) + 9000) * 100000 + (np.round(lon * 100).astype(np.int64) + 18000)


def static_pixels(df: pd.DataFrame, dilate: int = STATIC_DILATE) -> set[int]:
    """0.01 degree pixels of static heat sources (type 1/2/3 at least STATIC_MIN_DETECTIONS times), dilated.

    Compute it on the largest frame available (the whole cached region) and pass it to `flag_quality`.
    """
    pixel = _pixel(df.latitude, df.longitude)
    counts = pixel[df.type.isin([1, 2, 3])].value_counts()
    core = counts[counts >= STATIC_MIN_DETECTIONS].index.to_numpy()
    if not len(core) or dilate <= 0:
        return set(core.tolist())
    offsets = np.array([dl * 100000 + dn for dl in range(-dilate, dilate + 1) for dn in range(-dilate, dilate + 1)])
    return set((core[:, None] + offsets[None, :]).ravel().tolist())


def flag_quality(df: pd.DataFrame, static: set[int] | None = None) -> pd.DataFrame:
    """Add `qa_pass` (as v1) and `frp_pct`, the FRP percentile within the sensor family.

    `static` is a precomputed `static_pixels` mask; by default it is computed from `df` itself.
    """
    is_modis = df.platform.isin(MODIS)
    modis_ok = pd.to_numeric(df.confidence, errors="coerce").fillna(100) >= MODIS_MIN_CONFIDENCE
    viirs_ok = ~df.confidence.str.lower().str.startswith("l")
    conf_ok = np.where(is_modis, modis_ok, viirs_ok)
    if static is None:
        static = static_pixels(df)
    pixel = _pixel(df.latitude, df.longitude)
    type_ok = (df.type == 0) | (df.type.isna() & ~pixel.isin(static))
    df = df.copy()
    df["qa_pass"] = conf_ok & type_ok
    family = np.where(is_modis, "MODIS", "VIIRS")
    df["frp_pct"] = df.groupby(family).frp.rank(pct=True).fillna(0.5)
    if "stratum" not in df:
        df["stratum"] = 0
    return df


# ----------------------------------------------------------------------------------------------
# Availability with outages
# ----------------------------------------------------------------------------------------------

def detect_outages(df: pd.DataFrame, first: dict[str, pd.Timestamp] | None = None,
                   last: dict[str, pd.Timestamp | None] | None = None,
                   min_expected: float = OUTAGE_MIN_EXPECTED) -> dict[str, list[pd.Timestamp]]:
    """Days when a platform reported nothing although the others imply it should have seen >= min_expected.

    The expectation scales each other platform's count by the ratio of prior efficiencies. Only
    meaningful on a large region: on a small bbox a busy day is rare and the test has no power.
    """
    daily = df.groupby(["date", "platform"]).size().unstack(fill_value=0).reindex(columns=list(PLATFORMS), fill_value=0)
    if daily.empty:
        return {}
    dates = daily.index
    first = first or {p: daily.index[daily[p] > 0].min() for p in PLATFORMS if (daily[p] > 0).any()}
    last = last or {}
    operating = {}
    for p in PLATFORMS:
        if p not in first or pd.isna(first[p]):
            continue
        end = last.get(p) or dates.max()
        operating[p] = (dates >= first[p]) & (dates <= end)
    out: dict[str, list[pd.Timestamp]] = {}
    for p, op in operating.items():
        others = [o for o in operating if o != p]
        if not others:
            continue
        num = sum(np.where(operating[o], daily[o].to_numpy(), 0) for o in others)
        den = sum(np.where(operating[o], PRIOR_EFFICIENCY[o], 0) for o in others)
        with np.errstate(divide="ignore", invalid="ignore"):
            expected = np.where(den > 0, PRIOR_EFFICIENCY[p] * num / den, 0)
        silent = op & (daily[p].to_numpy() == 0) & (expected >= min_expected)
        if silent.any():
            out[p] = list(dates[silent])
    return out


@dataclass
class Availability:
    """Operating period of each platform plus single-day outages inside it."""
    first: dict[str, pd.Timestamp]
    last: dict[str, pd.Timestamp | None]
    horizon: pd.Timestamp
    outages: dict[str, list[pd.Timestamp]] = field(default_factory=dict)

    @classmethod
    def default(cls, horizon: pd.Timestamp) -> "Availability":
        return cls({p: pd.Timestamp(d) for p, d in DEFAULT_FIRST_DAY.items()}, {p: None for p in PLATFORMS}, pd.Timestamp(horizon))

    @classmethod
    def from_data(cls, df: pd.DataFrame, find_outages: bool = True) -> "Availability":
        """First and last detection per platform and outage days. Only reliable for a large region."""
        horizon = df.date.max()
        first, last = {}, {}
        for p, dates in df.groupby("platform").date:
            first[p] = dates.min()
            last[p] = None if (horizon - dates.max()).days <= 10 else dates.max()
        outages = detect_outages(df, first, last) if find_outages else {}
        return cls(first, last, horizon, outages)

    def to_json(self) -> dict:
        return {"first": {p: f"{d:%Y-%m-%d}" for p, d in self.first.items()},
                "last": {p: None if d is None else f"{d:%Y-%m-%d}" for p, d in self.last.items()},
                "horizon": f"{self.horizon:%Y-%m-%d}",
                "outages": {p: [f"{d:%Y-%m-%d}" for d in days] for p, days in self.outages.items()}}

    @classmethod
    def from_json(cls, obj: dict) -> "Availability":
        return cls({p: pd.Timestamp(d) for p, d in obj["first"].items()},
                   {p: None if d is None else pd.Timestamp(d) for p, d in obj["last"].items()},
                   pd.Timestamp(obj["horizon"]),
                   {p: [pd.Timestamp(d) for d in days] for p, days in obj.get("outages", {}).items()})


# ----------------------------------------------------------------------------------------------
# Cube
# ----------------------------------------------------------------------------------------------

@dataclass
class Cube:
    counts_s: np.ndarray      # [platform, stratum, cell, month] QA-passed detections
    exposure: np.ndarray      # [platform, month] share of the month the platform was operating, 0..1
    cells: list[str]
    months: pd.PeriodIndex
    cal_month: np.ndarray     # [month] 0..11
    years: np.ndarray         # [month]
    observed: np.ndarray      # [month] share of the month inside the record; below 1 only for the current month
    pct_sum: np.ndarray       # [platform, stratum, cell, month] sum of FRP percentiles of the detections
    units: dict = field(default_factory=dict)  # fire-days for the bootstrap: arrays s, c, t, n

    @property
    def counts(self) -> np.ndarray:
        """[platform, cell, month], as in v1."""
        return self.counts_s.sum(axis=1)

    @property
    def era(self) -> np.ndarray:
        return np.searchsorted(np.array(ERA_BREAKS), self.years, side="right")


def build_cube(df: pd.DataFrame, avail: Availability, h3_res: int) -> Cube:
    """Bin QA-passed detections to platform x stratum x H3 cell x month."""
    if "stratum" not in df:
        df = df.assign(stratum=0)
    if "frp_pct" not in df:
        df = df.assign(frp_pct=0.5)
    months = pd.period_range(min(avail.first.values()), avail.horizon, freq="M")
    cell_of = [h3.latlng_to_cell(lat, lon, h3_res) for lat, lon in zip(df.latitude.to_numpy(), df.longitude.to_numpy())]
    cells = sorted(set(cell_of))
    cell_idx = {c: i for i, c in enumerate(cells)}
    p_idx = df.platform.map({p: i for i, p in enumerate(PLATFORMS)}).to_numpy()
    s_idx = df.stratum.to_numpy().astype(np.int64)
    c_idx = np.fromiter((cell_idx[c] for c in cell_of), dtype=np.int64, count=len(cell_of))
    m_idx = (df.date.dt.year.to_numpy() - months[0].year) * 12 + df.date.dt.month.to_numpy() - months[0].month
    inside = (m_idx >= 0) & (m_idx < len(months))
    shape = (len(PLATFORMS), len(STRATA), len(cells), len(months))
    counts, pct_sum = np.zeros(shape), np.zeros(shape)
    at = (p_idx[inside], s_idx[inside], c_idx[inside], m_idx[inside])
    np.add.at(counts, at, 1)
    np.add.at(pct_sum, at, df.frp_pct.to_numpy()[inside])

    units = {}
    if inside.any():
        day = df.date.to_numpy()[inside].astype("datetime64[D]").astype(np.int64)
        u = pd.DataFrame({"s": s_idx[inside], "c": c_idx[inside], "t": m_idx[inside], "d": day}).value_counts().reset_index(name="n")
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
    return Cube(counts, exposure, cells, months, months.month.to_numpy() - 1, months.year.to_numpy(), observed, pct_sum, units)


def intensity_mean(cube: Cube, platforms: tuple[str, ...] = PLATFORMS) -> np.ndarray:
    """[stratum, cell, month] mean FRP percentile: VIIRS detections if any, else MODIS; NaN without detections."""
    def mean_of(family: tuple[str, ...]) -> np.ndarray:
        idx = [PLATFORMS.index(p) for p in platforms if p in family]
        if not idx:
            return np.full(cube.counts_s.shape[1:], np.nan)
        n, s = cube.counts_s[idx].sum(axis=0), cube.pct_sum[idx].sum(axis=0)
        return np.where(n > 0, s / np.where(n > 0, n, 1), np.nan)

    v, m = mean_of(VIIRS), mean_of(MODIS)
    return np.where(np.isnan(v), m, v)


def intensity_class(cube: Cube, thresholds: np.ndarray, platforms: tuple[str, ...] = PLATFORMS) -> np.ndarray:
    """[stratum, cell, month] class 0..N_FRP_CLASSES-1, or -1 without detections."""
    mean = intensity_mean(cube, platforms)
    cls = np.digitize(np.nan_to_num(mean, nan=0.0), thresholds)
    return np.where(np.isnan(mean), -1, cls)


# ----------------------------------------------------------------------------------------------
# Efficiency model
# ----------------------------------------------------------------------------------------------

@dataclass
class EfficiencyModel:
    base: np.ndarray          # [platform, stratum, cell, 12]
    regional: np.ndarray      # [platform, stratum, 12]
    era_factor: np.ndarray    # [platform, stratum, era]
    frp_factor: np.ndarray    # [platform, stratum, 1 + class]; index 0 = no detections (factor 1)
    thresholds: np.ndarray    # FRP-percentile class boundaries
    stratum_weight: np.ndarray  # [stratum] share of MODIS hot spots in each stratum (overlap months)
    phi: float = 1.0          # quasi-Poisson dispersion

    def efficiency(self, cube: Cube, p: int, s: int, cls: np.ndarray) -> np.ndarray:
        """[cell, month] efficiency of platform p in stratum s."""
        e = self.base[p, s][:, cube.cal_month] * self.era_factor[p, s, cube.era][None, :]
        return e * self.frp_factor[p, s][cls[s] + 1]


def _overlap(cube: Cube, fit_months: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
    full = cube.exposure >= 0.999
    modis_full = full[PLATFORMS.index("TERRA")] & full[PLATFORMS.index("AQUA")]
    if fit_months is not None:
        modis_full = modis_full & fit_months
    return full, modis_full


def fit_efficiency(cube: Cube, fit_months: np.ndarray | None = None,
                   prior: dict[str, float] | None = None) -> tuple[EfficiencyModel, np.ndarray, dict]:
    """Fit base (cell x calendar month, shrunk as in v1), era and intensity factors, and dispersion.

    Returns (model, regional efficiency [platform, 12] summed over strata, calibration summary) so the
    call pattern matches v1: `eff, regional, summary = fit_efficiency(cube)`; `harmonize(cube, eff, regional)`.
    """
    prior = prior or PRIOR_EFFICIENCY
    full, modis_full = _overlap(cube, fit_months)
    modis = cube.counts_s[PLATFORMS.index("TERRA")] + cube.counts_s[PLATFORMS.index("AQUA")]  # [s, c, t]
    n_p, n_s, n_c = len(PLATFORMS), len(STRATA), len(cube.cells)
    n_era = len(ERA_BREAKS) + 1
    era = cube.era

    base = np.zeros((n_p, n_s, n_c, 12))
    regional = np.zeros((n_p, n_s, 12))
    pooled = np.zeros((n_p, n_s))
    for p, name in enumerate(PLATFORMS):
        ref = modis_full & full[p]
        for s in range(n_s):
            modis_ref = float(modis[s][:, ref].sum())
            whole = (cube.counts_s[p, s][:, ref].sum() + KAPPA_REGION * prior[name]) / (modis_ref + KAPPA_REGION)
            pooled[p, s] = whole
            for m in range(12):
                sel = ref & (cube.cal_month == m)
                num, den = cube.counts_s[p, s][:, sel].sum(axis=1), modis[s][:, sel].sum(axis=1)
                regional[p, s, m] = (num.sum() + KAPPA_MONTH * whole) / (den.sum() + KAPPA_MONTH)
                base[p, s, :, m] = (num + KAPPA_CELL * regional[p, s, m]) / (den + KAPPA_CELL)

    # era factors on top of base
    era_factor = np.ones((n_p, n_s, n_era))
    for p in range(n_p):
        ref = modis_full & full[p]
        for s in range(n_s):
            expected_all = base[p, s][:, cube.cal_month] * modis[s]
            has = np.zeros(n_era, dtype=bool)
            for r in range(n_era):
                sel = ref & (era == r)
                obs, exp = cube.counts_s[p, s][:, sel].sum(), expected_all[:, sel].sum()
                if exp > 0:
                    k = KAPPA_ERA * pooled[p, s]
                    era_factor[p, s, r] = (obs + k) / (exp + k)
                    has[r] = True
            for r in range(1, n_era):  # an era without overlap inherits the last fitted one
                if not has[r] and has[r - 1]:
                    era_factor[p, s, r] = era_factor[p, s, r - 1]
                    has[r] = True

    # intensity classes from the overlap months
    mean_all = intensity_mean(cube)
    pool = mean_all[:, :, modis_full]
    pool = pool[~np.isnan(pool)]
    if pool.size >= 3 * N_FRP_CLASSES:
        thresholds = np.quantile(pool, np.arange(1, N_FRP_CLASSES) / N_FRP_CLASSES)
    else:
        thresholds = np.arange(1, N_FRP_CLASSES) / N_FRP_CLASSES
    cls = intensity_class(cube, thresholds)

    frp_factor = np.ones((n_p, n_s, N_FRP_CLASSES + 1))
    for p in range(n_p):
        ref = modis_full & full[p]
        for s in range(n_s):
            expected = base[p, s][:, cube.cal_month] * era_factor[p, s, era][None, :] * modis[s]
            for k in range(N_FRP_CLASSES):
                mask = (cls[s] == k) & ref[None, :]
                obs, exp = cube.counts_s[p, s][mask].sum(), expected[mask].sum()
                kk = KAPPA_FRP * pooled[p, s]
                frp_factor[p, s, k + 1] = (obs + kk) / (exp + kk)

    modis_by_s = modis[:, :, modis_full].sum(axis=(1, 2))
    weight = modis_by_s / modis_by_s.sum() if modis_by_s.sum() > 0 else np.full(n_s, 1 / n_s)
    model = EfficiencyModel(base, regional, era_factor, frp_factor, thresholds, weight)
    model.phi = _dispersion(cube, model, modis_full)

    summary = {}
    for p, name in enumerate(PLATFORMS):
        ref = modis_full & full[p]
        modis_ref = float(modis[:, :, ref].sum())
        summary[name] = {
            "efficiency": round(float((pooled[p] * weight).sum()), 3),
            "dayNight": {STRATA[s]: round(float(pooled[p, s]), 3) for s in range(n_s)},
            "overlapMonths": int(ref.sum()), "overlapModisHotspots": int(modis_ref),
            "priorWeight": round(KAPPA_REGION / (modis_ref / n_s + KAPPA_REGION), 3),
            "eraFactors": {_era_name(r): [round(float(era_factor[p, s, r]), 3) for s in range(n_s)] for r in range(n_era)},
            "frpFactors": [[round(float(frp_factor[p, s, k + 1]), 3) for k in range(N_FRP_CLASSES)] for s in range(n_s)],
        }
    summary["model"] = {"version": 2, "dispersionPhi": round(float(model.phi), 3),
                        "frpClassThresholds": [round(float(t), 3) for t in thresholds], "strata": list(STRATA),
                        "eraBreaks": list(ERA_BREAKS)}
    return model, (regional * weight[None, :, None]).sum(axis=1), summary


def _era_name(r: int) -> str:
    b = (None,) + ERA_BREAKS + (None,)
    lo, hi = b[r], b[r + 1]
    return f"{lo or ''}-{(hi - 1) if hi else ''}"


def _dispersion(cube: Cube, model: EfficiencyModel, months: np.ndarray) -> float:
    """Pearson chi^2 / df of the platforms against the fitted model, on the given months; at least 1."""
    cls = intensity_class(cube, model.thresholds)
    chi2, df = 0.0, 0.0
    for s in range(len(STRATA)):
        mu_parts, n_parts = [], []
        seen = np.zeros((len(cube.cells), len(cube.months)))
        power = np.zeros_like(seen)
        for p in range(len(PLATFORMS)):
            e = model.efficiency(cube, p, s, cls) * cube.exposure[p][None, :]
            mu_parts.append(e)
            n_parts.append(cube.counts_s[p, s])
            seen += cube.counts_s[p, s]
            power += e
        with np.errstate(divide="ignore", invalid="ignore"):
            h = np.where(power > 0, seen / power, 0)
        use = (seen > 0) & months[None, :]
        active = np.zeros(seen.shape, dtype=int)
        for e, n in zip(mu_parts, n_parts):
            mu = h * e
            ok = use & (mu > 0)
            chi2 += float((((n - mu) ** 2) / np.where(ok, mu, 1))[ok].sum())
            active += ok
        df += float(np.clip(active - 1, 0, None).sum())
    return max(1.0, chi2 / df) if df > 0 else 1.0


# ----------------------------------------------------------------------------------------------
# Harmonization and intervals
# ----------------------------------------------------------------------------------------------

def _gamma_ppf(q: float, a: np.ndarray) -> np.ndarray:
    """Quantile of Gamma(a, 1) via Wilson-Hilferty on chi^2(2a); exact for a = 1; 0 for a <= 0."""
    a = np.asarray(a, dtype=float)
    z = _Z if q > 0.5 else -_Z
    k = 2 * np.maximum(a, 1e-12)
    wh = k * np.clip(1 - 2 / (9 * k) + z * np.sqrt(2 / (9 * k)), 0, None) ** 3 / 2
    exact1 = -math.log(1 - q)
    return np.where(a <= 0, 0.0, np.where(np.isclose(a, 1.0), exact1, wh))


@dataclass
class HarmonizedResult:
    values: np.ndarray        # [cell, month] MODIS-equivalent hot spots
    sd: np.ndarray            # [cell, month] quasi-Poisson standard deviation
    lo: np.ndarray            # [cell, month] 90 % lower bound (Garwood per stratum, summed)
    hi: np.ndarray            # [cell, month] 90 % upper bound
    seen: np.ndarray          # [stratum, cell, month]
    power: np.ndarray         # [stratum, cell, month]
    valid: np.ndarray         # [month]
    phi: float


def harmonize_full(cube: Cube, model: EfficiencyModel, platforms: tuple[str, ...] = PLATFORMS) -> HarmonizedResult:
    """H = sum over strata of seen_s / power_s, with quasi-Poisson sd and Garwood intervals."""
    cls = intensity_class(cube, model.thresholds, platforms)
    n_s, n_c, n_t = len(STRATA), len(cube.cells), len(cube.months)
    seen, power = np.zeros((n_s, n_c, n_t)), np.zeros((n_s, n_c, n_t))
    power_regional = np.zeros(n_t)
    for name in platforms:
        p = PLATFORMS.index(name)
        for s in range(n_s):
            seen[s] += cube.counts_s[p, s]
            power[s] += model.efficiency(cube, p, s, cls) * cube.exposure[p][None, :]
            power_regional += model.regional[p, s][cube.cal_month] * model.era_factor[p, s, cube.era] * cube.exposure[p] * model.stratum_weight[s]
    valid = power_regional >= MIN_SENSING_POWER
    ok = valid[None, None, :] & (power > 0)
    phi = model.phi
    with np.errstate(divide="ignore", invalid="ignore"):
        h_s = np.where(ok, seen / power, np.nan)
        var_s = np.where(ok, phi * seen / power ** 2, np.nan)
        lo_s = np.where(ok, phi * _gamma_ppf(0.05, seen / phi) / power, np.nan)
        hi_s = np.where(ok, phi * _gamma_ppf(0.95, seen / phi + 1) / power, np.nan)
    any_ok = ok.any(axis=0)
    obs = cube.observed[None, :]
    values = np.where(any_ok, np.nansum(h_s, axis=0), np.nan) * obs
    sd = np.where(any_ok, np.sqrt(np.nansum(var_s, axis=0)), np.nan) * obs
    lo = np.where(any_ok, np.nansum(lo_s, axis=0), np.nan) * obs
    hi = np.where(any_ok, np.nansum(hi_s, axis=0), np.nan) * obs
    return HarmonizedResult(values, sd, lo, hi, seen, power, valid, phi)


def harmonize(cube: Cube, eff: EfficiencyModel, regional: np.ndarray | None = None,
              platforms: tuple[str, ...] = PLATFORMS) -> tuple[np.ndarray, np.ndarray]:
    """v1-compatible: (MODIS-equivalent hot spots [cell, month], quasi-Poisson sd)."""
    r = harmonize_full(cube, eff, platforms)
    return r.values, r.sd


def total_interval(cube: Cube, result: HarmonizedResult, cells: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Regional monthly total with a 90 % interval: normal (quasi-Poisson) when hot spots were seen,
    Garwood upper bound against the mean sensing power when none were."""
    sel = slice(None) if cells is None else cells
    values = np.nansum(result.values[sel], axis=0)
    sd = np.sqrt(np.nansum(result.sd[sel] ** 2, axis=0))
    seen = result.seen[:, sel].sum(axis=(0, 1))
    with np.errstate(invalid="ignore", divide="ignore"):
        mean_power = np.nanmean(np.where(result.power[:, sel] > 0, result.power[:, sel], np.nan), axis=1)  # [s, t]
        zero_hi = np.nansum(result.phi * -math.log(0.05) / mean_power / len(STRATA), axis=0)
    lo = np.where(seen > 0, np.clip(values - _Z * sd, 0, None), 0.0)
    hi = np.where(seen > 0, values + _Z * sd, zero_hi * cube.observed)
    empty = ~result.valid
    return np.where(empty, np.nan, values), np.where(empty, np.nan, lo), np.where(empty, np.nan, hi)


def bootstrap_interval(cube: Cube, result: HarmonizedResult, n_boot: int = 200, seed: int = 0,
                       batch: int = 50) -> tuple[np.ndarray, np.ndarray]:
    """90 % interval of the regional monthly total from a Poisson bootstrap over fire-days.

    A fire-day is all detections of one stratum in one H3 cell on one day. Efficiencies are held
    fixed, so this captures the clustering of detections, not the calibration uncertainty. Months
    without detections get the zero-count upper bound of `total_interval`.
    """
    n_t = len(cube.months)
    _, lo0, hi0 = total_interval(cube, result)
    if not cube.units:
        return lo0, hi0
    s, c, t, n = (cube.units[k] for k in ("s", "c", "t", "n"))
    power = result.power[s, c, t]
    ok = (power > 0) & result.valid[t]
    contrib = np.where(ok, n / np.where(ok, power, 1), 0) * cube.observed[t]
    rng = np.random.default_rng(seed)
    totals = np.empty((n_boot, n_t))
    for b0 in range(0, n_boot, batch):
        nb = min(batch, n_boot - b0)
        w = rng.poisson(1.0, size=(nb, len(contrib)))
        for i in range(nb):
            totals[b0 + i] = np.bincount(t, weights=w[i] * contrib, minlength=n_t)
    lo = np.quantile(totals, 0.05, axis=0)
    hi = np.quantile(totals, 0.95, axis=0)
    has = np.bincount(t, weights=ok.astype(float), minlength=n_t) > 0
    return np.where(has, lo, lo0), np.where(has, hi, hi0)


# ----------------------------------------------------------------------------------------------
# Calendar statistics and validation
# ----------------------------------------------------------------------------------------------

def calendar_stats(values: np.ndarray, cal_month: np.ndarray, complete: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Leave-one-out anomaly of each month against the same calendar month in the other years.

    Everything is on log(1 + value): z = (log1p(v) - mean of the others) / std of the others; the
    percentile is the share of other years below (ties count half). Returns (z, percentile 0..100,
    typical month = expm1(mean log1p) [12], std of log1p [12]).
    """
    z, pct = np.full(len(values), np.nan), np.full(len(values), np.nan)
    clim_mean, clim_std = np.full(12, np.nan), np.full(12, np.nan)
    logv = np.log1p(values)
    for m in range(12):
        idx = np.flatnonzero((cal_month == m) & ~np.isnan(values) & complete)
        if len(idx) < 4:  # leave-one-out needs at least 3 others for a std
            continue
        lv, v = logv[idx], values[idx]
        clim_mean[m], clim_std[m] = float(np.expm1(lv.mean())), float(lv.std(ddof=1))
        n = len(idx)
        total, total_sq = lv.sum(), (lv ** 2).sum()
        mean_o = (total - lv) / (n - 1)
        var_o = np.clip((total_sq - lv ** 2 - (n - 1) * mean_o ** 2) / (n - 2), 0, None)
        std_o = np.sqrt(var_o)
        z[idx] = np.where(std_o > 1e-12, (lv - mean_o) / np.where(std_o > 1e-12, std_o, 1), 0.0)
        below = (v[None, :] < v[:, None]).sum(axis=1)
        ties = (v[None, :] == v[:, None]).sum(axis=1) - 1
        pct[idx] = 100 * (below + 0.5 * ties) / (n - 1)
    return z, pct, clim_mean, clim_std


def _training_prior(cube: Cube, train: np.ndarray) -> dict[str, float]:
    """Pooled ratio to MODIS on the training months only (falls back on PRIOR_EFFICIENCY without overlap)."""
    full, modis_full = _overlap(cube, train)
    modis = cube.counts[PLATFORMS.index("TERRA")] + cube.counts[PLATFORMS.index("AQUA")]
    out = {}
    for p, name in enumerate(PLATFORMS):
        ref = modis_full & full[p]
        den = float(modis[:, ref].sum())
        out[name] = float(cube.counts[p][:, ref].sum()) / den if den > 0 else PRIOR_EFFICIENCY[name]
    return out


def validate(cube: Cube, k: int = K_FOLDS) -> dict | None:
    """Blocked k-fold over years: refit on the other years (prior included), predict MODIS from VIIRS alone."""
    modis = cube.counts[PLATFORMS.index("TERRA")] + cube.counts[PLATFORMS.index("AQUA")]
    full, modis_full = _overlap(cube, None)
    viirs_any = cube.exposure[[PLATFORMS.index(p) for p in VIIRS]].max(axis=0) >= 0.999
    test_all = modis_full & viirs_any
    if modis[:, test_all].sum() < MIN_TEST_HOTSPOTS:
        return None
    test_years = np.unique(cube.years[test_all])
    k = min(k, len(test_years))
    if k < 2:
        return None
    fold_of_year = {int(y): i % k for i, y in enumerate(test_years)}
    fold = np.array([fold_of_year.get(int(y), -1) for y in cube.years])

    pred = np.full(modis.shape, np.nan)
    pred_sd = np.full(modis.shape, np.nan)
    phis = []
    for f in range(k):
        train = fold != f
        test = test_all & (fold == f)
        model, _, _ = fit_efficiency(cube, fit_months=train, prior=_training_prior(cube, train))
        res = harmonize_full(cube, model, platforms=VIIRS)
        pred[:, test], pred_sd[:, test] = res.values[:, test], res.sd[:, test]
        phis.append(model.phi)
    phi = float(np.mean(phis))

    def score(sel: np.ndarray) -> dict | None:
        truth, est = modis[:, sel].sum(axis=0), np.nansum(pred[:, sel], axis=0)
        if truth.sum() < MIN_TEST_HOTSPOTS:
            return None
        var = np.nansum(pred_sd[:, sel] ** 2, axis=0) + phi * np.maximum(est, 0)
        busy = truth >= 50
        cell_truth, cell_est = modis[:, sel].sum(axis=1), np.nansum(pred[:, sel], axis=1)
        busy_cells = cell_truth >= 20
        return {
            "months": int(sel.sum()), "modisHotspots": int(truth.sum()), "viirsOnlyEstimate": round(float(est.sum()), 1),
            "totalBiasPct": round(100 * (est.sum() / truth.sum() - 1), 2),
            "monthlyPearsonR": round(float(np.corrcoef(truth, est)[0, 1]), 4) if sel.sum() > 2 else None,
            "monthlyMedianAbsErrorPct": round(float(np.median(np.abs(est[busy] / truth[busy] - 1)) * 100), 1) if busy.any() else None,
            "interval90Coverage": round(float(np.mean(np.abs(truth - est) <= _Z * np.sqrt(var))), 3),
            "cellPearsonR": round(float(np.corrcoef(cell_truth[busy_cells], cell_est[busy_cells])[0, 1]), 4) if busy_cells.sum() > 2 else None,
        }

    eras = {"2012-2019": (2012, 2019), "2020-2022": (2020, 2022), "2023+": (2023, 2100)}
    return {
        "design": f"blocked {k}-fold over years; each fold refits efficiencies and the prior on the other years "
                  "and predicts MODIS from VIIRS alone",
        "dispersionPhi": round(phi, 3),
        "allTestYears": score(test_all),
        "byEra": {name: score(test_all & (cube.years >= a) & (cube.years <= b)) for name, (a, b) in eras.items()},
    }
