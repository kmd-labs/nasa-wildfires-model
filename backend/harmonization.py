"""Harmonize MODIS and VIIRS active-fire hot spots for any bounding box.

Every satellite is a separate witness of the same fire activity: Terra and Aqua (MODIS, 1 km)
and S-NPP, NOAA-20 and NOAA-21 (VIIRS, 375 m).

1. QA: presumed vegetation fires only (`type == 0`), no low-confidence detections, and no
   near-real-time rows (which have no `type` yet) on a known static heat source.
2. Detections are binned to H3 cells and calendar months: N[platform, cell, month].
3. Detection efficiency e[platform, cell, calendar month] is the number of hot spots a platform
   reports per MODIS (Terra + Aqua) hot spot, estimated on months when both were operating.
   It is shrunk in three steps (cell -> region and calendar month -> region -> prior), so a
   small or quiet bounding box falls back on typical values instead of on noise.
4. Harmonized activity = all hot spots seen / total sensing power in orbit that month:

       H[cell, month] = sum_p N[p, cell, month] / sum_p ( e[p, cell, month] * exposure[p, month] )

   This is the maximum-likelihood estimate of one fire intensity observed by platforms that
   count hot spots as Poisson(H * e_p * exposure_p). The unit is MODIS-equivalent hot spots,
   so 2000-2011 needs no back-casting, and a satellite joining (2002 Aqua, 2012 S-NPP,
   2018 NOAA-20, 2023 NOAA-21) or retiring changes the precision of the estimate, not its level.
5. Validation: efficiencies fitted on even years, MODIS predicted from VIIRS alone in odd years.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import h3
import numpy as np
import pandas as pd

PLATFORMS = ("TERRA", "AQUA", "SNPP", "NOAA20", "NOAA21")
MODIS = ("TERRA", "AQUA")
VIIRS = ("SNPP", "NOAA20", "NOAA21")
SATELLITE_TO_PLATFORM = {
    "terra": "TERRA", "t": "TERRA", "aqua": "AQUA", "a": "AQUA",
    "n": "SNPP", "npp": "SNPP", "snpp": "SNPP", "suomi npp": "SNPP",
    "n20": "NOAA20", "noaa-20": "NOAA20", "noaa20": "NOAA20", "j1": "NOAA20", "1": "NOAA20",
    "n21": "NOAA21", "noaa-21": "NOAA21", "noaa21": "NOAA21", "j2": "NOAA21", "2": "NOAA21",
}
# First day of each platform in the FIRMS archive; used when the FIRMS availability service was not asked.
DEFAULT_FIRST_DAY = {"TERRA": "2000-11-01", "AQUA": "2002-07-04", "SNPP": "2012-01-20", "NOAA20": "2018-04-01", "NOAA21": "2023-03-01"}
# Hot spots per MODIS hot spot when a bounding box has too little overlap data of its own (values measured on Iberia).
PRIOR_EFFICIENCY = {"TERRA": 0.5, "AQUA": 0.5, "SNPP": 3.0, "NOAA20": 3.2, "NOAA21": 3.4}

MODIS_MIN_CONFIDENCE = 30      # FIRMS convention: below 30 is "low"
STATIC_MIN_DETECTIONS = 2      # a 0.01 degree pixel is a static source after this many type 1/2/3 detections
MIN_SENSING_POWER = 0.2        # months with less MODIS-equivalent coverage than this are left empty
KAPPA_CELL = 50                # shrinkage of a cell towards its region, in MODIS hot spots
KAPPA_MONTH = 30               # shrinkage of a calendar month towards the whole year
KAPPA_REGION = 200             # shrinkage of the region towards the prior
MAX_CELLS = 5000               # the H3 resolution is the finest one that keeps the bbox under this many cells
MIN_TEST_HOTSPOTS = 200        # below this the hold-out validation is too noisy to report


# ----------------------------------------------------------------------------------------------
# Cleaning
# ----------------------------------------------------------------------------------------------

def normalize(df: pd.DataFrame) -> pd.DataFrame:
    """Give raw FIRMS rows (all strings) typed columns: latitude, longitude, frp, type, date, platform."""
    df = df.copy()
    for col in ("latitude", "longitude", "frp", "type"):
        df[col] = pd.to_numeric(df[col], errors="coerce") if col in df else np.nan
    df["platform"] = df.satellite.astype(str).str.strip().str.lower().map(SATELLITE_TO_PLATFORM)
    df = df[df.platform.notna() & df.latitude.notna() & df.longitude.notna()].copy()
    df["date"] = pd.to_datetime(df.acq_date, format="%Y-%m-%d")
    df["acq_time"] = df.acq_time.astype(str).str.zfill(4)
    df["confidence"] = df.confidence.fillna("").astype(str)
    return df


def flag_quality(df: pd.DataFrame) -> pd.DataFrame:
    """Add `qa_pass`: presumed vegetation fire with nominal or high confidence.

    `type` (0 vegetation, 1 volcano, 2 static land source, 3 offshore) exists only in
    science-quality rows. Near-real-time rows are tested against the 0.01 degree pixels where
    the science-quality record shows a static source; otherwise the newest weeks of the series
    would carry industrial heat sources that the rest of the series does not.
    """
    is_modis = df.platform.isin(MODIS)
    modis_ok = pd.to_numeric(df.confidence, errors="coerce").fillna(100) >= MODIS_MIN_CONFIDENCE
    viirs_ok = ~df.confidence.str.lower().str.startswith("l")
    conf_ok = np.where(is_modis, modis_ok, viirs_ok)

    pixel = (np.round(df.latitude * 100).astype(np.int64) + 9000) * 100000 + (np.round(df.longitude * 100).astype(np.int64) + 18000)
    static_counts = pixel[df.type.isin([1, 2, 3])].value_counts()
    static_pixels = set(static_counts[static_counts >= STATIC_MIN_DETECTIONS].index)
    type_ok = (df.type == 0) | (df.type.isna() & ~pixel.isin(static_pixels))
    df = df.copy()
    df["qa_pass"] = conf_ok & type_ok
    return df


def pick_h3_resolution(bbox: tuple[float, float, float, float]) -> int:
    """Finest H3 resolution from 4 to 7 that keeps the bounding box under MAX_CELLS cells."""
    w, s, e, n = bbox
    area_km2 = (e - w) * 111.32 * math.cos(math.radians((s + n) / 2)) * (n - s) * 110.57
    for res in (7, 6, 5):
        if area_km2 / h3.average_hexagon_area(res, unit="km^2") <= MAX_CELLS:
            return res
    return 4


# ----------------------------------------------------------------------------------------------
# Monthly cube, exposure, efficiency, harmonization
# ----------------------------------------------------------------------------------------------

@dataclass
class Availability:
    """Operating period of each platform. `last` is None while the platform is still flying."""
    first: dict[str, pd.Timestamp]
    last: dict[str, pd.Timestamp | None]
    horizon: pd.Timestamp  # last day covered by the data

    @classmethod
    def default(cls, horizon: pd.Timestamp) -> "Availability":
        return cls({p: pd.Timestamp(d) for p, d in DEFAULT_FIRST_DAY.items()}, {p: None for p in PLATFORMS}, pd.Timestamp(horizon))

    @classmethod
    def from_data(cls, df: pd.DataFrame) -> "Availability":
        """First and last detection per platform. Only reliable for a large region."""
        horizon = df.date.max()
        first, last = {}, {}
        for p, dates in df.groupby("platform").date:
            first[p] = dates.min()
            last[p] = None if (horizon - dates.max()).days <= 10 else dates.max()
        return cls(first, last, horizon)

    def to_json(self) -> dict:
        return {"first": {p: f"{d:%Y-%m-%d}" for p, d in self.first.items()},
                "last": {p: None if d is None else f"{d:%Y-%m-%d}" for p, d in self.last.items()},
                "horizon": f"{self.horizon:%Y-%m-%d}"}

    @classmethod
    def from_json(cls, obj: dict) -> "Availability":
        return cls({p: pd.Timestamp(d) for p, d in obj["first"].items()},
                   {p: None if d is None else pd.Timestamp(d) for p, d in obj["last"].items()}, pd.Timestamp(obj["horizon"]))


@dataclass
class Cube:
    counts: np.ndarray        # [platform, cell, month] QA-passed detections
    exposure: np.ndarray      # [platform, month] share of the month the platform was operating, 0..1
    cells: list[str]
    months: pd.PeriodIndex
    cal_month: np.ndarray     # [month] 0..11
    years: np.ndarray         # [month]
    observed: np.ndarray      # [month] share of the month inside the record; below 1 only for the current month


def build_cube(df: pd.DataFrame, avail: Availability, h3_res: int) -> Cube:
    """Bin QA-passed detections (needs columns platform, date, latitude, longitude) to H3 cells and months."""
    months = pd.period_range(min(avail.first.values()), avail.horizon, freq="M")
    cell_of = [h3.latlng_to_cell(lat, lon, h3_res) for lat, lon in zip(df.latitude.to_numpy(), df.longitude.to_numpy())]
    cells = sorted(set(cell_of))
    cell_idx = {c: i for i, c in enumerate(cells)}
    p_idx = df.platform.map({p: i for i, p in enumerate(PLATFORMS)}).fillna(-1).to_numpy(dtype=np.int64)
    c_idx = np.fromiter((cell_idx[c] for c in cell_of), dtype=np.int64, count=len(cell_of))
    m_idx = (
        ((df.date.dt.year.to_numpy() - months[0].year) * 12 + df.date.dt.month.to_numpy() - months[0].month).astype(np.int64)
        if len(df) else np.empty(0, dtype=np.int64)
    )
    inside = (p_idx >= 0) & (m_idx >= 0) & (m_idx < len(months))
    counts = np.zeros((len(PLATFORMS), len(cells), len(months)))
    if inside.any():
        np.add.at(counts, (p_idx[inside], c_idx[inside], m_idx[inside]), 1)

    exposure = np.zeros((len(PLATFORMS), len(months)))
    for i, p in enumerate(PLATFORMS):
        if p not in avail.first:
            continue
        last = avail.horizon if avail.last.get(p) is None else min(avail.last[p], avail.horizon)
        for t, month in enumerate(months):
            start, end = max(month.start_time, avail.first[p]), min(month.end_time.normalize(), last)
            exposure[i, t] = max(0, (end - start).days + 1) / month.days_in_month
    observed = np.ones(len(months))
    observed[-1] = min(1.0, avail.horizon.day / months[-1].days_in_month)
    return Cube(counts, exposure, cells, months, months.month.to_numpy() - 1, months.year.to_numpy(), observed)


def fit_efficiency(cube: Cube, fit_months: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, dict]:
    """Hot spots a platform reports per MODIS (Terra + Aqua) hot spot, by cell and calendar month.

    Only months when Terra, Aqua and the platform were all operating the whole month are used.
    Each level is (platform count + kappa * value one level up) / (MODIS count + kappa):
    region vs prior, calendar month vs region, cell vs calendar month.
    Returns (efficiency [platform, cell, 12], regional [platform, 12], calibration summary).
    """
    full = cube.exposure >= 0.999
    modis_full = full[PLATFORMS.index("TERRA")] & full[PLATFORMS.index("AQUA")]
    if fit_months is not None:
        modis_full = modis_full & fit_months
    modis = cube.counts[PLATFORMS.index("TERRA")] + cube.counts[PLATFORMS.index("AQUA")]

    eff = np.zeros((len(PLATFORMS), len(cube.cells), 12))
    regional = np.zeros((len(PLATFORMS), 12))
    summary = {}
    for p, name in enumerate(PLATFORMS):
        ref = modis_full & full[p]
        modis_ref = float(modis[:, ref].sum())
        whole_year = (cube.counts[p][:, ref].sum() + KAPPA_REGION * PRIOR_EFFICIENCY[name]) / (modis_ref + KAPPA_REGION)
        for m in range(12):
            sel = ref & (cube.cal_month == m)
            num, den = cube.counts[p][:, sel].sum(axis=1), modis[:, sel].sum(axis=1)
            regional[p, m] = (num.sum() + KAPPA_MONTH * whole_year) / (den.sum() + KAPPA_MONTH)
            eff[p, :, m] = (num + KAPPA_CELL * regional[p, m]) / (den + KAPPA_CELL)
        summary[name] = {"efficiency": round(float(whole_year), 3), "overlapMonths": int(ref.sum()),
                         "overlapModisHotspots": int(modis_ref), "priorWeight": round(KAPPA_REGION / (modis_ref + KAPPA_REGION), 3)}
    return eff, regional, summary


def harmonize(cube: Cube, eff: np.ndarray, regional: np.ndarray, platforms: tuple[str, ...] = PLATFORMS) -> tuple[np.ndarray, np.ndarray]:
    """MODIS-equivalent hot spots per cell and month, and the standard deviation of that estimate.

    The standard deviation assumes Poisson counts and known efficiencies, so it is a floor.
    The month still in progress is reported as hot spots detected so far, not projected to a full month.
    """
    n_c, n_t = len(cube.cells), len(cube.months)
    seen, power, power_regional = np.zeros((n_c, n_t)), np.zeros((n_c, n_t)), np.zeros(n_t)
    for name in platforms:
        p = PLATFORMS.index(name)
        seen += cube.counts[p]
        power += eff[p][:, cube.cal_month] * cube.exposure[p][None, :]
        power_regional += regional[p][cube.cal_month] * cube.exposure[p]
    valid = (power_regional >= MIN_SENSING_POWER)[None, :] & (power > 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        harmonized = np.where(valid, seen / power, np.nan)
        sd = np.where(valid, np.sqrt(seen) / power, np.nan)
    return harmonized * cube.observed[None, :], sd * cube.observed[None, :]


# ----------------------------------------------------------------------------------------------
# Calendar statistics and validation
# ----------------------------------------------------------------------------------------------

def calendar_stats(values: np.ndarray, cal_month: np.ndarray, complete: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Anomaly z-score and percentile of each month against the same calendar month in other years.

    The z-score is computed on log(1 + count) because fire counts are strongly right-skewed.
    Months still in progress are left out: a half month cannot be ranked against whole months.
    Returns (z, percentile 0..100, climatological mean [12], climatological std [12]).
    """
    z, pct = np.full(len(values), np.nan), np.full(len(values), np.nan)
    clim_mean, clim_std = np.full(12, np.nan), np.full(12, np.nan)
    logv = np.log1p(values)
    for m in range(12):
        sel = (cal_month == m) & ~np.isnan(values) & complete
        if sel.sum() < 3:
            continue
        clim_mean[m], clim_std[m] = values[sel].mean(), values[sel].std(ddof=1)
        sigma = logv[sel].std(ddof=1)
        z[sel] = (logv[sel] - logv[sel].mean()) / sigma if sigma > 0 else 0
        pct[sel] = 100 * (pd.Series(values[sel]).rank(method="average").to_numpy() - 0.5) / sel.sum()
    return z, pct, clim_mean, clim_std


def validate(cube: Cube) -> dict | None:
    """Fit efficiencies on even years, then predict MODIS from VIIRS alone in odd years."""
    modis = cube.counts[PLATFORMS.index("TERRA")] + cube.counts[PLATFORMS.index("AQUA")]
    full = cube.exposure >= 0.999
    modis_full = full[PLATFORMS.index("TERRA")] & full[PLATFORMS.index("AQUA")]
    viirs_any = cube.exposure[[PLATFORMS.index(p) for p in VIIRS]].max(axis=0) >= 0.999
    even = cube.years % 2 == 0
    eff, regional, _ = fit_efficiency(cube, fit_months=even)
    viirs_only, _ = harmonize(cube, eff, regional, platforms=VIIRS)
    test = modis_full & viirs_any & ~even
    if modis[:, test].sum() < MIN_TEST_HOTSPOTS:
        return None

    def score(sel: np.ndarray) -> dict | None:
        truth, pred = modis[:, sel].sum(axis=0), np.nansum(viirs_only[:, sel], axis=0)
        if truth.sum() < MIN_TEST_HOTSPOTS:
            return None
        busy = truth >= 50
        return {
            "months": int(sel.sum()), "modisHotspots": int(truth.sum()), "viirsOnlyEstimate": round(float(pred.sum()), 1),
            "totalBiasPct": round(100 * (pred.sum() / truth.sum() - 1), 2),
            "monthlyPearsonR": round(float(np.corrcoef(truth, pred)[0, 1]), 4) if sel.sum() > 2 else None,
            "monthlyMedianAbsErrorPct": round(float(np.median(np.abs(pred[busy] / truth[busy] - 1)) * 100), 1) if busy.any() else None,
        }

    eras = {"2012-2017 (S-NPP)": (2012, 2017), "2018-2022 (+NOAA-20)": (2018, 2022), "2023+ (+NOAA-21)": (2023, 2100)}
    return {
        "design": "efficiencies fitted on even years; odd years predicted from VIIRS only and compared with MODIS",
        "allTestYears": score(test),
        "byEra": {name: score(test & (cube.years >= a) & (cube.years <= b)) for name, (a, b) in eras.items()},
    }
