import { Dict } from './i18n.types';

export const ES: Dict = {
  htmlLang: 'es',
  docTitle: 'KMD · Analítica Global de Incendios e Inercia Climática',
  langName: 'Español',
  appName: 'Incendios Globales',

  // Top HUD & Navigation
  changeLanguage: 'Idioma',
  chooseView: 'Vista',
  viewAnalytics: 'Analítica y Calendario de Incendios',
  viewInertia: 'Satélite e Inercia Climática',
  viewSpread: 'Viento y Puntos Críticos',
  viewEvacuation: 'Evacuación e Impacto Poblacional',
  stageAriaLabel: 'Visualización 3D Global de Incendios',

  // Camera Focus Presets
  focusIberia: 'Iberia',
  focusGulfStream: 'Corriente del Golfo',
  focusElNino: 'El Niño',

  // Bottom Dock & Controls
  timelineLabel: 'Línea temporal',
  play: 'Reproducir',
  pause: 'Pausa',
  glossary: 'Glosario y Datos',
  glossaryTitle: 'Glosario Científico y Atribuciones de Datos Abiertos',
  close: 'Cerrar',

  // Layer & Mode Toggles
  sensorHarmonized: 'Armonizado',
  sensorRaw: 'Bruto (Salto 2012)',
  sstOrtho: 'Ortofoto',
  sstAnomaly: 'Anomalía SST',
  sstAbsolute: 'SST Absoluta',
  chokePointsToggle: 'Puntos Críticos',
  windToggle: 'Campo de Viento',
  escapeRoadsToggle: 'Rutas de Escape',

  // Wind Scenarios
  scenarioLabel: 'Escenario de Viento',
  scenarioActual: 'Viento Real ERA5',
  scenarioAtlanticSurge: 'Racha Atlántica (+42° / 1.75×)',
  scenarioLevanteReversal: 'Giro de Levante (E→O)',
  scenarioElNinoDrought: 'Sequía El Niño (Amplificado)',

  // Wildfire Region Selector & Timeline Phases
  wildfireSelectLabel: 'Región del Incendio',
  phasePreFire: 'Pre-incendio (-6m)',
  phaseActiveFire: 'Incendio Activo',
  metricDate: 'Fecha',
  metricBurnedArea: 'Área Quemada',

  // Telemetry & Context Readouts
  metricYear: 'Año',
  metricHotspots: 'Detecciones',
  metricGulfStream: 'SST Corriente del Golfo',
  metricElNino: 'Índice El Niño ONI',
  metricNdvi: 'Anomalía Combustible NDVI',
  metricLag: 'Desfase de Inercia',
  metricWind: 'Vector de Viento',
  metricShear: 'Cizalladura 3h Δθ',
  metricBurningCells: 'Celdas H3 Activas',
  metricChokePoints: 'Puntos Críticos',
  metricAffectedPop: 'Población Afectada',
  metricEvacZones: 'Zonas de Evacuación',
  metricEscapeRoutes: 'Rutas OSM',

  // Globe Inspect Tooltip
  inspectWaterTemp: 'SST Océano',
  inspectAirTemp: 'Aire 2m',
  inspectLand: 'Tierra',
  inspectOcean: 'Océano',

  // Glossary & Legal Attribution Popup
  glossaryIntro: 'Acoplando 26 años de focos satelitales NASA armonizados con la inercia térmica de la Corriente del Golfo y El Niño y la propagación local por viento en Iberia.',
  glossaryTermInertiaTitle: 'Inercia Térmica Oceánica (Desfase 3–9 meses)',
  glossaryTermInertiaDesc: 'Las anomalías de SST en el Atlántico Norte (Corriente del Golfo) y el índice El Niño (ONI) en el Pacífico alteran las lluvias invernales y bloqueos estivales en Iberia meses antes de la ignición.',
  glossaryTermHarmonizationTitle: 'Armonización Cuantílica MODIS y VIIRS',
  glossaryTermHarmonizationDesc: 'Corrige el salto de 2012 tras el lanzamiento de VIIRS (375m) frente a MODIS (1km), creando una serie homogénea 2000–2026.',
  glossaryTermWindShearTitle: 'Cizalladura Direccional del Viento (Δθ / Δt)',
  glossaryTermWindShearDesc: 'Los giros bruscos de viento (rachas atlánticas o Levante seco) convierten flancos estrechos en frentes masivos sobre cañones SRTM.',
  glossaryTermChokePointsTitle: 'Cuellos de Botella y Cortafuegos',
  glossaryTermChokePointsDesc: 'Corredores estratégicos donde la deforestación o los cortafuegos frenan o aceleran la transición del fuego entre celdas H3.',
  legalTitle: 'Atribuciones Obligatorias de Datos Abiertos',
  legalNasa: 'NASA FIRMS (MCD14ML, VNP14IMGML), NASA/USGS SRTM 30m y NASA EOSDIS MODIS NDVI (MOD13Q1) — Dominio Público de EE. UU.',
  legalCopernicus: 'Contiene información modificada de Copernicus Climate Change Service (C3S ERA5-Land) y Copernicus Marine Service (CMEMS) [2026].',
  legalNoaa: 'Temperatura Superficial del Mar (OISST v2.1) e índices ENSO ONI / NAO proporcionados por NOAA NCEI y Climate Prediction Center.',
  legalOsm: 'Red viaria de evacuación y límites municipales: © colaboradores de OpenStreetMap (ODbL).',

  // Data Sources Popup
  sourcesBtn: 'Fuentes de Datos',
  sourcesTitle: 'Fuentes de Datos Científicos y Licencias',
  sourcesList: [
    {
      name: 'NASA FIRMS (MODIS MCD14ML y VIIRS VNP14IMGML)',
      url: 'https://firms.modaps.eosdis.nasa.gov/',
      license: 'Dominio Público EE. UU.',
      desc: '26 años de focos activos de incendios y potencia radiativa del fuego (FRP) en la Península Ibérica.'
    },
    {
      name: 'NASA / USGS SRTM 30m y MODIS NDVI (MOD13Q1)',
      url: 'https://lpdaac.usgs.gov/',
      license: 'Dominio Público EE. UU.',
      desc: 'Pendiente y orientación topográfica e índices de sequedad vegetal NDVI cada 16 días.'
    },
    {
      name: 'NOAA OISST v2.1 y CPC ENSO (ONI)',
      url: 'https://www.ncei.noaa.gov/products/optimum-interpolation-sst',
      license: 'Dominio Público EE. UU.',
      desc: 'Campos globales de temperatura superficial del mar (0.25°) y serie histórica del índice El Niño ONI.'
    },
    {
      name: 'Copernicus C3S (ERA5-Land) y CMEMS',
      url: 'https://cds.climate.copernicus.eu/',
      license: 'Licencia Copernicus (CC-BY 4.0)',
      desc: 'Vectores horarios de viento a 10 m, rachas, temperatura a 2 m y reanálisis del Atlántico Norte.'
    },
    {
      name: 'Vectores Natural Earth 10m y 50m',
      url: 'https://www.naturalearthdata.com/',
      license: 'Dominio Público',
      desc: 'Líneas de costa vectoriales, fronteras provinciales ibéricas, áreas urbanas y red de carreteras.'
    },
    {
      name: 'Colaboradores de OpenStreetMap',
      url: 'https://www.openstreetmap.org/copyright',
      license: 'ODbL',
      desc: 'Polígonos vectoriales de bosques y masas forestales, corredores de evacuación y límites municipales en España y Portugal.'
    }
  ],

  // Region Bounding Box, Draw Mode & Date Range Controls
  regionIberiaAll: 'Península Ibérica (Completa)',
  regionCustomBbox: 'Cuadro Delimitador Personalizado',
  regionBboxLabel: 'Cuadro Delimitador',
  drawBboxBtn: 'Dibujar Cuadro Delimitador',
  drawBboxActiveHint: 'Arrastra sobre el globo 3D para dibujar el cuadro delimitador',
  drawBboxShiftHint: 'Consejo: Mantén Shift + arrastra en el globo',
  coordsBtn: 'Coordenadas y Fechas',
  coordsTitle: 'Coordenadas de Región y Rango de Fechas',
  coordWest: 'Longitud Oeste (°)',
  coordSouth: 'Latitud Sur (°)',
  coordEast: 'Longitud Este (°)',
  coordNorth: 'Latitud Norte (°)',
  applyCoords: 'Aplicar Cuadro',
  focusBbox: 'Enfocar Globo',
  resetRegion: 'Restablecer Iberia',
  dateRangeLabel: 'Rango de Fechas',
  dateStartLabel: 'Desde',
  dateEndLabel: 'Hasta',
  presetFullArchive: '2000–2026',
  presetRecent5Yr: '2022–2026',
  preset2022Season: 'Pico 2022',
  preset2017Season: 'Pico 2017',

  // Accessible Color Ramps
  colorRampLabel: 'Rampa de Color',
  rampOkabeIto: 'Okabe-Ito (Accesible)',
  rampCividis: 'Cividis (Accesible)',
  rampViridis: 'Viridis (Uniforme)',
  rampYlOrRd: 'YlOrRd (Secuencial)',
  globeHotspotsToggle: 'Focos',

  // Analytics & Burning Calendar Dashboard
  analyticsBtn: 'Analítica y Descarga',
  analyticsTitle: 'Analítica de Actividad de Incendios Armonizada',
  analyticsExpand: 'Ampliar',
  analyticsCollapse: 'Compacto',
  analyticsMinimize: 'Ocultar Panel',
  analyticsShowPanel: 'Ver Analítica',
  tabOverviewCalendar: 'Calendario de Fuego',
  tabHistoricalAnomalies: 'Histórico y Anomalías',
  tabInputExport: 'Entrada y Descarga',
  kpiHarmonizedFires: 'Focos Armonizados',
  kpiRawSensors: 'Detecciones Brutas',
  kpiMultiYearAnomaly: 'Anomalía Multianual',
  kpiVsBaseline: 'vs media 2000–2026',
  kpiTotalFrp: 'FRP Total',
  kpiMeanFrp: 'FRP Media',
  kpiPeakDate: 'Día Pico',
  kpiActiveDays: 'días activos',
  kpiRegionArea: 'Área de Región',
  burningCalendarTitle: 'Calendario de Quemas (Detecciones Armonizadas)',
  calendarMonthly: 'Año × Mes',
  calendarDaily: 'Mes × Día',
  calendarNoData: 'No hay detecciones para esta región y rango de fechas.',
  calendarLow: 'Bajo',
  calendarHigh: 'Pico',
  historicalFiresTitle: 'Incendios Detectados: Armonizado vs MODIS Bruto (2000–2026)',
  historicalFiresSubtitle: 'La armonización cuantílica corrige el salto de VIIRS en 2012 frente a la media multianual.',
  legendHarmonized: 'Armonizado (eq. VIIRS)',
  legendRawModis: 'MODIS Bruto (1 km)',
  legendMultiYearAvg: 'Media Multianual',
  anomalyChartTitle: 'Anomalía frente a la Media Multianual (Z-Score)',
  anomalyChartSubtitle: 'Desviación estandarizada de la media regional (escala divergente accesible).',
  anomalyAboveAvg: 'Sobre la media (+σ)',
  anomalyBelowAvg: 'Bajo la media (−σ)',

  // Data Input & Downloads
  inputDataTitle: 'Entrada de Datos Armonizados de Focos',
  inputDataDesc: 'Analiza el conjunto NASA FIRMS Ibérico precargado o importa tu propio archivo CSV / JSON armonizado.',
  activeDatasetLabel: 'Conjunto Activo',
  defaultDatasetName: 'NASA FIRMS Armonizado (Iberia 2000–2026)',
  uploadFileBtn: 'Importar CSV / JSON',
  downloadTemplateBtn: 'Plantilla CSV',
  resetDatasetBtn: 'Restablecer',
  importSuccessMsg: 'Registros armonizados personalizados cargados.',
  importErrorEmpty: 'El archivo cargado está vacío.',
  importErrorNoRows: 'No se encontraron filas válidas (requiere date, lat, lon).',
  importErrorParse: 'Error al analizar el archivo. Verifique formato CSV o JSON.',
  downloadTitle: 'Descargar Analítica y Visualizaciones',
  downloadCsvBtn: 'Focos CSV',
  downloadJsonBtn: 'Analítica JSON',
  downloadSvgBtn: 'Gráficos SVG',
  downloadPngBtn: 'Informe PNG',
  recordsCountLabel: 'registros filtrados',
  backendLiveLabel: 'NASA FIRMS en vivo',
  backendDownloadingLabel: 'Descargando datos de NASA FIRMS',
  backendOfflineLabel: 'Muestra local (API offline)',
  backendChunksLabel: 'bloques',

  // Map & Globe Layers
  layersBtn: 'Capas',
  layersTitle: 'Capas del Globo',
  layersZoomBadge: 'Zoom',
  layersResetBtn: 'Restablecer',
  layersSectionFire: 'Fuego y Análisis',
  layersSectionBase: 'Cartografía',
  layerHotspots: 'Focos Armonizados',
  layerRegionBbox: 'Caja Delimitadora de Región',
  layerWindStreamlines: 'Corrientes de Viento',
  layerEscapeRoutes: 'Rutas de Evacuación',
  layerLandOrtho: 'Imagen Satelital',
  layerOsmTiles: 'OpenStreetMap (Adaptativo)',
  layerForests: 'Cobertura Forestal (MODIS)',
  layerUrbanAreas: 'Áreas Urbanas',
  layerBorders: 'Fronteras Administrativas',
  layerRoads: 'Red Viaria',
  layerGraticule: 'Retícula de Coordenadas'
};
