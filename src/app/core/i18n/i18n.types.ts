export type Lang = 'en' | 'pl';
export type DateFormatPref = 'auto' | 'dmy-dot' | 'dmy-slash' | 'mdy-slash' | 'iso';
export type AreaUnitPref = 'auto' | 'km2' | 'm2' | 'ha' | 'mi2';

export interface DataSourceItem {
  name: string;
  url: string;
  license: string;
  desc: string;
}

/**
 * Every user-facing text of the application in one language.
 * Add new translation keys here first so TypeScript enforces parity across en.ts and pl.ts.
 */
export interface Dict {
  htmlLang: string;
  locale: string;
  docTitle: string;
  appName: string;

  // Top HUD & Navigation
  changeLanguage: string;
  settingsTitle: string;
  settingsAria: string;
  dateFormatLabel: string;
  dateFormatAuto: string;
  areaUnitLabel: string;
  areaUnitAuto: string;
  areaUnitKm2: string;
  areaUnitM2: string;
  areaUnitHa: string;
  areaUnitMi2: string;
  chooseView: string;
  mapMode2d: string;
  mapModeGlobe: string;

  // Bottom Dock & Controls
  play: string;
  glossary: string;
  glossaryTitle: string;
  close: string;

  // Layer & Mode Toggles
  sensorRaw: string;

  // Glossary & Legal Attribution Popup
  glossaryIntro: string;
  glossaryTermHotspotTitle: string;
  glossaryTermHotspotDesc: string;
  glossaryTermHarmonizationTitle: string;
  glossaryTermHarmonizationDesc: string;
  glossaryTermSmallFiresTitle: string;
  glossaryTermSmallFiresDesc: string;
  glossaryTermIntervalTitle: string;
  glossaryTermIntervalDesc: string;
  glossaryTermAnomalyTitle: string;
  glossaryTermAnomalyDesc: string;
  legalTitle: string;
  legalNasa: string;
  legalGibs: string;
  reportAttribution: string;
  legalNaturalEarth: string;
  legalOsm: string;

  // Data Sources Popup
  sourcesBtn: string;
  sourcesTitle: string;
  sourcesList: DataSourceItem[];

  // Region BBox, Draw Mode & Date Range Controls
  regionIberiaAll: string;
  regionMultiPolygon: string;
  regionBboxLabel: string;
  drawBboxBtn: string;
  drawBboxActiveHint: string;
  acceptAndCalculateBtn: string;
  recalculatePrompt: string;
  recalculateBtn: string;
  draftPendingDesc: string;
  datasetLabel: string;
  datasetViirsBtn: string;
  datasetModisBtn: string;
  datasetBothBtn: string;
  datasetViirsDesc: string;
  datasetModisDesc: string;
  datasetBothDesc: string;
  viirsUnavailableTooltip: string;
  bothSensorsRequiredTooltip: string;
  searchAreasPlaceholder: string;
  searchNoResults: string;
  predefinedAreasLabel: string;
  regionIberiaDefault: string;
  cachedBadgeLabel: string;
  groupCountries: string;
  coordsTitle: string;
  dataSectionTitle: string;
  coordWest: string;
  coordSouth: string;
  coordEast: string;
  coordNorth: string;
  resetRegion: string;
  dateRangeLabel: string;
  dateStartLabel: string;
  dateEndLabel: string;

  // Accessible Color Ramps
  colorRampLabel: string;
  rampOkabeIto: string;
  rampCividis: string;
  rampViridis: string;
  rampYlOrRd: string;

  // Analytics & Burning Calendar Dashboard
  analyticsTitle: string;
  analysisSectionTitle: string;
  emptyAnalysisTitle: string;
  emptyAnalysisDesc: string;
  emptyStepBbox: string;
  emptyStepDates: string;
  emptyStatusReady: string;
  emptyStatusPending: string;
  clearSelectionBtn: string;
  applyCoordsError: string;
  missingInputsHint: string;
  globeAltEmpty: string;
  globeAltLoading: string;
  globeAltActive: string;
  globeAreaUnknown: string;
  analyticsExpand: string;
  analyticsCollapse: string;
  analyticsMinimize: string;
  analyticsShowPanel: string;
  kpiHarmonizedFires: string;
  kpiRawSensors: string;
  kpiMultiYearAnomaly: string;
  kpiVsBaseline: string;
  kpiAnomalyNoHistory: string;
  kpiAnomalyNoHistoryHint: string;
  kpiTotalFrp: string;
  kpiMeanFrp: string;
  kpiTotalFrpHint: string;
  kpiPeakDateHint: string;
  kpiPeakDate: string;
  kpiActiveDays: string;
  burningCalendarTitle: string;
  calendarMonthly: string;
  calendarDaily: string;
  calendarNoData: string;
  calendarHoverPlaceholder: string;
  calendarLow: string;
  calendarHigh: string;
  historicalFiresTitle: string;
  historicalFiresSubtitle: string;
  chartMonthly: string;
  chartYearly: string;
  monthNamesShort: readonly string[];
  legendHarmonized: string;
  legendRawModis: string;
  legendMultiYearAvg: string;
  legendInterval90: string;
  kpiOfMedian: string;
  kpiYearsShort: string;
  kpiMedianHint: string;
  normalWithin: string;
  normalAbove: string;
  normalBelow: string;
  normalOutside: string;
  otherYearsMedianLabel: string;
  legendSmallFires: string;
  legendSmallFiresHint: string;
  calendarOtherYearsAvg: string;
  chartViirsStartMarker: string;
  perMonthShort: string;
  perYearShort: string;
  chartNoData: string;
  anomalyChartTitle: string;
  anomalyChartSubtitle: string;
  anomalyAboveAvg: string;
  anomalyBelowAvg: string;

  // Data Input & Downloads
  activeDatasetLabel: string;
  defaultDatasetName: string;
  downloadTitle: string;
  exportBtn: string;
  exportPopupTitle: string;
  downloadCsvBtn: string;
  csvExportWorking: string;
  csvExportError: string;
  downloadJsonBtn: string;
  downloadSvgBtn: string;
  downloadPngBtn: string;
  recordsCountLabel: string;
  backendLiveLabel: string;
  backendCachedLabel: string;
  backendCachedTooltip: string;
  backendLoadingLabel: string;
  backendDownloadingLabel: string;
  backendAnalyzingLabel: string;
  backendOfflineLabel: string;
  backendChunksLabel: string;
  largeSelectionTitle: string;
  largeSelectionSubtitle: string;
  largeSelectionDesc: string;
  largeSelectionCancelBtn: string;
  largeSelectionContinueBtn: string;
  locationErrorTitle: string;
  locationErrorDesc: string;
  locationErrorOkBtn: string;

  // Map & Globe Layers
  layersTitle: string;
  layersZoomBadge: string;
  layersResetBtn: string;
  layersSectionFire: string;
  layersSectionBase: string;
  layerHotspots: string;
  layerRegionBbox: string;
  layerUserLocation: string;
  layerLandOrtho: string;
  layerBorders: string;
  osmAttribution: string;
  gibsAttribution: string;
}
