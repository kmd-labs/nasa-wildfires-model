import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AoiTimelineStep,
  BoundingBox,
  CalendarGranularity,
  CameraFocusId,
  ColorRampId,
  SstDisplayMode,
  WildfireViewMode,
  WindScenarioId
} from '../models/wildfire.model';
import { WildfireDataService } from './wildfire-data.service';

export const IBERIA_DEFAULT_BBOX: BoundingBox = [-9.6, 36.0, 3.4, 43.8];
export const DEFAULT_DATE_START = '2016-01-01';
export const DEFAULT_DATE_END = '2026-12-31';

const SCENARIO_MULTIPLIERS: Record<WindScenarioId, number> = {
  actual: 1.0,
  atlanticSurge: 1.48,
  levanteReversal: 1.24,
  elNinoDroughtBoost: 1.65
};

const SCENARIO_WIND_OFFSET_DEG: Record<WindScenarioId, number> = {
  actual: 0,
  atlanticSurge: 42,
  levanteReversal: -145,
  elNinoDroughtBoost: 18
};

const SCENARIO_SPEED_MULT: Record<WindScenarioId, number> = {
  actual: 1.0,
  atlanticSurge: 1.75,
  levanteReversal: 1.35,
  elNinoDroughtBoost: 1.2
};

@Injectable({
  providedIn: 'root'
})
export class WildfireStateService {
  private readonly data = inject(WildfireDataService);

  readonly viewMode = signal<WildfireViewMode>('analytics');
  readonly cameraFocus = signal<CameraFocusId>('iberia');
  readonly sstMode = signal<SstDisplayMode>('ortho');

  readonly selectedAoiId = signal<string>('iberia_all');
  readonly regionBbox = signal<BoundingBox>([...IBERIA_DEFAULT_BBOX]);
  readonly dateStart = signal<string>(DEFAULT_DATE_START);
  readonly dateEnd = signal<string>(DEFAULT_DATE_END);

  readonly isDrawingBbox = signal<boolean>(false);
  readonly liveDrawBbox = signal<BoundingBox | null>(null);
  readonly flyToBboxTrigger = signal<number>(0);
  readonly isAnalyticsMinimized = signal<boolean>(false);
  readonly autoRestoreAfterDraw = signal<boolean>(false);

  readonly colorRamp = signal<ColorRampId>('okabeIto');
  readonly showHotspotsOnGlobe = signal<boolean>(true);
  readonly showRegionBbox = signal<boolean>(true);
  readonly showLandOrtho = signal<boolean>(true);
  readonly showOsmTiles = signal<boolean>(false);
  readonly showForests = signal<boolean>(true);
  readonly activeTileZoom = signal<number>(5);
  readonly showUrbanAreas = signal<boolean>(true);
  readonly showBorders = signal<boolean>(true);
  readonly showRoads = signal<boolean>(true);
  readonly showGraticule = signal<boolean>(true);
  readonly calendarGranularity = signal<CalendarGranularity>('monthly');

  readonly isLayersOpen = signal<boolean>(false);

  readonly timelineIndex = signal<number>(25);

  readonly harmonizedMode = signal<boolean>(true);
  readonly windScenario = signal<WindScenarioId>('actual');

  readonly showWindStreamlines = signal<boolean>(false);
  readonly showEscapeRoads = signal<boolean>(false);

  readonly frameIndex = signal<number>(5); // 0..11 for hourly spread/evacuation frames
  readonly playing = signal<boolean>(false);
  readonly mapLoaded = signal<boolean>(false);

  readonly selectedAoi = computed(() => {
    const id = this.selectedAoiId();
    const list = this.data.aois();
    if (id === 'iberia_all' || id === 'custom') {
      return list[0];
    }
    return list.find(a => a.aoiId === id) ?? list[0];
  });

  readonly bboxCenter = computed<[number, number]>(() => {
    const [w, s, e, n] = this.regionBbox();
    return [(w + e) / 2, (s + n) / 2];
  });

  /**
   * Builds a weekly timeline from 6 months before wildfire start up to the end of the wildfire,
   * enriched with El Niño (ONI) and Gulf Stream SST anomaly data.
   */
  readonly aoiTimeline = computed<AoiTimelineStep[]>(() => {
    const aoi = this.selectedAoi();
    if (!aoi) return [];

    // Trigger dependency on data.isLoaded so ONI/meta maps are populated
    this.data.isLoaded();

    const startMs = Date.parse(`${aoi.startDate}T00:00:00Z`);
    const endMs = Date.parse(`${aoi.endDate}T00:00:00Z`);
    const preStart = new Date(startMs);
    preStart.setUTCMonth(preStart.getUTCMonth() - 6);
    const preStartMs = preStart.getTime();

    const weekMs = 7 * 24 * 3600 * 1000;
    const steps: AoiTimelineStep[] = [];
    let idx = 0;

    for (let t = preStartMs; t <= endMs; t += weekMs) {
      const d = new Date(t);
      const iso = d.toISOString().slice(0, 10);
      const ym = iso.slice(0, 7);
      const monthsRel = Number(((t - startMs) / (30.4375 * 24 * 3600 * 1000)).toFixed(1));
      const sstMonth = d.getUTCMonth() + d.getUTCDate() / 31;

      steps.push({
        index: idx++,
        date: iso,
        yearMonth: ym,
        phase: t < startMs ? 'preFire' : 'activeFire',
        monthsRelative: monthsRel,
        elNinoOni: this.data.getEnsoOni(ym),
        gulfStreamSstAnomalyC: this.data.getGulfStreamAnomaly(ym),
        sstMonth
      });
    }

    // Ensure the exact wildfire end date is the final step
    const last = steps[steps.length - 1];
    if (!last || last.date !== aoi.endDate) {
      const d = new Date(endMs);
      const ym = aoi.endDate.slice(0, 7);
      steps.push({
        index: idx,
        date: aoi.endDate,
        yearMonth: ym,
        phase: 'activeFire',
        monthsRelative: Number(((endMs - startMs) / (30.4375 * 24 * 3600 * 1000)).toFixed(1)),
        elNinoOni: this.data.getEnsoOni(ym),
        gulfStreamSstAnomalyC: this.data.getGulfStreamAnomaly(ym),
        sstMonth: d.getUTCMonth() + d.getUTCDate() / 31
      });
    }

    return steps;
  });

  readonly currentTimelineStep = computed<AoiTimelineStep | null>(() => {
    const steps = this.aoiTimeline();
    if (steps.length === 0) return null;
    const idx = Math.max(0, Math.min(steps.length - 1, Math.round(this.timelineIndex())));
    return steps[idx];
  });

  /** Maps the active slider position onto 0..11.99 for the global SST/Anomaly texture */
  readonly sstMonth = computed(() => {
    if (this.viewMode() === 'inertia') {
      return this.currentTimelineStep()?.sstMonth ?? 7.5;
    }
    return 6.5 + (this.frameIndex() / 11) * 1.5;
  });

  readonly currentSpreadFrame = computed(() => {
    const frames = this.data.spreadFrames()?.frames;
    if (!frames || frames.length === 0) return null;
    const idx = Math.max(0, Math.min(frames.length - 1, Math.round(this.frameIndex())));
    return frames[idx];
  });

  readonly effectiveWindDirDeg = computed(() => {
    const base = this.currentSpreadFrame()?.synopticSummary.windDirDeg ?? 245;
    const offset = SCENARIO_WIND_OFFSET_DEG[this.windScenario()];
    return ((base + offset) % 360 + 360) % 360;
  });

  readonly effectiveWindSpeedKmh = computed(() => {
    const base = this.currentSpreadFrame()?.synopticSummary.windSpeedKmh ?? 38;
    return Number((base * SCENARIO_SPEED_MULT[this.windScenario()]).toFixed(1));
  });

  readonly burningCellCount = computed(() => {
    const frame = this.currentSpreadFrame();
    if (!frame) return 0;
    const scenario = this.windScenario();
    return frame.cells.filter(c => c.scenarios[scenario] >= 0.45).length;
  });

  readonly affectedPopulation = computed(() => {
    const zones = this.data.evacuation()?.zones ?? [];
    const basePop = zones.reduce((sum, z) => sum + z.populationBase, 0);
    const frameProgress = 0.45 + (this.frameIndex() / 11) * 0.55;
    const mult = SCENARIO_MULTIPLIERS[this.windScenario()];
    return Math.round(basePop * frameProgress * mult);
  });

  selectAoi(aoiId: string) {
    this.selectedAoiId.set(aoiId);
    this.isDrawingBbox.set(false);
    this.cameraFocus.set('iberia');

    if (aoiId === 'iberia_all') {
      this.regionBbox.set([...IBERIA_DEFAULT_BBOX]);
      this.dateStart.set('2000-01-01');
      this.dateEnd.set('2026-12-31');
      this.flyToBboxTrigger.update(n => n + 1);
      return;
    }

    if (aoiId === 'custom') {
      this.flyToBboxTrigger.update(n => n + 1);
      return;
    }

    const aoi = this.data.aois().find(a => a.aoiId === aoiId);
    if (aoi) {
      this.regionBbox.set([...aoi.bbox]);
      this.dateStart.set(aoi.startDate);
      this.dateEnd.set(aoi.endDate);
      this.flyToBboxTrigger.update(n => n + 1);
    }

    const steps = this.aoiTimeline();
    const ignitionIdx = steps.findIndex(s => s.phase === 'activeFire');
    this.timelineIndex.set(ignitionIdx >= 0 ? ignitionIdx : Math.max(0, steps.length - 1));
  }

  setCustomBbox(bbox: BoundingBox, flyTo = false) {
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
    this.regionBbox.set([w, s, e, n]);
    this.selectedAoiId.set('custom');
    if (flyTo) {
      this.flyToBboxTrigger.update(v => v + 1);
    }
  }

  setDateRange(start: string, end: string) {
    if (!start || !end) return;
    if (start <= end) {
      this.dateStart.set(start);
      this.dateEnd.set(end);
    } else {
      this.dateStart.set(end);
      this.dateEnd.set(start);
    }
  }

  toggleDrawBbox() {
    if (this.isDrawingBbox()) {
      this.cancelDrawBoundingBox();
    } else {
      this.startDrawBoundingBox();
    }
  }

  startDrawBoundingBox() {
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

  focusOnBbox() {
    this.cameraFocus.set('iberia');
    this.flyToBboxTrigger.update(v => v + 1);
  }

  resetRegionAndDates() {
    this.selectAoi('iberia_all');
  }

  setViewMode(mode: WildfireViewMode) {
    this.viewMode.set(mode);
    this.showWindStreamlines.set(mode === 'spread');
    this.showEscapeRoads.set(mode === 'evacuation');
    if (mode === 'inertia' && this.sstMode() === 'ortho') {
      this.sstMode.set('sst');
    } else if (mode === 'analytics') {
      this.sstMode.set('ortho');
    }
    if (mode === 'spread' || mode === 'evacuation') {
      this.cameraFocus.set('iberia');
    }
  }

  cycleSurfaceMode() {
    const cur = this.sstMode();
    if (cur === 'ortho') this.sstMode.set('sst');
    else if (cur === 'sst') this.sstMode.set('anomaly');
    else this.sstMode.set('ortho');
  }

  toggleLayersPanel() {
    this.isLayersOpen.update(open => !open);
  }

  resetDefaultLayers() {
    const view = this.viewMode();
    this.showHotspotsOnGlobe.set(true);
    this.showRegionBbox.set(true);
    this.showLandOrtho.set(true);
    this.showOsmTiles.set(false);
    this.showForests.set(true);
    this.showUrbanAreas.set(true);
    this.showBorders.set(true);
    this.showRoads.set(true);
    this.showGraticule.set(true);
    this.showWindStreamlines.set(view === 'spread');
    this.showEscapeRoads.set(view === 'evacuation');
  }

  togglePlay() {
    this.playing.update(p => !p);
  }
}
