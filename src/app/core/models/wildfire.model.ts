export type WildfireViewMode = 'analytics' | 'inertia' | 'spread' | 'evacuation';
export type MapRenderMode = '2d' | 'globe';
export type WindScenarioId = 'actual' | 'atlanticSurge' | 'levanteReversal' | 'elNinoDroughtBoost';
export type CameraFocusId = 'iberia' | 'northAtlantic' | 'pacificEnso';
export type SstDisplayMode = 'ortho' | 'anomaly' | 'sst';
export type BoundingBox = [number, number, number, number]; // [westLon, southLat, eastLon, northLat]
export type PolygonRing = [number, number][]; // [[lon, lat], ...]
export type PolygonCoords = PolygonRing[]; // [outerRing, ...holeRings]
export type MultiPolygonCoords = PolygonCoords[]; // GeoJSON MultiPolygon coordinates

export interface PredefinedCountry {
  code: string; // ISO-3 (e.g. 'ESP', 'PRT', 'FRA')
  iso2?: string; // Optional ISO-2 for Intl.DisplayNames
  name: string; // Default English name from Natural Earth
  bboxes: BoundingBox[]; // Tight component bounding boxes
  primaryBbox: BoundingBox; // Primary mainland/cluster bounding box
  polygons: MultiPolygonCoords; // Exact country MultiPolygon rings
  center: [number, number];
}
export type ColorRampId = 'okabeIto' | 'cividis' | 'viridis' | 'ylOrRd';
export type HotspotSensor = 'MODIS' | 'VIIRS' | 'HARMONIZED';
export type ActiveFireDataset = 'VIIRS' | 'MODIS';
export type CalendarGranularity = 'daily' | 'monthly';

export interface HarmonizedHotspotRecord {
  id: string;
  date: string; // YYYY-MM-DD
  lon: number;
  lat: number;
  frpMw: number;
  confidence: number;
  sensor: HotspotSensor;
  rawModisCount: number;
  rawViirsCount: number;
  harmonizedCount: number;
  biome: string;
  regionName?: string;
}

export interface HarmonizedHotspotsPayload {
  metadata: {
    title: string;
    years: [number, number];
    source: string;
    harmonizationMethod: string;
  };
  records: HarmonizedHotspotRecord[];
}

export interface BurningCalendarCell {
  key: string;
  label: string;
  row: number; // month 0..11 (daily) or year index (monthly)
  col: number; // day 0..30 (daily) or month 0..11 (monthly)
  harmonizedCount: number;
  rawModisCount: number;
  rawViirsCount: number;
  frpMw: number;
  multiYearAvg: number;
  anomalyZScore: number;
  intensity: number; // 0..1 normalized
  inRange: boolean;
}

export interface YearlyComparisonPoint {
  year: number;
  rawModisCount: number;
  rawViirsCount: number;
  harmonizedCount: number;
  frpMw: number;
  multiYearAvgCount: number;
  anomalyPct: number;
  anomalyZScore: number;
  inSelectedRange: boolean;
}

export interface HotspotAnalyticsSummary {
  totalRecords: number;
  harmonizedFires: number;
  rawModisFires: number;
  rawViirsFires: number;
  totalFrpMw: number;
  meanFrpMw: number;
  activeFireDays: number;
  peakDate: string | null;
  peakCount: number;
  multiYearAvgFires: number;
  anomalyPct: number;
  anomalyZScore: number;
  areaKm2: number;
  areaHa: number;
  activeDataset: ActiveFireDataset;
  activeDatasetFires: number;
}

export interface WildfireAoi {
  aoiId: string;
  name: string;
  year: number;
  country: string;
  ignitionLat: number;
  ignitionLon: number;
  bbox: [number, number, number, number];
  burnedAreaHa: number;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

export interface AoiTimelineStep {
  index: number;
  date: string;      // YYYY-MM-DD
  yearMonth: string; // YYYY-MM
  phase: 'preFire' | 'activeFire';
  monthsRelative: number;
  elNinoOni: number;
  gulfStreamSstAnomalyC: number;
  sstMonth: number;  // 0..11.99 for globe SST texture
}

export interface IberianHotspot {
  id: string;
  name: string;
  lon: number;
  lat: number;
  biome: string;
  baseFrp: number;
}

export interface AnnualCalendarPoint {
  year: number;
  rawModisCount: number;
  rawViirsCount: number;
  harmonizedCount: number;
  harmonizedFrpMw: number;
  anomalyZScore: number;
  regime: 'BASELINE' | 'FUEL_ACCUMULATION_WATCH' | 'OCEAN_INERTIA_ALERT' | 'EXTREME_TAIL_ANOMALY';
  ndviAnomaly: number;
  gulfStreamSstAnomalyC: number;
  elNinoOni: number;
}

export interface CalendarSummaryData {
  metadata: {
    region: string;
    bbox: [number, number, number, number];
    h3Resolution: number;
    years: [number, number];
    license: string;
  };
  hotspots: IberianHotspot[];
  annualSeries: AnnualCalendarPoint[];
}

export interface LagCorrelationPoint {
  lagMonths: number;
  gulfStreamSstCorr: number;
  elNinoOniCorr: number;
  naoCorr: number;
}

export interface ClimateInertiaData {
  optimalLagMonths: number;
  lagCorrelations: LagCorrelationPoint[];
  summary: {
    gulfStreamPeakCorr: number;
    elNinoPeakCorr: number;
    naoWinterSwitchCorr: number;
  };
}

export interface ChokePoint {
  id: string;
  name: string;
  lon: number;
  lat: number;
  widthM: number;
  riskScore: number;
  type: 'fuelBreak' | 'deforestation';
}

export interface SpreadCell {
  id: string;
  lon: number;
  lat: number;
  state: 'BURNING' | 'IGNITING';
  frp: number;
  slopeDeg: number;
  scenarios: Record<WindScenarioId, number>;
}

export interface SpreadFrame {
  hourOffset: number;
  timestamp: string;
  synopticSummary: {
    windSpeedKmh: number;
    windDirDeg: number;
    windShear3hDeg: number;
    tempC: number;
  };
  cells: SpreadCell[];
}

export interface MlSpreadFramesData {
  event: {
    id: string;
    name: string;
    center: [number, number];
    h3Resolution: number;
    metrics: { rocAuc: number; prAuc: number; brierScore: number };
  };
  chokePoints: ChokePoint[];
  frames: SpreadFrame[];
}

export interface EvacuationZone {
  id: string;
  name: string;
  lon: number;
  lat: number;
  radiusDeg: number;
  populationBase: number;
  riskLevel: 'critical' | 'high' | 'elevated';
}

export interface EscapeRoad {
  id: string;
  name: string;
  coords: [number, number][];
}

export interface EvacuationData {
  zones: EvacuationZone[];
  escapeRoads: EscapeRoad[];
}

export type BackendSyncStatus = 'idle' | 'loading' | 'downloading' | 'live' | 'offline' | 'error';

export interface BackendDownloadProgress {
  done: number;
  total: number;
}

export interface BackendH3Cell {
  h3: string;
  lon: number;
  lat: number;
  harmonized: number;
  rawModis: number;
  rawViirs: number;
}

export interface BackendPixelDetection {
  lon: number;
  lat: number;
  sensor: ActiveFireDataset;
  count: number;
  frpMw: number;
}

export interface BackendYearlyRow {
  year: number;
  rawModis: number;
  rawViirs: number;
  harmonized: number;
  frpMw?: number;
  monthsWithData: number;
}

export interface BackendDailyBucket {
  mmdd: string; // MM-DD
  harmonized: number;
  rawModis: number;
  rawViirs: number;
  frpMw: number;
  baselineAvg: number;
}

export interface BackendCalendarPayload {
  metadata: {
    bbox: BoundingBox;
    cachedRegion: BoundingBox;
    h3Resolution: number;
    months: [string, string];
    dataThrough: string;
    monthInProgress: string | null;
    refreshing: boolean;
    failedChunks: number;
    metric: string;
    unit: string;
    license: string;
    attribution: string;
  };
  months: string[];
  series: {
    rawModis: (number | null)[];
    rawViirs: (number | null)[];
    naiveSum: (number | null)[];
    harmonized: (number | null)[];
    harmonizedLo90: (number | null)[];
    harmonizedHi90: (number | null)[];
    anomalyZ: (number | null)[];
    percentile: (number | null)[];
  };
  calendar: {
    years: number[];
    harmonized: (number | null)[][];
  };
  climatology: {
    monthMean: (number | null)[];
    monthStd: (number | null)[];
  };
  yearly: BackendYearlyRow[];
  selection: {
    from: string;
    to: string;
    hotspots: {
      harmonized: number;
      rawModis: number;
      rawViirs: number;
    };
    frp?: {
      totalMw: number;
      meanMw: number;
      activeFireDays: number;
      peakDate: string | null;
      peakCount: number;
    };
    daily?: BackendDailyBucket[];
    comparedWithSameMonthsInOtherYears: {
      years: number;
      median: number | null;
      percentile: number | null;
      rank: number | null;
      top5: { year: number; harmonized: number }[];
    };
    cells: BackendH3Cell[];
    pixels?: BackendPixelDetection[];
  };
  validation: Record<string, unknown> | null;
}
