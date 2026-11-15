"""Global validation of harmonization v4 (MODIS orbit-drift model) on fire regions around the world.

v4 is the version under test; v3 runs on the same data as the reference (add v1 with --versions v4,v3,v1).

Meant to run overnight and be resumed if it stops:

    python scripts/validation/global_validation.py                              # everything
    python scripts/validation/global_validation.py --regions california,zambia  # a subset
    python scripts/validation/global_validation.py --witness none               # no burned-area download
    python scripts/validation/global_validation.py --stage report               # rebuild the report only
    python scripts/validation/global_validation.py --list                       # show the regions

What it does, per region (a 3-6 degree box in one country, see REGIONS):
  1. Download: NASA FIRMS yearly country CSVs (public, no key): MODIS 2000-2025, VIIRS Suomi NPP 2012-2025,
     NOAA-20 2018-2025. Each file is streamed once and filtered to every region in that country, so only the
     region's rows are stored. NOAA-21 has no yearly files; with FIRMS_MAP_KEY (.env) it comes from the Area API
     (VIIRS_NOAA21_SP, 2023-2025).
  2. Validate v4 (and the reference versions) on the same data:
       - its own `validate()` (v3/v4: blocked k-fold over years, VIIRS alone predicts raw MODIS; v1: even/odd years),
         reported by era 2012-2019 / 2020-2022 / 2023+,
       - forward test: fit on years <= 2023, predict raw MODIS in 2024 and 2025 from VIIRS alone (v4 through its
         drift law), which is where the MODIS orbit drift is largest,
       - the 2012 jump: harmonized, naive (MODIS + VIIRS) and MODIS-only, 2013-2015 over 2009-2011,
       - v4: measured overpass shift of Terra and Aqua and the fitted drift law.
  3. Witness (EARTHDATA_TOKEN): monthly burned area (MCD64A1 and/or VNP64A1) for the box and the seam test of
     each version's harmonized series at the Suomi NPP, NOAA-20 and NOAA-21 seams.
  4. Report: <out>/report.md, <out>/summary.csv, <out>/regions/<name>.json, <out>/run.log.

Resumable: downloaded files and finished regions are kept (data/cache/global_validation); --force redoes regions.
Expect several GB of downloads (only the regions' rows are stored) and a few hours in total.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import importlib
import io
import json
import math
import os
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd
import requests

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

FIRMS = "https://firms.modaps.eosdis.nasa.gov"
PRODUCTS = {  # yearly country files: product -> (first year, last year)
    "modis": (2000, 2025),
    "viirs-snpp": (2012, 2025),
    "viirs-jpss1": (2018, 2025),
}
HORIZON = pd.Timestamp("2025-12-31")    # last day of the yearly files; the whole validation stops here
NOAA21_SOURCE = "VIIRS_NOAA21_SP"
KEEP = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "confidence", "version",
        "frp", "daynight", "type", "scan", "track"]
VERSIONS = {"v1": "backend.harmonization", "v2": "backend.harmonization2", "v3": "backend.harmonization3", "v4": "backend.harmonization4"}

# name, FIRMS country file name, biome, bbox (W, S, E, N), note
REGIONS = [
    ("portugal_centro", "Portugal", "mediterranean", (-8.7, 39.6, -7.0, 41.0), "reference region of the project"),
    ("greece", "Greece", "mediterranean", (21.0, 37.0, 24.5, 40.5), "summer wildfires, crop burning"),
    ("turkey_sw", "Turkey", "mediterranean", (27.0, 36.0, 31.0, 38.5), "2021 megafires"),
    ("california", "United_States", "mediterranean", (-123.0, 37.0, -119.5, 41.0), "large wildfires"),
    ("us_southeast", "United_States", "temperate", (-85.0, 30.0, -81.0, 33.5), "prescribed burning, many small fires"),
    ("canada_alberta", "Canada", "boreal", (-118.0, 55.0, -112.0, 59.0), "boreal crown fires, 2023 record"),
    ("russia_transbaikal", "Russian_Federation", "boreal", (116.0, 50.0, 122.0, 54.0), "boreal and steppe fires"),
    ("kazakhstan_steppe", "Kazakhstan", "grassland", (62.0, 47.0, 68.0, 51.0), "steppe fires"),
    ("mexico_yucatan", "Mexico", "tropical_forest", (-92.0, 17.0, -88.0, 21.0), "dry-season clearing"),
    ("brazil_rondonia", "Brazil", "tropical_forest", (-63.5, -11.5, -60.5, -8.5), "deforestation arc"),
    ("brazil_cerrado", "Brazil", "savanna", (-49.0, -11.0, -46.0, -8.0), "savanna burning"),
    ("bolivia_chiquitania", "Bolivia", "tropical_forest", (-62.0, -18.0, -59.0, -15.0), "dry forest, 2019 and 2024 fires"),
    ("argentina_chaco", "Argentina", "savanna", (-62.0, -27.0, -59.0, -24.0), "Chaco clearing and grassland"),
    ("ghana_north", "Ghana", "savanna", (-2.5, 8.5, 0.5, 11.0), "West African savanna, Dec-Feb season"),
    ("south_sudan", "South_Sudan", "savanna", (27.0, 6.0, 30.0, 9.0), "very high fire density"),
    ("zambia", "Zambia", "savanna", (24.0, -15.0, 27.0, -12.0), "miombo woodland, May-Oct season"),
    ("mozambique", "Mozambique", "savanna", (35.0, -18.0, 38.0, -14.0), "miombo woodland"),
    ("india_punjab", "India", "cropland", (74.0, 29.5, 77.0, 32.0), "rice-residue burning, timing sensitive"),
    ("thailand_north", "Thailand", "tropical_forest", (98.0, 17.0, 101.0, 20.0), "dry-season burning"),
    ("indonesia_kalimantan", "Indonesia", "peat", (112.0, -3.5, 115.0, -0.5), "peat fires, El Nino years"),
    ("australia_top_end", "Australia", "savanna", (131.0, -15.0, 135.0, -12.0), "tropical savanna"),
    ("australia_se", "Australia", "temperate", (147.0, -37.5, 151.0, -34.0), "2019-2020 Black Summer"),
]
REGION_BY_NAME = {r[0]: r for r in REGIONS}
ERA_KEYS = (("2012", "2012-2019"), ("2020", "2020-2022"), ("2023", "2023+"))


# ----------------------------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------------------------

LOG_PATH: Path | None = None


def log(msg: str) -> None:
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line, flush=True)
    if LOG_PATH:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _write_frame(path: Path, df: pd.DataFrame) -> None:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
        gz.write(df.reindex(columns=KEEP).to_csv(index=False).encode("utf-8"))
    _atomic_write_bytes(path, buf.getvalue())


# ----------------------------------------------------------------------------------------------
# 1. Download
# ----------------------------------------------------------------------------------------------

def _region_file(cache: Path, region: str, product: str, year: int) -> Path:
    return cache / "regions" / region / f"{product}_{year}.csv.gz"


def _download_country_year(cache: Path, country: str, product: str, year: int, regions: list[tuple]) -> str:
    """Stream one FIRMS yearly country file and keep each region's rows. Returns a status line."""
    targets = [r for r in regions if not _region_file(cache, r[0], product, year).exists()]
    if not targets:
        return f"{product} {year} {country}: cached"
    url = f"{FIRMS}/data/country/{product}/{year}/{product}_{year}_{country}.csv"
    parts = {r[0]: [] for r in targets}
    size = 0
    for attempt in range(4):
        try:
            with requests.get(url, stream=True, timeout=600) as resp:
                if resp.status_code == 404:
                    for r in targets:
                        _write_frame(_region_file(cache, r[0], product, year), pd.DataFrame(columns=KEEP))
                    return f"{product} {year} {country}: not published (404), recorded as empty"
                resp.raise_for_status()
                resp.raw.decode_content = True
                parts = {r[0]: [] for r in targets}
                for chunk in pd.read_csv(resp.raw, dtype=str, chunksize=250_000, usecols=lambda c: c in KEEP):
                    size += len(chunk)
                    lat = pd.to_numeric(chunk.latitude, errors="coerce")
                    lon = pd.to_numeric(chunk.longitude, errors="coerce")
                    for name, _, _, (w, s, e, n), _ in targets:
                        keep = lat.between(s, n) & lon.between(w, e)
                        if keep.any():
                            parts[name].append(chunk[keep])
            break
        except Exception as exc:  # network hiccups: retry with back-off
            if attempt == 3:
                raise RuntimeError(f"{url}: {type(exc).__name__}: {exc}") from exc
            time.sleep(10 * (attempt + 1))
    kept = []
    for name, chunks in parts.items():
        df = pd.concat(chunks, ignore_index=True) if chunks else pd.DataFrame(columns=KEEP)
        _write_frame(_region_file(cache, name, product, year), df)
        kept.append(f"{name}={len(df)}")
    return f"{product} {year} {country}: {size:,} rows read, kept " + ", ".join(kept)


def download_firms(cache: Path, regions: list[tuple], workers: int) -> None:
    by_country: dict[str, list[tuple]] = {}
    for r in regions:
        by_country.setdefault(r[1], []).append(r)
    tasks = [(country, product, year, rs) for country, rs in by_country.items()
             for product, (a, b) in PRODUCTS.items() for year in range(a, b + 1)]
    todo = [t for t in tasks if any(not _region_file(cache, r[0], t[1], t[2]).exists() for r in t[3])]
    log(f"FIRMS yearly files: {len(tasks)} country-product-years, {len(todo)} to download ({workers} parallel)")
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_download_country_year, cache, c, p, y, rs): (c, p, y) for c, p, y, rs in todo}
        for fut in as_completed(futures):
            done += 1
            try:
                log(f"  [{done}/{len(todo)}] {fut.result()}")
            except Exception as exc:
                log(f"  [{done}/{len(todo)}] FAILED {futures[fut]}: {exc}")


def download_noaa21(cache: Path, regions: list[tuple], workers: int) -> None:
    from backend.firms import FirmsClient

    client = FirmsClient()
    if not client.online:
        log("NOAA-21: FIRMS_MAP_KEY is not set, the regions are validated without NOAA-21")
        return
    try:
        first, last = client.availability()[NOAA21_SOURCE]
    except Exception as exc:
        log(f"NOAA-21: availability failed ({exc}), skipped")
        return
    last = min(last, HORIZON.date())

    def one(region: tuple) -> str:
        name, _, _, bbox, _ = region
        path = cache / "regions" / name / "noaa21_api.csv.gz"
        if path.exists():
            return f"{name}: cached"
        frames, day = [], first
        while day <= last:
            n = min(5, (last - day).days + 1)
            for attempt in range(4):
                try:
                    frames.append(client.area(NOAA21_SOURCE, bbox, day, n))
                    break
                except Exception:
                    if attempt == 3:
                        raise
                    time.sleep(15 * (attempt + 1))
            day += dt.timedelta(days=n)
        df = pd.concat([f for f in frames if len(f)], ignore_index=True) if any(len(f) for f in frames) else pd.DataFrame(columns=KEEP)
        _write_frame(path, df)
        return f"{name}: {len(df):,} NOAA-21 detections"

    log(f"NOAA-21 from the Area API ({NOAA21_SOURCE}, {first} to {last})")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for fut in as_completed([pool.submit(one, r) for r in regions]):
            try:
                log("  " + fut.result())
            except Exception as exc:
                log(f"  NOAA-21 FAILED: {exc}")


def load_region(cache: Path, name: str) -> pd.DataFrame:
    files = sorted((cache / "regions" / name).glob("*.csv.gz"))
    frames = [pd.read_csv(f, dtype=str) for f in files]
    frames = [f for f in frames if len(f)]
    if not frames:
        return pd.DataFrame(columns=KEEP)
    df = pd.concat(frames, ignore_index=True)
    return df[pd.to_datetime(df.acq_date, errors="coerce") <= HORIZON].reset_index(drop=True)


# ----------------------------------------------------------------------------------------------
# 2. Validation of one region (runs in a worker process)
# ----------------------------------------------------------------------------------------------

def _availability(mod, norm: pd.DataFrame):
    first, last = {}, {}
    for p in mod.PLATFORMS:
        rows = norm[norm.platform == p]
        if not len(rows):
            continue
        # NOAA-21 starts where its Area API record starts; the others at their known first day
        first[p] = rows.date.min().normalize() if p == "NOAA21" else pd.Timestamp(mod.DEFAULT_FIRST_DAY[p])
        last[p] = None
    try:
        return mod.Availability(first, last, HORIZON, {})
    except TypeError:  # v1 has no outages field
        return mod.Availability(first, last, HORIZON)


def _totals(values: np.ndarray, complete: np.ndarray) -> np.ndarray:
    empty = np.isnan(values).all(axis=0) if values.size else np.ones(values.shape[1], dtype=bool)
    tot = np.where(empty, np.nan, np.nansum(values, axis=0))
    return np.where(complete, tot, np.nan)


def _jump(series: np.ndarray, years: np.ndarray) -> float | None:
    before = series[(years >= 2009) & (years <= 2011)]
    after = series[(years >= 2013) & (years <= 2015)]
    if np.isnan(before).all() or np.isnan(after).all() or np.nansum(before) <= 0:
        return None
    return round(float(np.nansum(after) / np.nansum(before)), 3)


def _forward(version: str, mod, cube) -> dict:
    """Fit on years <= 2023, predict raw MODIS in 2024 and 2025 from VIIRS alone."""
    P = mod.PLATFORMS
    train = cube.years <= 2023
    full = cube.exposure >= 0.999
    viirs = [P.index(v) for v in mod.VIIRS if v in P]
    test = (cube.years >= 2024) & full[P.index("TERRA")] & full[P.index("AQUA")] & (cube.exposure[viirs].max(axis=0) >= 0.999)
    if version == "v4":
        model, _, _ = mod.fit_efficiency(cube, fit_months=train, prior=mod.v2._training_prior(cube, train & (cube.years < mod.NOMINAL_END)), calibrate=False)
        pred, _ = mod.predicted_raw_modis(cube, model, mod.harmonize_full(cube, model, platforms=mod.VIIRS))
    elif version == "v3":
        model, regional, _ = mod.fit_efficiency(cube, fit_months=train, prior=mod.v2._training_prior(cube, train), calibrate=False)
        pred, _ = mod.harmonize(cube, model, regional, platforms=mod.VIIRS)
    elif version == "v2":
        model, regional, _ = mod.fit_efficiency(cube, fit_months=train, prior=mod._training_prior(cube, train))
        pred, _ = mod.harmonize(cube, model, regional, platforms=mod.VIIRS)
    else:
        eff, regional, _ = mod.fit_efficiency(cube, fit_months=train)
        pred, _ = mod.harmonize(cube, eff, regional, platforms=mod.VIIRS)
    truth = cube.counts[P.index("TERRA")] + cube.counts[P.index("AQUA")]
    out = {}
    for label, sel in (("2024", test & (cube.years == 2024)), ("2025", test & (cube.years == 2025)), ("all", test)):
        t, e = truth[:, sel].sum(axis=0), np.nansum(pred[:, sel], axis=0)
        busy = t >= 50
        out[label] = {"modis": float(t.sum()), "biasPct": round(100 * (e.sum() / t.sum() - 1), 1) if t.sum() > 0 else None,
                      "medErrPct": round(float(np.median(np.abs(e[busy] / t[busy] - 1)) * 100), 1) if busy.any() else None}
    return out


def validate_region(cache: str, region: tuple, versions: list[str]) -> dict:
    name, country, biome, bbox, note = region
    raw = load_region(Path(cache), name)
    result = {"region": name, "country": country, "biome": biome, "bbox": list(bbox), "note": note,
              "rawRows": int(len(raw)), "versions": {}, "started": f"{dt.datetime.now():%Y-%m-%d %H:%M}"}
    if len(raw) < 1000:
        result["error"] = f"too few detections ({len(raw)})"
        return result
    for version in versions:
        t0 = time.time()
        try:
            mod = importlib.import_module(VERSIONS[version])
            norm = mod.normalize(raw)
            frame = mod.flag_quality(norm)
            df = frame[frame.qa_pass]
            avail = _availability(mod, norm)
            cube = mod.build_cube(df, avail, mod.pick_h3_resolution(bbox))
            report = mod.validate(cube)
            fwd = _forward(version, mod, cube)
            model, regional, summary = mod.fit_efficiency(cube)
            values, _ = mod.harmonize(cube, model, regional)
            complete = getattr(cube, "observed", np.ones(len(cube.months))) >= 0.999
            P = mod.PLATFORMS
            modis = (cube.counts[P.index("TERRA")] + cube.counts[P.index("AQUA")]).sum(axis=0).astype(float)
            viirs = cube.counts[[P.index(v) for v in mod.VIIRS]].sum(axis=(0, 1)).astype(float)
            harm = _totals(values, complete)
            entry = {
                "seconds": round(time.time() - t0, 1), "qaRows": int(len(df)), "cells": len(cube.cells),
                "platformRows": {p: int((norm.platform == p).sum()) for p in P},
                "validate": report, "forward": fwd,
                "jump2012": {"harmonized": _jump(harm, cube.years), "naive": _jump(np.where(complete, modis + viirs, np.nan), cube.years),
                             "modis": _jump(np.where(complete, modis, np.nan), cube.years)},
                "months": [str(m) for m in cube.months],
                "series": {"harmonized": [None if np.isnan(v) else round(float(v), 2) for v in harm],
                           "rawModis": [None if not c else float(v) for v, c in zip(modis, complete)],
                           "naiveSum": [None if not c else float(v) for v, c in zip(modis + viirs, complete)]},
            }
            if version == "v4":
                entry["drift"] = summary["model"]["modisDrift"]
                entry["viirsChain"] = summary["model"]["viirsChain"]
            result["versions"][version] = entry
        except Exception as exc:
            result["versions"][version] = {"error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()[-2000:],
                                           "seconds": round(time.time() - t0, 1)}
    result["finished"] = f"{dt.datetime.now():%Y-%m-%d %H:%M}"
    return result


# ----------------------------------------------------------------------------------------------
# 3. Witness: burned area and the seam test
# ----------------------------------------------------------------------------------------------

def witness_region(result: dict, products: list[str], first_year: int) -> dict:
    from backend import harmonization3 as h3
    from backend.burned_area import PRODUCTS as BA_PRODUCTS, BurnedAreaClient

    client = BurnedAreaClient()
    bbox = tuple(result["bbox"])
    out = result.setdefault("witness", {})
    for product in products:
        if product in out and "rows" in out[product]:
            continue
        start = max(f"{first_year}-01", str(pd.Period(BA_PRODUCTS[product]["first"], "M")))
        try:
            if client.online:
                fetched = client.fetch(product, bbox, start, f"{HORIZON:%Y-%m}")
                if fetched["failed"]:
                    log(f"  {result['region']} {product}: {len(fetched['failed'])} tiles failed")
            ok_versions = {v: e for v, e in result["versions"].items() if "series" in e}
            if not ok_versions:
                continue
            months = next(iter(ok_versions.values()))["months"]
            frame = client.monthly(product, bbox, months[0], months[-1])
            if frame.complete.sum() < 24:
                out[product] = {"error": "fewer than 24 complete months of burned area (no EARTHDATA_TOKEN or download failed)"}
                continue
            first = next(iter(ok_versions.values()))
            series = {"naiveSum": np.array(first["series"]["naiveSum"], dtype=float),
                      "rawModis": np.array(first["series"]["rawModis"], dtype=float)}
            for v, e in ok_versions.items():
                if e["months"] == months:
                    series[f"harmonized_{v}"] = np.array(e["series"]["harmonized"], dtype=float)
            st = h3.seam_test(months, series, frame.burnedKm2.to_numpy(float), witness_name=product)
            yearly = frame.assign(year=frame.month.str[:4]).groupby("year").burnedKm2.sum(min_count=1)
            out[product] = {"rows": st["rows"], "burnedKm2ByYear": {k: (None if pd.isna(v) else round(float(v), 1)) for k, v in yearly.items()}}
        except Exception as exc:
            out[product] = {"error": f"{type(exc).__name__}: {exc}"}
    return result


# ----------------------------------------------------------------------------------------------
# 4. Report
# ----------------------------------------------------------------------------------------------

def _era(report: dict | None, key: str) -> dict | None:
    if not report or not report.get("byEra"):
        return None
    for name, score in report["byEra"].items():
        if name.startswith(key):
            return score
    return None


def _num(x):
    return "" if x is None or (isinstance(x, float) and math.isnan(x)) else x


def _seam(result: dict, product: str, seam: str, series: str) -> dict | None:
    rows = ((result.get("witness") or {}).get(product) or {}).get("rows") or []
    return next((r for r in rows if r["seam"] == seam and r["series"] == series), None)


def _v4_headline(df: pd.DataFrame) -> list[str]:
    """The v4 verdict: how close VIIRS + the drift law come to raw MODIS, region by region."""
    d = df[df.version == "v4"]
    if d.empty:
        return []

    def share(col: str, limit: float) -> str:
        if col not in d:
            return "–"
        s = pd.to_numeric(d[col], errors="coerce").dropna().abs()
        return f"{int((s <= limit).sum())} of {len(s)}" if len(s) else "–"

    def med(col: str, absolute: bool = True) -> str:
        if col not in d:
            return "–"
        s = pd.to_numeric(d[col], errors="coerce").dropna()
        s = s.abs() if absolute else s
        return f"{s.median():.1f}" if len(s) else "–"

    terra = pd.to_numeric(d["terra_shift_h"], errors="coerce").dropna() if "terra_shift_h" in d else pd.Series(dtype=float)
    aqua = pd.to_numeric(d["aqua_shift_h"], errors="coerce").dropna() if "aqua_shift_h" in d else pd.Series(dtype=float)
    failed = int(d["error"].astype(str).str.len().gt(0).sum()) if "error" in d else 0
    out = ["## v4 in short", "",
           f"- Regions validated: {d.region.nunique()} ({failed} with errors).",
           f"- k-fold, raw MODIS predicted from VIIRS through the drift law: median |bias| 2012–19 {med('kfold_bias_2012-2019')}%, "
           f"2020–22 {med('kfold_bias_2020-2022')}%, 2023+ {med('kfold_bias_2023+')}%; median monthly error 2023+ {med('kfold_err_2023+', False)}%.",
           f"- |bias| 2023+ within 10%: {share('kfold_bias_2023+', 10)} regions; within 20%: {share('kfold_bias_2023+', 20)}.",
           f"- Forward test (fit on years up to 2023): median |bias| 2024 {med('fwd_bias_2024')}%, 2025 {med('fwd_bias_2025')}%; "
           f"2025 within 15%: {share('fwd_bias_2025', 15)} regions.",
           f"- 90% interval coverage (k-fold, calibrated): median {med('kfold_cov90', False)}.",
           f"- 2012 jump of the harmonized series: median {med('jump_harmonized', False)}× (1 = no jump)."]
    if len(terra) and len(aqua):
        out.append(f"- Measured overpass shift in the last month: Terra median {terra.median():+.2f} h, Aqua {aqua.median():+.2f} h "
                   f"(ranges {terra.min():+.2f} to {terra.max():+.2f} and {aqua.min():+.2f} to {aqua.max():+.2f}).")
    return out


def build_report(out: Path, versions: list[str]) -> None:
    results = []
    for f in sorted((out / "regions").glob("*.json")):
        try:
            results.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            continue
    if not results:
        log("report: no region results yet")
        return
    witness_products = sorted({p for r in results for p in (r.get("witness") or {})})

    # summary.csv
    rows = []
    for r in results:
        for v, e in r.get("versions", {}).items():
            row = {"region": r["region"], "country": r["country"], "biome": r["biome"], "version": v,
                   "error": e.get("error", r.get("error", "")), "seconds": e.get("seconds"), "qaRows": e.get("qaRows")}
            rep = e.get("validate")
            for key, label in ERA_KEYS:
                sc = _era(rep, key)
                row[f"kfold_bias_{label}"] = _num(sc and sc.get("totalBiasPct"))
                row[f"kfold_err_{label}"] = _num(sc and sc.get("monthlyMedianAbsErrorPct"))
            allsc = (rep or {}).get("allTestYears") or {}
            row["kfold_cov90"] = _num(allsc.get("interval90Coverage"))
            for y in ("2024", "2025", "all"):
                f = (e.get("forward") or {}).get(y) or {}
                row[f"fwd_bias_{y}"] = _num(f.get("biasPct"))
                row[f"fwd_err_{y}"] = _num(f.get("medErrPct"))
            j = e.get("jump2012") or {}
            row["jump_harmonized"], row["jump_naive"], row["jump_modis"] = _num(j.get("harmonized")), _num(j.get("naive")), _num(j.get("modis"))
            for p in witness_products:
                for seam in ("SNPP", "NOAA20", "NOAA21"):
                    s = _seam(r, p, seam, f"harmonized_{v}")
                    row[f"{p}_{seam}_stepPct"] = _num(s and s["stepPct"])
                    row[f"{p}_{seam}_t"] = _num(s and s["t"])
            if v == "v4" and e.get("drift"):
                for plat in ("TERRA", "AQUA"):
                    d = e["drift"].get(plat, {})
                    row[f"{plat.lower()}_shift_h"] = d.get("latestShiftHours")
                    row[f"{plat.lower()}_shift_measured"] = d.get("shiftFromThisArea")
                    for s in ("D", "N"):
                        row[f"{plat.lower()}_{s}_factor"] = (d.get(s) or {}).get("latestFactor")
            rows.append(row)
    cols = []
    for row in rows:
        cols += [c for c in row if c not in cols]
    with open(out / "summary.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    df = pd.DataFrame(rows)

    def med(series: pd.Series, absolute: bool = False):
        s = pd.to_numeric(series, errors="coerce").dropna()
        if absolute:
            s = s.abs()
        return f"{s.median():.1f}" if len(s) else "–"

    lines = [f"# Global validation of the MODIS–VIIRS harmonization", "",
             f"Generated {dt.datetime.now():%Y-%m-%d %H:%M}. {len(results)} regions, versions {', '.join(versions)}. "
             f"Data: NASA FIRMS yearly country files (MODIS 2000–2025, VIIRS S-NPP 2012–2025, NOAA-20 2018–2025), "
             f"NOAA-21 from the Area API when available; witness: {', '.join(witness_products) or 'none'}.", "",
             "Errors are VIIRS-only predictions of raw MODIS (Terra + Aqua): **bias** is the total over the period, "
             "**error** the median absolute monthly error over months with ≥ 50 MODIS hot spots. "
             "k-fold: v3/v4 blocked by years; v1 even/odd years. Forward: fitted on years ≤ 2023, predicting 2024 and 2025.", "",
             *_v4_headline(df), "",
             "## All versions (median across regions)", "",
             "| Version | k-fold \\|bias\\| 2012–19 | 2020–22 | 2023+ | k-fold error 2012–19 | 2023+ | forward \\|bias\\| 2024 | 2025 | forward error | 90% coverage | 2012 jump (harmonized) |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for v in versions:
        d = df[df.version == v]
        if d.empty:
            continue
        lines.append(f"| {v} | {med(d['kfold_bias_2012-2019'], True)}% | {med(d['kfold_bias_2020-2022'], True)}% | {med(d['kfold_bias_2023+'], True)}% | "
                     f"{med(d['kfold_err_2012-2019'])}% | {med(d['kfold_err_2023+'])}% | {med(d['fwd_bias_2024'], True)}% | {med(d['fwd_bias_2025'], True)}% | "
                     f"{med(d['fwd_err_all'])}% | {med(d['kfold_cov90'])} | {med(d['jump_harmonized'])}× |")
    naive = pd.to_numeric(df.drop_duplicates("region")["jump_naive"], errors="coerce").dropna()
    modis_j = pd.to_numeric(df.drop_duplicates("region")["jump_modis"], errors="coerce").dropna()
    if len(naive):
        lines += ["", f"For comparison, the 2012 jump of the naive sum (MODIS + VIIRS) has a median of {naive.median():.2f}× and of MODIS alone {modis_j.median():.2f}×."]

    if {"v3", "v4"} <= set(df.version):
        lines += ["", "## v4 against v3 (regions where v4 is closer to raw MODIS)", ""]
        a, b = df[df.version == "v3"].set_index("region"), df[df.version == "v4"].set_index("region")
        both = a.index.intersection(b.index)
        for col, label in (("kfold_bias_2023+", "k-fold |bias| 2023+"), ("kfold_err_2023+", "k-fold error 2023+"),
                           ("fwd_bias_2024", "forward |bias| 2024"), ("fwd_bias_2025", "forward |bias| 2025"),
                           ("kfold_bias_2012-2019", "k-fold |bias| 2012–19"), ("kfold_err_2012-2019", "k-fold error 2012–19")):
            x = pd.to_numeric(a.loc[both, col], errors="coerce").abs()
            y = pd.to_numeric(b.loc[both, col], errors="coerce").abs()
            ok = x.notna() & y.notna()
            lines.append(f"- {label}: v4 better in {int((y[ok] < x[ok]).sum())} of {int(ok.sum())} regions "
                         f"(median {x[ok].median():.1f}% → {y[ok].median():.1f}%)" if ok.any() else f"- {label}: no data")

    lines += ["", "## By biome (median, v3 → v4)", "", "| Biome | Regions | k-fold \\|bias\\| 2023+ | forward \\|bias\\| 2025 | k-fold error 2023+ |", "|---|---|---|---|---|"]
    for biome, d in df.groupby("biome"):
        def pair(col, absolute=True):
            return " → ".join(med(d[d.version == v][col], absolute) for v in ("v3", "v4") if v in set(d.version))
        lines.append(f"| {biome} | {d.region.nunique()} | {pair('kfold_bias_2023+')} | {pair('fwd_bias_2025')} | {pair('kfold_err_2023+', False)} |")

    lines += ["", "## Regions", "", "| Region | Biome | Version | k-fold bias 2012–19 | 2023+ | error 2023+ | forward 2024 | 2025 | 2012 jump |", "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        for v in versions:
            row = next((x for x in rows if x["region"] == r["region"] and x["version"] == v), None)
            if not row:
                continue
            if row.get("error"):
                lines.append(f"| {r['region']} | {r['biome']} | {v} | error: {str(row['error'])[:80]} | | | | | |")
                continue
            lines.append(f"| {r['region']} | {r['biome']} | {v} | {row['kfold_bias_2012-2019']} | {row['kfold_bias_2023+']} | {row['kfold_err_2023+']} | "
                         f"{row['fwd_bias_2024']} | {row['fwd_bias_2025']} | {row['jump_harmonized']} |")

    lines += ["", "## MODIS orbit drift measured by v4", "", "| Region | Terra shift (h) | Aqua shift (h) | measured here | Terra day | Terra night | Aqua day | Aqua night |", "|---|---|---|---|---|---|---|---|"]
    for row in rows:
        if row["version"] == "v4" and "terra_shift_h" in row:
            lines.append(f"| {row['region']} | {row['terra_shift_h']} | {row['aqua_shift_h']} | {row['terra_shift_measured']}/{row['aqua_shift_measured']} | "
                         f"{row.get('terra_D_factor')} | {row.get('terra_N_factor')} | {row.get('aqua_D_factor')} | {row.get('aqua_N_factor')} |")
    lines += ["", "Factors are the drift law's multiplier of the nominal efficiency in the last month (1 = no change)."]

    for p in witness_products:
        lines += ["", f"## Seam test against {p} burned area", "",
                  "Step of each series relative to burned area at the satellite seam (t in brackets; |t| ≥ 2 is a seam).", "",
                  "| Region | Seam | naive sum | raw MODIS | " + " | ".join(f"harmonized {v}" for v in versions) + " |",
                  "|---|---|---|---|" + "---|" * len(versions)]
        for r in results:
            w = (r.get("witness") or {}).get(p) or {}
            if "error" in w:
                lines.append(f"| {r['region']} | – | {w['error'][:60]} | | " + " | " * len(versions))
                continue
            for seam in ("SNPP", "NOAA20", "NOAA21"):
                cells = []
                for series in ["naiveSum", "rawModis"] + [f"harmonized_{v}" for v in versions]:
                    s = _seam(r, p, seam, series)
                    cells.append("–" if not s or s["stepPct"] is None else f"{s['stepPct']:+.0f}% ({s['t']})")
                lines.append(f"| {r['region']} | {seam} | " + " | ".join(cells) + " |")
        flagged = {v: 0 for v in versions}
        tested = {v: 0 for v in versions}
        for r in results:
            for seam in ("SNPP", "NOAA20", "NOAA21"):
                for v in versions:
                    s = _seam(r, p, seam, f"harmonized_{v}")
                    if s and s["verdict"] != "insufficient":
                        tested[v] += 1
                        flagged[v] += s["verdict"] in ("seamUp", "seamDown")
        lines += ["", "Seams flagged (|t| ≥ 2): " + ", ".join(f"{v} {flagged[v]} of {tested[v]}" for v in versions) + "."]

    errors = [(r["region"], v, e.get("error")) for r in results for v, e in r.get("versions", {}).items() if e.get("error")]
    errors += [(r["region"], "-", r["error"]) for r in results if r.get("error")]
    if errors:
        lines += ["", "## Failures", ""] + [f"- {a} {b}: {c}" for a, b, c in errors]
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"report: {out / 'report.md'} and {out / 'summary.csv'} ({len(results)} regions)")


# ----------------------------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------------------------

def main() -> int:
    global LOG_PATH
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", default=str(REPO / "data" / "cache" / "global_validation" / "results"))
    parser.add_argument("--cache", default=str(REPO / "data" / "cache" / "global_validation"))
    parser.add_argument("--regions", default="all", help="comma-separated names (see --list) or 'all'")
    parser.add_argument("--versions", default="v4,v3", help="v4 is the version under test; the others are references")
    parser.add_argument("--workers", type=int, default=2, help="regions validated in parallel (CPU and memory heavy)")
    parser.add_argument("--download-workers", type=int, default=4)
    parser.add_argument("--witness", default="MCD64A1", help="MCD64A1, VNP64A1, both or none")
    parser.add_argument("--witness-from", type=int, default=2008, help="first year of burned area (2008 gives 4 years before the 2012 seam)")
    parser.add_argument("--no-noaa21", action="store_true", help="skip NOAA-21 from the Area API")
    parser.add_argument("--stage", default="all", choices=["all", "download", "validate", "witness", "report"])
    parser.add_argument("--force", action="store_true", help="redo regions that already have results")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--allow-sleep", action="store_true", help="do not keep Windows awake while running")
    args = parser.parse_args()

    if args.list:
        for name, country, biome, bbox, note in REGIONS:
            print(f"{name:<22} {country:<20} {biome:<16} {bbox}  {note}")
        return 0
    try:
        from dotenv import load_dotenv
        load_dotenv(REPO / ".env")
    except ImportError:
        pass
    out, cache = Path(args.out), Path(args.cache)
    (out / "regions").mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    LOG_PATH = out / "run.log"
    if os.name == "nt" and not args.allow_sleep:  # keep the PC from idling to sleep during the night run
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)
    regions = REGIONS if args.regions == "all" else [REGION_BY_NAME[n.strip()] for n in args.regions.split(",") if n.strip()]
    versions = [v.strip() for v in args.versions.split(",") if v.strip()]
    witness = {"none": [], "both": ["MCD64A1", "VNP64A1"]}.get(args.witness, [args.witness])
    log(f"global validation: {len(regions)} regions, versions {versions}, witness {witness or 'none'}, out {out}")
    t_start = time.time()

    if args.stage in ("all", "download"):
        download_firms(cache, regions, args.download_workers)
        if not args.no_noaa21:
            download_noaa21(cache, regions, workers=2)

    if args.stage in ("all", "validate"):
        todo = [r for r in regions if args.force or not (out / "regions" / f"{r[0]}.json").exists()]
        log(f"validation: {len(todo)} regions to run ({args.workers} in parallel)")
        with ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = {pool.submit(validate_region, str(cache), r, versions): r[0] for r in todo}
            for i, fut in enumerate(as_completed(futures), 1):
                name = futures[fut]
                try:
                    res = fut.result()
                except Exception as exc:
                    res = {"region": name, "country": REGION_BY_NAME[name][1], "biome": REGION_BY_NAME[name][2],
                           "bbox": list(REGION_BY_NAME[name][3]), "versions": {}, "error": f"{type(exc).__name__}: {exc}"}
                (out / "regions" / f"{name}.json").write_text(json.dumps(res, ensure_ascii=False, default=str), encoding="utf-8")
                msg = res.get("error") or ", ".join(
                    f"{v}: " + (e.get("error", "")[:60] or f"bias23+ {(_era(e.get('validate'), '2023') or {}).get('totalBiasPct')}% fwd25 {((e.get('forward') or {}).get('2025') or {}).get('biasPct')}% ({e.get('seconds')} s)")
                    for v, e in res["versions"].items())
                elapsed = time.time() - t_start
                log(f"  [{i}/{len(todo)}] {name}: {msg}  | elapsed {elapsed / 3600:.1f} h")
                build_report(out, versions)

    if args.stage in ("all", "witness") and witness:
        log(f"witness: {', '.join(witness)} from {args.witness_from}" + ("" if os.getenv("EARTHDATA_TOKEN") else " (EARTHDATA_TOKEN missing: cached tiles only)"))
        for i, r in enumerate(regions, 1):
            path = out / "regions" / f"{r[0]}.json"
            if not path.exists():
                continue
            res = json.loads(path.read_text(encoding="utf-8"))
            res = witness_region(res, witness, args.witness_from)
            path.write_text(json.dumps(res, ensure_ascii=False, default=str), encoding="utf-8")
            summary = []
            for p in witness:
                w = (res.get("witness") or {}).get(p) or {}
                if "error" in w:
                    summary.append(f"{p}: {w['error'][:60]}")
                else:
                    s = _seam(res, p, "SNPP", "naiveSum")
                    summary.append(f"{p}: naive S-NPP step {s['stepPct'] if s else '–'}%")
            log(f"  [{i}/{len(regions)}] {r[0]} " + "; ".join(summary))
            build_report(out, versions)

    build_report(out, versions)
    log(f"done in {(time.time() - t_start) / 3600:.2f} h. Results: {out / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
