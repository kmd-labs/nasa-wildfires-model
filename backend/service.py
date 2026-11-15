"""Burning-activity calendar for a user-selected bounding box and date range."""
from __future__ import annotations

import datetime as dt
import threading
import time

import h3
import numpy as np
import pandas as pd

from .harmonization_select import hz
from .burned_area import PIXEL_KM2, PRODUCTS, BurnedAreaClient, BurnedAreaError, tiles_for_bbox
from .firms import FirmsClient, FirmsError, Region, RegionStore
from .harmonization3 import seam_test

ATTRIBUTION = ("We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management "
               "System (FIRMS) (https://www.earthdata.nasa.gov/firms), part of NASA's Earth Science Data and "
               "Information System (ESDIS). MODIS Collection 6.1 and VIIRS 375 m active fire products. "
               "Harmonized by KMD Labs.")
CSV_COLUMNS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "confidence", "version", "frp", "daynight", "type"]
MAX_BBOX_DEG2 = 8000.0  # up to ~90 x 88 degrees; larger requests are refused
BURNED_AREA_MAX_DEG2 = 400.0    # burned-area downloads: about 4 sinusoidal tiles x 310 months at most
BURNED_AREA_LATENCY_DAYS = 75  # the newest burned-area month LP DAAC has normally published is about this old
BURNED_AREA_RETRY_S = 600       # a burned-area job with failed tiles is retried after this many seconds
FAILED_JOB_COOLDOWN_S = 30.0    # avoid immediate retry loops when FIRMS chunk downloads or availability fail


class NotReady(Exception):
    """The region is still being downloaded. `progress` is {"done": int, "total": int}."""

    def __init__(self, progress: dict):
        super().__init__("downloading")
        self.progress = progress


class BadRequest(ValueError):
    pass


def parse_bbox(text: str) -> tuple[float, float, float, float]:
    try:
        w, s, e, n = (float(v) for v in text.split(","))
    except ValueError as exc:
        raise BadRequest("bbox must be W,S,E,N in decimal degrees") from exc
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise BadRequest("bbox must satisfy -180 <= W < E <= 180 and -90 <= S < N <= 90")
    if (e - w) * (n - s) > MAX_BBOX_DEG2:
        raise BadRequest(f"bbox is larger than {MAX_BBOX_DEG2:g} square degrees")
    return w, s, e, n


def parse_bboxes(text: str) -> tuple[tuple[float, float, float, float], ...]:
    parts = [p.strip() for p in text.split(";") if p.strip()]
    if not parts:
        raise BadRequest("bbox must be W,S,E,N in decimal degrees")
    boxes = tuple(parse_bbox(p) for p in parts)
    total_area = sum((e - w) * (n - s) for w, s, e, n in boxes)
    if total_area > MAX_BBOX_DEG2:
        raise BadRequest(f"total multipolygon bbox area is larger than {MAX_BBOX_DEG2:g} square degrees")
    return boxes


def envelope_bbox(boxes: tuple[tuple[float, float, float, float], ...]) -> tuple[float, float, float, float]:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _overlapping(boxes: tuple[tuple[float, float, float, float], ...]) -> bool:
    return any(a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]
               for i, a in enumerate(boxes) for b in boxes[i + 1:])


def parse_day(text: str, end: bool) -> pd.Timestamp:
    """Accept YYYY-MM-DD or YYYY-MM (first or last day of the month)."""
    try:
        if len(text) == 7:
            period = pd.Period(text, freq="M")
            return period.end_time.normalize() if end else period.start_time
        return pd.Timestamp(dt.date.fromisoformat(text))
    except ValueError as exc:
        raise BadRequest("dates must be YYYY-MM-DD or YYYY-MM") from exc


def _clean(values, digits: int = 2) -> list:
    return [None if np.isnan(v) else (int(v) if digits == 0 else round(float(v), digits)) for v in values]


class CalendarService:
    """Glue between the FIRMS cache and the harmonization: download if needed, harmonize, summarize."""

    def __init__(self, store: RegionStore | None = None, client: FirmsClient | None = None,
                 burned: BurnedAreaClient | None = None):
        self.store = store or RegionStore()
        self.client = client or FirmsClient()
        self.burned = burned or BurnedAreaClient()
        self._jobs: dict[str, dict] = {}
        self._burned_jobs: dict[tuple, dict] = {}
        self._results: dict[tuple, dict] = {}
        self._lock = threading.Lock()

    # -- data ----------------------------------------------------------------------------------

    def _job(self, region: Region) -> dict | None:
        with self._lock:
            return self._jobs.get(region.key)

    def ensure_data(
        self,
        bbox: tuple[float, float, float, float],
        wait: bool = False,
        priority_window: tuple[dt.date, dt.date] | None = None,
    ) -> Region:
        """Return a region with data for bbox, starting a background download when something is missing.

        Raises NotReady while the first download of a region is running. A region that already has
        data is served as it is while its newest weeks are refreshed in the background.
        """
        region = self.store.get_or_create(bbox)
        if not self.client.online:
            if not region.has_data:
                raise BadRequest("FIRMS_MAP_KEY is not set and there is no cached data for this area")
            return region
        job = self._job(region)
        cooldown_elapsed = job is not None and (time.time() - job.get("finished_at", 0.0)) >= FAILED_JOB_COOLDOWN_S
        should_retry_error = bool(job and job["finished"] and job["error"] and cooldown_elapsed)
        should_sync_more = bool(
            job
            and job["finished"]
            and job["error"] is None
            and (not job["failed"] or cooldown_elapsed)
            and self._needs_sync(region)
        )
        if job is None or should_sync_more or should_retry_error:
            job = self._start(region, priority_window=priority_window)
        elif priority_window is not None:
            job["priority_window"] = priority_window
        if wait:
            job["thread"].join()
        if job["error"] and not region.has_data:
            raise FirmsError(job["error"])
        if job["finished"] and job["error"] and region.has_data:
            return region
        if not region.has_data:
            raise NotReady({"done": job["done"], "total": job["total"]})
        if priority_window is not None and not job["finished"]:
            from .firms import FirmsError as _FirmsError, today_utc
            try:
                avail = self.client.availability()
            except _FirmsError:
                return region
            if region.pending_in_window_count(avail, today_utc(), priority_window) > 0:
                raise NotReady({"done": job["done"], "total": job["total"]})
        return region

    def _needs_sync(self, region: Region) -> bool:
        from .firms import today_utc
        return bool(region.plan(self.client.availability(), today_utc(), respect_cooldown=True))

    def _start(self, region: Region, priority_window: tuple[dt.date, dt.date] | None = None) -> dict:
        job = {
            "done": 0,
            "total": 0,
            "finished": False,
            "finished_at": 0.0,
            "error": None,
            "failed": [],
            "priority_window": priority_window,
        }

        def work() -> None:
            try:
                outcome = region.sync(
                    self.client,
                    progress=lambda done, total: job.update(done=done, total=total),
                    priority_window=priority_window,
                    get_priority_window=lambda: job["priority_window"],
                )
                job["failed"] = outcome["failed"]
            except Exception as exc:  # the thread must always finish the job record
                job["error"] = str(exc)
            finally:
                job["finished_at"] = time.time()
                job["finished"] = True

        job["thread"] = threading.Thread(target=work, name=f"firms-sync-{region.key}", daemon=True)
        with self._lock:
            self._jobs[region.key] = job
        job["thread"].start()
        return job

    # -- analytics -----------------------------------------------------------------------------

    def _harmonized(
        self,
        regions: list[Region],
        bboxes: tuple[tuple[float, float, float, float], ...],
    ) -> dict:
        """Everything that depends on the bboxes but not on the selected dates. Cached per data version."""
        reg_key = tuple((r.key, r.version) for r in regions)
        key = (reg_key, bboxes)
        with self._lock:
            if key in self._results:
                return self._results[key]
        if len(regions) == 1:
            frame = regions[0].frame()
        else:
            frames = [r.frame() for r in regions]
            frame = pd.concat(frames, ignore_index=True).drop_duplicates(
                ["platform", "latitude", "longitude", "acq_date", "acq_time"]
            )
        mask = pd.Series(False, index=frame.index)
        pad = 0.015  # include detections whose center lies just outside the bbox so boundary pixel squares clip cleanly
        pad_mask = pd.Series(False, index=frame.index)
        for w, s, e, n in bboxes:
            mask |= frame.latitude.between(s, n) & frame.longitude.between(w, e)
            pad_mask |= frame.latitude.between(s - pad, n + pad) & frame.longitude.between(w - pad, e + pad)
        df = frame[mask & frame.qa_pass]
        pixel_df = frame[pad_mask & frame.qa_pass][["date", "latitude", "longitude", "frp", "platform"]].copy()
        avail = regions[0].availability()
        env = envelope_bbox(bboxes)
        res = hz.pick_h3_resolution(env)
        cube = hz.build_cube(df, avail, res)
        eff, regional, calibration = hz.fit_efficiency(cube)
        harmonized, sd = hz.harmonize(cube, eff, regional)
        out = {"cube": cube, "harmonized": harmonized, "sd": sd, "calibration": calibration, "h3Resolution": res,
               "validation": hz.validate(cube) if len(cube.cells) else None, "availability": avail,
               "df": df[["date", "acq_date", "latitude", "longitude", "frp", "platform"]].copy(), "pixel_df": pixel_df}
        if hasattr(hz, "extras"):  # v3: weight per detection and the small-fire layer
            out.update(hz.extras(cube, eff, df))
        with self._lock:
            if len(self._results) > 32:
                self._results.pop(next(iter(self._results)))
            self._results[key] = out
        return out

    @staticmethod
    def _totals(h: dict) -> dict:
        """Monthly totals of the bbox: raw MODIS / VIIRS per cell and summed, harmonized value and sd."""
        cube = h["cube"]
        modis_cell = cube.counts[hz.PLATFORMS.index("TERRA")] + cube.counts[hz.PLATFORMS.index("AQUA")]
        viirs_cell = cube.counts[[hz.PLATFORMS.index(p) for p in hz.VIIRS]].sum(axis=0)
        empty = np.isnan(h["harmonized"]).all(axis=0) if len(cube.cells) else (cube.exposure.sum(axis=0) == 0)
        return {"modis_cell": modis_cell, "viirs_cell": viirs_cell, "modis": modis_cell.sum(axis=0), "viirs": viirs_cell.sum(axis=0),
                "total": np.where(empty, np.nan, np.nansum(h["harmonized"], axis=0)),
                "sd": np.where(empty, np.nan, np.sqrt(np.nansum(h["sd"] ** 2, axis=0))),
                "complete": cube.observed >= 0.999}

    def _seam_tests(self, bboxes: tuple[tuple[float, float, float, float], ...], h: dict, tot: dict) -> dict | None:
        """Seam test of the calendar against every burned-area product cached for the bboxes (never downloads).

        Several bboxes are summed, so they must not overlap; overlapping ones get no seam test.
        """
        months = h["cube"].months
        if not len(months) or _overlapping(bboxes):
            return None
        keep = tot["complete"]
        series = {"harmonized": np.where(keep, tot["total"], np.nan),
                  "naiveSum": np.where(keep, tot["modis"] + tot["viirs"], np.nan).astype(float),
                  "rawModis": np.where(keep, tot["modis"], np.nan).astype(float)}
        out = {}
        for product in PRODUCTS:
            frames = [self.burned.monthly(product, b, str(months[0]), str(months[-1])) for b in bboxes]
            witness = np.sum([f.burnedKm2.to_numpy(float) for f in frames], axis=0)   # NaN unless every bbox has the month
            if (~np.isnan(witness)).sum() >= 24:
                out[product] = seam_test(months, series, witness, witness_name=product)
        return out or None

    def _ensure_regions_for_bboxes(
        self,
        bboxes: tuple[tuple[float, float, float, float], ...],
        wait: bool = False,
        priority_window: tuple[dt.date, dt.date] | None = None,
    ) -> list[Region]:
        seen: dict[str, Region] = {}
        total_done = 0
        total_chunks = 0
        not_ready = False
        for b in bboxes:
            try:
                reg = self.ensure_data(b, wait=wait, priority_window=priority_window)
                seen[reg.key] = reg
            except NotReady as nr:
                not_ready = True
                total_done += int(nr.progress.get("done", 0))
                total_chunks += int(nr.progress.get("total", 0))
        if not_ready:
            raise NotReady({"done": total_done, "total": total_chunks})
        return list(seen.values())

    def calendar(self, bbox_text: str, date_from: str | None = None, date_to: str | None = None, wait: bool = False) -> dict:
        """The API payload: full harmonized calendar of the bbox(es) plus a summary of the selected period."""
        bboxes = parse_bboxes(bbox_text)
        bbox = envelope_bbox(bboxes)
        prio_window = None
        if date_from and date_to:
            p_start = parse_day(date_from, end=False).date()
            p_end = parse_day(date_to, end=True).date()
            if p_start <= p_end:
                prio_window = (p_start, p_end)
        regions = self._ensure_regions_for_bboxes(bboxes, wait=wait, priority_window=prio_window)
        region = regions[0]
        h = self._harmonized(regions, bboxes)
        cube: hz.Cube = h["cube"]
        months = [str(m) for m in cube.months]
        tot = self._totals(h)
        modis_cell, viirs_cell, modis, viirs = tot["modis_cell"], tot["viirs_cell"], tot["modis"], tot["viirs"]
        total, sd, complete = tot["total"], tot["sd"], tot["complete"]
        z, pct, clim_mean, clim_std = hz.calendar_stats(total, cube.cal_month, complete)
        lo90, hi90 = np.maximum(total - 1.645 * sd, 0), total + 1.645 * sd
        extra_series = {}
        if hasattr(hz, "median_stats"):  # v3: leave-one-out median of the same calendar month
            ms = hz.median_stats(total, cube.cal_month, complete, lo90, hi90)
            extra_series.update({"otherYearsMedian": _clean(ms["otherYearsMedian"], 1), "pctOfMedian": _clean(ms["pctOfMedian"], 1),
                                 "withinNormal": _clean(ms["withinNormal"], 0)})
        if "smallFires" in h:  # v3: small fires per VIIRS satellite, the explanatory layer (not in the count)
            small_total = np.nansum(h["smallFires"], axis=0) if len(cube.cells) else np.full(len(cube.months), np.nan)
            no_viirs = np.isnan(h["smallFires"]).all(axis=0) if len(cube.cells) else np.ones(len(cube.months), dtype=bool)
            extra_series["smallFiresPerViirsSatellite"] = _clean(np.where(no_viirs, np.nan, small_total), 1)
        years = sorted(set(cube.years.tolist()))

        # selected period: exact date bounds [first, last]
        first = parse_day(date_from, end=False) if date_from else cube.months[0].start_time
        last = parse_day(date_to, end=True) if date_to else cube.months[-1].end_time.normalize()
        if first > last:
            raise BadRequest("from must not be after to")
        t0 = int(np.clip((first.year - cube.months[0].year) * 12 + first.month - cube.months[0].month, 0, len(months) - 1))
        t1 = int(np.clip((last.year - cube.months[0].year) * 12 + last.month - cube.months[0].month, t0, len(months) - 1))
        window = np.arange(t0, t1 + 1)

        first_is_partial = first.year == cube.months[t0].year and first.month == cube.months[t0].month and first.day > 1
        last_end_day = cube.months[t1].end_time.normalize()
        last_is_partial = last.year == cube.months[t1].year and last.month == cube.months[t1].month and last < last_end_day
        partial_yms: set[str] = set()
        if first_is_partial:
            partial_yms.add(months[t0])
        if last_is_partial:
            partial_yms.add(months[t1])
        full_window = np.array([i for i in window if months[i] not in partial_yms], dtype=int)

        # Exact selection stats for FRP, active fire days, peak day, daily buckets, and partial boundary months
        sel_df = h["df"]
        in_win = sel_df[(sel_df.date >= first) & (sel_df.date <= last)]
        frp_vals = in_win.frp.dropna()
        total_frp = float(frp_vals.sum()) if len(frp_vals) else 0.0
        mean_frp = float(frp_vals.mean()) if len(frp_vals) else 0.0
        day_counts = in_win.acq_date.value_counts() if len(in_win) else pd.Series(dtype=int)
        active_days = int(len(day_counts))
        peak_date = str(day_counts.index[0]) if len(day_counts) else None
        peak_count = int(day_counts.iloc[0]) if len(day_counts) else 0
        frp_by_year = sel_df.groupby(sel_df.date.dt.year)["frp"].sum().to_dict() if len(sel_df) else {}

        raw_tot_arr = modis + viirs
        scale_by_ym = {
            months[i]: float(total[i] / raw_tot_arr[i]) if (not np.isnan(total[i]) and raw_tot_arr[i] > 0) else 1.0
            for i in range(len(months))
        }

        value = float(np.nansum(total[full_window])) if len(full_window) else 0.0
        raw_modis = int(modis[full_window].sum()) if len(full_window) else 0
        raw_viirs = int(viirs[full_window].sum()) if len(full_window) else 0
        partial_in_win = (
            in_win[in_win.acq_date.str.slice(0, 7).isin(partial_yms)]
            if (partial_yms and len(in_win))
            else in_win.iloc[0:0]
        )
        if len(partial_in_win):
            p_w = partial_in_win.acq_date.str.slice(0, 7).map(scale_by_ym).fillna(1.0)
            value += float(p_w.sum())
            raw_modis += int(partial_in_win.platform.isin(hz.MODIS).sum())
            raw_viirs += int(partial_in_win.platform.isin(hz.VIIRS).sum())

        ym_day_harm: dict[tuple[str, int], float] = {}
        if partial_yms and len(sel_df):
            sel_ym = sel_df.acq_date.str.slice(0, 7)
            sel_w = sel_ym.map(scale_by_ym).fillna(1.0)
            for (ym_k, day_k), v_k in sel_w.groupby([sel_ym, sel_df.date.dt.day]).sum().items():
                ym_day_harm[(str(ym_k), int(day_k))] = float(v_k)

        same_window = {}
        for y in years:  # the same calendar window in every year, for "how does this compare with previous years"
            start = np.flatnonzero((cube.years == y) & (cube.cal_month == cube.cal_month[t0]))
            if len(start) and start[0] + len(window) <= len(months) and not np.isnan(total[start[0]:start[0] + len(window)]).any():
                if not partial_yms:
                    same_window[y] = float(total[start[0]:start[0] + len(window)].sum())
                else:
                    yr_sum = 0.0
                    for k in range(len(window)):
                        idx = int(start[0] + k)
                        if len(window) == 1:
                            min_d = first.day if first_is_partial else 1
                            max_d = last.day if last_is_partial else 31
                            yr_sum += sum(ym_day_harm.get((months[idx], d), 0.0) for d in range(min_d, max_d + 1))
                        elif k == 0 and first_is_partial:
                            yr_sum += sum(ym_day_harm.get((months[idx], d), 0.0) for d in range(first.day, 32))
                        elif k == len(window) - 1 and last_is_partial:
                            yr_sum += sum(ym_day_harm.get((months[idx], d), 0.0) for d in range(1, last.day + 1))
                        else:
                            yr_sum += float(total[idx])
                    same_window[y] = yr_sum
        others = np.array([v for y, v in same_window.items() if y != int(cube.years[t0])])

        cell_acc: dict[str, list[float]] = {}
        for c, cell in enumerate(cube.cells):
            cell_value = float(np.nansum(h["harmonized"][c, full_window])) if len(full_window) else 0.0
            cell_m = int(modis_cell[c, full_window].sum()) if len(full_window) else 0
            cell_v = int(viirs_cell[c, full_window].sum()) if len(full_window) else 0
            if cell_value > 0 or cell_m > 0 or cell_v > 0:
                cell_acc[cell] = [cell_value, cell_m, cell_v]
        if len(partial_in_win):
            h3_res = h3.get_resolution(cube.cells[0]) if len(cube.cells) else int(h.get("h3Resolution", 4))
            p_cells = [h3.latlng_to_cell(float(la), float(lo), h3_res) for la, lo in zip(partial_in_win.latitude, partial_in_win.longitude)]
            p_frame = pd.DataFrame({
                "cell": p_cells,
                "harm": partial_in_win.acq_date.str.slice(0, 7).map(scale_by_ym).fillna(1.0).to_numpy(),
                "modis": partial_in_win.platform.isin(hz.MODIS).astype(int).to_numpy(),
                "viirs": partial_in_win.platform.isin(hz.VIIRS).astype(int).to_numpy(),
            })
            for cell, row in p_frame.groupby("cell").sum().iterrows():
                cur = cell_acc.setdefault(str(cell), [0.0, 0, 0])
                cur[0] += float(row["harm"])
                cur[1] += int(row["modis"])
                cur[2] += int(row["viirs"])
        cells = []
        for cell, (cell_value, cell_m, cell_v) in cell_acc.items():
            if cell_value > 0:
                lat, lon = h3.cell_to_latlng(cell)
                cells.append({"h3": cell, "lon": round(lon, 4), "lat": round(lat, 4), "harmonized": round(cell_value, 2),
                              "rawModis": int(cell_m), "rawViirs": int(cell_v)})

        daily_buckets = []
        daily_by_year: dict[str, list[dict]] = {}
        if len(sel_df):
            n_base_years = max(1, sel_df.date.dt.year.nunique())
            base_mmdd = sel_df.acq_date.str.slice(5, 10)
            base_w = sel_df.acq_date.str.slice(0, 7).map(scale_by_ym).fillna(1.0)
            base_avg_map = base_w.groupby(base_mmdd).sum().div(n_base_years).to_dict()

            if len(in_win):
                win_year = in_win.acq_date.str.slice(0, 4)
                win_mmdd = in_win.acq_date.str.slice(5, 10)
                win_is_modis = in_win.platform.isin(hz.MODIS).astype(int)
                win_is_viirs = in_win.platform.isin(hz.VIIRS).astype(int)
                win_w = in_win.acq_date.str.slice(0, 7).map(scale_by_ym).fillna(1.0)
                win_frame = pd.DataFrame({
                    "harm": win_w,
                    "modis": win_is_modis,
                    "viirs": win_is_viirs,
                    "frp": in_win.frp.fillna(0.0),
                })
                grouped = win_frame.groupby(win_mmdd).sum()
                for mmdd, row in grouped.iterrows():
                    daily_buckets.append({
                        "mmdd": str(mmdd),
                        "harmonized": round(float(row["harm"]), 1),
                        "rawModis": int(row["modis"]),
                        "rawViirs": int(row["viirs"]),
                        "frpMw": round(float(row["frp"])),
                        "baselineAvg": round(float(base_avg_map.get(mmdd, 0.0)), 2),
                    })
                grouped_yr = win_frame.groupby([win_year, win_mmdd]).sum()
                for (yr, mmdd), row in grouped_yr.iterrows():
                    daily_by_year.setdefault(str(yr), []).append({
                        "mmdd": str(mmdd),
                        "harmonized": round(float(row["harm"]), 1),
                        "rawModis": int(row["modis"]),
                        "rawViirs": int(row["viirs"]),
                        "frpMw": round(float(row["frp"])),
                        "baselineAvg": round(float(base_avg_map.get(mmdd, 0.0)), 2),
                    })

        pixel_df = h["pixel_df"]
        pixel_win = pixel_df[(pixel_df.date >= first) & (pixel_df.date <= last)]
        viirs_start = pd.Timestamp("2012-01-20")
        pixels = []

        def _append_pixel_groups(df_slice: pd.DataFrame, sensor_name: str, pre_viirs: bool, cap: int) -> None:
            if not len(df_slice):
                return
            grp = pd.DataFrame({
                "lat": df_slice.latitude.round(4),
                "lon": df_slice.longitude.round(4),
                "frp": df_slice.frp.fillna(0.0),
                "n": 1,
            }).groupby(["lat", "lon"], as_index=False).sum()
            if len(grp) > cap:
                grp = grp.nlargest(cap, "frp")
            for row in grp.itertuples(index=False):
                pixels.append({
                    "lon": float(row.lon),
                    "lat": float(row.lat),
                    "sensor": sensor_name,
                    "preViirs": pre_viirs,
                    "count": int(row.n),
                    "frpMw": round(float(row.frp), 1),
                })

        if len(pixel_win):
            viirs_sub = pixel_win[pixel_win.platform.isin(hz.VIIRS)]
            _append_pixel_groups(viirs_sub, "VIIRS", False, 2500)

            modis_sub = pixel_win[pixel_win.platform.isin(hz.MODIS)]
            if len(modis_sub):
                pre_sub = modis_sub[modis_sub.date < viirs_start]
                post_sub = modis_sub[modis_sub.date >= viirs_start]
                if len(pre_sub) and len(post_sub):
                    _append_pixel_groups(pre_sub, "MODIS", True, 1500)
                    _append_pixel_groups(post_sub, "MODIS", False, 1500)
                elif len(pre_sub):
                    _append_pixel_groups(pre_sub, "MODIS", True, 2500)
                else:
                    _append_pixel_groups(post_sub, "MODIS", False, 2500)

        job = self._job(region)
        return {
            "metadata": {
                "bbox": list(bbox), "cachedRegion": list(region.bbox), "h3Resolution": h["h3Resolution"],
                "months": [months[0], months[-1]], "dataThrough": f"{h['availability'].horizon:%Y-%m-%d}",
                "monthInProgress": None if complete[-1] else months[-1],
                "refreshing": bool(job and not job["finished"]),
                "failedChunks": len(job["failed"]) if job else 0,
                "metric": "hotspotCount",
                "unit": "MODIS-equivalent hot spots (Terra + Aqua, vegetation fires, confidence >= 30 / nominal)",
                "platforms": h["availability"].to_json(), "calibration": h["calibration"],
                "license": "NASA FIRMS, US Government public domain", "attribution": ATTRIBUTION,
            },
            "months": months,
            "series": {
                "rawModis": _clean(modis, 0), "rawViirs": _clean(viirs, 0), "naiveSum": _clean(modis + viirs, 0),
                "harmonized": _clean(total, 1),
                "harmonizedLo90": _clean(lo90, 1), "harmonizedHi90": _clean(hi90, 1),
                "anomalyZ": _clean(z), "percentile": _clean(pct, 1), **extra_series,
            },
            "calendar": {  # year x month matrix of harmonized hot spots, ready for the heat map
                "years": years,
                "harmonized": [[None if not ((cube.years == y) & (cube.cal_month == m)).any() or np.isnan(total[(cube.years == y) & (cube.cal_month == m)][0])
                                else round(float(total[(cube.years == y) & (cube.cal_month == m)][0]), 1) for m in range(12)] for y in years],
            },
            "climatology": {"monthMean": _clean(clim_mean, 1), "monthStd": _clean(clim_std, 1)},
            "yearly": [{"year": y, "rawModis": int(modis[cube.years == y].sum()), "rawViirs": int(viirs[cube.years == y].sum()),
                        "harmonized": round(float(np.nansum(total[cube.years == y])), 1),
                        "frpMw": round(float(frp_by_year.get(y, 0.0))),
                        "monthsWithData": int((~np.isnan(total[cube.years == y])).sum())} for y in years],
            "selection": {
                "from": months[t0], "to": months[t1],
                "fromDate": str(first.date()), "toDate": str(last.date()),
                "hotspots": {"harmonized": round(value, 1), "rawModis": raw_modis, "rawViirs": raw_viirs},
                "frp": {
                    "totalMw": round(total_frp),
                    "meanMw": round(mean_frp, 1),
                    "activeFireDays": active_days,
                    "peakDate": peak_date,
                    "peakCount": peak_count,
                },
                "daily": daily_buckets,
                "dailyByYear": daily_by_year,
                "comparedWithSameMonthsInOtherYears": {
                    "years": len(others), "median": round(float(np.median(others)), 1) if len(others) else None,
                    "percentile": round(100 * float((others < value).mean()), 1) if len(others) else None,
                    "rank": int((others > value).sum()) + 1 if len(others) else None,
                    "top5": sorted(({"year": y, "harmonized": round(v, 1)} for y, v in same_window.items()), key=lambda r: -r["harmonized"])[:5],
                },
                "cells": cells,
                "pixels": pixels,
            },
            "validation": h["validation"],
            "seamTest": self._seam_tests(bboxes, h, tot),
        }

    # -- burned area (independent witness for the seam test) ---------------------------------------

    def _start_burned(self, key: tuple, product: str, bbox: tuple, first: str, last: str) -> dict:
        job = {"done": 0, "total": 0, "finished": False, "error": None, "failed": [], "finishedAt": None}

        def work() -> None:
            try:
                outcome = self.burned.fetch(product, bbox, first, last, progress=lambda done, total: job.update(done=done, total=total))
                job["failed"] = outcome["failed"]
            except Exception as exc:  # the thread must always finish the job record
                job["error"] = str(exc)
            finally:
                job["finished"], job["finishedAt"] = True, time.time()

        job["thread"] = threading.Thread(target=work, name=f"burned-area-{product}", daemon=True)
        with self._lock:
            self._burned_jobs[key] = job
        job["thread"].start()
        return job

    def burned_area(self, bbox_text: str, product: str = "MCD64A1", date_from: str | None = None, date_to: str | None = None,
                    wait: bool = False) -> dict:
        """Monthly burned area of the bbox, downloaded from LP DAAC in the background on first use.

        Adds the seam test of the hot-spot calendar when FIRMS data of the bbox are already cached.
        """
        bbox = parse_bbox(bbox_text)
        if (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > BURNED_AREA_MAX_DEG2:
            raise BadRequest(f"burned area is served for bboxes up to {BURNED_AREA_MAX_DEG2:g} square degrees")
        product = product.upper()
        if product not in PRODUCTS:
            raise BadRequest(f"product must be one of {', '.join(PRODUCTS)}")
        start = pd.Period(PRODUCTS[product]["first"], "M")
        newest = pd.Timestamp(dt.date.today() - dt.timedelta(days=BURNED_AREA_LATENCY_DAYS)).to_period("M")
        first = max(parse_day(date_from, end=False).to_period("M"), start) if date_from else start
        last = min(parse_day(date_to, end=True).to_period("M"), newest) if date_to else newest
        if first > last:
            raise BadRequest("from must not be after to; burned area is published about 2-3 months after the month")
        first, last = str(first), str(last)
        frame = self.burned.monthly(product, bbox, first, last)
        key = (product, bbox, first, last)
        with self._lock:
            job = self._burned_jobs.get(key)
        if not frame.complete.all():
            if not self.burned.online:
                if not frame.complete.any():
                    raise BadRequest("EARTHDATA_TOKEN is not set and there is no cached burned area for this area")
            else:
                retry = bool(job and job["finished"] and (job["error"] or job["failed"])
                             and time.time() - job["finishedAt"] > BURNED_AREA_RETRY_S)
                if job is None or retry:
                    job = self._start_burned(key, product, bbox, first, last)
                if wait:
                    job["thread"].join()
                frame = self.burned.monthly(product, bbox, first, last)
                if job["error"] and not frame.complete.any():
                    raise BurnedAreaError(job["error"])
                if not frame.complete.any():
                    raise NotReady({"done": job["done"], "total": job["total"]})
        region = self.store.find(bbox)
        seam = None
        if region is not None and region.has_data:
            h = self._harmonized([region], (bbox,))
            seam = (self._seam_tests((bbox,), h, self._totals(h)) or {}).get(product)
        km2 = frame.burnedKm2.to_numpy(float)
        years = frame.month.str.slice(0, 4).astype(int).to_numpy()
        return {
            "metadata": {
                "product": product, "sensor": PRODUCTS[product]["sensor"], "bbox": list(bbox), "months": [first, last],
                "tiles": sorted(f"h{th:02d}v{tv:02d}" for th, tv in tiles_for_bbox(bbox)), "pixelKm2": round(PIXEL_KM2, 4),
                "monthsComplete": int(frame.complete.sum()), "refreshing": bool(job and not job["finished"]),
                "failedGranules": len(job["failed"]) if job else 0,
                "unit": "km2 of burned 463 m pixels whose centre lies in the bbox",
                "license": "NASA LP DAAC, US Government public domain", "citation": PRODUCTS[product]["citation"],
            },
            "months": frame.month.tolist(),
            "series": {"burnedKm2": _clean(km2, 2)},
            "yearly": [{"year": int(y), "burnedKm2": round(float(np.nansum(km2[years == y])), 1),
                        "monthsWithData": int((~np.isnan(km2[years == y])).sum())} for y in np.unique(years)],
            "seamTest": seam,
        }

    def hotspots_csv(self, bbox_text: str, date_from: str | None = None, date_to: str | None = None, wait: bool = False) -> str:
        """CSV of every hot spot found in the search. `used_in_calendar` tells which rows passed the QA."""
        bboxes = parse_bboxes(bbox_text)
        regions = self._ensure_regions_for_bboxes(bboxes, wait=wait)
        if len(regions) == 1:
            df = regions[0].frame()
        else:
            df = pd.concat([r.frame() for r in regions], ignore_index=True).drop_duplicates(
                ["platform", "latitude", "longitude", "acq_date", "acq_time"]
            )
        keep = pd.Series(False, index=df.index)
        for w, s, e, n in bboxes:
            keep |= df.latitude.between(s, n) & df.longitude.between(w, e)
        if date_from:
            keep &= df.date >= parse_day(date_from, end=False)
        if date_to:
            keep &= df.date <= parse_day(date_to, end=True)
        out = df.loc[keep, [c for c in CSV_COLUMNS if c in df]].copy()
        out["platform"] = df.platform[keep]
        out["used_in_calendar"] = df.qa_pass[keep]
        if hasattr(hz, "extras") and len(regions) == 1:  # v3: MODIS-equivalent weight (sums to the calendar) and small-fire flag
            h = self._harmonized(regions, bboxes)
            out["weight"] = h["weights"].reindex(out.index).fillna(0.0).round(5)
            if "small" in df:
                out["small_fire"] = df.small[keep]
        return out.sort_values(["acq_date", "acq_time"]).to_csv(index=False)
