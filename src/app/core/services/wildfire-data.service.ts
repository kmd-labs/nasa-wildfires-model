import { Injectable, inject, signal } from '@angular/core';
import {
  BackendCalendarPayload,
  BackendDailyBucket,
  BackendDownloadProgress,
  BackendSyncStatus,
  BoundingBox,
  CalendarSummaryData,
  ClimateInertiaData,
  EvacuationData,
  HarmonizedHotspotRecord,
  HarmonizedHotspotsPayload,
  HotspotSensor,
  MlSpreadFramesData,
  MultiPolygonCoords,
  PolygonCoords,
  PredefinedCountry,
  WildfireAoi
} from '../models/wildfire.model';
import { OfflineCacheService } from './offline-cache.service';

interface CountryGeoJsonPayload {
  type: string;
  features?: Array<{
    properties?: { code?: string; name?: string; res?: string };
    geometry?: { type?: 'Polygon' | 'MultiPolygon'; coordinates?: any };
  }>;
}

const ISO3_TO_ISO2: Record<string, string> = {
  ESP: 'ES', PRT: 'PT', FRA: 'FR', ITA: 'IT', GRC: 'GR', POL: 'PL', DEU: 'DE', GBR: 'GB',
  IRL: 'IE', BEL: 'BE', NLD: 'NL', LUX: 'LU', CHE: 'CH', AUT: 'AT', CZE: 'CZ', SVK: 'SK',
  HUN: 'HU', SVN: 'SI', HRV: 'HR', BIH: 'BA', SRB: 'RS', MNE: 'ME', ALB: 'AL', MKD: 'MK',
  BGR: 'BG', ROU: 'RO', MDA: 'MD', UKR: 'UA', BLR: 'BY', LTU: 'LT', LVA: 'LV', EST: 'EE',
  DNK: 'DK', NOR: 'NO', SWE: 'SE', FIN: 'FI', ISL: 'IS', AND: 'AD', MCO: 'MC', MLT: 'MT',
  CYP: 'CY', TUR: 'TR', MAR: 'MA', DZA: 'DZ', TUN: 'TN', LBY: 'LY', EGY: 'EG', USA: 'US',
  CAN: 'CA', MEX: 'MX', BRA: 'BR', ARG: 'AR', CHL: 'CL', COL: 'CO', PER: 'PE', VEN: 'VE',
  BOL: 'BO', PRY: 'PY', URY: 'UY', ECU: 'EC', AUS: 'AU', NZL: 'NZ', ZAF: 'ZA', AGO: 'AO',
  MOZ: 'MZ', MDG: 'MG', KEN: 'KE', TZA: 'TZ', ETH: 'ET', NGA: 'NG', SEN: 'SN', CIV: 'CI',
  GHA: 'GH', CMR: 'CM', COD: 'CD', SDN: 'SD', CHN: 'CN', IND: 'IN', JPN: 'JP', KOR: 'KR',
  IDN: 'ID', MYS: 'MY', THA: 'TH', VNM: 'VN', PHL: 'PH', MMR: 'MM', KHM: 'KH', LAO: 'LA',
  RUS: 'RU', KAZ: 'KZ', GEO: 'GE', ARM: 'AM', AZE: 'AZ', ISR: 'IL', LBN: 'LB', JOR: 'JO',
  SYR: 'SY', IRQ: 'IQ', IRN: 'IR', SAU: 'SA', PAK: 'PK', AFG: 'AF', NPL: 'NP', LKA: 'LK'
};

const PRIORITY_COUNTRY_CODES = [
  'PRT', 'ESP', 'FRA', 'ITA', 'GRC', 'HRV', 'TUR', 'MAR', 'DZA', 'POL',
  'DEU', 'GBR', 'SWE', 'NOR', 'FIN', 'USA', 'CAN', 'AUS', 'BRA', 'CHL'
];

interface EnsoHistoryJson {
  index?: {
    firstMonth?: string;
    lastMonth?: string;
    oni?: number[];
  };
  provisional?: {
    month?: string;
    oni?: number;
  };
}

interface TimelineMetaJson {
  keyframes?: Array<{
    date: string;
    s?: number;
    nino34?: number;
  }>;
}

const DEFAULT_HOSTED_API_BASE = 'https://nasa-wildfires-model-95065765400.europe-west1.run.app';
const DEFAULT_CACHED_IBERIA_BBOX: BoundingBox = [-9.55, 36.0, 3.45, 43.8];
const DEFAULT_CACHED_FROM_YM = '2025-06';
const DEFAULT_CACHED_TO_YM = '2025-09';

/**
 * Fallback AOI registry matching aoi.csv from Issue #22
 * (used until Marcin's PR lands src/assets/data/aoi.csv).
 */
const DEFAULT_AOIS: WildfireAoi[] = [
  {
    aoiId: 'piodao_2025',
    name: 'Piódão (Arganil) – Serra do Açor',
    year: 2025,
    country: 'Portugal',
    ignitionLat: 40.2240,
    ignitionLon: -7.8294,
    bbox: [-8.11, 40.0, -7.62, 40.43],
    burnedAreaHa: 64451,
    startDate: '2025-08-13',
    endDate: '2025-08-24'
  },
  {
    aoiId: 'larouco_2025',
    name: 'Larouco – Quiroga – Oencia',
    year: 2025,
    country: 'Spain',
    ignitionLat: 42.3465,
    ignitionLon: -7.1608,
    bbox: [-7.33, 42.26, -6.91, 42.59],
    burnedAreaHa: 44879,
    startDate: '2025-08-13',
    endDate: '2025-08-22'
  },
  {
    aoiId: 'burgohondo_2026_avila',
    name: 'Burgohondo – Navaluenga / El Barraco',
    year: 2026,
    country: 'Spain',
    ignitionLat: 40.4136,
    ignitionLon: -4.7864,
    bbox: [-4.88, 40.28, -4.4, 40.54],
    burnedAreaHa: 33943,
    startDate: '2026-07-22',
    endDate: '2026-08-15'
  },
  {
    aoiId: 'burgohondo_2026_kompleks',
    name: 'Burgohondo – Ávila–Madrid–Toledo',
    year: 2026,
    country: 'Spain',
    ignitionLat: 40.4136,
    ignitionLon: -4.7864,
    bbox: [-4.88, 40.18, -4.19, 40.54],
    burnedAreaHa: 80000,
    startDate: '2026-07-22',
    endDate: '2026-08-15'
  },
  {
    aoiId: 'losacio_2022_lipiec',
    name: 'Losacio (Sierra de la Culebra) – July',
    year: 2022,
    country: 'Spain',
    ignitionLat: 41.7109,
    ignitionLon: -6.0406,
    bbox: [-6.28, 41.62, -5.87, 41.93],
    burnedAreaHa: 31473,
    startDate: '2022-07-17',
    endDate: '2022-08-14'
  },
  {
    aoiId: 'losacio_2022_lacznie',
    name: 'Losacio + Sierra de la Culebra (Combined)',
    year: 2022,
    country: 'Spain',
    ignitionLat: 41.7109,
    ignitionLon: -6.0406,
    bbox: [-6.51, 41.62, -5.87, 42.03],
    burnedAreaHa: 65600,
    startDate: '2022-06-15',
    endDate: '2022-08-14'
  }
];

@Injectable({
  providedIn: 'root'
})
export class WildfireDataService {
  private readonly offlineCache = inject(OfflineCacheService);

  readonly aois = signal<WildfireAoi[]>(DEFAULT_AOIS);
  readonly countries = signal<PredefinedCountry[]>([]);
  readonly calendar = signal<CalendarSummaryData | null>(null);
  readonly climateInertia = signal<ClimateInertiaData | null>(null);
  readonly spreadFrames = signal<MlSpreadFramesData | null>(null);
  readonly evacuation = signal<EvacuationData | null>(null);
  readonly hotspots = signal<HarmonizedHotspotRecord[]>([]);
  readonly hotspotDatasetName = signal<string>('');
  readonly isCustomDataset = signal<boolean>(false);
  readonly importError = signal<string | null>(null);
  readonly isLoaded = signal<boolean>(false);

  readonly backendCalendar = signal<BackendCalendarPayload | null>(null);
  readonly backendStatus = signal<BackendSyncStatus>('idle');
  readonly backendProgress = signal<BackendDownloadProgress | null>(null);
  readonly backendError = signal<string | null>(null);
  readonly backendCachedAt = signal<number | null>(null);

  private defaultHotspots: HarmonizedHotspotRecord[] = [];
  private cachedDefaultCalendar: BackendCalendarPayload | null = null;
  private readonly oniByMonth = new Map<string, number>();
  private readonly gsByMonth = new Map<string, number>();
  private loadPromise: Promise<void> | null = null;
  private apiAbort: AbortController | null = null;
  private apiPollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeApiQuery = '';
  private offlineRetryDelayMs = 5000;
  private bgRefreshCount = 0;
  private offlineRetryCount = 0;
  private downloadPollCount = 0;
  private zeroTotalPolls = 0;
  private lastDownloadDone = -1;
  private stalledOrResetPolls = 0;
  private readonly resolvedCalendarCache = new Map<string, BackendCalendarPayload>();

  resolveApiUrl(apiPath: string): string {
    const winBase = typeof window !== 'undefined' ? (window as { __KMD_API_BASE__?: string }).__KMD_API_BASE__ : '';
    const lsBase = typeof localStorage !== 'undefined' ? localStorage.getItem('kmd.fireApiBase') : '';
    const base = (winBase || lsBase || DEFAULT_HOSTED_API_BASE).replace(/\/+$/, '');
    return `${base}${apiPath}`;
  }

  cancelBackendSync(): void {
    if (this.apiPollTimer !== null) {
      clearTimeout(this.apiPollTimer);
      this.apiPollTimer = null;
    }
    if (this.apiAbort) {
      this.apiAbort.abort();
      this.apiAbort = null;
    }
  }

  clearBackendCalendar(): void {
    this.activeApiQuery = '';
    this.bgRefreshCount = 0;
    this.offlineRetryCount = 0;
    this.cancelBackendSync();
    this.backendCalendar.set(null);
    this.backendProgress.set(null);
    this.backendError.set(null);
    this.backendCachedAt.set(null);
    this.backendStatus.set('idle');
  }

  private hydrateIncompleteWithDefault(
    live: BackendCalendarPayload,
    dateStart: string,
    dateEnd: string
  ): BackendCalendarPayload {
    const prebaked = this.cachedDefaultCalendar;
    if (!prebaked || !live.metadata?.refreshing) return live;

    const liveReg = live.metadata.cachedRegion;
    const preReg = prebaked.metadata?.cachedRegion;
    if (!liveReg || !preReg || liveReg.some((v, idx) => Math.abs(v - preReg[idx]) > 0.05)) {
      return live;
    }

    const liveNonzeroYears = live.yearly.filter(y => y.harmonized > 0).length;
    const preNonzeroYears = prebaked.yearly.filter(y => y.harmonized > 0).length;
    if (liveNonzeroYears >= 5 || preNonzeroYears < 10) {
      return live;
    }

    const preMonthIdx = new Map<string, number>();
    prebaked.months.forEach((ym, i) => preMonthIdx.set(ym, i));

    const start = dateStart.slice(0, 10);
    const end = dateEnd.slice(0, 10);
    const startYm = start.slice(0, 7);
    const endYm = end.slice(0, 7);
    const startDay = Number(start.slice(8, 10)) || 1;
    const endDay = Number(end.slice(8, 10)) || 31;

    const [preToY, preToM] = prebaked.selection.to.split('-').map(Number);
    const preToDim = new Date(Date.UTC(preToY, preToM, 0)).getUTCDate();
    const preFromDate = prebaked.selection.fromDate ?? `${prebaked.selection.from}-01`;
    const preToDate = prebaked.selection.toDate ?? `${prebaked.selection.to}-${String(preToDim).padStart(2, '0')}`;

    const monthScale = new Map<string, number>();
    for (let i = 0; i < prebaked.months.length; i++) {
      const h = prebaked.series.harmonized[i];
      const raw = (prebaked.series.rawModis[i] ?? 0) + (prebaked.series.rawViirs[i] ?? 0);
      if (h !== null && raw > 0) {
        monthScale.set(prebaked.months[i], h / raw);
      }
    }

    const dailyByYear: Record<string, BackendDailyBucket[]> = {};
    const preDailyByYear = prebaked.selection.dailyByYear ?? {};
    const liveDailyByYear = live.selection.dailyByYear ?? {};
    const allYears = new Set([...Object.keys(preDailyByYear), ...Object.keys(liveDailyByYear)]);

    const mergedDailyByMmDd = new Map<string, BackendDailyBucket>();
    for (const yrStr of allYears) {
      const yrBuckets = new Map<string, BackendDailyBucket>();
      for (const row of liveDailyByYear[yrStr] ?? []) {
        const iso = `${yrStr}-${row.mmdd}`;
        if (iso < start || iso > end) continue;
        const scale = monthScale.get(iso.slice(0, 7));
        const harm = scale !== undefined ? Number(((row.rawModis + row.rawViirs) * scale).toFixed(1)) : row.harmonized;
        yrBuckets.set(row.mmdd, { ...row, harmonized: harm });
      }
      for (const row of preDailyByYear[yrStr] ?? []) {
        const iso = `${yrStr}-${row.mmdd}`;
        if (iso < start || iso > end) continue;
        if (iso >= preFromDate && iso <= preToDate) {
          yrBuckets.set(row.mmdd, { ...row });
        }
      }
      const sorted = Array.from(yrBuckets.values()).sort((a, b) => a.mmdd.localeCompare(b.mmdd));
      if (sorted.length > 0) {
        dailyByYear[yrStr] = sorted;
      }
      for (const row of sorted) {
        const cur = mergedDailyByMmDd.get(row.mmdd);
        if (!cur) {
          mergedDailyByMmDd.set(row.mmdd, { ...row });
        } else {
          cur.harmonized = Number((cur.harmonized + row.harmonized).toFixed(1));
          cur.rawModis += row.rawModis;
          cur.rawViirs += row.rawViirs;
          cur.frpMw += row.frpMw;
        }
      }
    }

    const preDailyByMmDd = new Map<string, BackendDailyBucket>();
    for (const row of prebaked.selection.daily ?? []) {
      preDailyByMmDd.set(row.mmdd, row);
    }
    const mergedDaily = Array.from(mergedDailyByMmDd.values())
      .map(row => {
        const p = preDailyByMmDd.get(row.mmdd);
        return p ? { ...row, baselineAvg: p.baselineAvg } : row;
      })
      .sort((a, b) => a.mmdd.localeCompare(b.mmdd));

    let totalHarm = 0;
    let totalModis = 0;
    let totalViirs = 0;
    const [sy, sm] = startYm.split('-').map(Number);
    const [ey, em] = endYm.split('-').map(Number);
    const startIdx = sy * 12 + (sm - 1);
    const endIdx = ey * 12 + (em - 1);
    for (let idx = startIdx; idx <= endIdx; idx++) {
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const isPartial = (ym === startYm && startDay > 1) || (ym === endYm && endDay < dim);
      const pIdx = preMonthIdx.get(ym);
      if (!isPartial && pIdx !== undefined && prebaked.series.harmonized[pIdx] !== null) {
        totalHarm += prebaked.series.harmonized[pIdx] ?? 0;
        totalModis += prebaked.series.rawModis[pIdx] ?? 0;
        totalViirs += prebaked.series.rawViirs[pIdx] ?? 0;
      } else {
        const mmPrefix = `${String(m).padStart(2, '0')}-`;
        for (const row of dailyByYear[String(y)] ?? []) {
          if (!row.mmdd.startsWith(mmPrefix)) continue;
          const iso = `${y}-${row.mmdd}`;
          if (iso < start || iso > end) continue;
          totalHarm += row.harmonized;
          totalModis += row.rawModis;
          totalViirs += row.rawViirs;
        }
      }
    }

    const mergedHarm = [...prebaked.series.harmonized];
    const mergedModis = [...prebaked.series.rawModis];
    const mergedViirs = [...prebaked.series.rawViirs];
    for (let i = 0; i < live.months.length; i++) {
      const pIdx = preMonthIdx.get(live.months[i]);
      if (pIdx !== undefined && mergedHarm[pIdx] === null && live.series.harmonized[i] !== null) {
        mergedHarm[pIdx] = live.series.harmonized[i];
        mergedModis[pIdx] = live.series.rawModis[i];
        mergedViirs[pIdx] = live.series.rawViirs[i];
      }
    }

    return {
      ...prebaked,
      metadata: {
        ...prebaked.metadata,
        dataThrough: live.metadata.dataThrough || prebaked.metadata.dataThrough,
        refreshing: live.metadata.refreshing,
        failedChunks: live.metadata.failedChunks
      },
      series: {
        ...prebaked.series,
        harmonized: mergedHarm,
        rawModis: mergedModis,
        rawViirs: mergedViirs
      },
      selection: {
        ...live.selection,
        from: startYm,
        to: endYm,
        fromDate: start,
        toDate: end,
        hotspots: {
          harmonized: Number(totalHarm.toFixed(1)),
          rawModis: Math.round(totalModis),
          rawViirs: Math.round(totalViirs)
        },
        daily: mergedDaily,
        dailyByYear
      }
    };
  }

  private cacheCalendarPayload(queryKey: string, payload: BackendCalendarPayload): void {
    if (this.resolvedCalendarCache.size >= 10) {
      const oldestKey = this.resolvedCalendarCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.resolvedCalendarCache.delete(oldestKey);
      }
    }
    this.resolvedCalendarCache.set(queryKey, payload);
    void this.offlineCache.putCalendar(queryKey, payload);
  }

  private async tryRestoreOfflineCalendar(queryKey: string): Promise<boolean> {
    const record = await this.offlineCache.getCalendar(queryKey);
    if (!record) return false;
    if (this.activeApiQuery !== queryKey) return false;
    this.cacheCalendarPayloadInMemory(queryKey, record.payload);
    this.backendCalendar.set(record.payload);
    this.backendCachedAt.set(record.cachedAt);
    this.backendStatus.set('cached');
    this.backendProgress.set(null);
    this.backendError.set(null);
    return true;
  }

  private cacheCalendarPayloadInMemory(queryKey: string, payload: BackendCalendarPayload): void {
    if (this.resolvedCalendarCache.size >= 10) {
      const oldestKey = this.resolvedCalendarCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.resolvedCalendarCache.delete(oldestKey);
      }
    }
    this.resolvedCalendarCache.set(queryKey, payload);
  }

  private formatBboxesParam(bboxOrList: BoundingBox | BoundingBox[]): { bboxStr: string; fallbackStr: string; primaryBox: BoundingBox } {
    const list: BoundingBox[] = Array.isArray(bboxOrList[0])
      ? (bboxOrList as BoundingBox[])
      : [bboxOrList as BoundingBox];
    const valid = list.length > 0 ? list : [[-9.6, 36.0, 3.4, 43.8] as BoundingBox];
    const bboxStr = valid
      .map(b => b.map(v => Number(v.toFixed(4))).join(','))
      .join(';');
    let minW = 180, minS = 90, maxE = -180, maxN = -90;
    for (const [w, s, e, n] of valid) {
      if (w < minW) minW = w;
      if (s < minS) minS = s;
      if (e > maxE) maxE = e;
      if (n > maxN) maxN = n;
    }
    const envArea = (maxE - minW) * (maxN - minS);
    const fallbackBox: BoundingBox = envArea <= 3500 ? [minW, minS, maxE, maxN] : valid[0];
    const fallbackStr = fallbackBox.map(v => Number(v.toFixed(4))).join(',');
    return { bboxStr, fallbackStr, primaryBox: fallbackBox };
  }

  getBackendHotspotsCsvUrl(bboxOrList: BoundingBox | BoundingBox[], dateStart: string, dateEnd: string): string {
    const { bboxStr } = this.formatBboxesParam(bboxOrList);
    const params = new URLSearchParams({ bbox: bboxStr, from: dateStart, to: dateEnd });
    return this.resolveApiUrl(`/api/hotspots.csv?${params.toString()}`);
  }

  isDefaultCachedQuery(bboxOrList: BoundingBox | BoundingBox[], dateStart: string, dateEnd: string): boolean {
    const firstBox: BoundingBox = Array.isArray(bboxOrList[0])
      ? (bboxOrList as BoundingBox[])[0]
      : (bboxOrList as BoundingBox);
    if (!firstBox) return false;
    const matchesBox = DEFAULT_CACHED_IBERIA_BBOX.every((val, idx) => Math.abs(firstBox[idx] - val) <= 0.02);
    if (!matchesBox) return false;
    return dateStart.slice(0, 10) === `${DEFAULT_CACHED_FROM_YM}-01` && dateEnd.slice(0, 10) === `${DEFAULT_CACHED_TO_YM}-30`;
  }

  async syncCalendarFromBackend(
    bboxOrList: BoundingBox | BoundingBox[],
    dateStart: string,
    dateEnd: string,
    isBackgroundPoll = false
  ): Promise<void> {
    if (this.isCustomDataset()) {
      this.cancelBackendSync();
      return;
    }

    if (this.isDefaultCachedQuery(bboxOrList, dateStart, dateEnd)) {
      await this.loadAll();
      if (this.cachedDefaultCalendar) {
        this.cancelBackendSync();
        this.activeApiQuery = '';
        this.bgRefreshCount = 0;
        this.offlineRetryCount = 0;
        this.backendCalendar.set(this.cachedDefaultCalendar);
        this.backendCachedAt.set(null);
        this.backendStatus.set(typeof navigator !== 'undefined' && navigator.onLine === false ? 'cached' : 'live');
        this.backendProgress.set(null);
        this.backendError.set(null);
        return;
      }
    }

    const { bboxStr, fallbackStr, primaryBox } = this.formatBboxesParam(bboxOrList);
    const fromParam = dateStart.length >= 10 ? dateStart.slice(0, 10) : dateStart.slice(0, 7);
    const toParam = dateEnd.length >= 10 ? dateEnd.slice(0, 10) : dateEnd.slice(0, 7);
    const queryKey = `${bboxStr}|${fromParam}|${toParam}`;
    const isSameQuery = this.activeApiQuery === queryKey;
    this.activeApiQuery = queryKey;

    if (!isBackgroundPoll) {
      this.bgRefreshCount = 0;
      this.offlineRetryCount = 0;
      this.offlineRetryDelayMs = 5000;
      this.downloadPollCount = 0;
      this.zeroTotalPolls = 0;
      this.lastDownloadDone = -1;
      this.stalledOrResetPolls = 0;
      const cached = this.resolvedCalendarCache.get(queryKey);
      if (cached) {
        this.cancelBackendSync();
        this.backendCalendar.set(cached);
        this.backendCachedAt.set(null);
        this.backendStatus.set(typeof navigator !== 'undefined' && navigator.onLine === false ? 'cached' : 'live');
        this.backendProgress.set(null);
        this.backendError.set(null);
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        if (await this.tryRestoreOfflineCalendar(queryKey)) {
          this.cancelBackendSync();
          return;
        }
      }
    } else if (!isSameQuery) {
      return;
    }

    this.cancelBackendSync();
    const controller = new AbortController();
    this.apiAbort = controller;

    if (!isBackgroundPoll && !this.isInsideCachedRegion(primaryBox)) {
      this.backendCalendar.set(null);
    }
    if (!isBackgroundPoll && this.backendStatus() !== 'downloading') {
      this.backendCachedAt.set(null);
      this.backendStatus.set('loading');
    }
    this.backendError.set(null);

    const buildApiPath = (bParam: string) =>
      `/api/calendar?bbox=${encodeURIComponent(bParam)}&from=${encodeURIComponent(fromParam)}&to=${encodeURIComponent(toParam)}`;
    const apiPath = buildApiPath(bboxStr);

    try {
      let resp = await fetch(this.resolveApiUrl(apiPath), { signal: controller.signal });
      if (this.activeApiQuery !== queryKey || controller.signal.aborted) return;

      const contentType = resp.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        await this.handleOfflineOrUnreachable(queryKey, bboxOrList, dateStart, dateEnd, primaryBox);
        return;
      }

      let body = await resp.json();
      if (this.activeApiQuery !== queryKey || controller.signal.aborted) return;

      // Fallback if running backend only supports single W,S,E,N bbox parameter
      if (resp.status === 400 && bboxStr.includes(';') && fallbackStr !== bboxStr) {
        resp = await fetch(this.resolveApiUrl(buildApiPath(fallbackStr)), { signal: controller.signal });
        if (this.activeApiQuery !== queryKey || controller.signal.aborted) return;
        body = await resp.json();
        if (this.activeApiQuery !== queryKey || controller.signal.aborted) return;
      }

      if (resp.status === 202 && body?.status === 'downloading') {
        this.offlineRetryDelayMs = 5000;
        this.offlineRetryCount = 0;
        this.downloadPollCount += 1;
        const rawProg: BackendDownloadProgress = body.progress ?? { done: 0, total: 0 };
        if (rawProg.total > 0) {
          this.zeroTotalPolls = 0;
          if (rawProg.done > this.lastDownloadDone) {
            this.stalledOrResetPolls = 0;
          } else {
            this.stalledOrResetPolls += 1;
          }
        } else {
          this.zeroTotalPolls += 1;
          this.stalledOrResetPolls += 1;
        }
        this.lastDownloadDone = rawProg.done;

        // Break out of endless 202 download loops if the backend restarts jobs repeatedly or stalls
        if (this.zeroTotalPolls >= 8 || this.stalledOrResetPolls >= 12 || this.downloadPollCount >= 80) {
          this.backendProgress.set(null);
          if (!(await this.tryRestoreOfflineCalendar(queryKey))) {
            this.backendStatus.set(this.backendCalendar() ? 'cached' : 'offline');
          }
          return;
        }

        if (!this.isInsideCachedRegion(primaryBox)) {
          this.backendCalendar.set(null);
        }
        this.backendStatus.set('downloading');
        this.backendProgress.set({
          done: rawProg.total > 0 ? Math.min(rawProg.done, rawProg.total) : 0,
          total: Math.max(0, rawProg.total)
        });
        const pollDelayMs = Math.min(12000, 3000 + Math.floor(this.stalledOrResetPolls / 2) * 1500);
        this.apiPollTimer = setTimeout(() => {
          if (this.activeApiQuery === queryKey && !this.isCustomDataset()) {
            void this.syncCalendarFromBackend(bboxOrList, dateStart, dateEnd, true);
          }
        }, pollDelayMs);
        return;
      }

      if (resp.ok && body?.months && body?.selection) {
        this.offlineRetryDelayMs = 5000;
        this.offlineRetryCount = 0;
        const payload = this.hydrateIncompleteWithDefault(body as BackendCalendarPayload, dateStart, dateEnd);
        this.backendCalendar.set(payload);
        this.backendCachedAt.set(null);
        this.backendStatus.set('live');
        this.backendProgress.set(null);
        this.backendError.set(null);
        if (!body.metadata?.refreshing) {
          this.cacheCalendarPayload(queryKey, payload);
        } else {
          // Backend already returned HTTP 200 live data while a multi-year FIRMS backfill finishes in the
          // background; avoid polling the full payload every 3.5s and perform at most a bounded delayed check.
          const selHotspots = body.selection?.hotspots;
          const hasSelectionHits =
            (selHotspots?.harmonized ?? 0) > 0 ||
            (selHotspots?.rawModis ?? 0) > 0 ||
            (selHotspots?.rawViirs ?? 0) > 0;
          const maxBgRefreshes = hasSelectionHits ? 3 : 6;
          if (this.bgRefreshCount < maxBgRefreshes) {
            this.bgRefreshCount += 1;
            const delayMs = hasSelectionHits
              ? Math.min(25000, 8000 * this.bgRefreshCount)
              : Math.min(25000, 6000 * this.bgRefreshCount);
            this.apiPollTimer = setTimeout(() => {
              if (this.activeApiQuery === queryKey && !this.isCustomDataset()) {
                void this.syncCalendarFromBackend(bboxOrList, dateStart, dateEnd, true);
              }
            }, delayMs);
          }
        }
        return;
      }

      this.backendCalendar.set(null);
      this.backendStatus.set('error');
      this.backendProgress.set(null);
      this.backendError.set(typeof body?.error === 'string' ? body.error : `HTTP ${resp.status}`);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      await this.handleOfflineOrUnreachable(queryKey, bboxOrList, dateStart, dateEnd, primaryBox);
    }
  }

  private async handleOfflineOrUnreachable(
    queryKey: string,
    bboxOrList: BoundingBox | BoundingBox[],
    dateStart: string,
    dateEnd: string,
    primaryBox: BoundingBox
  ): Promise<void> {
    if (await this.tryRestoreOfflineCalendar(queryKey)) {
      return;
    }
    if (!this.isInsideCachedRegion(primaryBox)) {
      this.backendCalendar.set(null);
    }
    this.backendCachedAt.set(null);
    this.backendStatus.set('offline');
    this.backendProgress.set(null);
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (!isOffline && this.offlineRetryCount < 5) {
      this.offlineRetryCount += 1;
      const delay = this.offlineRetryDelayMs;
      this.offlineRetryDelayMs = Math.min(30000, this.offlineRetryDelayMs * 2);
      this.apiPollTimer = setTimeout(() => {
        if (this.activeApiQuery === queryKey && !this.isCustomDataset()) {
          void this.syncCalendarFromBackend(bboxOrList, dateStart, dateEnd, true);
        }
      }, delay);
    }
  }

  private isInsideCachedRegion(bbox: BoundingBox): boolean {
    const cached = this.backendCalendar()?.metadata.cachedRegion;
    if (!cached) return false;
    return bbox[0] >= cached[0] && bbox[1] >= cached[1] && bbox[2] <= cached[2] && bbox[3] <= cached[3];
  }

  loadAll(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    void this.warmUpBackend();
    this.loadPromise = this.fetchAll();
    return this.loadPromise;
  }

  private warmUpBackend(): void {
    // Wake scaled-to-zero Cloud Run instances while the user fills out the region form.
    if (typeof fetch === 'undefined') return;
    void fetch(this.resolveApiUrl('/api/health')).catch(() => {});
  }

  getEnsoOni(yearMonth: string): number {
    const exact = this.oniByMonth.get(yearMonth);
    if (exact !== undefined) return exact;
    const [y, m] = yearMonth.split('-').map(Number);
    return Number((0.9 * Math.sin(((y - 2000) * 12 + m) * 0.14)).toFixed(2));
  }

  getGulfStreamAnomaly(yearMonth: string): number {
    const exact = this.gsByMonth.get(yearMonth);
    if (exact !== undefined) return exact;
    const [y, m] = yearMonth.split('-').map(Number);
    // North Atlantic Gulf Stream SST anomaly seasonal + multi-year oscillation (°C)
    const val = 0.55 * Math.sin(((y - 2020) * 12 + m) * 0.18) + 0.35 * Math.cos((m - 8) * (Math.PI / 6));
    return Number(val.toFixed(2));
  }

  resetToDefaultHotspots(): void {
    this.importError.set(null);
    this.isCustomDataset.set(false);
    this.hotspotDatasetName.set('');
    this.hotspots.set(this.defaultHotspots);
    void this.offlineCache.clearCustomDataset();
  }

  getSampleCsvTemplate(): string {
    return [
      'date,lon,lat,frpMw,confidence,sensor,rawModisCount,rawViirsCount,harmonizedCount,biome,regionName',
      '2022-06-17,-6.2500,41.9200,1480.5,94,HARMONIZED,8,29,30,Mediterranean Pine/Scrub,Sierra de la Culebra',
      '2022-07-18,-6.0406,41.7109,1820.0,96,HARMONIZED,11,38,39,Mediterranean Pine/Scrub,Losacio',
      '2025-08-14,-7.8294,40.2240,2140.2,95,HARMONIZED,14,47,48,Atlantic Eucalyptus/Pine,Piódão',
      '2017-06-18,-8.2200,39.9500,2610.8,98,HARMONIZED,17,58,60,Atlantic Eucalyptus/Pine,Pedrógão Grande'
    ].join('\n');
  }

  importHotspotFile(
    filename: string,
    rawText: string,
    persist = true
  ): { ok: boolean; count: number; minDate?: string; maxDate?: string; bbox?: BoundingBox } {
    this.importError.set(null);
    const trimmed = rawText.trim();
    if (!trimmed) {
      this.importError.set('empty');
      return { ok: false, count: 0 };
    }

    try {
      let parsed: HarmonizedHotspotRecord[] = [];
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        parsed = this.parseHotspotJson(trimmed);
      } else {
        parsed = this.parseHotspotCsv(trimmed);
      }

      if (parsed.length === 0) {
        this.importError.set('noValidRows');
        return { ok: false, count: 0 };
      }

      parsed.sort((a, b) => a.date.localeCompare(b.date));
      let minLon = 180;
      let minLat = 90;
      let maxLon = -180;
      let maxLat = -90;
      for (const r of parsed) {
        if (r.lon < minLon) minLon = r.lon;
        if (r.lon > maxLon) maxLon = r.lon;
        if (r.lat < minLat) minLat = r.lat;
        if (r.lat > maxLat) maxLat = r.lat;
      }

      // Add a tiny padding when single point or tight cluster
      const padLon = maxLon - minLon < 0.05 ? 0.25 : 0.08;
      const padLat = maxLat - minLat < 0.05 ? 0.25 : 0.08;

      this.hotspots.set(parsed);
      this.hotspotDatasetName.set(filename);
      this.isCustomDataset.set(true);
      if (persist) {
        void this.offlineCache.putCustomDataset(filename, trimmed);
      }

      return {
        ok: true,
        count: parsed.length,
        minDate: parsed[0].date,
        maxDate: parsed[parsed.length - 1].date,
        bbox: [
          Number(Math.max(-180, minLon - padLon).toFixed(2)),
          Number(Math.max(-85, minLat - padLat).toFixed(2)),
          Number(Math.min(180, maxLon + padLon).toFixed(2)),
          Number(Math.min(85, maxLat + padLat).toFixed(2))
        ]
      };
    } catch {
      this.importError.set('parseError');
      return { ok: false, count: 0 };
    }
  }

  private parseHotspotJson(text: string): HarmonizedHotspotRecord[] {
    const raw = JSON.parse(text);
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.records) ? raw.records : [];
    const out: HarmonizedHotspotRecord[] = [];
    for (let i = 0; i < arr.length; i++) {
      const rec = this.normalizeRecord(arr[i], i);
      if (rec) out.push(rec);
    }
    return out;
  }

  private parseHotspotCsv(text: string): HarmonizedHotspotRecord[] {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return [];
    const headers = this.splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
    const out: HarmonizedHotspotRecord[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = this.splitCsvLine(lines[i]);
      const obj: Record<string, string> = {};
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = cols[c] ?? '';
      }
      const rec = this.normalizeRecord(obj, i - 1);
      if (rec) out.push(rec);
    }
    return out;
  }

  private normalizeRecord(raw: Record<string, any>, idx: number): HarmonizedHotspotRecord | null {
    const get = (...keys: string[]) => {
      for (const k of keys) {
        if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
        const lower = k.toLowerCase();
        if (raw[lower] !== undefined && raw[lower] !== null && raw[lower] !== '') return raw[lower];
      }
      return undefined;
    };

    const rawDate = String(get('date', 'acq_date', 'timestamp', 'acqDate') ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return null;

    const lat = Number(get('lat', 'latitude', 'zaplon_lat'));
    const lon = Number(get('lon', 'lng', 'longitude', 'zaplon_lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return null;
    }

    const rawModisCount = Math.max(0, Number(get('rawModisCount', 'raw_modis_count', 'modisCount', 'modis_count') ?? 0) || 0);
    const rawViirsCount = Math.max(0, Number(get('rawViirsCount', 'raw_viirs_count', 'viirsCount', 'viirs_count') ?? 0) || 0);
    const explicitHarm = Number(get('harmonizedCount', 'harmonized_count', 'count', 'fires', 'detections'));
    const harmonizedCount = Number.isFinite(explicitHarm) && explicitHarm > 0
      ? Math.round(explicitHarm)
      : Math.max(1, rawViirsCount > 0 ? rawViirsCount : Math.round(rawModisCount * 3.5) || 1);

    const frpMw = Math.max(0, Number(get('frpMw', 'frp_mw', 'frp', 'harmonizedFrpMw') ?? harmonizedCount * 24) || 0);
    const confidence = Math.max(0, Math.min(100, Number(get('confidence', 'conf') ?? 85) || 85));
    const sensorRaw = String(get('sensor', 'satellite', 'instrument') ?? 'HARMONIZED').toUpperCase();
    const sensor: HotspotSensor = sensorRaw.includes('MODIS')
      ? 'MODIS'
      : sensorRaw.includes('VIIRS')
        ? 'VIIRS'
        : 'HARMONIZED';

    return {
      id: String(get('id') ?? `custom-${idx + 1}`),
      date: rawDate,
      lon: Number(lon.toFixed(4)),
      lat: Number(lat.toFixed(4)),
      frpMw: Number(frpMw.toFixed(1)),
      confidence: Math.round(confidence),
      sensor,
      rawModisCount: rawModisCount || (sensor === 'MODIS' ? 1 : Math.max(1, Math.round(harmonizedCount / 3.5))),
      rawViirsCount: rawViirsCount || (sensor === 'VIIRS' ? harmonizedCount : 0),
      harmonizedCount,
      biome: String(get('biome', 'landcover') ?? 'Mixed Forest/Scrub'),
      regionName: get('regionName', 'region_name', 'region', 'name') ? String(get('regionName', 'region_name', 'region', 'name')) : undefined
    };
  }

  private async fetchAll(): Promise<void> {
    try {
      const [cal, inertia, enso, meta, hotspotsPayload, countriesGeo, defaultCal] = await Promise.all([
        this.fetchJson<CalendarSummaryData>('assets/data/calendar-summary.json'),
        this.fetchJson<ClimateInertiaData>('assets/data/climate-inertia.json'),
        this.fetchJson<EnsoHistoryJson>('assets/data/enso-history.json'),
        this.fetchJson<TimelineMetaJson>('assets/data/timeline-meta.json'),
        this.fetchJson<HarmonizedHotspotsPayload>('assets/data/harmonized-hotspots.json'),
        this.fetchJson<CountryGeoJsonPayload>('assets/data/uk-land-10m.json'),
        this.fetchJson<BackendCalendarPayload>('assets/data/default-iberia-calendar.json')
      ]);

      if (defaultCal?.months && defaultCal?.selection) {
        this.cachedDefaultCalendar = defaultCal;
        const defaultKey = `${DEFAULT_CACHED_IBERIA_BBOX.map(v => Number(v.toFixed(4))).join(',')}|${DEFAULT_CACHED_FROM_YM}|${DEFAULT_CACHED_TO_YM}`;
        void this.offlineCache.putCalendar(defaultKey, defaultCal);
        if (!this.isCustomDataset() && !this.backendCalendar()) {
          this.backendCalendar.set(defaultCal);
          this.backendCachedAt.set(null);
          this.backendStatus.set(typeof navigator !== 'undefined' && navigator.onLine === false ? 'cached' : 'live');
          this.backendProgress.set(null);
          this.backendError.set(null);
        }
      }

      if (!this.isCustomDataset()) {
        const savedCustom = await this.offlineCache.getCustomDataset();
        if (savedCustom) {
          this.importHotspotFile(savedCustom.filename, savedCustom.rawText, false);
        }
      }

      if (cal) this.calendar.set(cal);
      if (inertia) this.climateInertia.set(inertia);
      if (enso) this.indexEnsoHistory(enso);
      if (meta) this.indexGulfStreamMeta(meta);
      if (hotspotsPayload?.records) {
        // Do not populate defaultHotspots with the static Iberia-only sample;
        // live bounding-box data from /api/calendar is the sole spatial source of truth.
        this.defaultHotspots = [];
      }
      if (countriesGeo?.features) {
        this.countries.set(this.parseCountriesGeoJson(countriesGeo));
      }
      this.isLoaded.set(true);
    } catch (err) {
      console.warn('Could not load wildfire datasets:', err);
    }
  }

  private parseCountriesGeoJson(geo: CountryGeoJsonPayload): PredefinedCountry[] {
    const out: PredefinedCountry[] = [];
    const seen = new Set<string>();

    const ringBbox = (ring: [number, number][]): BoundingBox => {
      let w = 180, s = 90, e = -180, n = -90;
      for (const [x, y] of ring) {
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      }
      return [
        Math.max(-180, Number(w.toFixed(2))),
        Math.max(-85, Number(s.toFixed(2))),
        Math.min(180, Number(e.toFixed(2))),
        Math.min(85, Number(n.toFixed(2)))
      ];
    };

    for (const feat of geo.features ?? []) {
      const code = (feat.properties?.code ?? '').trim().toUpperCase();
      const name = (feat.properties?.name ?? code).trim();
      const geom = feat.geometry;
      if (!code || code === '-99' || seen.has(code) || !geom?.coordinates) continue;

      const rawPolys: PolygonCoords[] =
        geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      if (rawPolys.length === 0) continue;

      const withBox = rawPolys
        .filter(p => Array.isArray(p[0]) && p[0].length >= 4)
        .map(poly => {
          const bbox = ringBbox(poly[0]);
          const area = Math.max(0.0001, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
          return { poly, bbox, area };
        })
        .sort((a, b) => b.area - a.area);

      if (withBox.length === 0) continue;
      const main = withBox[0].bbox;

      // Keep polygons within 26 deg of main landmass so distant overseas islands don't span oceans
      const kept = withBox.filter((item, idx) => {
        if (idx === 0) return true;
        const b = item.bbox;
        const dx = Math.max(0, main[0] - b[2], b[0] - main[2]);
        const dy = Math.max(0, main[1] - b[3], b[1] - main[3]);
        return Math.hypot(dx, dy) <= 26;
      });

      const clusters: BoundingBox[] = [];
      for (const item of kept) {
        const b: BoundingBox = [...item.bbox];
        let merged = false;
        for (const c of clusters) {
          const dx = Math.max(0, c[0] - b[2], b[0] - c[2]);
          const dy = Math.max(0, c[1] - b[3], b[1] - c[3]);
          if (Math.hypot(dx, dy) <= 3.5) {
            c[0] = Math.min(c[0], b[0]);
            c[1] = Math.min(c[1], b[1]);
            c[2] = Math.max(c[2], b[2]);
            c[3] = Math.max(c[3], b[3]);
            merged = true;
            break;
          }
        }
        if (!merged) clusters.push(b);
      }

      const normClusters = clusters
        .slice(0, 4)
        .map(([w, s, e, n]): BoundingBox => [
          Number(Math.max(-180, e - w < 0.06 ? w - 0.04 : w).toFixed(2)),
          Number(Math.max(-85, n - s < 0.06 ? s - 0.04 : s).toFixed(2)),
          Number(Math.min(180, e - w < 0.06 ? e + 0.04 : e).toFixed(2)),
          Number(Math.min(85, n - s < 0.06 ? n + 0.04 : n).toFixed(2))
        ]);

      let primaryBbox: BoundingBox = normClusters[0] ?? [...main];
      let bboxes: BoundingBox[] = normClusters.length > 0 ? normClusters : [primaryBbox];

      // Align Spain & Portugal primary Iberian bounding boxes with the pre-seeded Iberia FIRMS cache
      if (code === 'ESP') {
        primaryBbox = [-9.3, 36.0, 3.48, 43.79];
        bboxes = [primaryBbox];
      } else if (code === 'PRT') {
        primaryBbox = [-9.5, 36.97, -6.21, 42.15];
        bboxes = [primaryBbox];
      }

      const center: [number, number] = [
        Number(((primaryBbox[0] + primaryBbox[2]) / 2).toFixed(2)),
        Number(((primaryBbox[1] + primaryBbox[3]) / 2).toFixed(2))
      ];

      seen.add(code);
      out.push({
        code,
        iso2: ISO3_TO_ISO2[code],
        name,
        bboxes,
        primaryBbox,
        polygons: kept.map(k => k.poly),
        center
      });
    }

    out.sort((a, b) => {
      const ia = PRIORITY_COUNTRY_CODES.indexOf(a.code);
      const ib = PRIORITY_COUNTRY_CODES.indexOf(b.code);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.name.localeCompare(b.name);
    });

    return out;
  }

  private indexEnsoHistory(enso: EnsoHistoryJson) {
    const first = enso.index?.firstMonth;
    const oni = enso.index?.oni;
    if (first && Array.isArray(oni)) {
      const [startY, startM] = first.split('-').map(Number);
      for (let i = 0; i < oni.length; i++) {
        const totalM = startY * 12 + (startM - 1) + i;
        const y = Math.floor(totalM / 12);
        const m = (totalM % 12) + 1;
        const key = `${y}-${String(m).padStart(2, '0')}`;
        this.oniByMonth.set(key, oni[i]);
      }
    }
    if (enso.provisional?.month && enso.provisional.oni !== undefined) {
      this.oniByMonth.set(enso.provisional.month, enso.provisional.oni);
    }
  }

  private indexGulfStreamMeta(meta: TimelineMetaJson) {
    const accum = new Map<string, { sum: number; count: number }>();
    for (const kf of meta.keyframes ?? []) {
      if (kf.s === undefined) continue;
      const ym = kf.date.slice(0, 7);
      const entry = accum.get(ym) ?? { sum: 0, count: 0 };
      entry.sum += kf.s;
      entry.count += 1;
      accum.set(ym, entry);
    }
    for (const [ym, { sum, count }] of accum.entries()) {
      this.gsByMonth.set(ym, Number((sum / count).toFixed(2)));
    }
  }

  private parseAoiCsv(csv: string): WildfireAoi[] {
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = this.splitCsvLine(lines[0]);
    const idx = (col: string) => headers.indexOf(col);
    const out: WildfireAoi[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = this.splitCsvLine(lines[i]);
      const aoiId = cols[idx('aoi_id')];
      if (!aoiId) continue;

      const preEnd = cols[idx('pre_fire_do')] || `${cols[idx('rok')]}-07-01`;
      const postStart = cols[idx('post_fire_od')] || `${cols[idx('rok')]}-08-25`;
      const start = this.addDays(preEnd, 1);
      const end = this.addDays(postStart, -1);

      out.push({
        aoiId,
        name: cols[idx('pozar')] || aoiId,
        year: Number(cols[idx('rok')]) || 2025,
        country: cols[idx('kraj')] || 'Iberia',
        ignitionLat: Number(cols[idx('zaplon_lat')]) || 40.2,
        ignitionLon: Number(cols[idx('zaplon_lon')]) || -3.7,
        bbox: [
          Number(cols[idx('bbox_w')]) || -9.6,
          Number(cols[idx('bbox_s')]) || 36.0,
          Number(cols[idx('bbox_e')]) || 3.4,
          Number(cols[idx('bbox_n')]) || 43.8
        ],
        burnedAreaHa: Number(cols[idx('areal_pozaru_ha')]) || 0,
        startDate: start,
        endDate: end
      });
    }
    return out;
  }

  private splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  private addDays(isoDate: string, days: number): string {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      return (await resp.json()) as T;
    } catch {
      return null;
    }
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    }
  }
}
