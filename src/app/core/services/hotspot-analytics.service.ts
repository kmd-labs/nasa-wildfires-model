import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import {
  ActiveFireDataset,
  BackendDailyBucket,
  BoundingBox,
  BurningCalendarCell,
  ChartSeriesPoint,
  DatasetSelectionMode,
  HarmonizedHotspotRecord,
  HotspotAnalyticsSummary,
  MultiPolygonCoords,
  PolygonRing,
  YearlyComparisonPoint
} from '../models/wildfire.model';
import { ColorRampService } from './color-ramp.service';
import { WildfireDataService } from './wildfire-data.service';
import { VIIRS_FIRST_DATE, WildfireStateService, isPointInPolygonCoords, ringToClosedPolygonCoords } from './wildfire-state.service';
import { I18nService } from '../i18n/i18n.service';
import { formatLocaleDate } from '../pipes/locale-date.pipe';

export interface BurningCalendarModel {
  mode: 'monthly' | 'daily';
  rowLabels: string[];
  colLabels: string[];
  cells: BurningCalendarCell[];
  maxCount: number;
  maxFrp: number;
}

export interface YearBurningCalendarModel {
  year: number;
  calendar: BurningCalendarModel;
  totalHarmonized: number;
}

function daysInUtcMonth(year: number, month1Based: number): number {
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
}

function isMmDdInDateRange(monthIdx0: number, day1Based: number, start: string, end: string): boolean {
  const startYear = Number(start.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  const mm = String(monthIdx0 + 1).padStart(2, '0');
  const dd = String(day1Based).padStart(2, '0');
  for (let y = startYear; y <= endYear; y++) {
    if (day1Based > daysInUtcMonth(y, monthIdx0 + 1)) continue;
    const iso = `${y}-${mm}-${dd}`;
    if (iso >= start && iso <= end) return true;
  }
  return false;
}

function sumDailyBucketsInMonth(
  rows: BackendDailyBucket[] | undefined,
  year: number,
  month1Based: number,
  start: string,
  end: string
): { modis: number; viirs: number; harm: number } | null {
  if (!rows) return null;
  const mmPrefix = `${String(month1Based).padStart(2, '0')}-`;
  let modis = 0;
  let viirs = 0;
  let harm = 0;
  for (const row of rows) {
    if (!row.mmdd.startsWith(mmPrefix)) continue;
    const iso = `${year}-${row.mmdd}`;
    if (iso < start || iso > end) continue;
    modis += row.rawModis;
    viirs += row.rawViirs;
    harm += row.harmonized;
  }
  return { modis, viirs, harm };
}

function backendPayloadCoversRange(
  sel: { from: string; to: string; fromDate?: string; toDate?: string },
  start: string,
  end: string
): boolean {
  const selFrom = sel.fromDate ?? `${sel.from}-01`;
  const selTo = sel.toDate ?? `${sel.to}-${String(daysInUtcMonth(Number(sel.to.slice(0, 4)), Number(sel.to.slice(5, 7)))).padStart(2, '0')}`;
  return selFrom <= start && selTo >= end;
}

/** A multi-year anomaly needs at least this many other years with downloaded data. */
export const MIN_ANOMALY_YEARS = 3;

interface ChartItem {
  key: string;
  label: string;
  modis: number;
  viirs: number;
  harm: number;
  inSelectedRange: boolean;
  hasData: boolean;
  lo: number | null;
  hi: number | null;
}

export interface GlobePixelSquare {
  lon: number;
  lat: number;
  halfLon: number;
  halfLat: number;
  sensor: ActiveFireDataset;
  sizeMeters: number;
  count: number;
  frpMw: number;
  normIntensity: number;
}

@Injectable({
  providedIn: 'root'
})
export class HotspotAnalyticsService {
  private readonly data = inject(WildfireDataService);
  private readonly state = inject(WildfireStateService);
  private readonly ramps = inject(ColorRampService);
  private readonly i18n = inject(I18nService);
  private backendDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const bbox = this.state.regionBbox();
      const start = this.state.dateStart();
      const end = this.state.dateEnd();
      const hasDates = this.state.hasDateRange();
      const isCustom = this.data.isCustomDataset();

      untracked(() => {
        if (this.backendDebounce !== null) {
          clearTimeout(this.backendDebounce);
          this.backendDebounce = null;
        }
        if (isCustom || !bbox || !hasDates) {
          this.data.clearBackendCalendar();
          return;
        }
        this.backendDebounce = setTimeout(() => {
          void this.data.syncCalendarFromBackend(bbox, start, end);
        }, 160);
      });
    });
  }

  readonly hasLiveBackend = computed<boolean>(
    () => !this.data.isCustomDataset() && this.data.backendCalendar() !== null
  );

  /** Spatial ratio when the accepted polygon / MultiPolygon is smaller than its bbox envelope. */
  private readonly backendSpatialRatio = computed<number>(() => {
    const bbox = this.state.regionBbox();
    const multi = this.state.regionMultiPolygon();
    if (!bbox || multi.length === 0) return 1;
    const envArea = Math.max(1, this.computeBboxArea(bbox).km2);
    const polyArea = this.bboxArea().km2;
    return Math.max(0.05, Math.min(1, polyArea / envArea));
  });

  /** All hotspot records inside the selected region bounding box (for custom uploaded datasets). */
  readonly regionHotspots = computed<HarmonizedHotspotRecord[]>(() => {
    if (!this.data.isCustomDataset()) {
      return [];
    }
    this.state.regionBbox();
    return this.data.hotspots().filter(r => this.state.isPointInRegion(r.lon, r.lat));
  });

  /** Hotspot records inside BOTH the selected bounding box AND the selected date range. */
  readonly filteredHotspots = computed<HarmonizedHotspotRecord[]>(() => {
    const backend = this.data.backendCalendar();
    this.state.regionBbox();
    if (!this.data.isCustomDataset()) {
      if (!backend) return [];
      const meanFrp = backend.selection.frp?.meanMw ?? 22;
      const dateStamp = `${backend.selection.from}-15`;
      return backend.selection.cells
        .filter(c => this.state.isPointInRegion(c.lon, c.lat))
        .map(c => ({
          id: c.h3,
          date: dateStamp,
          lon: c.lon,
          lat: c.lat,
          frpMw: Number((c.harmonized * meanFrp).toFixed(1)),
          confidence: 90,
          sensor: 'HARMONIZED',
          rawModisCount: c.rawModis,
          rawViirsCount: c.rawViirs,
          harmonizedCount: c.harmonized,
          biome: 'NASA FIRMS H3'
        }));
    }
    const start = this.state.dateStart();
    const end = this.state.dateEnd();
    return this.regionHotspots().filter(r => r.date >= start && r.date <= end);
  });

  /**
   * Pixel squares for the active dataset (VIIRS 375 m, MODIS 1 km, or mixed: MODIS 1 km pre-2012
   * switching automatically to VIIRS 375 m from 2012-01-20 onward) including boundary pixels
   * whose center may lie just outside the polygon so the map/globe clips them cleanly.
   */
  readonly globePixelSquares = computed<GlobePixelSquare[]>(() => {
    const dataset = this.state.activeDataset();
    const bbox = this.state.regionBbox();
    if (!bbox) return [];

    const midLat = (bbox[1] + bbox[3]) * 0.5;
    const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

    const binSensorPoints = (
      sensor: ActiveFireDataset,
      points: { lon: number; lat: number; count: number; frpMw: number }[]
    ): Omit<GlobePixelSquare, 'normIntensity'>[] => {
      if (points.length === 0) return [];
      const sizeMeters = sensor === 'VIIRS' ? 375 : 1000;
      const dLat = sizeMeters / 110574;
      const dLon = sizeMeters / (111320 * cosLat);
      const halfLon = dLon * 0.5;
      const halfLat = dLat * 0.5;

      // Snap detections to a regular sensor-resolution grid so pixels never overlap awkwardly
      const bins = new Map<string, { lon: number; lat: number; count: number; frpMw: number }>();
      for (const p of points) {
        const col = Math.round(p.lon / dLon);
        const row = Math.round(p.lat / dLat);
        const key = `${row}:${col}`;
        const existing = bins.get(key);
        if (existing) {
          existing.count += p.count;
          existing.frpMw += p.frpMw;
        } else {
          bins.set(key, {
            lon: col * dLon,
            lat: row * dLat,
            count: p.count,
            frpMw: p.frpMw
          });
        }
      }

      return Array.from(bins.values()).map(c => ({
        lon: c.lon,
        lat: c.lat,
        halfLon,
        halfLat,
        sensor,
        sizeMeters,
        count: c.count,
        frpMw: c.frpMw
      }));
    };

    const normalizeSquares = (
      raw: Omit<GlobePixelSquare, 'normIntensity'>[]
    ): GlobePixelSquare[] => {
      if (raw.length === 0) return [];
      const maxVal = Math.max(1, ...raw.map(c => (c.frpMw > 0 ? c.frpMw : c.count)));
      return raw.map(c => {
        const val = c.frpMw > 0 ? c.frpMw : c.count;
        return {
          ...c,
          normIntensity: Math.min(1, Math.pow(val / maxVal, 0.58))
        };
      });
    };

    if (!this.data.isCustomDataset()) {
      const backend = this.data.backendCalendar();
      if (!backend) return [];
      const rawPixels = backend.selection.pixels;
      const requiresBoth = this.state.requiresBothSensors();
      if (rawPixels && rawPixels.length > 0) {
        if (dataset === 'VIIRS' || dataset === 'MODIS') {
          return normalizeSquares(
            binSensorPoints(
              dataset,
              rawPixels
                .filter(p => p.sensor === dataset)
                .map(p => ({ lon: p.lon, lat: p.lat, count: p.count, frpMw: p.frpMw }))
            )
          );
        }

        // Combined VIIRS 375 m + MODIS 1 km view (pre-2012 MODIS when spanning launch, else all MODIS)
        const viirsPts = rawPixels
          .filter(p => p.sensor === 'VIIRS')
          .map(p => ({ lon: p.lon, lat: p.lat, count: p.count, frpMw: p.frpMw }));

        let modisPts: { lon: number; lat: number; count: number; frpMw: number }[];
        if (!requiresBoth) {
          modisPts = rawPixels
            .filter(p => p.sensor === 'MODIS')
            .map(p => ({ lon: p.lon, lat: p.lat, count: p.count, frpMw: p.frpMw }));
        } else {
          const hasExactEra = rawPixels.some(p => p.sensor === 'MODIS' && typeof p.preViirs === 'boolean');
          if (hasExactEra) {
            modisPts = rawPixels
              .filter(p => p.sensor === 'MODIS' && p.preViirs === true)
              .map(p => ({ lon: p.lon, lat: p.lat, count: p.count, frpMw: p.frpMw }));
          } else {
            const viirsOccupied = new Set<string>();
            for (const vp of viirsPts) {
              viirsOccupied.add(`${Math.round(vp.lat / 0.01)}:${Math.round(vp.lon / 0.01)}`);
            }
            modisPts = rawPixels
              .filter(
                p =>
                  p.sensor === 'MODIS' &&
                  !viirsOccupied.has(`${Math.round(p.lat / 0.01)}:${Math.round(p.lon / 0.01)}`)
              )
              .map(p => ({ lon: p.lon, lat: p.lat, count: p.count, frpMw: p.frpMw }));
          }
        }

        return normalizeSquares([
          ...binSensorPoints('MODIS', modisPts),
          ...binSensorPoints('VIIRS', viirsPts)
        ]);
      }

      // Fallback if backend payload has no pixels array
      if (dataset === 'VIIRS' || dataset === 'MODIS') {
        return normalizeSquares(
          binSensorPoints(
            dataset,
            backend.selection.cells
              .filter(c => (dataset === 'VIIRS' ? c.rawViirs > 0 : c.rawModis > 0))
              .map(c => ({
                lon: c.lon,
                lat: c.lat,
                count: dataset === 'VIIRS' ? c.rawViirs : c.rawModis,
                frpMw: 0
              }))
          )
        );
      }

      const viirsCells = backend.selection.cells
        .filter(c => c.rawViirs > 0)
        .map(c => ({ lon: c.lon, lat: c.lat, count: c.rawViirs, frpMw: 0 }));
      const modisCells = backend.selection.cells
        .filter(c => c.rawModis > 0 && (!requiresBoth || c.rawViirs === 0))
        .map(c => ({ lon: c.lon, lat: c.lat, count: c.rawModis, frpMw: 0 }));
      return normalizeSquares([
        ...binSensorPoints('MODIS', modisCells),
        ...binSensorPoints('VIIRS', viirsCells)
      ]);
    }

    const start = this.state.dateStart();
    const end = this.state.dateEnd();
    const pad = 0.015;
    const [w, s, e, n] = bbox;
    const inBoxAndDates = this.data.hotspots().filter(
      r =>
        r.date >= start &&
        r.date <= end &&
        r.lon >= w - pad &&
        r.lon <= e + pad &&
        r.lat >= s - pad &&
        r.lat <= n + pad
    );

    const requiresBoth = this.state.requiresBothSensors();
    if (dataset === 'VIIRS' || dataset === 'MODIS') {
      const matching = inBoxAndDates.filter(r =>
        dataset === 'VIIRS'
          ? r.rawViirsCount > 0 || r.sensor === 'VIIRS' || r.sensor === 'HARMONIZED'
          : r.rawModisCount > 0 || r.sensor === 'MODIS' || r.sensor === 'HARMONIZED'
      );
      return normalizeSquares(
        binSensorPoints(
          dataset,
          matching.map(r => ({
            lon: r.lon,
            lat: r.lat,
            count: dataset === 'VIIRS' ? (r.rawViirsCount || 1) : (r.rawModisCount || 1),
            frpMw: r.frpMw
          }))
        )
      );
    }

    const modisPts: { lon: number; lat: number; count: number; frpMw: number }[] = [];
    const viirsPts: { lon: number; lat: number; count: number; frpMw: number }[] = [];
    for (const r of inBoxAndDates) {
      if (requiresBoth) {
        if (r.date < VIIRS_FIRST_DATE) {
          if (r.rawModisCount > 0 || r.sensor === 'MODIS' || r.sensor === 'HARMONIZED') {
            modisPts.push({ lon: r.lon, lat: r.lat, count: r.rawModisCount || 1, frpMw: r.frpMw });
          }
        } else if (r.rawViirsCount > 0 || r.sensor === 'VIIRS' || r.sensor === 'HARMONIZED') {
          viirsPts.push({ lon: r.lon, lat: r.lat, count: r.rawViirsCount || 1, frpMw: r.frpMw });
        }
      } else {
        if (r.rawModisCount > 0 || r.sensor === 'MODIS' || r.sensor === 'HARMONIZED') {
          modisPts.push({ lon: r.lon, lat: r.lat, count: r.rawModisCount || 1, frpMw: r.frpMw });
        }
        if (r.rawViirsCount > 0 || r.sensor === 'VIIRS' || r.sensor === 'HARMONIZED') {
          viirsPts.push({ lon: r.lon, lat: r.lat, count: r.rawViirsCount || 1, frpMw: r.frpMw });
        }
      }
    }
    return normalizeSquares([
      ...binSensorPoints('MODIS', modisPts),
      ...binSensorPoints('VIIRS', viirsPts)
    ]);
  });

  /** Approximate MultiPolygon area in km², hectares, and m² using spherical latitude cosine. */
  readonly bboxArea = computed<{ km2: number; ha: number; m2: number }>(() => {
    return this.computeMultiPolygonArea(this.state.regionMultiPolygon());
  });

  /** Area of the active draft polygon (while editing) or the committed region. */
  readonly displayRegionArea = computed<{ km2: number; ha: number; m2: number }>(() => {
    const draft = this.state.draftPolygon();
    if (draft && draft.length >= 3) {
      return this.computeMultiPolygonArea([ringToClosedPolygonCoords(draft)]);
    }
    return this.bboxArea();
  });

  /** Historical multi-year comparison (2000–2026 or dataset span) for the selected region & seasonal window. */
  readonly yearlyComparison = computed<YearlyComparisonPoint[]>(() => {
    const start = this.state.dateStart();
    const end = this.state.dateEnd();
    const hasDates = this.state.hasDateRange();
    const startYear = hasDates ? Number(start.slice(0, 4)) : 2000;
    const endYear = hasDates ? Number(end.slice(0, 4)) : 2026;
    const spanDays = hasDates
      ? Math.max(1, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1)
      : 365;
    const useSeasonalWindow = hasDates && spanDays < 330;

    const backend = this.data.backendCalendar();
    if (!this.data.isCustomDataset() && backend) {
      const ratio = this.backendSpatialRatio();
      const startM = Number(start.slice(5, 7));
      const endM = Number(end.slice(5, 7));
      const byYear = new Map<number, { modis: number; viirs: number; harm: number; frp: number; hasData: boolean }>();
      for (const yr of backend.yearly) {
        // On-demand download: a year counts only when it was downloaded (fully, for whole-year totals)
        const coverage = yr.dataCoverage ?? 1;
        byYear.set(yr.year, {
          modis: useSeasonalWindow ? 0 : Math.round(yr.rawModis * ratio),
          viirs: useSeasonalWindow ? 0 : Math.round(yr.rawViirs * ratio),
          harm: useSeasonalWindow ? 0 : yr.harmonized * ratio,
          frp: (yr.frpMw ?? 0) * ratio,
          hasData: useSeasonalWindow ? true : yr.monthsWithData > 0 && coverage > 0
        });
      }

      if (useSeasonalWindow) {
        const startDay = Number(start.slice(8, 10)) || 1;
        const endDay = Number(end.slice(8, 10)) || 31;
        const dailyByYear = backend.selection.dailyByYear ?? {};
        const coversRange = backendPayloadCoversRange(backend.selection, start, end);

        for (let i = 0; i < backend.months.length; i++) {
          const ym = backend.months[i];
          const y = Number(ym.slice(0, 4));
          const m = Number(ym.slice(5, 7));
          const matches = startM <= endM ? m >= startM && m <= endM : m >= startM || m <= endM;
          if (!matches) continue;
          const b = byYear.get(y);
          if (!b) continue;
          if (backend.series.harmonized[i] === null || (backend.series.dataCoverage?.[i] ?? 1) <= 0) {
            b.hasData = false; // a month of the seasonal window was never downloaded for this year
            continue;
          }

          const dim = daysInUtcMonth(y, m);
          const isStartM = m === startM && startDay > 1;
          const isEndM = m === endM && endDay < dim;
          if (isStartM || isEndM) {
            if (coversRange && y >= startYear && y <= endYear && dailyByYear[String(y)]) {
              const exact = sumDailyBucketsInMonth(dailyByYear[String(y)], y, m, start, end);
              if (exact) {
                b.modis += Math.round(exact.modis * ratio);
                b.viirs += Math.round(exact.viirs * ratio);
                b.harm += exact.harm * ratio;
                continue;
              }
            }
            const lo = isStartM ? startDay : 1;
            const hi = isEndM ? Math.min(dim, endDay) : dim;
            const frac = lo <= hi ? (hi - lo + 1) / dim : 0;
            b.modis += Math.round((backend.series.rawModis[i] ?? 0) * ratio * frac);
            b.viirs += Math.round((backend.series.rawViirs[i] ?? 0) * ratio * frac);
            b.harm += (backend.series.harmonized[i] ?? 0) * ratio * frac;
            continue;
          }

          b.modis += Math.round((backend.series.rawModis[i] ?? 0) * ratio);
          b.viirs += Math.round((backend.series.rawViirs[i] ?? 0) * ratio);
          b.harm += (backend.series.harmonized[i] ?? 0) * ratio;
        }
      }

      const years = Array.from(byYear.keys()).sort((a, b) => a - b);
      const counts = years.filter(y => byYear.get(y)!.hasData).map(y => byYear.get(y)!.harm);
      const nYears = Math.max(1, counts.length);
      const mean = counts.reduce((a, b) => a + b, 0) / nYears;
      const variance = counts.reduce((acc, c) => acc + Math.pow(c - mean, 2), 0) / nYears;
      const std = Math.max(1, Math.sqrt(variance));

      return years.map(y => {
        const b = byYear.get(y)!;
        const harm = Math.round(b.harm);
        const pct = mean > 0 ? ((b.harm - mean) / mean) * 100 : 0;
        const z = (b.harm - mean) / std;
        return {
          year: y,
          rawModisCount: b.modis,
          rawViirsCount: b.viirs,
          harmonizedCount: harm,
          frpMw: Math.round(b.frp),
          multiYearAvgCount: Number(mean.toFixed(1)),
          anomalyPct: b.hasData ? Number(pct.toFixed(1)) : 0,
          anomalyZScore: b.hasData ? Number(z.toFixed(2)) : 0,
          inSelectedRange: y >= startYear && y <= endYear,
          hasData: b.hasData
        };
      });
    }

    const allInRegion = this.regionHotspots();
    const allDataset = this.data.hotspots();

    // Determine year span from dataset (default 2000..2026)
    let minYear = 2000;
    let maxYear = 2026;
    if (allDataset.length > 0) {
      minYear = Math.min(...allDataset.map(r => Number(r.date.slice(0, 4))));
      maxYear = Math.max(...allDataset.map(r => Number(r.date.slice(0, 4))));
    }

    const startMmDd = start.slice(5, 10);
    const endMmDd = end.slice(5, 10);

    const byYear = new Map<number, { modis: number; viirs: number; harm: number; frp: number }>();
    for (let y = minYear; y <= maxYear; y++) {
      byYear.set(y, { modis: 0, viirs: 0, harm: 0, frp: 0 });
    }

    for (const r of allInRegion) {
      const y = Number(r.date.slice(0, 4));
      const mmdd = r.date.slice(5, 10);
      if (useSeasonalWindow) {
        const matches = startMmDd <= endMmDd
          ? mmdd >= startMmDd && mmdd <= endMmDd
          : mmdd >= startMmDd || mmdd <= endMmDd;
        if (!matches) continue;
      }
      const bucket = byYear.get(y);
      if (!bucket) continue;
      bucket.modis += r.rawModisCount;
      bucket.viirs += r.rawViirsCount;
      bucket.harm += r.harmonizedCount;
      bucket.frp += r.frpMw;
    }

    const counts = Array.from(byYear.values()).map(v => v.harm);
    const nYears = Math.max(1, counts.length);
    const mean = counts.reduce((a, b) => a + b, 0) / nYears;
    const variance = counts.reduce((acc, c) => acc + Math.pow(c - mean, 2), 0) / nYears;
    const std = Math.max(1, Math.sqrt(variance));

    const out: YearlyComparisonPoint[] = [];
    for (let y = minYear; y <= maxYear; y++) {
      const b = byYear.get(y)!;
      const pct = mean > 0 ? ((b.harm - mean) / mean) * 100 : 0;
      const z = (b.harm - mean) / std;
      out.push({
        year: y,
        rawModisCount: b.modis,
        rawViirsCount: b.viirs,
        harmonizedCount: b.harm,
        frpMw: Math.round(b.frp),
        multiYearAvgCount: Number(mean.toFixed(1)),
        anomalyPct: Number(pct.toFixed(1)),
        anomalyZScore: Number(z.toFixed(2)),
        inSelectedRange: y >= startYear && y <= endYear,
        hasData: true
      });
    }
    return out;
  });

  /** Yearly series scaled to the currently analyzed date range (keeps multi-year baseline metadata). */
  readonly chartYearlyComparison = computed<YearlyComparisonPoint[]>(() => {
    const all = this.yearlyComparison();
    if (!this.state.hasDateRange()) return all;
    const selected = all.filter(y => y.inSelectedRange);
    return selected.length > 0 ? selected : all;
  });

  /** Fires-detected & anomaly bar series in either monthly or yearly granularity using regular period average. */
  readonly chartSeries = computed<ChartSeriesPoint[]>(() => {
    const mode = this.state.chartGranularity();
    if (mode === 'yearly') {
      const years = this.chartYearlyComparison();
      return this.finalizeChartSeries(
        years.map(y => ({
          key: String(y.year),
          label: String(y.year),
          modis: y.rawModisCount,
          viirs: y.rawViirsCount,
          harm: y.harmonizedCount,
          inSelectedRange: y.inSelectedRange,
          hasData: y.hasData,
          lo: null,
          hi: null
        }))
      );
    }

    const start = this.state.dateStart();
    const end = this.state.dateEnd();
    const hasDates = this.state.hasDateRange();
    const monthShort = [...this.i18n.t().monthNamesShort];
    const backend = this.data.backendCalendar();
    const isCustom = this.data.isCustomDataset();

    const startYm = hasDates ? start.slice(0, 7) : backend?.months[0] ?? '2025-01';
    const endYm = hasDates ? end.slice(0, 7) : backend?.months[backend.months.length - 1] ?? '2025-12';
    const [sy, sm] = startYm.split('-').map(Number);
    const [ey, em] = endYm.split('-').map(Number);
    if (!Number.isFinite(sy) || !Number.isFinite(sm) || !Number.isFinite(ey) || !Number.isFinite(em)) {
      return [];
    }

    const startIdx = sy * 12 + (sm - 1);
    const endIdx = Math.max(startIdx, ey * 12 + (em - 1));
    type MonthCounts = { modis: number; viirs: number; harm: number; hasData: boolean; lo: number | null; hi: number | null };
    const countsByYm = new Map<string, MonthCounts>();

    if (!isCustom && backend) {
      const ratio = this.backendSpatialRatio();
      const startDay = hasDates ? Number(start.slice(8, 10)) || 1 : 1;
      const endDay = hasDates ? Number(end.slice(8, 10)) || 31 : 31;
      const dailyByYear = backend.selection.dailyByYear ?? {};
      const coversRange = !hasDates || backendPayloadCoversRange(backend.selection, start, end);

      for (let i = 0; i < backend.months.length; i++) {
        const ym = backend.months[i];
        const y = Number(ym.slice(0, 4));
        const m = Number(ym.slice(5, 7));
        const dim = daysInUtcMonth(y, m);
        const isPartialStart = hasDates && ym === startYm && startDay > 1;
        const isPartialEnd = hasDates && ym === endYm && endDay < dim;
        const hasData = backend.series.harmonized[i] !== null && (backend.series.dataCoverage?.[i] ?? 1) > 0;
        const loRaw = backend.series.harmonizedLo90?.[i] ?? null;
        const hiRaw = backend.series.harmonizedHi90?.[i] ?? null;
        if (isPartialStart || isPartialEnd) {
          if (coversRange && dailyByYear[String(y)]) {
            const exact = sumDailyBucketsInMonth(dailyByYear[String(y)], y, m, start, end);
            if (exact) {
              countsByYm.set(ym, {
                modis: Math.round(exact.modis * ratio),
                viirs: Math.round(exact.viirs * ratio),
                harm: Math.round(exact.harm * ratio),
                hasData,
                lo: null,
                hi: null
              });
              continue;
            }
          }
          const lo = isPartialStart ? startDay : 1;
          const hi = isPartialEnd ? Math.min(dim, endDay) : dim;
          const frac = lo <= hi ? (hi - lo + 1) / dim : 0;
          countsByYm.set(ym, {
            modis: Math.round((backend.series.rawModis[i] ?? 0) * ratio * frac),
            viirs: Math.round((backend.series.rawViirs[i] ?? 0) * ratio * frac),
            harm: Math.round((backend.series.harmonized[i] ?? 0) * ratio * frac),
            hasData,
            lo: loRaw !== null ? loRaw * ratio * frac : null,
            hi: hiRaw !== null ? hiRaw * ratio * frac : null
          });
          continue;
        }
        countsByYm.set(ym, {
          modis: Math.round((backend.series.rawModis[i] ?? 0) * ratio),
          viirs: Math.round((backend.series.rawViirs[i] ?? 0) * ratio),
          harm: Math.round((backend.series.harmonized[i] ?? 0) * ratio),
          hasData,
          lo: loRaw !== null ? loRaw * ratio : null,
          hi: hiRaw !== null ? hiRaw * ratio : null
        });
      }
    } else {
      for (const r of this.filteredHotspots()) {
        const ym = r.date.slice(0, 7);
        const cur = countsByYm.get(ym) ?? { modis: 0, viirs: 0, harm: 0, hasData: true, lo: null, hi: null };
        cur.modis += r.rawModisCount;
        cur.viirs += r.rawViirsCount;
        cur.harm += r.harmonizedCount;
        countsByYm.set(ym, cur);
      }
    }

    const items: ChartItem[] = [];
    for (let idx = startIdx; idx <= endIdx; idx++) {
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      // A month absent from the backend payload counts as missing; from a custom dataset as zero
      const c = countsByYm.get(ym) ?? { modis: 0, viirs: 0, harm: 0, hasData: isCustom || !backend, lo: null, hi: null };
      items.push({
        key: ym,
        label: `${monthShort[m - 1] ?? String(m)} '${String(y).slice(-2)}`,
        modis: c.modis,
        viirs: c.viirs,
        harm: c.harm,
        inSelectedRange: true,
        hasData: c.hasData,
        lo: c.lo,
        hi: c.hi
      });
    }

    return this.finalizeChartSeries(items);
  });

  private finalizeChartSeries(items: ChartItem[]): ChartSeriesPoint[] {
    if (items.length === 0) return [];
    // periods that were never downloaded are gaps: they take no part in the period average
    const withData = items.filter(item => item.hasData);
    const n = Math.max(1, withData.length);
    const mean = withData.reduce((sum, item) => sum + item.harm, 0) / n;
    const variance = withData.reduce((sum, item) => sum + Math.pow(item.harm - mean, 2), 0) / n;
    const std = Math.sqrt(variance);

    return items.map(item => {
      const pct = item.hasData && mean > 0 ? ((item.harm - mean) / mean) * 100 : 0;
      const z = item.hasData && std > 0 ? (item.harm - mean) / std : 0;
      return {
        key: item.key,
        label: item.label,
        rawModisCount: item.modis,
        rawViirsCount: item.viirs,
        harmonizedCount: item.harm,
        avgCount: Number(mean.toFixed(1)),
        anomalyPct: Number(pct.toFixed(1)),
        anomalyZScore: Number(z.toFixed(2)),
        inSelectedRange: item.inSelectedRange,
        hasData: item.hasData,
        harmonizedLo90: item.lo,
        harmonizedHi90: item.hi
      };
    });
  }

  /** Summary KPI figures for the selected region & date range. */
  readonly summary = computed<HotspotAnalyticsSummary>(() => {
    const area = this.bboxArea();
    const yearly = this.yearlyComparison();
    const backend = this.data.backendCalendar();

    if (!this.data.isCustomDataset() && backend) {
      const ratio = this.backendSpatialRatio();
      const sel = backend.selection;
      const start = this.state.dateStart();
      const end = this.state.dateEnd();
      const hasDates = this.state.hasDateRange();

      let rawHarmTotal = sel.hotspots.harmonized;
      let rawModisTotal = sel.hotspots.rawModis;
      let rawViirsTotal = sel.hotspots.rawViirs;
      if (hasDates && (!sel.fromDate || !sel.toDate || sel.fromDate < start || sel.toDate > end)) {
        const startYm = start.slice(0, 7);
        const endYm = end.slice(0, 7);
        const startDay = Number(start.slice(8, 10)) || 1;
        const endDay = Number(end.slice(8, 10)) || 31;
        const dailyByYear = sel.dailyByYear ?? {};
        let calcHarm = 0;
        let calcModis = 0;
        let calcViirs = 0;
        for (let i = 0; i < backend.months.length; i++) {
          const ym = backend.months[i];
          if (ym < startYm || ym > endYm) continue;
          const y = Number(ym.slice(0, 4));
          const m = Number(ym.slice(5, 7));
          const dim = daysInUtcMonth(y, m);
          const isPartialStart = ym === startYm && startDay > 1;
          const isPartialEnd = ym === endYm && endDay < dim;
          if (isPartialStart || isPartialEnd) {
            const exact = sumDailyBucketsInMonth(dailyByYear[String(y)], y, m, start, end);
            if (exact) {
              calcHarm += exact.harm;
              calcModis += exact.modis;
              calcViirs += exact.viirs;
              continue;
            }
            const lo = isPartialStart ? startDay : 1;
            const hi = isPartialEnd ? Math.min(dim, endDay) : dim;
            const frac = lo <= hi ? (hi - lo + 1) / dim : 0;
            calcHarm += (backend.series.harmonized[i] ?? 0) * frac;
            calcModis += (backend.series.rawModis[i] ?? 0) * frac;
            calcViirs += (backend.series.rawViirs[i] ?? 0) * frac;
          } else {
            calcHarm += backend.series.harmonized[i] ?? 0;
            calcModis += backend.series.rawModis[i] ?? 0;
            calcViirs += backend.series.rawViirs[i] ?? 0;
          }
        }
        rawHarmTotal = calcHarm;
        rawModisTotal = calcModis;
        rawViirsTotal = calcViirs;
      }

      const harm = Math.round(rawHarmTotal * ratio);
      const modis = Math.round(rawModisTotal * ratio);
      const viirs = Math.round(rawViirsTotal * ratio);
      const totalFrp = Math.round((sel.frp?.totalMw ?? 0) * ratio);
      const meanFrp = sel.frp?.meanMw ?? 0;
      const activeFireDays = sel.frp?.activeFireDays ?? 0;
      const peakDate = sel.frp?.peakDate ?? null;
      const peakCount = Math.round((sel.frp?.peakCount ?? 0) * ratio);

      const activeYears = yearly.filter(y => y.inSelectedRange);
      const numSelectedYears = Math.max(1, activeYears.length);
      // Compare only with years that were downloaded; years never fetched are missing, not zero
      const withData = yearly.filter(y => y.hasData);
      const anomalyComparisonYears = withData.filter(y => !y.inSelectedRange).length;
      const anomalyAvailable = anomalyComparisonYears >= MIN_ANOMALY_YEARS;
      const singleYearAvg = withData.length > 0 ? withData[0].multiYearAvgCount : 0;
      const expectedTotal = anomalyAvailable ? singleYearAvg * numSelectedYears : 0;

      const counts = withData.map(y => y.harmonizedCount);
      const variance = counts.reduce((acc, c) => acc + Math.pow(c - singleYearAvg, 2), 0) / Math.max(1, counts.length);
      const std = Math.max(1, Math.sqrt(variance));

      const avgPerSelectedYear = harm / numSelectedYears;
      const anomalyZScore = anomalyAvailable ? Number(((avgPerSelectedYear - singleYearAvg) / std).toFixed(2)) : 0;
      const anomalyPct = expectedTotal > 0 ? Number((((harm - expectedTotal) / expectedTotal) * 100).toFixed(1)) : 0;

      const activeDataset = this.state.activeDataset();
      const requiresBoth = this.state.requiresBothSensors();
      let activeDatasetFires =
        activeDataset === 'VIIRS' ? viirs : activeDataset === 'MODIS' ? modis : viirs + modis;
      if (activeDataset === 'BOTH' && requiresBoth) {
        let preModis = 0;
        let postViirs = 0;
        const fromYm = sel.from;
        const toYm = sel.to;
        for (let i = 0; i < backend.months.length; i++) {
          const ym = backend.months[i];
          if (ym < fromYm || ym > toYm) continue;
          if (ym < '2012-01') {
            preModis += backend.series.rawModis[i] ?? 0;
          } else {
            postViirs += backend.series.rawViirs[i] ?? 0;
          }
        }
        activeDatasetFires = Math.round((preModis + postViirs) * ratio);
      }
      return {
        totalRecords: modis + viirs,
        harmonizedFires: harm,
        rawModisFires: modis,
        rawViirsFires: viirs,
        totalFrpMw: totalFrp,
        meanFrpMw: meanFrp,
        activeFireDays,
        peakDate,
        peakCount,
        multiYearAvgFires: Number(expectedTotal.toFixed(1)),
        anomalyPct,
        anomalyZScore,
        anomalyComparisonYears,
        anomalyAvailable,
        areaKm2: area.km2,
        areaHa: area.ha,
        activeDataset,
        activeDatasetFires
      };
    }

    const records = this.filteredHotspots();

    let harm = 0;
    let modis = 0;
    let viirs = 0;
    let frp = 0;
    const dayTotals = new Map<string, number>();

    for (const r of records) {
      harm += r.harmonizedCount;
      modis += r.rawModisCount;
      viirs += r.rawViirsCount;
      frp += r.frpMw;
      dayTotals.set(r.date, (dayTotals.get(r.date) ?? 0) + r.harmonizedCount);
    }

    let peakDate: string | null = null;
    let peakCount = 0;
    for (const [d, c] of dayTotals.entries()) {
      if (c > peakCount) {
        peakCount = c;
        peakDate = d;
      }
    }

    const activeYears = yearly.filter(y => y.inSelectedRange);
    const numSelectedYears = Math.max(1, activeYears.length);
    const anomalyComparisonYears = yearly.filter(y => !y.inSelectedRange).length;
    const anomalyAvailable = anomalyComparisonYears >= MIN_ANOMALY_YEARS;
    const singleYearAvg = yearly.length > 0 ? yearly[0].multiYearAvgCount : 0;
    const expectedTotal = singleYearAvg * numSelectedYears;

    const counts = yearly.map(y => y.harmonizedCount);
    const meanSingle = singleYearAvg;
    const variance = counts.reduce((acc, c) => acc + Math.pow(c - meanSingle, 2), 0) / Math.max(1, counts.length);
    const std = Math.max(1, Math.sqrt(variance));

    const avgPerSelectedYear = harm / numSelectedYears;
    const anomalyZScore = Number(((avgPerSelectedYear - meanSingle) / std).toFixed(2));
    const anomalyPct = expectedTotal > 0 ? Number((((harm - expectedTotal) / expectedTotal) * 100).toFixed(1)) : 0;

    const activeDataset = this.state.activeDataset();
    const requiresBoth = this.state.requiresBothSensors();
    const activeDatasetFires =
      activeDataset === 'BOTH'
        ? requiresBoth
          ? records.reduce(
              (sum, r) => sum + (r.date < VIIRS_FIRST_DATE ? r.rawModisCount : r.rawViirsCount),
              0
            )
          : viirs + modis
        : activeDataset === 'VIIRS'
          ? viirs
          : modis;
    return {
      totalRecords: records.length,
      harmonizedFires: harm,
      rawModisFires: modis,
      rawViirsFires: viirs,
      totalFrpMw: Math.round(frp),
      meanFrpMw: records.length > 0 ? Number((frp / records.length).toFixed(1)) : 0,
      activeFireDays: dayTotals.size,
      peakDate,
      peakCount,
      multiYearAvgFires: Number(expectedTotal.toFixed(1)),
      anomalyPct: anomalyAvailable ? anomalyPct : 0,
      anomalyZScore: anomalyAvailable ? anomalyZScore : 0,
      anomalyComparisonYears,
      anomalyAvailable,
      areaKm2: area.km2,
      areaHa: area.ha,
      activeDataset,
      activeDatasetFires
    };
  });

  /** Burning calendar heatmap matrix (Year×Month or Month×Day). */
  readonly burningCalendar = computed<BurningCalendarModel>(() => {
    const mode = this.state.calendarGranularity();
    const start = this.state.dateStart();
    const end = this.state.dateEnd();
    const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const backend = this.data.backendCalendar();
    if (!this.data.isCustomDataset() && backend) {
      const ratio = this.backendSpatialRatio();
      if (mode === 'daily') {
        const hasDates = this.state.hasDateRange();
        const byMmDd = new Map<string, BackendDailyBucket>();
        for (const row of backend.selection.daily ?? []) {
          byMmDd.set(row.mmdd, row);
        }

        const inRangeValues: BackendDailyBucket[] = [];
        for (let m = 0; m < 12; m++) {
          const daysInMonth = daysInUtcMonth(2024, m + 1);
          for (let d = 0; d < daysInMonth; d++) {
            const mmdd = `${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
            if (hasDates && !isMmDdInDateRange(m, d + 1, start, end)) continue;
            const b = byMmDd.get(mmdd);
            if (b) inRangeValues.push(b);
          }
        }
        const maxCount = Math.max(1, ...inRangeValues.map(v => Math.round(v.harmonized * ratio)));
        const maxFrp = Math.max(1, ...inRangeValues.map(v => Math.round(v.frpMw * ratio)));

        const cells: BurningCalendarCell[] = [];
        for (let m = 0; m < 12; m++) {
          const daysInMonth = daysInUtcMonth(2024, m + 1);
          for (let d = 0; d < 31; d++) {
            const validDay = d < daysInMonth;
            const inRange = validDay && (!hasDates || isMmDdInDateRange(m, d + 1, start, end));
            const mmdd = `${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
            const b = inRange ? byMmDd.get(mmdd) : undefined;
            const harm = b ? Math.round(b.harmonized * ratio) : 0;
            const avg = b ? b.baselineAvg * ratio : 0;
            const z = inRange ? (avg > 0 ? (harm - avg) / Math.max(1, Math.sqrt(avg)) : harm > 0 ? 1.5 : 0) : 0;
            cells.push({
              key: mmdd,
              label: `${monthShort[m]} ${String(d + 1).padStart(2, '0')}`,
              row: m,
              col: d,
              harmonizedCount: harm,
              rawModisCount: Math.round((b?.rawModis ?? 0) * ratio),
              rawViirsCount: Math.round((b?.rawViirs ?? 0) * ratio),
              frpMw: Math.round((b?.frpMw ?? 0) * ratio),
              multiYearAvg: Number(avg.toFixed(1)),
              anomalyZScore: Number(z.toFixed(2)),
              intensity: inRange && harm > 0 ? Math.min(1, Math.pow(harm / maxCount, 0.72)) : 0,
              inRange
            });
          }
        }
        return {
          mode: 'daily',
          rowLabels: monthShort,
          colLabels: Array.from({ length: 31 }, (_, i) => String(i + 1)),
          cells,
          maxCount,
          maxFrp
        };
      }

      // Monthly mode from backend cube
      const startYear = Number(start.slice(0, 4));
      const endYear = Number(end.slice(0, 4));
      const startYm = start.slice(0, 7);
      const endYm = end.slice(0, 7);
      const displayStartYear = Math.min(startYear, endYear);
      const displayEndYear = Math.max(startYear, endYear);
      const years = backend.calendar.years.filter(y => y >= displayStartYear && y <= displayEndYear);
      const finalYears = years.length > 0 ? years : backend.calendar.years;

      const byYm = new Map<string, { harm: number; modis: number; viirs: number; z: number }>();
      for (let i = 0; i < backend.months.length; i++) {
        byYm.set(backend.months[i], {
          harm: Math.round((backend.series.harmonized[i] ?? 0) * ratio),
          modis: Math.round((backend.series.rawModis[i] ?? 0) * ratio),
          viirs: Math.round((backend.series.rawViirs[i] ?? 0) * ratio),
          z: backend.series.anomalyZ[i] ?? 0
        });
      }

      let maxCount = 1;
      for (const y of finalYears) {
        for (let m = 0; m < 12; m++) {
          const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
          const inRange = ym >= startYm && ym <= endYm;
          const b = byYm.get(ym);
          if (inRange && b && b.harm > maxCount) maxCount = b.harm;
        }
      }

      const cells: BurningCalendarCell[] = [];
      for (let yi = 0; yi < finalYears.length; yi++) {
        const y = finalYears[yi];
        for (let m = 0; m < 12; m++) {
          const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
          const inRange = ym >= startYm && ym <= endYm;
          const b = byYm.get(ym);
          const harm = b?.harm ?? 0;
          const avg = (backend.climatology.monthMean[m] ?? 0) * ratio;
          const z = b?.z ?? 0;
          cells.push({
            key: ym,
            label: `${monthShort[m]} ${y}`,
            row: yi,
            col: m,
            harmonizedCount: harm,
            rawModisCount: b?.modis ?? 0,
            rawViirsCount: b?.viirs ?? 0,
            frpMw: 0,
            multiYearAvg: Number(avg.toFixed(1)),
            anomalyZScore: Number(z.toFixed(2)),
            intensity: inRange && harm > 0 ? Math.min(1, Math.pow(harm / maxCount, 0.72)) : 0,
            inRange
          });
        }
      }
      return {
        mode: 'monthly',
        rowLabels: finalYears.map(String),
        colLabels: monthShort,
        cells,
        maxCount,
        maxFrp: 1
      };
    }

    const region = this.regionHotspots();
    const filtered = this.filteredHotspots();

    if (mode === 'daily') {
      // 12 months (rows) x 31 days (cols) aggregated across selected date range
      const buckets = new Map<string, { harm: number; modis: number; viirs: number; frp: number }>();
      const baselineBuckets = new Map<string, number>();

      for (const r of region) {
        const key = r.date.slice(5, 10); // MM-DD
        baselineBuckets.set(key, (baselineBuckets.get(key) ?? 0) + r.harmonizedCount);
      }
      for (const r of filtered) {
        const key = r.date.slice(5, 10);
        const b = buckets.get(key) ?? { harm: 0, modis: 0, viirs: 0, frp: 0 };
        b.harm += r.harmonizedCount;
        b.modis += r.rawModisCount;
        b.viirs += r.rawViirsCount;
        b.frp += r.frpMw;
        buckets.set(key, b);
      }

      const yearsInRegion = Math.max(1, new Set(region.map(r => r.date.slice(0, 4))).size);
      const maxCount = Math.max(1, ...Array.from(buckets.values()).map(v => v.harm));
      const maxFrp = Math.max(1, ...Array.from(buckets.values()).map(v => v.frp));

      const hasDates = this.state.hasDateRange();
      const cells: BurningCalendarCell[] = [];
      for (let m = 0; m < 12; m++) {
        const daysInMonth = daysInUtcMonth(2024, m + 1); // leap-safe 31/29
        for (let d = 0; d < 31; d++) {
          const validDay = d < daysInMonth;
          const inRange = validDay && (!hasDates || isMmDdInDateRange(m, d + 1, start, end));
          const mmdd = `${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
          const b = inRange ? (buckets.get(mmdd) ?? { harm: 0, modis: 0, viirs: 0, frp: 0 }) : { harm: 0, modis: 0, viirs: 0, frp: 0 };
          const avg = (baselineBuckets.get(mmdd) ?? 0) / yearsInRegion;
          const z = inRange ? (avg > 0 ? (b.harm - avg) / Math.max(1, Math.sqrt(avg)) : b.harm > 0 ? 1.5 : 0) : 0;

          cells.push({
            key: mmdd,
            label: `${monthShort[m]} ${String(d + 1).padStart(2, '0')}`,
            row: m,
            col: d,
            harmonizedCount: b.harm,
            rawModisCount: b.modis,
            rawViirsCount: b.viirs,
            frpMw: Math.round(b.frp),
            multiYearAvg: Number(avg.toFixed(1)),
            anomalyZScore: Number(z.toFixed(2)),
            intensity: inRange && b.harm > 0 ? Math.min(1, Math.pow(b.harm / maxCount, 0.72)) : 0,
            inRange
          });
        }
      }

      return {
        mode: 'daily',
        rowLabels: monthShort,
        colLabels: Array.from({ length: 31 }, (_, i) => String(i + 1)),
        cells,
        maxCount,
        maxFrp
      };
    }

    // Monthly mode: Years (rows) x 12 Months (cols)
    const startYear = Number(start.slice(0, 4));
    const endYear = Number(end.slice(0, 4));
    const startYm = start.slice(0, 7);
    const endYm = end.slice(0, 7);

    // Show selected years, or up to last 12 years if wide, or all years in range
    const displayStartYear = Math.min(startYear, endYear);
    const displayEndYear = Math.max(startYear, endYear);
    const years: number[] = [];
    for (let y = displayStartYear; y <= displayEndYear; y++) {
      years.push(y);
    }

    const ymBuckets = new Map<string, { harm: number; modis: number; viirs: number; frp: number }>();
    const monthTotals = new Array<number>(12).fill(0);
    const allYearsSet = new Set<string>();

    for (const r of region) {
      const ym = r.date.slice(0, 7);
      allYearsSet.add(r.date.slice(0, 4));
      const mIdx = Number(r.date.slice(5, 7)) - 1;
      monthTotals[mIdx] += r.harmonizedCount;
      const b = ymBuckets.get(ym) ?? { harm: 0, modis: 0, viirs: 0, frp: 0 };
      b.harm += r.harmonizedCount;
      b.modis += r.rawModisCount;
      b.viirs += r.rawViirsCount;
      b.frp += r.frpMw;
      ymBuckets.set(ym, b);
    }

    const totalBaselineYears = Math.max(1, allYearsSet.size);
    const cells: BurningCalendarCell[] = [];
    let maxCount = 1;
    let maxFrp = 1;

    for (let yi = 0; yi < years.length; yi++) {
      const y = years[yi];
      for (let m = 0; m < 12; m++) {
        const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
        const inRange = ym >= startYm && ym <= endYm;
        const b = ymBuckets.get(ym) ?? { harm: 0, modis: 0, viirs: 0, frp: 0 };
        if (inRange && b.harm > maxCount) maxCount = b.harm;
        if (inRange && b.frp > maxFrp) maxFrp = b.frp;
      }
    }

    for (let yi = 0; yi < years.length; yi++) {
      const y = years[yi];
      for (let m = 0; m < 12; m++) {
        const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
        const inRange = ym >= startYm && ym <= endYm;
        const b = ymBuckets.get(ym) ?? { harm: 0, modis: 0, viirs: 0, frp: 0 };
        const avg = monthTotals[m] / totalBaselineYears;
        const z = avg > 0 ? (b.harm - avg) / Math.max(1, Math.sqrt(avg)) : b.harm > 0 ? 1.5 : 0;

        cells.push({
          key: ym,
          label: `${monthShort[m]} ${y}`,
          row: yi,
          col: m,
          harmonizedCount: b.harm,
          rawModisCount: b.modis,
          rawViirsCount: b.viirs,
          frpMw: Math.round(b.frp),
          multiYearAvg: Number(avg.toFixed(1)),
          anomalyZScore: Number(z.toFixed(2)),
          intensity: inRange && b.harm > 0 ? Math.min(1, Math.pow(b.harm / maxCount, 0.72)) : 0,
          inRange
        });
      }
    }

    return {
      mode: 'monthly',
      rowLabels: years.map(String),
      colLabels: monthShort,
      cells,
      maxCount,
      maxFrp
    };
  });

  /**
   * Month × Day calendar split per touched calendar year when 2+ years overlap the selection.
   * Uses unified intensity normalization across years so collapsible sections compare on the same scale.
   */
  readonly burningCalendarsDailyByYear = computed<YearBurningCalendarModel[]>(() => {
    if (this.state.calendarGranularity() !== 'daily') return [];
    const start = this.state.dateStart();
    const end = this.state.dateEnd();
    if (!start || !end) return [];

    const y0 = Number(start.slice(0, 4));
    const y1 = Number(end.slice(0, 4));
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return [];
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const years: number[] = [];
    for (let y = minY; y <= maxY; y++) {
      years.push(y);
    }

    const monthShort = [...this.i18n.t().monthNamesShort];
    const colLabels = Array.from({ length: 31 }, (_, i) => String(i + 1));

    type DailyBucket = { harm: number; modis: number; viirs: number; frp: number; avg: number };
    const bucketsByYear = new Map<number, Map<string, DailyBucket>>();
    for (const y of years) {
      bucketsByYear.set(y, new Map<string, DailyBucket>());
    }

    const backend = this.data.backendCalendar();
    if (!this.data.isCustomDataset() && backend) {
      const ratio = this.backendSpatialRatio();
      const baseAvgByMmDd = new Map<string, number>();
      for (const row of backend.selection.daily ?? []) {
        baseAvgByMmDd.set(row.mmdd, row.baselineAvg * ratio);
      }

      const byYearPayload = backend.selection.dailyByYear;
      if (byYearPayload) {
        for (const y of years) {
          const map = bucketsByYear.get(y)!;
          for (const row of byYearPayload[String(y)] ?? []) {
            map.set(row.mmdd, {
              harm: Math.round(row.harmonized * ratio),
              modis: Math.round(row.rawModis * ratio),
              viirs: Math.round(row.rawViirs * ratio),
              frp: Math.round(row.frpMw * ratio),
              avg: row.baselineAvg * ratio
            });
          }
        }
      } else if (years.length === 1) {
        const map = bucketsByYear.get(years[0])!;
        for (const row of backend.selection.daily ?? []) {
          map.set(row.mmdd, {
            harm: Math.round(row.harmonized * ratio),
            modis: Math.round(row.rawModis * ratio),
            viirs: Math.round(row.rawViirs * ratio),
            frp: Math.round(row.frpMw * ratio),
            avg: row.baselineAvg * ratio
          });
        }
      } else {
        // Fallback for cached/older backends without `dailyByYear`: apportion mm-dd across years by monthly share.
        const monthTotalsByYear = new Map<string, number>();
        const monthSumAcrossYears = new Array<number>(12).fill(0);
        for (let i = 0; i < backend.months.length; i++) {
          const ym = backend.months[i];
          const y = Number(ym.slice(0, 4));
          if (y < minY || y > maxY) continue;
          const mIdx = Number(ym.slice(5, 7)) - 1;
          const v = Math.max(0, backend.series.harmonized[i] ?? 0);
          monthTotalsByYear.set(ym, v);
          monthSumAcrossYears[mIdx] += v;
        }
        for (const row of backend.selection.daily ?? []) {
          const mIdx = Number(row.mmdd.slice(0, 2)) - 1;
          const totalMonth = monthSumAcrossYears[mIdx];
          for (const y of years) {
            const ym = `${y}-${row.mmdd.slice(0, 2)}`;
            const iso = `${y}-${row.mmdd}`;
            if (iso < start || iso > end) continue;
            const share = totalMonth > 0
              ? (monthTotalsByYear.get(ym) ?? 0) / totalMonth
              : 1 / years.length;
            if (share <= 0) continue;
            bucketsByYear.get(y)!.set(row.mmdd, {
              harm: Math.round(row.harmonized * ratio * share),
              modis: Math.round(row.rawModis * ratio * share),
              viirs: Math.round(row.rawViirs * ratio * share),
              frp: Math.round(row.frpMw * ratio * share),
              avg: row.baselineAvg * ratio
            });
          }
        }
      }
    } else {
      const region = this.regionHotspots();
      const filtered = this.filteredHotspots();
      const baselineBuckets = new Map<string, number>();
      const yearsInRegion = Math.max(1, new Set(region.map(r => r.date.slice(0, 4))).size);
      for (const r of region) {
        const mmdd = r.date.slice(5, 10);
        baselineBuckets.set(mmdd, (baselineBuckets.get(mmdd) ?? 0) + r.harmonizedCount);
      }
      for (const r of filtered) {
        const y = Number(r.date.slice(0, 4));
        const map = bucketsByYear.get(y);
        if (!map) continue;
        const mmdd = r.date.slice(5, 10);
        const cur = map.get(mmdd) ?? {
          harm: 0,
          modis: 0,
          viirs: 0,
          frp: 0,
          avg: (baselineBuckets.get(mmdd) ?? 0) / yearsInRegion
        };
        cur.harm += r.harmonizedCount;
        cur.modis += r.rawModisCount;
        cur.viirs += r.rawViirsCount;
        cur.frp += r.frpMw;
        map.set(mmdd, cur);
      }
    }

    let maxCount = 1;
    let maxFrp = 1;
    for (const map of bucketsByYear.values()) {
      for (const b of map.values()) {
        if (b.harm > maxCount) maxCount = b.harm;
        if (b.frp > maxFrp) maxFrp = b.frp;
      }
    }

    return years.map(year => {
      const map = bucketsByYear.get(year)!;
      const cells: BurningCalendarCell[] = [];
      let totalHarmonized = 0;

      for (let m = 0; m < 12; m++) {
        const daysInMonth = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
        for (let d = 0; d < 31; d++) {
          const validDay = d < daysInMonth;
          const mmdd = `${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
          const isoDate = `${year}-${mmdd}`;
          const inRange = validDay && isoDate >= start && isoDate <= end;
          const b = map.get(mmdd);
          const harm = inRange && b ? b.harm : 0;
          totalHarmonized += harm;
          const avg = b ? b.avg : 0;
          const z = avg > 0 ? (harm - avg) / Math.max(1, Math.sqrt(avg)) : harm > 0 ? 1.5 : 0;

          cells.push({
            key: isoDate,
            label: `${monthShort[m]} ${String(d + 1).padStart(2, '0')}, ${year}`,
            row: m,
            col: d,
            harmonizedCount: harm,
            rawModisCount: inRange && b ? b.modis : 0,
            rawViirsCount: inRange && b ? b.viirs : 0,
            frpMw: inRange && b ? b.frp : 0,
            multiYearAvg: Number(avg.toFixed(1)),
            anomalyZScore: Number(z.toFixed(2)),
            intensity: validDay && inRange && harm > 0 ? Math.min(1, Math.pow(harm / maxCount, 0.72)) : 0,
            inRange
          });
        }
      }

      return {
        year,
        totalHarmonized,
        calendar: {
          mode: 'daily',
          rowLabels: monthShort,
          colLabels,
          cells,
          maxCount,
          maxFrp
        }
      };
    });
  });

  computeBboxArea(bbox: BoundingBox): { km2: number; ha: number; m2: number } {
    const [w, s, e, n] = bbox;
    const meanLatRad = (((s + n) / 2) * Math.PI) / 180;
    const widthKm = Math.abs(e - w) * 111.32 * Math.cos(meanLatRad);
    const heightKm = Math.abs(n - s) * 110.574;
    const rawKm2 = widthKm * heightKm;
    const km2 = Math.round(rawKm2);
    return { km2, ha: km2 * 100, m2: Math.max(0, Math.round(rawKm2 * 1_000_000)) };
  }

  computeMultiPolygonArea(multi: MultiPolygonCoords): { km2: number; ha: number; m2: number } {
    if (multi.length === 0) {
      return { km2: 0, ha: 0, m2: 0 };
    }
    let totalKm2 = 0;
    for (const poly of multi) {
      if (poly.length === 0) continue;
      totalKm2 += this.computeRingAreaKm2(poly[0]);
      for (let h = 1; h < poly.length; h++) {
        totalKm2 -= this.computeRingAreaKm2(poly[h]);
      }
    }
    if (totalKm2 <= 0) {
      return { km2: 0, ha: 0, m2: 0 };
    }
    const km2 = Math.max(1, Math.round(totalKm2));
    return { km2, ha: km2 * 100, m2: Math.max(0, Math.round(totalKm2 * 1_000_000)) };
  }

  /** Localized geographic area name where the globe camera is currently pointed. */
  readonly pointedAreaName = computed<string>(() => {
    const t = this.i18n.t();
    const lang = this.i18n.lang();
    const [lon, lat] = this.state.cameraTargetLonLat();
    const countries = this.data.countries();

    let displayNames: Intl.DisplayNames | null = null;
    try {
      displayNames = new Intl.DisplayNames([lang], { type: 'region' });
    } catch {
      displayNames = null;
    }

    for (const c of countries) {
      if (!c.bboxes.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n)) continue;
      for (const poly of c.polygons) {
        if (isPointInPolygonCoords(lon, lat, poly)) {
          if (displayNames && c.iso2) {
            try {
              const localized = displayNames.of(c.iso2);
              if (localized) return localized;
            } catch {
              // fallback to raw name
            }
          }
          return c.name;
        }
      }
    }

    return t.globeAreaUnknown;
  });

  /**
   * Smart dynamic alt text for the 3D wildfire globe describing the current camera area,
   * bounding box, fire count (harmonized + MODIS/VIIRS), and active time range.
   */
  readonly globeAltText = computed<string>(() => {
    const t = this.i18n.t();
    const lang = this.i18n.lang();
    const [lon, lat] = this.state.cameraTargetLonLat();
    const area = this.pointedAreaName();
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    const coords = `${Math.abs(lat).toFixed(1)}°${latDir}, ${Math.abs(lon).toFixed(1)}°${lonDir}`;

    const active = this.state.hasActiveSelection();
    const bbox = this.state.regionBbox();
    const start = this.state.dateStart();
    const end = this.state.dateEnd();

    if (!active || !bbox) {
      return t.globeAltEmpty
        .replace('{area}', area)
        .replace('{coords}', coords);
    }

    const bboxText = `${bbox[0].toFixed(2)}°, ${bbox[1].toFixed(2)}°, ${bbox[2].toFixed(2)}°, ${bbox[3].toFixed(2)}°`;
    const bStatus = this.data.backendStatus();
    if (!this.data.isCustomDataset() && (bStatus === 'loading' || bStatus === 'downloading') && !this.data.backendCalendar()) {
      return t.globeAltLoading
        .replace('{area}', area)
        .replace('{coords}', coords)
        .replace('{bbox}', bboxText)
        .replace('{from}', start)
        .replace('{to}', end);
    }

    const s = this.summary();
    const fmt = new Intl.NumberFormat(lang);
    return t.globeAltActive
      .replace('{area}', area)
      .replace('{coords}', coords)
      .replace('{bbox}', bboxText)
      .replace('{fires}', fmt.format(s.harmonizedFires))
      .replace('{modis}', fmt.format(s.rawModisFires))
      .replace('{viirs}', fmt.format(s.rawViirsFires))
      .replace('{from}', start || '—')
      .replace('{to}', end || '—');
  });

  private computeRingAreaKm2(ring: PolygonRing): number {
    if (ring.length < 3) return 0;
    let sumLat = 0;
    for (const pt of ring) sumLat += pt[1];
    const meanLatRad = ((sumLat / ring.length) * Math.PI) / 180;
    const cosLat = Math.cos(meanLatRad);
    let areaDeg2 = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      areaDeg2 += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return Math.abs(areaDeg2 * 0.5) * (111.32 * cosLat) * 110.574;
  }

  async downloadFilteredCsv(): Promise<void> {
    const start = this.state.dateStart() || 'all';
    const end = this.state.dateEnd() || 'all';
    const stamp = `${start}_to_${end}`;
    if (!this.data.isCustomDataset() && this.data.backendStatus() === 'live' && this.state.regionBbox()) {
      try {
        const url = this.data.getBackendHotspotsCsvUrl(
          this.state.regionBboxes(),
          this.state.dateStart(),
          this.state.dateEnd()
        );
        const resp = await fetch(url);
        if (resp.ok && (resp.headers.get('content-type') ?? '').includes('csv')) {
          const blob = await resp.blob();
          this.triggerBlobDownload(blob, `firms-hotspots_${stamp}.csv`);
          return;
        }
      } catch {
        // fallback below to local client export
      }
    }

    const records = this.filteredHotspots();
    const header = 'id,date,lon,lat,frp_mw,confidence,sensor,raw_modis_count,raw_viirs_count,harmonized_count,biome,region_name';
    const rows = records.map(r => [
      this.csvEscape(r.id),
      r.date,
      r.lon,
      r.lat,
      r.frpMw,
      r.confidence,
      r.sensor,
      r.rawModisCount,
      r.rawViirsCount,
      r.harmonizedCount,
      this.csvEscape(r.biome),
      this.csvEscape(r.regionName ?? '')
    ].join(','));

    const csv = [header, ...rows].join('\n');
    this.triggerDownload(csv, `harmonized-hotspots_${stamp}.csv`, 'text/csv;charset=utf-8');
  }

  downloadSampleCsv(): void {
    const csv = this.data.getSampleCsvTemplate();
    this.triggerDownload(csv, 'harmonized-hotspots-template.csv', 'text/csv;charset=utf-8');
  }

  downloadAnalyticsJson(): void {
    const payload = {
      generatedAt: new Date().toISOString(),
      datasetSource: this.data.isCustomDataset()
        ? this.data.hotspotDatasetName()
        : 'NASA FIRMS MODIS (MCD14ML) + VIIRS (VNP14IMGML), harmonized to MODIS-equivalent hotspots',
      activeDataset: this.state.activeDataset(),
      regionBbox: this.state.regionBbox(),
      regionPolygon: this.state.regionPolygon(),
      dateRange: {
        start: this.state.dateStart(),
        end: this.state.dateEnd()
      },
      summary: this.summary(),
      yearlyComparison: this.yearlyComparison(),
      burningCalendar: this.burningCalendar(),
      filteredHotspotsCount: this.filteredHotspots().length
    };
    const stamp = `${this.state.dateStart() || 'all'}_to_${this.state.dateEnd() || 'all'}`;
    this.triggerDownload(
      JSON.stringify(payload, null, 2),
      `fire-analytics-report_${stamp}.json`,
      'application/json;charset=utf-8'
    );
  }

  downloadSvgReport(): void {
    const svg = this.buildCompositeReportSvg();
    const stamp = `${this.state.dateStart()}_to_${this.state.dateEnd()}`;
    this.triggerDownload(svg, `fire-activity-visualizations_${stamp}.svg`, 'image/svg+xml;charset=utf-8');
  }

  async downloadPngReport(): Promise<void> {
    const svg = this.buildCompositeReportSvg();
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = err => reject(err);
        image.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = 2400;
      canvas.height = 1880;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = '#f5f7fb';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const pngBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (pngBlob) {
        const stamp = `${this.state.dateStart()}_to_${this.state.dateEnd()}`;
        this.triggerBlobDownload(pngBlob, `fire-activity-visualizations_${stamp}.png`);
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Builds a self-contained publication-grade 1200x940 SVG report of the active
   * Region, Date Range, Key Indices, Burning Calendar, and Historical Anomaly Charts.
   */
  private buildCompositeReportSvg(): string {
    const t = this.i18n.t();
    const s = this.summary();
    const cal = this.burningCalendar();
    const series = this.chartSeries();
    const rampId = this.state.colorRamp();
    const [w, south, e, n] = this.state.regionBbox() ?? [-180, -85, 180, 85];

    const esc = (str: string) =>
      str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // KPI Cards
    const kpis = [
      { label: t.kpiHarmonizedFires, val: s.harmonizedFires.toLocaleString(), sub: `MODIS ${s.rawModisFires.toLocaleString()} · VIIRS ${s.rawViirsFires.toLocaleString()}` },
      s.anomalyAvailable
        ? { label: t.kpiMultiYearAnomaly, val: `${s.anomalyZScore >= 0 ? '+' : ''}${s.anomalyZScore}σ`, sub: `${s.anomalyPct >= 0 ? '+' : ''}${s.anomalyPct}% vs avg (${s.multiYearAvgFires.toLocaleString()})` }
        : { label: t.kpiMultiYearAnomaly, val: '—', sub: t.kpiAnomalyNoHistory },
      { label: t.kpiTotalFrp, val: `${s.totalFrpMw.toLocaleString()} MW`, sub: `${t.kpiMeanFrp}: ${s.meanFrpMw} MW` },
      { label: t.kpiPeakDate, val: s.peakDate ?? '—', sub: `${s.activeFireDays} ${t.kpiActiveDays} · ${this.i18n.formatArea(this.bboxArea().m2)}` }
    ];

    const kpiSvg = kpis
      .map((k, idx) => {
        const x = 40 + idx * 285;
        return `
          <rect x="${x}" y="112" width="268" height="84" rx="12" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>
          <text x="${x + 16}" y="136" font-size="11" font-weight="600" fill="#64748b">${esc(k.label)}</text>
          <text x="${x + 16}" y="166" font-size="22" font-weight="700" fill="#0f172a" font-family="monospace">${esc(k.val)}</text>
          <text x="${x + 16}" y="185" font-size="11" fill="#475569">${esc(k.sub)}</text>
        `;
      })
      .join('');

    // Burning Calendar Grid
    const calX = 56;
    const calY = 258;
    const calW = 1088;
    const calH = 260;
    const rows = Math.max(1, cal.rowLabels.length);
    const cols = Math.max(1, cal.colLabels.length);
    const cellW = Math.floor((calW - 56) / cols);
    const cellH = Math.min(20, Math.floor((calH - 28) / rows));

    const calCellsSvg = cal.cells
      .map(c => {
        const cx = calX + 48 + c.col * cellW;
        const cy = calY + 18 + c.row * cellH;
        let fill = '#eef2f7';
        let opacity = c.inRange ? 1 : 0.35;
        if (c.harmonizedCount > 0 && c.inRange) {
          fill = this.ramps.sampleHex(rampId, c.intensity);
        } else if (c.harmonizedCount > 0) {
          fill = '#cbd5e1';
        }
        return `<rect x="${cx}" y="${cy}" width="${Math.max(4, cellW - 2)}" height="${Math.max(4, cellH - 2)}" rx="3" fill="${fill}" opacity="${opacity}"/>`;
      })
      .join('');

    const calRowLabelsSvg = cal.rowLabels
      .filter((_, i) => rows <= 14 || i % Math.ceil(rows / 10) === 0 || i === rows - 1)
      .map(lbl => {
        const idx = cal.rowLabels.indexOf(lbl);
        const cy = calY + 18 + idx * cellH + cellH * 0.72;
        return `<text x="${calX + 42}" y="${cy}" font-size="10" text-anchor="end" fill="#475569" font-family="monospace">${esc(lbl)}</text>`;
      })
      .join('');

    const calColLabelsSvg = cal.colLabels
      .filter((_, i) => cols <= 14 || i % 3 === 0)
      .map(lbl => {
        const idx = cal.colLabels.indexOf(lbl);
        const cx = calX + 48 + idx * cellW + cellW * 0.45;
        return `<text x="${cx}" y="${calY + 11}" font-size="10" text-anchor="middle" fill="#64748b">${esc(lbl)}</text>`;
      })
      .join('');

    // Historical Fires Chart (Left bottom) + Anomaly Z-Score Chart (Right bottom)
    const chartY = 582;
    const chartH = 220;
    const maxYVal = Math.max(1, ...series.map(y => Math.max(y.harmonizedCount, y.rawModisCount, y.avgCount)));
    const barSlot = 510 / Math.max(1, series.length);

    const histBarsSvg = series
      .map((y, idx) => {
        const barW = Math.min(68, Math.max(4, barSlot - 4));
        const bx = 66 + idx * barSlot + (barSlot - barW) / 2;
        const hHarm = (y.harmonizedCount / maxYVal) * (chartH - 34);
        const hModis = (y.rawModisCount / maxYVal) * (chartH - 34);
        const byHarm = chartY + chartH - 24 - hHarm;
        const byModis = chartY + chartH - 24 - hModis;
        const fill = y.inSelectedRange ? '#d37400' : '#94a3b8';
        const showLabel = series.length <= 8 || idx % Math.ceil(series.length / 7) === 0;
        return `
          <rect x="${bx}" y="${byHarm}" width="${barW}" height="${hHarm}" rx="2" fill="${fill}" opacity="${y.inSelectedRange ? 0.9 : 0.45}"/>
          <rect x="${bx + barW * 0.2}" y="${byModis}" width="${barW * 0.6}" height="${hModis}" rx="1" fill="#0f172a" opacity="0.28"/>
          ${showLabel ? `<text x="${bx + barW / 2}" y="${chartY + chartH - 8}" font-size="9" text-anchor="middle" fill="#64748b">${esc(y.label)}</text>` : ''}
        `;
      })
      .join('');

    const avgLineY = series.length > 0
      ? chartY + chartH - 24 - (series[0].avgCount / maxYVal) * (chartH - 34)
      : chartY + chartH - 24;

    const maxAbsZ = Math.max(1, ...series.map(y => Math.abs(y.anomalyZScore)));
    const zeroY = chartY + (chartH - 24) / 2;
    const anomBarsSvg = series
      .map((y, idx) => {
        const barW = Math.min(68, Math.max(4, barSlot - 4));
        const bx = 636 + idx * barSlot + (barSlot - barW) / 2;
        const mag = (Math.abs(y.anomalyZScore) / maxAbsZ) * ((chartH - 40) / 2);
        const by = y.anomalyZScore >= 0 ? zeroY - mag : zeroY;
        const fill = y.anomalyZScore >= 0 ? this.ramps.anomalyPositiveHex : this.ramps.anomalyNegativeHex;
        const showLabel = series.length <= 8 || idx % Math.ceil(series.length / 7) === 0;
        return `
          <rect x="${bx}" y="${by}" width="${barW}" height="${Math.max(1.5, mag)}" rx="2" fill="${fill}" opacity="${y.inSelectedRange ? 0.92 : 0.45}"/>
          ${showLabel ? `<text x="${bx + barW / 2}" y="${chartY + chartH - 8}" font-size="9" text-anchor="middle" fill="#64748b">${esc(y.label)}</text>` : ''}
        `;
      })
      .join('');

    // Color Ramp Legend stops
    const stops = this.ramps.getRamp(rampId).stops;
    const gradStopsSvg = stops
      .map(st => `<stop offset="${Math.round(st.t * 100)}%" stop-color="rgb(${st.rgb[0]},${st.rgb[1]},${st.rgb[2]})"/>`)
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="940" viewBox="0 0 1200 940" style="font-family: Inter, system-ui, sans-serif;">
  <defs>
    <linearGradient id="rampGrad" x1="0%" y1="0%" x2="100%" y2="0%">${gradStopsSvg}</linearGradient>
  </defs>
  <rect width="1200" height="940" fill="#f5f7fb"/>
  <rect x="24" y="20" width="1152" height="900" rx="18" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5"/>

  <text x="44" y="54" font-size="20" font-weight="700" fill="#0f172a">KMD · ${esc(t.analyticsTitle)}</text>
  <text x="44" y="78" font-size="12" fill="#475569">
    ${esc(t.regionBboxLabel)}: [${w.toFixed(2)}°, ${south.toFixed(2)}°, ${e.toFixed(2)}°, ${n.toFixed(2)}°] · ${esc(t.dateRangeLabel)}: ${esc(formatLocaleDate(this.state.dateStart(), 'full', this.i18n.dateLocale()))} → ${esc(formatLocaleDate(this.state.dateEnd(), 'full', this.i18n.dateLocale()))}
  </text>
  <text x="1156" y="54" font-size="11" text-anchor="end" fill="#64748b" font-family="monospace">${esc(this.data.isCustomDataset() ? this.data.hotspotDatasetName() : 'NASA FIRMS MODIS+VIIRS')}</text>
  <text x="1156" y="78" font-size="11" text-anchor="end" fill="#64748b">${esc(t.colorRampLabel)}: ${esc(rampId.toUpperCase())}</text>

  ${kpiSvg}

  <rect x="40" y="216" width="1120" height="320" rx="14" fill="#f8fafc" stroke="#e2e8f0"/>
  <text x="56" y="242" font-size="14" font-weight="700" fill="#0f172a">${esc(t.burningCalendarTitle)}</text>
  <rect x="920" y="229" width="160" height="10" rx="5" fill="url(#rampGrad)"/>
  <text x="912" y="238" font-size="10" text-anchor="end" fill="#64748b">0</text>
  <text x="1088" y="238" font-size="10" fill="#64748b">${cal.maxCount}</text>
  ${calColLabelsSvg}
  ${calRowLabelsSvg}
  ${calCellsSvg}

  <rect x="40" y="552" width="550" height="270" rx="14" fill="#f8fafc" stroke="#e2e8f0"/>
  <text x="56" y="576" font-size="13" font-weight="700" fill="#0f172a">${esc(t.historicalFiresTitle)}</text>
  <line x1="60" y1="${avgLineY}" x2="578" y2="${avgLineY}" stroke="#0284c7" stroke-width="1.5" stroke-dasharray="5,4"/>
  ${histBarsSvg}

  <rect x="610" y="552" width="550" height="270" rx="14" fill="#f8fafc" stroke="#e2e8f0"/>
  <text x="626" y="576" font-size="13" font-weight="700" fill="#0f172a">${esc(t.anomalyChartTitle)}</text>
  <line x1="630" y1="${zeroY}" x2="1146" y2="${zeroY}" stroke="#64748b" stroke-width="1"/>
  ${anomBarsSvg}

  <text x="44" y="880" font-size="11" fill="#64748b">${esc(t.reportAttribution)}</text>
</svg>`;
  }

  private csvEscape(val: string): string {
    if (/[",\n]/.test(val)) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  }

  private triggerDownload(content: string, filename: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    this.triggerBlobDownload(blob, filename);
  }

  private triggerBlobDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
