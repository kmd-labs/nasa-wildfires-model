export type Lang = 'en' | 'pl';
export type DateFormatPref = 'auto' | 'dmy-dot' | 'dmy-slash' | 'mdy-slash' | 'iso';

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
  langName: string;
  appName: string;

  // Top HUD & Navigation
  changeLanguage: string;
  settingsTitle: string;
  settingsAria: string;
  dateFormatLabel: string;
  dateFormatAuto: string;
  chooseView: string;
  mapMode2d: string;
  mapModeGlobe: string;
  viewAnalytics: string;
  viewInertia: string;
  viewSpread: string;
  viewEvacuation: string;
  stageAriaLabel: string;

  // Camera Focus Presets (Climatological Context)
  focusIberia: string;
  focusGulfStream: string;
  focusElNino: string;

  // Bottom Dock & Controls
  timelineLabel: string;
  play: string;
  pause: string;
  glossary: string;
  glossaryTitle: string;
  close: string;

  // Layer & Mode Toggles
  sensorHarmonized: string;
  sensorRaw: string;
  sstOrtho: string;
  sstAnomaly: string;
  sstAbsolute: string;
  chokePointsToggle: string;
  windToggle: string;
  escapeRoadsToggle: string;

  // Wind Scenarios
  scenarioLabel: string;
  scenarioActual: string;
  scenarioAtlanticSurge: string;
  scenarioLevanteReversal: string;
  scenarioElNinoDrought: string;

  // Wildfire AOI Selector & Timeline Phases
  wildfireSelectLabel: string;
  phasePreFire: string;
  phaseActiveFire: string;
  metricDate: string;
  metricBurnedArea: string;

  // Telemetry & Context Readouts
  metricYear: string;
  metricHotspots: string;
  metricGulfStream: string;
  metricElNino: string;
  metricNdvi: string;
  metricLag: string;
  metricWind: string;
  metricShear: string;
  metricBurningCells: string;
  metricChokePoints: string;
  metricAffectedPop: string;
  metricEvacZones: string;
  metricEscapeRoutes: string;

  // Globe Inspect Tooltip
  inspectWaterTemp: string;
  inspectAirTemp: string;
  inspectLand: string;
  inspectOcean: string;

  // Glossary & Legal Attribution Popup
  glossaryIntro: string;
  glossaryTermInertiaTitle: string;
  glossaryTermInertiaDesc: string;
  glossaryTermHarmonizationTitle: string;
  glossaryTermHarmonizationDesc: string;
  glossaryTermWindShearTitle: string;
  glossaryTermWindShearDesc: string;
  glossaryTermChokePointsTitle: string;
  glossaryTermChokePointsDesc: string;
  legalTitle: string;
  legalNasa: string;
  legalCopernicus: string;
  legalNoaa: string;
  legalOsm: string;

  // Data Sources Popup
  sourcesBtn: string;
  sourcesTitle: string;
  sourcesList: DataSourceItem[];

  // Region BBox, Draw Mode & Date Range Controls
  regionIberiaAll: string;
  regionCustomBbox: string;
  regionMultiPolygon: string;
  regionBboxLabel: string;
  drawBboxBtn: string;
  addBboxBtn: string;
  drawBboxActiveHint: string;
  drawBboxEditEdgeHint: string;
  drawBboxShiftHint: string;
  polygonEdgesLabel: string;
  acceptAndCalculateBtn: string;
  recalculatePrompt: string;
  recalculateBtn: string;
  calculateBboxBtn: string;
  draftPendingDesc: string;
  datasetLabel: string;
  datasetUsedLabel: string;
  datasetViirsBtn: string;
  datasetModisBtn: string;
  datasetBothBtn: string;
  datasetMixedLabel: string;
  datasetViirsDesc: string;
  datasetModisDesc: string;
  datasetBothDesc: string;
  viirsUnavailableTooltip: string;
  bothSensorsRequiredTooltip: string;
  datasetDetectionsLabel: string;
  searchAreasPlaceholder: string;
  searchNoResults: string;
  predefinedAreasLabel: string;
  regionIberiaDefault: string;
  cachedBadgeLabel: string;
  groupPredefinedAreas: string;
  groupFireEvents: string;
  groupCountries: string;
  regionMediterranean: string;
  regionWesternEurope: string;
  regionCentralEurope: string;
  regionNorthAfrica: string;
  regionScandinavia: string;
  addAreaToMultiTooltip: string;
  polygonsCountLabel: string;
  wktLabel: string;
  applyWktBtn: string;
  removeBoxLabel: string;
  coordsBtn: string;
  coordsTitle: string;
  dataSectionTitle: string;
  coordWest: string;
  coordSouth: string;
  coordEast: string;
  coordNorth: string;
  applyCoords: string;
  focusBbox: string;
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
  globeHotspotsToggle: string;

  // Analytics & Burning Calendar Dashboard
  analyticsBtn: string;
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
  tabOverviewCalendar: string;
  tabHistoricalAnomalies: string;
  tabInputExport: string;
  kpiHarmonizedFires: string;
  kpiRawSensors: string;
  kpiMultiYearAnomaly: string;
  kpiVsBaseline: string;
  kpiTotalFrp: string;
  kpiMeanFrp: string;
  kpiPeakDate: string;
  kpiActiveDays: string;
  kpiRegionArea: string;
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
  anomalyChartTitle: string;
  anomalyChartSubtitle: string;
  anomalyAboveAvg: string;
  anomalyBelowAvg: string;

  // Data Input & Downloads
  inputDataTitle: string;
  inputDataDesc: string;
  activeDatasetLabel: string;
  defaultDatasetName: string;
  uploadFileBtn: string;
  downloadTemplateBtn: string;
  resetDatasetBtn: string;
  importSuccessMsg: string;
  importErrorEmpty: string;
  importErrorNoRows: string;
  importErrorParse: string;
  downloadTitle: string;
  exportBtn: string;
  exportPopupTitle: string;
  downloadCsvBtn: string;
  downloadJsonBtn: string;
  downloadSvgBtn: string;
  downloadPngBtn: string;
  recordsCountLabel: string;
  backendLiveLabel: string;
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
  layersBtn: string;
  layersTitle: string;
  layersZoomBadge: string;
  layersResetBtn: string;
  layersSectionFire: string;
  layersSectionBase: string;
  layerHotspots: string;
  layerRegionBbox: string;
  layerUserLocation: string;
  layerWindStreamlines: string;
  layerEscapeRoutes: string;
  layerLandOrtho: string;
  layerOsmTiles: string;
  layerForests: string;
  layerUrbanAreas: string;
  layerBorders: string;
  layerRoads: string;
  layerGraticule: string;
  osmAttribution: string;
}
