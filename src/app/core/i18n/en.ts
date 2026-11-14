import { Dict } from './i18n.types';

export const EN: Dict = {
  htmlLang: 'en',
  docTitle: 'KMD · Global Wildfire Analytics & Climate Inertia',
  langName: 'English',
  appName: 'Global Wildfires',

  // Top HUD & Navigation
  changeLanguage: 'Language',
  chooseView: 'View',
  viewAnalytics: 'Fire Analytics & Calendar',
  viewInertia: 'Satellite & Climate Inertia',
  viewSpread: 'Wind Spread & Choke-Points',
  viewEvacuation: 'Evacuation & Population Impact',
  stageAriaLabel: '3D Globe Global Wildfire Visualization',

  // Camera Focus Presets
  focusIberia: 'Iberia',
  focusGulfStream: 'Gulf Stream',
  focusElNino: 'El Niño',

  // Bottom Dock & Controls
  timelineLabel: 'Timeline',
  play: 'Play',
  pause: 'Pause',
  glossary: 'Glossary & Data',
  glossaryTitle: 'Scientific Glossary & Open-Data Attributions',
  close: 'Close',

  // Layer & Mode Toggles
  sensorHarmonized: 'Harmonized',
  sensorRaw: 'Raw (2012 Jump)',
  sstOrtho: 'Orthophoto',
  sstAnomaly: 'SST Anomaly',
  sstAbsolute: 'Absolute SST',
  chokePointsToggle: 'Choke-Points',
  windToggle: 'Wind Field',
  escapeRoadsToggle: 'Escape Roads',

  // Wind Scenarios
  scenarioLabel: 'Wind Scenario',
  scenarioActual: 'Actual ERA5 Winds',
  scenarioAtlanticSurge: 'Atlantic Surge (+42° / 1.75×)',
  scenarioLevanteReversal: 'Levante Reversal (E→W)',
  scenarioElNinoDrought: 'El Niño Drought Boost',

  // Wildfire Region Selector & Timeline Phases
  wildfireSelectLabel: 'Wildfire Region',
  phasePreFire: 'Pre-Fire (-6m)',
  phaseActiveFire: 'Active Wildfire',
  metricDate: 'Date',
  metricBurnedArea: 'Burned Area',

  // Telemetry & Context Readouts
  metricYear: 'Year',
  metricHotspots: 'Fire Detections',
  metricGulfStream: 'Gulf Stream SST',
  metricElNino: 'El Niño ONI',
  metricNdvi: 'NDVI Fuel Anomaly',
  metricLag: 'Peak Inertia Lag',
  metricWind: 'Wind Vector',
  metricShear: '3h Shear Δθ',
  metricBurningCells: 'Active H3 Cells',
  metricChokePoints: 'Choke-Points',
  metricAffectedPop: 'Affected Population',
  metricEvacZones: 'Evacuation Zones',
  metricEscapeRoutes: 'OSM Escape Routes',

  // Globe Inspect Tooltip
  inspectWaterTemp: 'Ocean SST',
  inspectAirTemp: 'Air 2m',
  inspectLand: 'Land',
  inspectOcean: 'Ocean',

  // Glossary & Legal Attribution Popup
  glossaryIntro: 'Coupling 26 years of harmonized NASA satellite hotspots with Gulf Stream & El Niño thermal inertia and local Iberian wind-driven spread.',
  glossaryTermInertiaTitle: 'Oceanic Thermal Inertia (3–9 Month Lag)',
  glossaryTermInertiaDesc: 'North Atlantic / Gulf Stream SST anomalies and tropical Pacific El Niño (ONI) shifts alter Iberian winter precipitation and summer blocking highs months before ignition.',
  glossaryTermHarmonizationTitle: 'MODIS & VIIRS Quantile Harmonization',
  glossaryTermHarmonizationDesc: 'Corrects the 2012 sensor jump when 375m VIIRS launched alongside 1km MODIS, creating a consistent 2000–2026 fire baseline across Iberian biomes.',
  glossaryTermWindShearTitle: 'Wind Directional Shear (Δθ / Δt)',
  glossaryTermWindShearDesc: 'Rapid Iberian wind rotations (Atlantic surges or dry Levante reversals) turn narrow fire flanks into wide head fires across steep SRTM river canyons.',
  glossaryTermChokePointsTitle: 'Deforestation & Fuel-Break Choke-Points',
  glossaryTermChokePointsDesc: 'Critical landscape corridors where fuel breaks or deforestation gaps bottleneck or accelerate fire transition between neighboring H3 cells.',
  legalTitle: 'Required Open-Data Attributions',
  legalNasa: 'NASA FIRMS (MCD14ML, VNP14IMGML), NASA/USGS SRTM 30m, and NASA EOSDIS MODIS NDVI (MOD13Q1) — US Government Public Domain.',
  legalCopernicus: 'Contains modified Copernicus Climate Change Service (C3S ERA5-Land) and Copernicus Marine Service (CMEMS) information [2026].',
  legalNoaa: 'Sea Surface Temperature (OISST v2.1) and ENSO ONI / NAO teleconnection indices provided by NOAA NCEI & Climate Prediction Center.',
  legalOsm: 'Evacuation road network & municipal boundaries: © OpenStreetMap contributors (ODbL).',

  // Data Sources Popup
  sourcesBtn: 'Data Sources',
  sourcesTitle: 'Scientific Data Sources & Licenses',
  sourcesList: [
    {
      name: 'NASA FIRMS (MODIS MCD14ML & VIIRS VNP14IMGML)',
      url: 'https://firms.modaps.eosdis.nasa.gov/',
      license: 'US Gov Public Domain',
      desc: '26-year active fire hotspots and Fire Radiative Power (FRP) detections across the Iberian Peninsula.'
    },
    {
      name: 'NASA / USGS SRTM 30m & MODIS NDVI (MOD13Q1)',
      url: 'https://lpdaac.usgs.gov/',
      license: 'US Gov Public Domain',
      desc: 'Topographic slope/aspect and 16-day vegetation fuel dryness indices.'
    },
    {
      name: 'NOAA OISST v2.1 & CPC ENSO (ONI)',
      url: 'https://www.ncei.noaa.gov/products/optimum-interpolation-sst',
      license: 'US Gov Public Domain',
      desc: 'Global 0.25° Sea Surface Temperature fields and historical El Niño / La Niña ONI time series.'
    },
    {
      name: 'Copernicus C3S (ERA5-Land) & CMEMS',
      url: 'https://cds.climate.copernicus.eu/',
      license: 'Copernicus License (CC-BY 4.0)',
      desc: 'Hourly 10m wind vectors, gusts, 2m air temperature, and North Atlantic / Gulf Stream marine reanalysis.'
    },
    {
      name: 'Natural Earth 10m & 50m Vectors',
      url: 'https://www.naturalearthdata.com/',
      license: 'Public Domain',
      desc: 'High-resolution vector coastlines, Iberian provincial borders, urban footprints, and major highway networks.'
    },
    {
      name: 'OpenStreetMap Contributors',
      url: 'https://www.openstreetmap.org/copyright',
      license: 'ODbL',
      desc: 'Forest/woodland vector polygons, evacuation road corridors, and municipal boundaries across Spain and Portugal.'
    }
  ],

  // Region Bounding Box, Draw Mode & Date Range Controls
  regionIberiaAll: 'Iberian Peninsula (Full)',
  regionCustomBbox: 'Custom Bounding Box',
  regionBboxLabel: 'Bounding Box',
  drawBboxBtn: 'Draw Bounding Box',
  drawBboxActiveHint: 'Drag across the 3D globe to draw your bounding box',
  drawBboxShiftHint: 'Tip: Hold Shift + drag on globe anytime',
  coordsBtn: 'Coordinates & Dates',
  coordsTitle: 'Region Bounding Box & Date Range',
  coordWest: 'West Longitude (°)',
  coordSouth: 'South Latitude (°)',
  coordEast: 'East Longitude (°)',
  coordNorth: 'North Latitude (°)',
  applyCoords: 'Apply Bounding Box',
  focusBbox: 'Focus Globe',
  resetRegion: 'Reset Iberia',
  dateRangeLabel: 'Date Range',
  dateStartLabel: 'From',
  dateEndLabel: 'To',
  presetFullArchive: '2000–2026',
  presetRecent5Yr: '2022–2026',
  preset2022Season: '2022 Peak',
  preset2017Season: '2017 Peak',

  // Accessible Color Ramps
  colorRampLabel: 'Color Ramp',
  rampOkabeIto: 'Okabe-Ito (CVD-Safe)',
  rampCividis: 'Cividis (CVD-Safe)',
  rampViridis: 'Viridis (Uniform)',
  rampYlOrRd: 'YlOrRd (Sequential)',
  globeHotspotsToggle: 'Hotspots',

  // Analytics & Burning Calendar Dashboard
  analyticsBtn: 'Analytics & Export',
  analyticsTitle: 'Harmonized Fire Activity Analytics',
  analyticsExpand: 'Expand',
  analyticsCollapse: 'Compact',
  analyticsMinimize: 'Hide Panel',
  analyticsShowPanel: 'Show Analytics',
  tabOverviewCalendar: 'Burning Calendar',
  tabHistoricalAnomalies: 'Historical & Anomalies',
  tabInputExport: 'Input & Download',
  kpiHarmonizedFires: 'Harmonized Fires',
  kpiRawSensors: 'Raw Detections',
  kpiMultiYearAnomaly: 'Multi-Year Anomaly',
  kpiVsBaseline: 'vs 2000–2026 Avg',
  kpiTotalFrp: 'Total FRP',
  kpiMeanFrp: 'Mean FRP',
  kpiPeakDate: 'Peak Fire Date',
  kpiActiveDays: 'active days',
  kpiRegionArea: 'Region Area',
  burningCalendarTitle: 'Burning Calendar (Harmonized Detections)',
  calendarMonthly: 'Year × Month',
  calendarDaily: 'Month × Day',
  calendarNoData: 'No fire detections match this region and date range.',
  calendarLow: 'Low',
  calendarHigh: 'Peak',
  historicalFiresTitle: 'Fires Detected: Harmonized vs Raw MODIS (2000–2026)',
  historicalFiresSubtitle: 'Quantile harmonization bridges the 2012 VIIRS launch jump against the multi-year baseline.',
  legendHarmonized: 'Harmonized (VIIRS-eq.)',
  legendRawModis: 'Raw MODIS (1 km)',
  legendMultiYearAvg: 'Multi-Year Avg',
  anomalyChartTitle: 'Anomaly vs Multi-Year Average (Z-Score)',
  anomalyChartSubtitle: 'Standardized departure from historical regional mean (colorblind-safe diverging scale).',
  anomalyAboveAvg: 'Above Avg (+σ)',
  anomalyBelowAvg: 'Below Avg (−σ)',

  // Data Input & Downloads
  inputDataTitle: 'Harmonized Hotspot Data Input',
  inputDataDesc: 'Analyze the pre-loaded NASA FIRMS Iberian dataset or import your own harmonized CSV / JSON hotspot file.',
  activeDatasetLabel: 'Active Dataset',
  defaultDatasetName: 'NASA FIRMS Harmonized (Iberia 2000–2026)',
  uploadFileBtn: 'Import CSV / JSON',
  downloadTemplateBtn: 'CSV Template',
  resetDatasetBtn: 'Reset Default',
  importSuccessMsg: 'Loaded custom harmonized hotspot records.',
  importErrorEmpty: 'The uploaded file is empty.',
  importErrorNoRows: 'No valid hotspot rows found (need date, lat, lon).',
  importErrorParse: 'Could not parse file. Ensure valid CSV or JSON format.',
  downloadTitle: 'Download Analytics & Visualizations',
  downloadCsvBtn: 'Hotspots CSV',
  downloadJsonBtn: 'Analytics JSON',
  downloadSvgBtn: 'Charts SVG',
  downloadPngBtn: 'Report PNG',
  recordsCountLabel: 'matched records',
  backendLiveLabel: 'Live NASA FIRMS',
  backendDownloadingLabel: 'Downloading NASA FIRMS data',
  backendOfflineLabel: 'Local Sample (API offline)',
  backendChunksLabel: 'chunks',

  // Map & Globe Layers
  layersBtn: 'Layers',
  layersTitle: 'Globe Layers',
  layersZoomBadge: 'Zoom',
  layersResetBtn: 'Reset',
  layersSectionFire: 'Fire & Analysis',
  layersSectionBase: 'Cartography',
  layerHotspots: 'Harmonized Hotspots',
  layerRegionBbox: 'Region Bounding Box',
  layerWindStreamlines: 'Wind Streamlines',
  layerEscapeRoutes: 'Evacuation Routes',
  layerLandOrtho: 'Satellite Imagery',
  layerOsmTiles: 'OpenStreetMap (Zoom-Adaptive)',
  layerForests: 'Forest Canopy (MODIS)',
  layerUrbanAreas: 'Urban Footprints',
  layerBorders: 'Administrative Borders',
  layerRoads: 'Road Network',
  layerGraticule: 'Coordinate Graticule'
};
