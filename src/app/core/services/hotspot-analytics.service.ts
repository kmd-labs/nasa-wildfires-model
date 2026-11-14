import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import {
  ActiveFireDataset,
  BackendDailyBucket,
  BoundingBox,
  BurningCalendarCell,
  HarmonizedHotspotRecord,
  HotspotAnalyticsSummary,
  MultiPolygonCoords,
  PolygonRing,
  YearlyComparisonPoint
} from '../models/wildfire.model';
import { ColorRampService } from './color-ramp.service';
import { WildfireDataService } from './wildfire-data.service';
import { WildfireStateService, isPointInPolygonCoords } from './wildfire-state.service';
import { I18nService } from '../i18n/i18n.service';

export interface BurningCalendarModel {
  mode: 'monthly' | 'daily';
  rowLabels: string[];
  colLabels: string[];
  cells: BurningCalendarCell[];
  maxCount: number;
  maxFrp: number;
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

  /** Spatial ratio when the accepted polygon is edited (4+ edges) inside the bbox envelope. */
  private readonly backendSpatialRatio = computed<number>(() => {
    const bbox = this.state.regionBbox();
    const poly = this.state.regionPolygon();
    if (!bbox || !poly || poly.length < 3) return 1;
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
   * Pixel squares for the active dataset (VIIRS 375 m or MODIS 1 km) including boundary pixels
   * whose center may lie just outside the polygon so the globe clips them accurately.
   */
  readonly globePixelSquares = computed<GlobePixelSquare[]>(() => {
    const dataset = this.state.activeDataset();
    const sizeMeters = dataset === 'VIIRS' ? 375 : 1000;
    const bbox = this.state.regionBbox();
    if (!bbox) return [];

    const aggregateToGrid = (
      points: { lon: number; lat: number; count: number; frpMw: number }[]
    ): GlobePixelSquare[] => {
      if (points.length === 0) return [];
      const midLat = (bbox[1] + bbox[3]) * 0.5;
      const dLat = sizeMeters / 110574;
      const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
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

      const cells = Array.from(bins.values());
      const maxVal = Math.max(1, ...cells.map(c => (c.frpMw > 0 ? c.frpMw : c.count)));
      return cells.map(c => {
        const val = c.frpMw > 0 ? c.frpMw : c.count;
        return {
          lon: c.lon,
          lat: c.lat,
          halfLon,
          halfLat,
          sensor: dataset,
          sizeMeters,
          count: c.count,
          frpMw: c.frpMw,
          normIntensity: Math.min(1, Math.pow(val / maxVal, 0.58))
        };
      });
    };

    if (!this.data.isCustomDataset()) {
      const backend = this.data.backendCalendar();
      if (!backend) return [];
      const rawPixels = backend.selection.pixels;
      if (rawPixels && rawPixels.length > 0) {
        return aggregateToGrid(
          rawPixels
            .filter(p => p.sensor === dataset)
            .map(p => ({ lon: p.lon, lat: p.lat, count: p.count, frpMw: p.frpMw }))
        );
      }
      // Fallback if backend payload has no pixels array
      return aggregateToGrid(
        backend.selection.cells
          .filter(c => (dataset === 'VIIRS' ? c.rawViirs > 0 : c.rawModis > 0))
          .map(c => ({
            lon: c.lon,
            lat: c.lat,
            count: dataset === 'VIIRS' ? c.rawViirs : c.rawModis,
            frpMw: 0
          }))
      );
    }

    const start = this.state.dateStart();
    const end = this.state.dateEnd();
    const pad = 0.015;
    const [w, s, e, n] = bbox;
    const matching = this.data.hotspots().filter(r => {
      if (r.date < start || r.date > end) return false;
      if (r.lon < w - pad || r.lon > e + pad || r.lat < s - pad || r.lat > n + pad) return false;
      if (dataset === 'VIIRS') return r.rawViirsCount > 0 || r.sensor === 'VIIRS' || r.sensor === 'HARMONIZED';
      return r.rawModisCount > 0 || r.sensor === 'MODIS' || r.sensor === 'HARMONIZED';
    });
    return aggregateToGrid(
      matching.map(r => ({
        lon: r.lon,
        lat: r.lat,
        count: dataset === 'VIIRS' ? (r.rawViirsCount || 1) : (r.rawModisCount || 1),
        frpMw: r.frpMw
      }))
    );
  });

  /** Approximate MultiPolygon area in km² and hectares using spherical latitude cosine. */
  readonly bboxArea = computed<{ km2: number; ha: number }>(() => {
    return this.computeMultiPolygonArea(this.state.regionMultiPolygon());
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
      const byYear = new Map<number, { modis: number; viirs: number; harm: number; frp: number }>();
      for (const yr of backend.yearly) {
        byYear.set(yr.year, {
          modis: useSeasonalWindow ? 0 : Math.round(yr.rawModis * ratio),
          viirs: useSeasonalWindow ? 0 : Math.round(yr.rawViirs * ratio),
          harm: useSeasonalWindow ? 0 : yr.harmonized * ratio,
          frp: (yr.frpMw ?? 0) * ratio
        });
      }

      if (useSeasonalWindow) {
        for (let i = 0; i < backend.months.length; i++) {
          const ym = backend.months[i];
          const y = Number(ym.slice(0, 4));
          const m = Number(ym.slice(5, 7));
          const matches = startM <= endM ? m >= startM && m <= endM : m >= startM || m <= endM;
          if (!matches) continue;
          const b = byYear.get(y);
          if (!b) continue;
          b.modis += Math.round((backend.series.rawModis[i] ?? 0) * ratio);
          b.viirs += Math.round((backend.series.rawViirs[i] ?? 0) * ratio);
          b.harm += (backend.series.harmonized[i] ?? 0) * ratio;
        }
      }

      const years = Array.from(byYear.keys()).sort((a, b) => a - b);
      const counts = years.map(y => byYear.get(y)!.harm);
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
          anomalyPct: Number(pct.toFixed(1)),
          anomalyZScore: Number(z.toFixed(2)),
          inSelectedRange: y >= startYear && y <= endYear
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
        inSelectedRange: y >= startYear && y <= endYear
      });
    }
    return out;
  });

  /** Summary KPI figures for the selected region & date range. */
  readonly summary = computed<HotspotAnalyticsSummary>(() => {
    const area = this.bboxArea();
    const yearly = this.yearlyComparison();
    const backend = this.data.backendCalendar();

    if (!this.data.isCustomDataset() && backend) {
      const ratio = this.backendSpatialRatio();
      const sel = backend.selection;
      const harm = Math.round(sel.hotspots.harmonized * ratio);
      const modis = Math.round(sel.hotspots.rawModis * ratio);
      const viirs = Math.round(sel.hotspots.rawViirs * ratio);
      const totalFrp = Math.round((sel.frp?.totalMw ?? 0) * ratio);
      const meanFrp = sel.frp?.meanMw ?? 0;
      const activeFireDays = sel.frp?.activeFireDays ?? 0;
      const peakDate = sel.frp?.peakDate ?? null;
      const peakCount = Math.round((sel.frp?.peakCount ?? 0) * ratio);

      const activeYears = yearly.filter(y => y.inSelectedRange);
      const numSelectedYears = Math.max(1, activeYears.length);
      const singleYearAvg = yearly.length > 0 ? yearly[0].multiYearAvgCount : 0;
      const expectedTotal = singleYearAvg * numSelectedYears;

      const counts = yearly.map(y => y.harmonizedCount);
      const variance = counts.reduce((acc, c) => acc + Math.pow(c - singleYearAvg, 2), 0) / Math.max(1, counts.length);
      const std = Math.max(1, Math.sqrt(variance));

      const avgPerSelectedYear = harm / numSelectedYears;
      const anomalyZScore = Number(((avgPerSelectedYear - singleYearAvg) / std).toFixed(2));
      const anomalyPct = expectedTotal > 0 ? Number((((harm - expectedTotal) / expectedTotal) * 100).toFixed(1)) : 0;

      const activeDataset = this.state.activeDataset();
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
        areaKm2: area.km2,
        areaHa: area.ha,
        activeDataset,
        activeDatasetFires: activeDataset === 'VIIRS' ? viirs : modis
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
      anomalyPct,
      anomalyZScore,
      areaKm2: area.km2,
      areaHa: area.ha,
      activeDataset,
      activeDatasetFires: activeDataset === 'VIIRS' ? viirs : modis
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
        const byMmDd = new Map<string, BackendDailyBucket>();
        for (const row of backend.selection.daily ?? []) {
          byMmDd.set(row.mmdd, row);
        }
        const maxCount = Math.max(1, ...Array.from(byMmDd.values()).map(v => Math.round(v.harmonized * ratio)));
        const maxFrp = Math.max(1, ...Array.from(byMmDd.values()).map(v => Math.round(v.frpMw * ratio)));

        const cells: BurningCalendarCell[] = [];
        for (let m = 0; m < 12; m++) {
          const daysInMonth = new Date(Date.UTC(2024, m + 1, 0)).getUTCDate();
          for (let d = 0; d < 31; d++) {
            const validDay = d < daysInMonth;
            const mmdd = `${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
            const b = byMmDd.get(mmdd);
            const harm = b ? Math.round(b.harmonized * ratio) : 0;
            const avg = b ? b.baselineAvg * ratio : 0;
            const z = avg > 0 ? (harm - avg) / Math.max(1, Math.sqrt(avg)) : harm > 0 ? 1.5 : 0;
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
              intensity: validDay && harm > 0 ? Math.min(1, Math.pow(harm / maxCount, 0.72)) : 0,
              inRange: validDay
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

      const cells: BurningCalendarCell[] = [];
      for (let m = 0; m < 12; m++) {
        const daysInMonth = new Date(Date.UTC(2024, m + 1, 0)).getUTCDate(); // leap-safe 31/29
        for (let d = 0; d < 31; d++) {
          const validDay = d < daysInMonth;
          const mmdd = `${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
          const b = buckets.get(mmdd) ?? { harm: 0, modis: 0, viirs: 0, frp: 0 };
          const avg = (baselineBuckets.get(mmdd) ?? 0) / yearsInRegion;
          const z = avg > 0 ? (b.harm - avg) / Math.max(1, Math.sqrt(avg)) : b.harm > 0 ? 1.5 : 0;

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
            intensity: validDay && b.harm > 0 ? Math.min(1, Math.pow(b.harm / maxCount, 0.72)) : 0,
            inRange: validDay
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

  computeBboxArea(bbox: BoundingBox): { km2: number; ha: number } {
    const [w, s, e, n] = bbox;
    const meanLatRad = (((s + n) / 2) * Math.PI) / 180;
    const widthKm = Math.abs(e - w) * 111.32 * Math.cos(meanLatRad);
    const heightKm = Math.abs(n - s) * 110.574;
    const km2 = Math.round(widthKm * heightKm);
    return { km2, ha: km2 * 100 };
  }

  computeMultiPolygonArea(multi: MultiPolygonCoords): { km2: number; ha: number } {
    let totalKm2 = 0;
    for (const poly of multi) {
      if (poly.length === 0) continue;
      totalKm2 += this.computeRingAreaKm2(poly[0]);
      for (let h = 1; h < poly.length; h++) {
        totalKm2 -= this.computeRingAreaKm2(poly[h]);
      }
    }
    const km2 = Math.max(1, Math.round(totalKm2));
    return { km2, ha: km2 * 100 };
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
        : 'NASA FIRMS MODIS (MCD14ML) + VIIRS (VNP14IMGML) Quantile Harmonized',
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
    const yearly = this.yearlyComparison();
    const rampId = this.state.colorRamp();
    const [w, south, e, n] = this.state.regionBbox() ?? [-180, -85, 180, 85];

    const esc = (str: string) =>
      str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // KPI Cards
    const kpis = [
      { label: t.kpiHarmonizedFires, val: s.harmonizedFires.toLocaleString(), sub: `MODIS ${s.rawModisFires.toLocaleString()} · VIIRS ${s.rawViirsFires.toLocaleString()}` },
      { label: t.kpiMultiYearAnomaly, val: `${s.anomalyZScore >= 0 ? '+' : ''}${s.anomalyZScore}σ`, sub: `${s.anomalyPct >= 0 ? '+' : ''}${s.anomalyPct}% vs avg (${s.multiYearAvgFires.toLocaleString()})` },
      { label: t.kpiTotalFrp, val: `${s.totalFrpMw.toLocaleString()} MW`, sub: `${t.kpiMeanFrp}: ${s.meanFrpMw} MW` },
      { label: t.kpiPeakDate, val: s.peakDate ?? '—', sub: `${s.activeFireDays} ${t.kpiActiveDays} · ${s.areaKm2.toLocaleString()} km²` }
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
    const maxYVal = Math.max(1, ...yearly.map(y => Math.max(y.harmonizedCount, y.rawModisCount, y.multiYearAvgCount)));
    const barSlot = 510 / Math.max(1, yearly.length);

    const histBarsSvg = yearly
      .map((y, idx) => {
        const bx = 66 + idx * barSlot;
        const hHarm = (y.harmonizedCount / maxYVal) * (chartH - 34);
        const hModis = (y.rawModisCount / maxYVal) * (chartH - 34);
        const byHarm = chartY + chartH - 24 - hHarm;
        const byModis = chartY + chartH - 24 - hModis;
        const barW = Math.max(4, barSlot - 4);
        const fill = y.inSelectedRange ? '#d37400' : '#94a3b8';
        return `
          <rect x="${bx}" y="${byHarm}" width="${barW}" height="${hHarm}" rx="2" fill="${fill}" opacity="${y.inSelectedRange ? 0.9 : 0.45}"/>
          <rect x="${bx + barW * 0.2}" y="${byModis}" width="${barW * 0.6}" height="${hModis}" rx="1" fill="#0f172a" opacity="0.28"/>
          ${idx % Math.max(1, Math.floor(yearly.length / 7)) === 0 ? `<text x="${bx + barW / 2}" y="${chartY + chartH - 8}" font-size="9" text-anchor="middle" fill="#64748b">${y.year}</text>` : ''}
        `;
      })
      .join('');

    const avgLineY = yearly.length > 0
      ? chartY + chartH - 24 - (yearly[0].multiYearAvgCount / maxYVal) * (chartH - 34)
      : chartY + chartH - 24;

    const maxAbsZ = Math.max(2, ...yearly.map(y => Math.abs(y.anomalyZScore)));
    const zeroY = chartY + (chartH - 24) / 2;
    const anomBarsSvg = yearly
      .map((y, idx) => {
        const bx = 636 + idx * barSlot;
        const mag = (Math.abs(y.anomalyZScore) / maxAbsZ) * ((chartH - 40) / 2);
        const by = y.anomalyZScore >= 0 ? zeroY - mag : zeroY;
        const barW = Math.max(4, barSlot - 4);
        const fill = y.anomalyZScore >= 0 ? this.ramps.anomalyPositiveHex : this.ramps.anomalyNegativeHex;
        return `
          <rect x="${bx}" y="${by}" width="${barW}" height="${Math.max(1.5, mag)}" rx="2" fill="${fill}" opacity="${y.inSelectedRange ? 0.92 : 0.45}"/>
          ${idx % Math.max(1, Math.floor(yearly.length / 7)) === 0 ? `<text x="${bx + barW / 2}" y="${chartY + chartH - 8}" font-size="9" text-anchor="middle" fill="#64748b">${y.year}</text>` : ''}
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
    ${esc(t.regionBboxLabel)}: [${w.toFixed(2)}°, ${south.toFixed(2)}°, ${e.toFixed(2)}°, ${n.toFixed(2)}°] · ${esc(t.dateRangeLabel)}: ${esc(this.state.dateStart())} → ${esc(this.state.dateEnd())}
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

  <text x="44" y="880" font-size="11" fill="#64748b">${esc(t.legalNasa)}</text>
  <text x="44" y="898" font-size="11" fill="#64748b">${esc(t.legalCopernicus)} · ${esc(t.legalNoaa)}</text>
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
