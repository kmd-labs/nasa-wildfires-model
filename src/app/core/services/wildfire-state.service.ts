import { Injectable, NgZone, computed, effect, inject, signal } from '@angular/core';
import { PopupService } from '@kmd/design-system';
import {
  ActiveFireDataset,
  BoundingBox,
  CalendarGranularity,
  CameraFocusId,
  ChartGranularity,
  ColorRampId,
  MapRenderMode,
  MultiPolygonCoords,
  PolygonCoords,
  PolygonRing,
  PredefinedCountry,
  WildfireViewMode
} from '../models/wildfire.model';
import { I18nService } from '../i18n/i18n.service';
import { WildfireDataService } from './wildfire-data.service';

export const VIIRS_FIRST_DATE = '2012-01-20';
const LARGE_BBOX_DEG2_THRESHOLD = 20;
const HUGE_TIME_RANGE_DAYS_THRESHOLD = 730;

const COLOR_RAMP_STORAGE_KEY = 'nasa-wildfires-model.colorRamp';
const BBOX_STORAGE_KEY = 'nasa-wildfires-model.bbox';
const POLYGON_STORAGE_KEY = 'nasa-wildfires-model.polygon';
const DATE_START_STORAGE_KEY = 'nasa-wildfires-model.dateStart';
const DATE_END_STORAGE_KEY = 'nasa-wildfires-model.dateEnd';
const UI_STORAGE_KEY = 'nasa-wildfires-model.ui';
const PREFILL_VERSION_KEY = 'nasa-wildfires-model.prefillVersion';
const CURRENT_PREFILL_VERSION = '3';

const VALID_COLOR_RAMPS = new Set<ColorRampId>(['okabeIto', 'cividis', 'viridis', 'ylOrRd']);
const VALID_CALENDAR_MODES = new Set<CalendarGranularity>(['daily', 'monthly']);
const VALID_CHART_MODES = new Set<ChartGranularity>(['monthly', 'yearly']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const LEGACY_PREFILL_BBOX: BoundingBox = [-8.11, 40.0, -7.62, 40.43];

// Prefill with 6-edge polygon encompassing the entire Iberian Peninsula & 2025 fire season (Jun–Sep 2025)
export const DEFAULT_PREFILL_BBOX: BoundingBox = [-9.55, 36.0, 3.45, 43.8];
export const DEFAULT_PREFILL_POLYGON: PolygonRing = [
  [-9.55, 37.0],
  [-5.6, 36.0],
  [0.45, 37.25],
  [3.45, 42.35],
  [-1.8, 43.65],
  [-9.4, 43.8]
];
export const DEFAULT_PREFILL_DATES = { start: '2025-06-01', end: '2025-09-30' };

export function bboxToPolygonRing(bbox: BoundingBox): PolygonRing {
  const [w, s, e, n] = bbox;
  return [[w, s], [e, s], [e, n], [w, n]];
}

export function ringToClosedPolygonCoords(ring: PolygonRing): PolygonCoords {
  if (ring.length === 0) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed =
    Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6
      ? ring
      : [...ring, first];
  return [closed];
}

export function bboxToPolygonCoords(bbox: BoundingBox): PolygonCoords {
  return ringToClosedPolygonCoords(bboxToPolygonRing(bbox));
}

function isPointInRing(lon: number, lat: number, ring: PolygonRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointInPolygonCoords(lon: number, lat: number, poly: PolygonCoords): boolean {
  if (poly.length === 0 || !isPointInRing(lon, lat, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) {
    if (isPointInRing(lon, lat, poly[h])) return false;
  }
  return true;
}

interface StoredUiSettings {
  mapMode: MapRenderMode;
  analyticsMinimized: boolean;
  analyticsExpanded: boolean;
  showRegionForm: boolean;
  showDataSection: boolean;
  showCoordsInputs: boolean;
  showLayersSection: boolean;
  showAnalysisSection: boolean;
  showHotspotsOnGlobe: boolean;
  showRegionBbox: boolean;
  showLandOrtho: boolean;
  showBorders: boolean;
  calendarGranularity: CalendarGranularity;
  chartGranularity: ChartGranularity;
}

const DEFAULT_UI_SETTINGS: StoredUiSettings = {
  mapMode: '2d',
  analyticsMinimized: false,
  analyticsExpanded: false,
  showRegionForm: true,
  showDataSection: true,
  showCoordsInputs: true,
  showLayersSection: false,
  showAnalysisSection: true,
  showHotspotsOnGlobe: true,
  showRegionBbox: true,
  showLandOrtho: true,
  showBorders: true,
  calendarGranularity: 'daily',
  chartGranularity: 'monthly'
};

@Injectable({
  providedIn: 'root'
})
export class WildfireStateService {
  private readonly data = inject(WildfireDataService);
  private readonly popup = inject(PopupService);
  private readonly i18n = inject(I18nService);
  private readonly ngZone = inject(NgZone);

  private readonly initialDates = (() => {
    this.migrateLegacyPrefillIfNeeded();
    return this.resolveInitialDateRange();
  })();
  private readonly initialUi = this.resolveInitialUiSettings();

  readonly mapMode = signal<MapRenderMode>(this.initialUi.mapMode);
  readonly viewMode = signal<WildfireViewMode>('analytics');
  readonly cameraFocus = signal<CameraFocusId>('iberia');
  readonly cameraTargetLonLat = signal<[number, number]>([0, 22]);

  /** Single bounding box envelope [west, south, east, north] in EPSG:4326, or null before user defines one. */
  readonly regionBbox = signal<BoundingBox | null>(this.resolveInitialBbox());

  /** Accepted region polygon vertices (4+ unique [lon, lat] vertices), or null. */
  readonly regionPolygon = signal<PolygonRing | null>(this.resolveInitialPolygon(this.regionBbox()));

  /** Exact Natural Earth country/area MultiPolygon border geometry when a predefined country is active. */
  readonly regionBorderMultiPolygon = signal<MultiPolygonCoords | null>(null);

  /** Unaccepted draft polygon currently being edited on the globe before clicking Accept & Calculate. */
  readonly draftPolygon = signal<PolygonRing | null>(null);

  readonly hasUnacceptedDraft = computed<boolean>(() => this.draftPolygon() !== null);
  readonly draftEdgeCount = computed<number>(
    () => this.draftPolygon()?.length ?? this.regionPolygon()?.length ?? 0
  );

  readonly regionBboxes = computed<BoundingBox[]>(() => {
    const b = this.regionBbox();
    return b ? [b] : [];
  });

  readonly regionMultiPolygon = computed<MultiPolygonCoords>(() => {
    const border = this.regionBorderMultiPolygon();
    if (border && border.length > 0) {
      return border;
    }
    const poly = this.regionPolygon();
    if (poly && poly.length >= 3) {
      return [ringToClosedPolygonCoords(poly)];
    }
    const b = this.regionBbox();
    return b ? [bboxToPolygonCoords(b)] : [];
  });

  readonly dateStart = signal<string>(this.initialDates.start);
  readonly dateEnd = signal<string>(this.initialDates.end);
  readonly draftDateStart = signal<string>(this.initialDates.start);
  readonly draftDateEnd = signal<string>(this.initialDates.end);
  readonly missingInputsPrompt = signal<boolean>(false);

  readonly hasValidDraftDateStart = computed<boolean>(() => {
    const s = this.draftDateStart();
    const e = this.draftDateEnd();
    return Boolean(s && ISO_DATE_RE.test(s) && (!e || !ISO_DATE_RE.test(e) || s <= e));
  });
  readonly hasValidDraftDateEnd = computed<boolean>(() => {
    const s = this.draftDateStart();
    const e = this.draftDateEnd();
    return Boolean(e && ISO_DATE_RE.test(e) && (!s || !ISO_DATE_RE.test(s) || s <= e));
  });
  readonly hasValidDraftDates = computed<boolean>(
    () => this.hasValidDraftDateStart() && this.hasValidDraftDateEnd()
  );
  readonly hasAnyRegionGeometry = computed<boolean>(
    () => Boolean(this.draftPolygon() || this.regionBbox())
  );
  readonly canRecalculate = computed<boolean>(
    () => this.hasValidDraftDates() && this.hasAnyRegionGeometry()
  );
  readonly missingDateStart = computed<boolean>(
    () => !this.hasValidDraftDateStart() && (this.missingInputsPrompt() || this.hasAnyRegionGeometry())
  );
  readonly missingDateEnd = computed<boolean>(
    () => !this.hasValidDraftDateEnd() && (this.missingInputsPrompt() || this.hasAnyRegionGeometry())
  );
  readonly missingRegion = computed<boolean>(
    () => !this.hasAnyRegionGeometry() && (this.missingInputsPrompt() || this.hasValidDraftDates())
  );

  readonly hasPendingDateChanges = computed<boolean>(
    () => this.draftDateStart() !== this.dateStart() || this.draftDateEnd() !== this.dateEnd()
  );
  readonly needsRecalculate = computed<boolean>(
    () => this.hasUnacceptedDraft() || this.hasPendingDateChanges()
  );

  readonly isViirsAvailable = computed<boolean>(() => {
    const e = this.dateEnd();
    return !e || e >= VIIRS_FIRST_DATE;
  });

  readonly preferredDataset = signal<ActiveFireDataset>('VIIRS');

  readonly activeDataset = computed<ActiveFireDataset>(() =>
    this.isViirsAvailable() ? this.preferredDataset() : 'MODIS'
  );

  /**
   * True when the best-quality preference ('VIIRS') is active over a range spanning the
   * 2012-01-20 VIIRS launch, so MODIS 1 km is used pre-2012 and VIIRS 375 m from 2012 onward.
   */
  readonly isMixedSensorRange = computed<boolean>(() => {
    const s = this.dateStart();
    const e = this.dateEnd();
    return (
      this.activeDataset() === 'VIIRS' &&
      Boolean(s && e && s < VIIRS_FIRST_DATE && e >= VIIRS_FIRST_DATE)
    );
  });

  readonly hasBoundingBox = computed<boolean>(() => this.regionBbox() !== null);
  readonly hasDateRange = computed<boolean>(() => {
    const s = this.dateStart();
    const e = this.dateEnd();
    return Boolean(s && e && ISO_DATE_RE.test(s) && ISO_DATE_RE.test(e) && s <= e);
  });
  readonly hasActiveSelection = computed<boolean>(
    () => (this.hasBoundingBox() && this.hasDateRange()) || this.data.isCustomDataset()
  );

  readonly isDrawingBbox = signal<boolean>(false);
  readonly drawBoxMode = signal<'replace' | 'add'>('replace');
  readonly liveDrawBbox = signal<BoundingBox | null>(null);
  readonly flyToBboxTrigger = signal<number>(0);

  readonly isAnalyticsMinimized = signal<boolean>(this.initialUi.analyticsMinimized);
  readonly isAnalyticsExpanded = signal<boolean>(this.initialUi.analyticsExpanded);
  readonly showRegionForm = signal<boolean>(this.initialUi.showRegionForm);
  readonly showDataSection = signal<boolean>(this.initialUi.showDataSection);
  readonly showCoordsInputs = signal<boolean>(this.initialUi.showCoordsInputs);
  readonly showLayersSection = signal<boolean>(this.initialUi.showLayersSection);
  readonly showAnalysisSection = signal<boolean>(this.initialUi.showAnalysisSection);
  readonly autoRestoreAfterDraw = signal<boolean>(false);

  readonly colorRamp = signal<ColorRampId>(this.resolveInitialColorRamp());
  readonly showHotspotsOnGlobe = signal<boolean>(this.initialUi.showHotspotsOnGlobe);
  readonly showRegionBbox = signal<boolean>(this.initialUi.showRegionBbox);
  readonly showLandOrtho = signal<boolean>(this.initialUi.showLandOrtho);
  readonly showBorders = signal<boolean>(this.initialUi.showBorders);
  readonly showUserLocation = signal<boolean>(false);
  readonly userLocation = signal<{ lon: number; lat: number } | null>(null);
  readonly activeTileZoom = signal<number>(3);
  readonly calendarGranularity = signal<CalendarGranularity>(this.initialUi.calendarGranularity);
  readonly chartGranularity = signal<ChartGranularity>(this.initialUi.chartGranularity);
  readonly mapLoaded = signal<boolean>(false);

  readonly bboxCenter = computed<[number, number]>(() => {
    const b = this.regionBbox();
    if (!b) return this.cameraTargetLonLat();
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  });

  constructor() {
    effect(() => {
      const ramp = this.colorRamp();
      const bbox = this.regionBbox();
      const poly = this.regionPolygon();
      const start = this.dateStart();
      const end = this.dateEnd();
      const ui: StoredUiSettings = {
        mapMode: this.mapMode(),
        analyticsMinimized: this.isAnalyticsMinimized(),
        analyticsExpanded: this.isAnalyticsExpanded(),
        showRegionForm: this.showRegionForm(),
        showDataSection: this.showDataSection(),
        showCoordsInputs: this.showCoordsInputs(),
        showLayersSection: this.showLayersSection(),
        showAnalysisSection: this.showAnalysisSection(),
        showHotspotsOnGlobe: this.showHotspotsOnGlobe(),
        showRegionBbox: this.showRegionBbox(),
        showLandOrtho: this.showLandOrtho(),
        showBorders: this.showBorders(),
        calendarGranularity: this.calendarGranularity(),
        chartGranularity: this.chartGranularity()
      };
      try {
        localStorage.setItem(COLOR_RAMP_STORAGE_KEY, ramp);
        if (bbox) {
          localStorage.setItem(BBOX_STORAGE_KEY, JSON.stringify(bbox));
        } else {
          localStorage.removeItem(BBOX_STORAGE_KEY);
        }
        if (poly) {
          localStorage.setItem(POLYGON_STORAGE_KEY, JSON.stringify(poly));
        } else {
          localStorage.removeItem(POLYGON_STORAGE_KEY);
        }
        if (start) {
          localStorage.setItem(DATE_START_STORAGE_KEY, start);
        } else {
          localStorage.removeItem(DATE_START_STORAGE_KEY);
        }
        if (end) {
          localStorage.setItem(DATE_END_STORAGE_KEY, end);
        } else {
          localStorage.removeItem(DATE_END_STORAGE_KEY);
        }
        localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(ui));
      } catch {
        // localStorage unavailable
      }
    });
  }

  private migrateLegacyPrefillIfNeeded(): void {
    try {
      if (localStorage.getItem(PREFILL_VERSION_KEY) === CURRENT_PREFILL_VERSION) return;
      const rawBox = localStorage.getItem(BBOX_STORAGE_KEY);
      if (rawBox) {
        const parsed = JSON.parse(rawBox);
        if (
          Array.isArray(parsed) &&
          parsed.length === 4 &&
          LEGACY_PREFILL_BBOX.every((v, i) => typeof parsed[i] === 'number' && Math.abs(parsed[i] - v) < 1e-3)
        ) {
          localStorage.removeItem(BBOX_STORAGE_KEY);
          localStorage.removeItem(POLYGON_STORAGE_KEY);
          localStorage.removeItem(DATE_START_STORAGE_KEY);
          localStorage.removeItem(DATE_END_STORAGE_KEY);
        }
      }
      const rawUi = localStorage.getItem(UI_STORAGE_KEY);
      if (rawUi) {
        try {
          const parsedUi = JSON.parse(rawUi);
          if (parsedUi && typeof parsedUi === 'object') {
            parsedUi.showLayersSection = false;
            localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(parsedUi));
          }
        } catch {
          // ignore malformed stored ui
        }
      }
      localStorage.setItem(PREFILL_VERSION_KEY, CURRENT_PREFILL_VERSION);
    } catch {
      // localStorage unavailable
    }
  }

  private resolveInitialUiSettings(): StoredUiSettings {
    try {
      const raw = localStorage.getItem(UI_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredUiSettings> | null;
        if (parsed && typeof parsed === 'object') {
          return {
            mapMode:
              parsed.mapMode === '2d' || parsed.mapMode === 'globe'
                ? parsed.mapMode
                : DEFAULT_UI_SETTINGS.mapMode,
            analyticsMinimized:
              typeof parsed.analyticsMinimized === 'boolean'
                ? parsed.analyticsMinimized
                : DEFAULT_UI_SETTINGS.analyticsMinimized,
            analyticsExpanded:
              typeof parsed.analyticsExpanded === 'boolean'
                ? parsed.analyticsExpanded
                : DEFAULT_UI_SETTINGS.analyticsExpanded,
            showRegionForm:
              typeof parsed.showRegionForm === 'boolean'
                ? parsed.showRegionForm
                : DEFAULT_UI_SETTINGS.showRegionForm,
            showDataSection:
              typeof parsed.showDataSection === 'boolean'
                ? parsed.showDataSection
                : DEFAULT_UI_SETTINGS.showDataSection,
            showCoordsInputs:
              typeof parsed.showCoordsInputs === 'boolean'
                ? parsed.showCoordsInputs
                : DEFAULT_UI_SETTINGS.showCoordsInputs,
            showLayersSection:
              typeof parsed.showLayersSection === 'boolean'
                ? parsed.showLayersSection
                : DEFAULT_UI_SETTINGS.showLayersSection,
            showAnalysisSection:
              typeof parsed.showAnalysisSection === 'boolean'
                ? parsed.showAnalysisSection
                : DEFAULT_UI_SETTINGS.showAnalysisSection,
            showHotspotsOnGlobe:
              typeof parsed.showHotspotsOnGlobe === 'boolean'
                ? parsed.showHotspotsOnGlobe
                : DEFAULT_UI_SETTINGS.showHotspotsOnGlobe,
            showRegionBbox:
              typeof parsed.showRegionBbox === 'boolean'
                ? parsed.showRegionBbox
                : DEFAULT_UI_SETTINGS.showRegionBbox,
            showLandOrtho:
              typeof parsed.showLandOrtho === 'boolean'
                ? parsed.showLandOrtho
                : DEFAULT_UI_SETTINGS.showLandOrtho,
            showBorders:
              typeof parsed.showBorders === 'boolean'
                ? parsed.showBorders
                : DEFAULT_UI_SETTINGS.showBorders,
            calendarGranularity:
              parsed.calendarGranularity && VALID_CALENDAR_MODES.has(parsed.calendarGranularity)
                ? parsed.calendarGranularity
                : DEFAULT_UI_SETTINGS.calendarGranularity,
            chartGranularity:
              parsed.chartGranularity && VALID_CHART_MODES.has(parsed.chartGranularity)
                ? parsed.chartGranularity
                : DEFAULT_UI_SETTINGS.chartGranularity
          };
        }
      }
    } catch {
      // localStorage unavailable or malformed
    }
    return { ...DEFAULT_UI_SETTINGS };
  }

  private resolveInitialColorRamp(): ColorRampId {
    try {
      const stored = localStorage.getItem(COLOR_RAMP_STORAGE_KEY) as ColorRampId | null;
      if (stored && VALID_COLOR_RAMPS.has(stored)) {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }
    return 'ylOrRd';
  }

  private resolveInitialBbox(): BoundingBox | null {
    try {
      const raw = localStorage.getItem(BBOX_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          Array.isArray(parsed) &&
          parsed.length === 4 &&
          parsed.every(v => typeof v === 'number' && Number.isFinite(v))
        ) {
          const [w, s, e, n] = parsed as BoundingBox;
          if (w >= -180 && e <= 180 && w < e && s >= -85 && n <= 85 && s < n) {
            return [w, s, e, n];
          }
        }
      }
    } catch {
      // localStorage unavailable or malformed
    }
    return [...DEFAULT_PREFILL_BBOX];
  }

  private resolveInitialPolygon(fallbackBbox: BoundingBox | null): PolygonRing | null {
    try {
      const raw = localStorage.getItem(POLYGON_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          Array.isArray(parsed) &&
          parsed.length >= 3 &&
          parsed.every(
            pt =>
              Array.isArray(pt) &&
              pt.length === 2 &&
              typeof pt[0] === 'number' &&
              Number.isFinite(pt[0]) &&
              typeof pt[1] === 'number' &&
              Number.isFinite(pt[1])
          )
        ) {
          return parsed as PolygonRing;
        }
      }
    } catch {
      // localStorage unavailable or malformed
    }
    if (!fallbackBbox) return null;
    const isDefaultEnvelope = fallbackBbox.every((v, i) => Math.abs(v - DEFAULT_PREFILL_BBOX[i]) < 1e-6);
    return isDefaultEnvelope
      ? DEFAULT_PREFILL_POLYGON.map(([lon, lat]) => [lon, lat] as [number, number])
      : bboxToPolygonRing(fallbackBbox);
  }

  private resolveInitialDateRange(): { start: string; end: string } {
    try {
      const rawStart = localStorage.getItem(DATE_START_STORAGE_KEY) ?? '';
      const rawEnd = localStorage.getItem(DATE_END_STORAGE_KEY) ?? '';
      const startOk = ISO_DATE_RE.test(rawStart) && !Number.isNaN(Date.parse(`${rawStart}T00:00:00Z`));
      const endOk = ISO_DATE_RE.test(rawEnd) && !Number.isNaN(Date.parse(`${rawEnd}T00:00:00Z`));
      const start = startOk ? rawStart : '';
      const end = endOk ? rawEnd : '';
      if (!start && !end) {
        return { ...DEFAULT_PREFILL_DATES };
      }
      if (start && end && start > end) {
        return { start: end, end: start };
      }
      return { start, end };
    } catch {
      // localStorage unavailable
    }
    return { ...DEFAULT_PREFILL_DATES };
  }

  isPointInRegion(lon: number, lat: number): boolean {
    const b = this.regionBbox();
    if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
    const multi = this.regionMultiPolygon();
    if (multi.length === 0) return true;
    return multi.some(poly => isPointInPolygonCoords(lon, lat, poly));
  }

  private clampLonLat([lon, lat]: [number, number]): [number, number] {
    return [
      Number(Math.max(-180, Math.min(180, lon)).toFixed(3)),
      Number(Math.max(-85, Math.min(85, lat)).toFixed(3))
    ];
  }

  sanitizeBbox(bbox: BoundingBox): BoundingBox {
    let [w, s, e, n] = bbox.map(v => Number(v.toFixed(2))) as BoundingBox;
    w = Math.max(-180, Math.min(180, w));
    e = Math.max(-180, Math.min(180, e));
    s = Math.max(-85, Math.min(85, s));
    n = Math.max(-85, Math.min(85, n));
    if (w > e) [w, e] = [e, w];
    if (s > n) [s, n] = [n, s];
    if (e - w < 0.05) {
      w = Math.max(-180, Number((w - 0.05).toFixed(2)));
      e = Math.min(180, Number((e + 0.05).toFixed(2)));
    }
    if (n - s < 0.05) {
      s = Math.max(-85, Number((s - 0.05).toFixed(2)));
      n = Math.min(85, Number((n + 0.05).toFixed(2)));
    }
    return [w, s, e, n];
  }

  setCustomBbox(bbox: BoundingBox, flyTo = false) {
    const clean = this.sanitizeBbox(bbox);
    this.draftPolygon.set(null);
    this.regionBorderMultiPolygon.set(null);
    this.regionPolygon.set(bboxToPolygonRing(clean));
    this.regionBbox.set(clean);
    if (flyTo) {
      this.flyToBboxTrigger.update(v => v + 1);
    }
  }

  setDataset(dataset: ActiveFireDataset) {
    if (dataset === 'VIIRS' && !this.isViirsAvailable()) return;
    this.preferredDataset.set(dataset);
  }

  private syncDatasetForEndDate(prevEnd: string, nextEnd: string) {
    const wasAvail = !prevEnd || prevEnd >= VIIRS_FIRST_DATE;
    const isAvail = !nextEnd || nextEnd >= VIIRS_FIRST_DATE;
    if (!wasAvail && isAvail) {
      this.preferredDataset.set('VIIRS');
    }
  }

  setDateStart(start: string) {
    const prevEnd = this.dateEnd();
    if (!start) {
      this.dateStart.set('');
      this.draftDateStart.set('');
      return;
    }
    const end = this.dateEnd();
    if (end && start > end) {
      this.dateStart.set(end);
      this.dateEnd.set(start);
      this.draftDateStart.set(end);
      this.draftDateEnd.set(start);
      this.syncDatasetForEndDate(prevEnd, start);
    } else {
      this.dateStart.set(start);
      this.draftDateStart.set(start);
    }
  }

  setDateEnd(end: string) {
    const prevEnd = this.dateEnd();
    if (!end) {
      this.dateEnd.set('');
      this.draftDateEnd.set('');
      this.syncDatasetForEndDate(prevEnd, '');
      return;
    }
    const start = this.dateStart();
    if (start && end < start) {
      this.dateStart.set(end);
      this.dateEnd.set(start);
      this.draftDateStart.set(end);
      this.draftDateEnd.set(start);
      this.syncDatasetForEndDate(prevEnd, start);
    } else {
      this.dateEnd.set(end);
      this.draftDateEnd.set(end);
      this.syncDatasetForEndDate(prevEnd, end);
    }
  }

  setDateRange(start: string, end: string) {
    const prevEnd = this.dateEnd();
    if (!start || !end) {
      const nextStart = start || '';
      const nextEnd = end || '';
      this.dateStart.set(nextStart);
      this.dateEnd.set(nextEnd);
      this.draftDateStart.set(nextStart);
      this.draftDateEnd.set(nextEnd);
      this.syncDatasetForEndDate(prevEnd, nextEnd);
      return;
    }
    if (start <= end) {
      this.dateStart.set(start);
      this.dateEnd.set(end);
      this.draftDateStart.set(start);
      this.draftDateEnd.set(end);
      this.syncDatasetForEndDate(prevEnd, end);
    } else {
      this.dateStart.set(end);
      this.dateEnd.set(start);
      this.draftDateStart.set(end);
      this.draftDateEnd.set(start);
      this.syncDatasetForEndDate(prevEnd, start);
    }
  }

  setDraftDateStart(start: string) {
    this.draftDateStart.set(start || '');
  }

  setDraftDateEnd(end: string) {
    this.draftDateEnd.set(end || '');
  }

  previewCoordBox(bbox: BoundingBox): void {
    const clean = this.sanitizeBbox(bbox);
    this.draftPolygon.set(bboxToPolygonRing(clean));
  }

  toggleDrawBbox(mode: 'replace' | 'add' = 'replace') {
    if (this.isDrawingBbox()) {
      this.cancelDrawBoundingBox();
    } else {
      this.startDrawBoundingBox(mode);
    }
  }

  startDrawBoundingBox(mode: 'replace' | 'add' = 'replace') {
    this.drawBoxMode.set(mode);
    this.draftPolygon.set(null);
    const wasOpen = this.viewMode() === 'analytics' && !this.isAnalyticsMinimized();
    this.autoRestoreAfterDraw.set(wasOpen);
    if (wasOpen) {
      this.isAnalyticsMinimized.set(true);
    }
    this.isDrawingBbox.set(true);
  }

  cancelDrawBoundingBox() {
    this.isDrawingBbox.set(false);
    this.liveDrawBbox.set(null);
    this.draftPolygon.set(null);
    if (this.autoRestoreAfterDraw()) {
      this.isAnalyticsMinimized.set(false);
      this.autoRestoreAfterDraw.set(false);
    }
  }

  finishDrawBoundingBox(bbox: BoundingBox) {
    const clean = this.sanitizeBbox(bbox);
    this.liveDrawBbox.set(null);
    this.isDrawingBbox.set(false);
    this.draftPolygon.set(bboxToPolygonRing(clean));
    if (this.autoRestoreAfterDraw()) {
      this.isAnalyticsMinimized.set(false);
      this.autoRestoreAfterDraw.set(false);
    }
  }

  /** Split any edge of the active/draft polygon into two edges, adding a draggable vertex (4 -> 5 -> 6 -> N). */
  insertPolygonVertex(edgeIndex: number, lonLat: [number, number]): number | null {
    const base = this.draftPolygon() ?? this.regionPolygon();
    if (!base || base.length < 3) return null;
    const idx = ((edgeIndex % base.length) + base.length) % base.length;
    const next = base.map(p => [...p] as [number, number]);
    const insertAt = idx + 1;
    next.splice(insertAt, 0, this.clampLonLat(lonLat));
    this.draftPolygon.set(next);
    return insertAt;
  }

  updateDraftVertex(vertexIndex: number, lonLat: [number, number]): void {
    const base = this.draftPolygon() ?? this.regionPolygon();
    if (!base || vertexIndex < 0 || vertexIndex >= base.length) return;
    const next = base.map(p => [...p] as [number, number]);
    next[vertexIndex] = this.clampLonLat(lonLat);
    this.draftPolygon.set(next);
  }

  /** Commit any pending polygon/bbox or date-range edits and trigger calculation. */
  recalculateSelection(): void {
    if (!this.canRecalculate()) {
      this.missingInputsPrompt.set(true);
      this.isAnalyticsMinimized.set(false);
      this.showRegionForm.set(true);
      this.showDataSection.set(true);
      return;
    }
    this.missingInputsPrompt.set(false);
    const draft = this.draftPolygon();
    const hasDraftPoly = Boolean(draft && draft.length >= 3);
    const hasDateDiff = this.hasPendingDateChanges();

    const cleanPoly = draft && draft.length >= 3 ? draft.map(p => this.clampLonLat(p)) : null;
    const nextBbox = cleanPoly ? (this.computeRingEnvelope(cleanPoly) ?? this.regionBbox()) : this.regionBbox();
    const nextStart = hasDateDiff ? this.draftDateStart() : this.dateStart();
    const nextEnd = hasDateDiff ? this.draftDateEnd() : this.dateEnd();

    const commit = () => {
      if (cleanPoly && nextBbox) {
        this.regionBorderMultiPolygon.set(null);
        this.regionPolygon.set(cleanPoly);
        this.regionBbox.set(nextBbox);
        this.draftPolygon.set(null);
      }
      if (hasDateDiff) {
        this.setDateRange(nextStart, nextEnd);
      }
      this.isDrawingBbox.set(false);
      this.liveDrawBbox.set(null);
      if (this.autoRestoreAfterDraw()) {
        this.isAnalyticsMinimized.set(false);
        this.autoRestoreAfterDraw.set(false);
      }
    };

    if ((hasDraftPoly || hasDateDiff) && nextBbox) {
      this.confirmLargeSelection(nextBbox, nextStart, nextEnd, commit);
    } else {
      commit();
    }
  }

  private confirmLargeSelection(bbox: BoundingBox, dateStart: string, dateEnd: string, onContinue: () => void): void {
    if (this.data.isCustomDataset() || this.data.isDefaultCachedQuery(bbox, dateStart, dateEnd)) {
      onContinue();
      return;
    }
    const bboxAreaDeg2 = Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
    const startMs = Date.parse(`${dateStart}T00:00:00Z`);
    const endMs = Date.parse(`${dateEnd}T00:00:00Z`);
    const rangeDays =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.floor(Math.abs(endMs - startMs) / 86_400_000) + 1
        : 0;

    if (bboxAreaDeg2 < LARGE_BBOX_DEG2_THRESHOLD && rangeDays < HUGE_TIME_RANGE_DAYS_THRESHOLD) {
      onContinue();
      return;
    }

    this.popup.open({
      id: 'large-selection-notice',
      size: 'sm',
      title: computed(() => this.i18n.t().largeSelectionTitle),
      subtitle: computed(() => this.i18n.t().largeSelectionSubtitle),
      description: computed(() => this.i18n.t().largeSelectionDesc),
      actions: [
        {
          label: computed(() => this.i18n.t().largeSelectionCancelBtn),
          variant: 'default'
        },
        {
          label: computed(() => this.i18n.t().largeSelectionContinueBtn),
          variant: 'default',
          hot: true,
          onClick: onContinue
        }
      ]
    });
  }

  /** Commit the draft polygon and trigger calculation. */
  acceptDraftPolygon(): void {
    this.recalculateSelection();
  }

  selectDefaultIberia(): void {
    const poly = DEFAULT_PREFILL_POLYGON.map(([lon, lat]) => [lon, lat] as [number, number]);
    const bbox: BoundingBox = [...DEFAULT_PREFILL_BBOX];
    this.confirmAndApplyPredefinedRegion(poly, null, bbox);
  }

  selectPredefinedCountry(country: PredefinedCountry): void {
    const borderPolys = this.extractMainCountryPolygons(country);
    if (borderPolys.length > 0) {
      const bbox = this.computeMultiEnvelope(borderPolys) ?? this.sanitizeBbox(country.primaryBbox);
      this.confirmAndApplyPredefinedRegion(null, borderPolys, bbox);
      return;
    }
    const clean = this.sanitizeBbox(country.primaryBbox);
    this.confirmAndApplyPredefinedRegion(bboxToPolygonRing(clean), null, clean);
  }

  private confirmAndApplyPredefinedRegion(
    poly: PolygonRing | null,
    borderMulti: MultiPolygonCoords | null,
    bbox: BoundingBox
  ): void {
    const useDefaultDates = !this.hasValidDraftDates();
    const nextStart = useDefaultDates
      ? DEFAULT_PREFILL_DATES.start
      : this.hasPendingDateChanges()
        ? this.draftDateStart()
        : this.dateStart();
    const nextEnd = useDefaultDates
      ? DEFAULT_PREFILL_DATES.end
      : this.hasPendingDateChanges()
        ? this.draftDateEnd()
        : this.dateEnd();

    this.confirmLargeSelection(bbox, nextStart, nextEnd, () => {
      this.missingInputsPrompt.set(false);
      this.draftPolygon.set(null);
      this.isDrawingBbox.set(false);
      this.liveDrawBbox.set(null);
      this.regionBorderMultiPolygon.set(borderMulti);
      this.regionPolygon.set(poly);
      this.regionBbox.set(bbox);
      if (useDefaultDates || this.hasPendingDateChanges()) {
        this.setDateRange(nextStart, nextEnd);
      }
      this.requestFlyToBbox();
    });
  }

  private extractMainCountryPolygons(country: PredefinedCountry): MultiPolygonCoords {
    const polys = country.polygons ?? [];
    if (polys.length === 0) return [];
    const withBox = polys
      .filter(p => Array.isArray(p[0]) && p[0].length >= 4)
      .map(poly => {
        const env = this.computeRingEnvelope(poly[0]);
        const area = env ? (env[2] - env[0]) * (env[3] - env[1]) : 0;
        return { poly, env, area };
      })
      .filter((x): x is { poly: PolygonCoords; env: BoundingBox; area: number } => x.env !== null)
      .sort((a, b) => b.area - a.area);
    if (withBox.length === 0) return [];
    const main = withBox[0].env;
    // Keep mainland plus nearby coastal islands within 4 degrees, preserving exact border vertices
    return withBox
      .filter((item, idx) => {
        if (idx === 0) return true;
        const b = item.env;
        const dx = Math.max(0, main[0] - b[2], b[0] - main[2]);
        const dy = Math.max(0, main[1] - b[3], b[1] - main[3]);
        return Math.hypot(dx, dy) <= 4.0;
      })
      .map(item => item.poly);
  }

  private computeMultiEnvelope(multi: MultiPolygonCoords): BoundingBox | null {
    let minW = 180;
    let minS = 85;
    let maxE = -180;
    let maxN = -85;
    let count = 0;
    for (const poly of multi) {
      const outer = poly[0];
      if (!outer) continue;
      for (const [lon, lat] of outer) {
        if (lon < minW) minW = lon;
        if (lon > maxE) maxE = lon;
        if (lat < minS) minS = lat;
        if (lat > maxN) maxN = lat;
        count++;
      }
    }
    if (count < 3) return null;
    // Round outward to 0.01 deg so extreme coastal points (e.g. Swinoujscie) are never clipped
    return this.sanitizeBbox([
      Math.floor(minW * 100) / 100,
      Math.floor(minS * 100) / 100,
      Math.ceil(maxE * 100) / 100,
      Math.ceil(maxN * 100) / 100
    ]);
  }

  private computeRingEnvelope(ring: PolygonRing): BoundingBox | null {
    if (ring.length < 3) return null;
    let minW = 180;
    let minS = 85;
    let maxE = -180;
    let maxN = -85;
    for (const [lon, lat] of ring) {
      if (lon < minW) minW = lon;
      if (lon > maxE) maxE = lon;
      if (lat < minS) minS = lat;
      if (lat > maxN) maxN = lat;
    }
    return this.sanitizeBbox([
      Math.floor(minW * 100) / 100,
      Math.floor(minS * 100) / 100,
      Math.ceil(maxE * 100) / 100,
      Math.ceil(maxN * 100) / 100
    ]);
  }

  requestFlyToBbox() {
    if (this.regionBbox()) {
      this.flyToBboxTrigger.update(v => v + 1);
    }
  }

  resetRegionAndDates() {
    this.missingInputsPrompt.set(false);
    this.regionBbox.set(null);
    this.regionBorderMultiPolygon.set(null);
    this.regionPolygon.set(null);
    this.draftPolygon.set(null);
    this.liveDrawBbox.set(null);
    this.dateStart.set('');
    this.dateEnd.set('');
    this.draftDateStart.set('');
    this.draftDateEnd.set('');
  }

  resetDefaultLayers() {
    this.showHotspotsOnGlobe.set(true);
    this.showRegionBbox.set(true);
    this.showLandOrtho.set(true);
    this.showBorders.set(true);
    this.showUserLocation.set(false);
    this.colorRamp.set('ylOrRd');
  }

  /**
   * Toggle the user-location pin layer. Enabling it triggers the browser's native geolocation
   * permission prompt directly and displays a pin once coordinates are granted.
   */
  setUserLocationEnabled(enabled: boolean): void {
    if (!enabled) {
      this.showUserLocation.set(false);
      return;
    }

    this.requestBrowserGeolocation();
  }

  private requestBrowserGeolocation(): void {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.showLocationUnavailablePopup();
      return;
    }

    navigator.geolocation.getCurrentPosition(
      pos => {
        this.ngZone.run(() => {
          this.userLocation.set({
            lon: pos.coords.longitude,
            lat: pos.coords.latitude
          });
          this.showUserLocation.set(true);
        });
      },
      () => {
        this.ngZone.run(() => {
          this.showUserLocation.set(false);
          this.showLocationUnavailablePopup();
        });
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  private showLocationUnavailablePopup(): void {
    this.popup.open({
      id: 'user-location-error',
      size: 'sm',
      title: computed(() => this.i18n.t().locationErrorTitle),
      description: computed(() => this.i18n.t().locationErrorDesc),
      actions: [
        {
          label: computed(() => this.i18n.t().locationErrorOkBtn),
          variant: 'default',
          hot: true
        }
      ]
    });
  }
}
