"""Burning-activity calendar for a user-selected bounding box and date range."""
from __future__ import annotations

import datetime as dt
import threading

import h3
import numpy as np
import pandas as pd

from .harmonization_select import hz
from .firms import FirmsClient, FirmsError, Region, RegionStore

ATTRIBUTION = ("We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management "
               "System (FIRMS) (https://www.earthdata.nasa.gov/firms), part of NASA's Earth Science Data and "
               "Information System (ESDIS). MODIS Collection 6.1 and VIIRS 375 m active fire products. "
               "Harmonized by KMD Labs.")
CSV_COLUMNS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "confidence", "version", "frp", "daynight", "type"]
MAX_BBOX_DEG2 = 8000.0  # up to ~90 x 88 degrees; larger requests are refused


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

    def __init__(self, store: RegionStore | None = None, client: FirmsClient | None = None):
        self.store = store or RegionStore()
        self.client = client or FirmsClient()
        self._jobs: dict[str, dict] = {}
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
        if job is None or (job["finished"] and job["error"] is None and self._needs_sync(region)) or (job["finished"] and job["error"]):
            job = self._start(region, priority_window=priority_window)
        if wait:
            job["thread"].join()
        if job["error"] and not region.has_data:
            raise FirmsError(job["error"])
        if not region.has_data:
            raise NotReady({"done": job["done"], "total": job["total"]})
        return region

    def _needs_sync(self, region: Region) -> bool:
        from .firms import today_utc
        return bool(region.plan(self.client.availability(), today_utc()))

    def _start(self, region: Region, priority_window: tuple[dt.date, dt.date] | None = None) -> dict:
        job = {"done": 0, "total": 0, "finished": False, "error": None, "failed": []}

        def work() -> None:
            try:
                outcome = region.sync(
                    self.client,
                    progress=lambda done, total: job.update(done=done, total=total),
                    priority_window=priority_window,
                )
                job["failed"] = outcome["failed"]
            except Exception as exc:  # the thread must always finish the job record
                job["error"] = str(exc)
            finally:
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
        for w, s, e, n in bboxes:
            mask |= frame.latitude.between(s, n) & frame.longitude.between(w, e)
        df = frame[mask & frame.qa_pass]
        avail = regions[0].availability()
        env = envelope_bbox(bboxes)
        res = hz.pick_h3_resolution(env)
        cube = hz.build_cube(df, avail, res)
        eff, regional, calibration = hz.fit_efficiency(cube)
        harmonized_res = hz.harmonize_full(cube, eff)
        out = {"cube": cube, "res": harmonized_res, "harmonized": harmonized_res.values, "sd": harmonized_res.sd,
               "calibration": calibration, "h3Resolution": res,
               "validation": hz.validate(cube) if len(cube.cells) else None, "availability": avail,
               "df": df[["date", "acq_date", "frp", "platform"]].copy()}
        if hasattr(hz, "extras"):  # v3: weight per detection and the small-fire layer
            out.update(hz.extras(cube, eff, df))
        with self._lock:
            if len(self._results) > 32:
                self._results.pop(next(iter(self._results)))
            self._results[key] = out
        return out

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
        modis_cell = cube.counts[hz.PLATFORMS.index("TERRA")] + cube.counts[hz.PLATFORMS.index("AQUA")]
        viirs_cell = cube.counts[[hz.PLATFORMS.index(p) for p in hz.VIIRS]].sum(axis=0)
        modis, viirs = modis_cell.sum(axis=0), viirs_cell.sum(axis=0)
        empty = np.isnan(h["harmonized"]).all(axis=0) if len(cube.cells) else (cube.exposure.sum(axis=0) == 0)
        total, lo90, hi90 = hz.total_interval(cube, h["res"])
        total = np.where(empty, np.nan, total)
        lo90 = np.where(empty, np.nan, lo90)
        hi90 = np.where(empty, np.nan, hi90)
        complete = cube.observed >= 0.999
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

        # selected period: whole months between the two dates
        first = parse_day(date_from, end=False) if date_from else cube.months[0].start_time
        last = parse_day(date_to, end=True) if date_to else cube.months[-1].end_time.normalize()
        if first > last:
            raise BadRequest("from must not be after to")
        t0 = int(np.clip((first.year - cube.months[0].year) * 12 + first.month - cube.months[0].month, 0, len(months) - 1))
        t1 = int(np.clip((last.year - cube.months[0].year) * 12 + last.month - cube.months[0].month, t0, len(months) - 1))
        window = np.arange(t0, t1 + 1)
        value = float(np.nansum(total[window]))
        same_window = {}
        for y in years:  # the same calendar months in every year, for "how does this compare with previous years"
            start = np.flatnonzero((cube.years == y) & (cube.cal_month == cube.cal_month[t0]))
            if len(start) and start[0] + len(window) <= len(months) and not np.isnan(total[start[0]:start[0] + len(window)]).any():
                same_window[y] = float(total[start[0]:start[0] + len(window)].sum())
        others = np.array([v for y, v in same_window.items() if y != int(cube.years[t0])])
        cells = []
        for c, cell in enumerate(cube.cells):
            cell_value = float(np.nansum(h["harmonized"][c, window]))
            if cell_value > 0:
                lat, lon = h3.cell_to_latlng(cell)
                cells.append({"h3": cell, "lon": round(lon, 4), "lat": round(lat, 4), "harmonized": round(cell_value, 2),
                              "rawModis": int(modis_cell[c, window].sum()), "rawViirs": int(viirs_cell[c, window].sum())})

        # Exact selection stats for FRP, active fire days, peak day, and Month x Day matrix
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

        daily_buckets = []
        if len(sel_df):
            raw_tot_arr = modis + viirs
            scale_by_ym = {
                months[i]: float(total[i] / raw_tot_arr[i]) if (not np.isnan(total[i]) and raw_tot_arr[i] > 0) else 1.0
                for i in range(len(months))
            }
            n_base_years = max(1, sel_df.date.dt.year.nunique())
            base_mmdd = sel_df.acq_date.str.slice(5, 10)
            base_w = sel_df.acq_date.str.slice(0, 7).map(scale_by_ym).fillna(1.0)
            base_avg_map = base_w.groupby(base_mmdd).sum().div(n_base_years).to_dict()

            if len(in_win):
                win_mmdd = in_win.acq_date.str.slice(5, 10)
                win_is_modis = in_win.platform.isin(hz.MODIS).astype(int)
                win_is_viirs = in_win.platform.isin(hz.VIIRS).astype(int)
                win_w = in_win.acq_date.str.slice(0, 7).map(scale_by_ym).fillna(1.0)
                grouped = pd.DataFrame({
                    "harm": win_w,
                    "modis": win_is_modis,
                    "viirs": win_is_viirs,
                    "frp": in_win.frp.fillna(0.0),
                }).groupby(win_mmdd).sum()
                for mmdd, row in grouped.iterrows():
                    daily_buckets.append({
                        "mmdd": str(mmdd),
                        "harmonized": round(float(row["harm"]), 1),
                        "rawModis": int(row["modis"]),
                        "rawViirs": int(row["viirs"]),
                        "frpMw": round(float(row["frp"])),
                        "baselineAvg": round(float(base_avg_map.get(mmdd, 0.0)), 2),
                    })

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
                "hotspots": {"harmonized": round(value, 1), "rawModis": int(modis[window].sum()), "rawViirs": int(viirs[window].sum())},
                "frp": {
                    "totalMw": round(total_frp),
                    "meanMw": round(mean_frp, 1),
                    "activeFireDays": active_days,
                    "peakDate": peak_date,
                    "peakCount": peak_count,
                },
                "daily": daily_buckets,
                "comparedWithSameMonthsInOtherYears": {
                    "years": len(others), "median": round(float(np.median(others)), 1) if len(others) else None,
                    "percentile": round(100 * float((others < value).mean()), 1) if len(others) else None,
                    "rank": int((others > value).sum()) + 1 if len(others) else None,
                    "top5": sorted(({"year": y, "harmonized": round(v, 1)} for y, v in same_window.items()), key=lambda r: -r["harmonized"])[:5],
                },
                "cells": cells,
            },
            "validation": h["validation"],
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
            h = self._harmonized(regions[0], bboxes[0])
            out["weight"] = h["weights"].reindex(out.index).fillna(0.0).round(5)
            if "small" in df:
                out["small_fire"] = df.small[keep]
        return out.sort_values(["acq_date", "acq_time"]).to_csv(index=False)
