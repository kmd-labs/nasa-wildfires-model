import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  BoundingBox,
  CalendarGranularity,
  CameraFocusId,
  ColorRampId,
  MultiPolygonCoords,
  PolygonCoords,
  PolygonRing,
  WildfireViewMode
} from '../models/wildfire.model';
import { WildfireDataService } from './wildfire-data.service';

const COLOR_RAMP_STORAGE_KEY = 'nasa-wildfires-model.colorRamp';
const BBOX_STORAGE_KEY = 'nasa-wildfires-model.bbox';
const DATE_START_STORAGE_KEY = 'nasa-wildfires-model.dateStart';
const DATE_END_STORAGE_KEY = 'nasa-wildfires-model.dateEnd';
const UI_STORAGE_KEY = 'nasa-wildfires-model.ui';

const VALID_COLOR_RAMPS = new Set<ColorRampId>(['okabeIto', 'cividis', 'viridis', 'ylOrRd']);
const VALID_CALENDAR_MODES = new Set<CalendarGranularity>(['daily', 'monthly']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function bboxToPolygonCoords(bbox: BoundingBox): PolygonCoords {
  const [w, s, e, n] = bbox;
  return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
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
  analyticsMinimized: boolean;
  analyticsExpanded: boolean;
  showRegionForm: boolean;
  showCoordsInputs: boolean;
  showLayersSection: boolean;
  showAnalysisSection: boolean;
  showHotspotsOnGlobe: boolean;
  showRegionBbox: boolean;
  calendarGranularity: CalendarGranularity;
}

const DEFAULT_UI_SETTINGS: StoredUiSettings = {
  analyticsMinimized: false,
  analyticsExpanded: false,
  showRegionForm: true,
  showCoordsInputs: true,
  showLayersSection: true,
  showAnalysisSection: true,
  showHotspotsOnGlobe: true,
  showRegionBbox: true,
  calendarGranularity: 'daily'
};

@Injectable({
  providedIn: 'root'
})
export class WildfireStateService {
  private readonly data = inject(WildfireDataService);

  private readonly initialDates = this.resolveInitialDateRange();
  private readonly initialUi = this.resolveInitialUiSettings();

  readonly viewMode = signal<WildfireViewMode>('analytics');
  readonly cameraFocus = signal<CameraFocusId>('iberia');
  readonly cameraTargetLonLat = signal<[number, number]>([0, 22]);

  /** Single bounding box [west, south, east, north] in EPSG:4326, or null before user defines one. */
  readonly regionBbox = signal<BoundingBox | null>(this.resolveInitialBbox());

  readonly regionBboxes = computed<BoundingBox[]>(() => {
    const b = this.regionBbox();
    return b ? [b] : [];
  });

  readonly regionMultiPolygon = computed<MultiPolygonCoords>(() => {
    const b = this.regionBbox();
    return b ? [bboxToPolygonCoords(b)] : [];
  });

  readonly dateStart = signal<string>(this.initialDates.start);
  readonly dateEnd = signal<string>(this.initialDates.end);

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
  readonly showCoordsInputs = signal<boolean>(this.initialUi.showCoordsInputs);
  readonly showLayersSection = signal<boolean>(this.initialUi.showLayersSection);
  readonly showAnalysisSection = signal<boolean>(this.initialUi.showAnalysisSection);
  readonly autoRestoreAfterDraw = signal<boolean>(false);

  readonly colorRamp = signal<ColorRampId>(this.resolveInitialColorRamp());
  readonly showHotspotsOnGlobe = signal<boolean>(this.initialUi.showHotspotsOnGlobe);
  readonly showRegionBbox = signal<boolean>(this.initialUi.showRegionBbox);
  readonly activeTileZoom = signal<number>(3);
  readonly calendarGranularity = signal<CalendarGranularity>(this.initialUi.calendarGranularity);
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
      const start = this.dateStart();
      const end = this.dateEnd();
      const ui: StoredUiSettings = {
        analyticsMinimized: this.isAnalyticsMinimized(),
        analyticsExpanded: this.isAnalyticsExpanded(),
        showRegionForm: this.showRegionForm(),
        showCoordsInputs: this.showCoordsInputs(),
        showLayersSection: this.showLayersSection(),
        showAnalysisSection: this.showAnalysisSection(),
        showHotspotsOnGlobe: this.showHotspotsOnGlobe(),
        showRegionBbox: this.showRegionBbox(),
        calendarGranularity: this.calendarGranularity()
      };
      try {
        localStorage.setItem(COLOR_RAMP_STORAGE_KEY, ramp);
        if (bbox) {
          localStorage.setItem(BBOX_STORAGE_KEY, JSON.stringify(bbox));
        } else {
          localStorage.removeItem(BBOX_STORAGE_KEY);
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

  private resolveInitialUiSettings(): StoredUiSettings {
    try {
      const raw = localStorage.getItem(UI_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredUiSettings> | null;
        if (parsed && typeof parsed === 'object') {
          return {
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
            calendarGranularity:
              parsed.calendarGranularity && VALID_CALENDAR_MODES.has(parsed.calendarGranularity)
                ? parsed.calendarGranularity
                : DEFAULT_UI_SETTINGS.calendarGranularity
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
    return 'okabeIto';
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
    return null;
  }

  private resolveInitialDateRange(): { start: string; end: string } {
    try {
      const rawStart = localStorage.getItem(DATE_START_STORAGE_KEY) ?? '';
      const rawEnd = localStorage.getItem(DATE_END_STORAGE_KEY) ?? '';
      const startOk = ISO_DATE_RE.test(rawStart) && !Number.isNaN(Date.parse(`${rawStart}T00:00:00Z`));
      const endOk = ISO_DATE_RE.test(rawEnd) && !Number.isNaN(Date.parse(`${rawEnd}T00:00:00Z`));
      const start = startOk ? rawStart : '';
      const end = endOk ? rawEnd : '';
      if (start && end && start > end) {
        return { start: end, end: start };
      }
      return { start, end };
    } catch {
      // localStorage unavailable
    }
    return { start: '', end: '' };
  }

  isPointInRegion(lon: number, lat: number): boolean {
    const b = this.regionBbox();
    if (!b) return false;
    return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
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
    this.regionBbox.set(this.sanitizeBbox(bbox));
    if (flyTo) {
      this.flyToBboxTrigger.update(v => v + 1);
    }
  }

  setDateStart(start: string) {
    if (!start) {
      this.dateStart.set('');
      return;
    }
    const end = this.dateEnd();
    if (end && start > end) {
      this.dateStart.set(end);
      this.dateEnd.set(start);
    } else {
      this.dateStart.set(start);
    }
  }

  setDateEnd(end: string) {
    if (!end) {
      this.dateEnd.set('');
      return;
    }
    const start = this.dateStart();
    if (start && end < start) {
      this.dateStart.set(end);
      this.dateEnd.set(start);
    } else {
      this.dateEnd.set(end);
    }
  }

  setDateRange(start: string, end: string) {
    if (!start || !end) {
      this.dateStart.set(start || '');
      this.dateEnd.set(end || '');
      return;
    }
    if (start <= end) {
      this.dateStart.set(start);
      this.dateEnd.set(end);
    } else {
      this.dateStart.set(end);
      this.dateEnd.set(start);
    }
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
    if (this.autoRestoreAfterDraw()) {
      this.isAnalyticsMinimized.set(false);
      this.autoRestoreAfterDraw.set(false);
    }
  }

  finishDrawBoundingBox(bbox: BoundingBox) {
    this.liveDrawBbox.set(null);
    this.isDrawingBbox.set(false);
    this.setCustomBbox(bbox, false);
    if (this.autoRestoreAfterDraw()) {
      this.isAnalyticsMinimized.set(false);
      this.autoRestoreAfterDraw.set(false);
    }
  }

  requestFlyToBbox() {
    if (this.regionBbox()) {
      this.flyToBboxTrigger.update(v => v + 1);
    }
  }

  resetRegionAndDates() {
    this.regionBbox.set(null);
    this.dateStart.set('');
    this.dateEnd.set('');
  }

  resetDefaultLayers() {
    this.showHotspotsOnGlobe.set(true);
    this.showRegionBbox.set(true);
  }
}
