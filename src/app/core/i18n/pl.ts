import { Dict } from './i18n.types';

export const PL: Dict = {
  htmlLang: 'pl',
  docTitle: 'KMD · Globalna Analityka Pożarów i Bezwładność Klimatu',
  langName: 'Polski',
  appName: 'Globalne Pożary',

  // Top HUD & Navigation
  changeLanguage: 'Język',
  chooseView: 'Widok',
  viewAnalytics: 'Analityka i Kalendarz Pożarów',
  viewInertia: 'Satelita i Bezwładność Klimatu',
  viewSpread: 'Wiatr i Punkty Krytyczne',
  viewEvacuation: 'Ewakuacja i Wpływ na Ludność',
  stageAriaLabel: 'Wizualizacja 3D Globalnych Pożarów',

  // Camera Focus Presets
  focusIberia: 'Iberia',
  focusGulfStream: 'Golfsztrom',
  focusElNino: 'El Niño',

  // Bottom Dock & Controls
  timelineLabel: 'Oś czasu',
  play: 'Odtwórz',
  pause: 'Pauza',
  glossary: 'Słowniczek i Dane',
  glossaryTitle: 'Słowniczek Naukowy i Źródła Danych',
  close: 'Zamknij',

  // Layer & Mode Toggles
  sensorHarmonized: 'Zharmonizowane',
  sensorRaw: 'Surowe (Skok 2012)',
  sstOrtho: 'Ortofotomapa',
  sstAnomaly: 'Anomalia SST',
  sstAbsolute: 'Temperatura SST',
  chokePointsToggle: 'Punkty Krytyczne',
  windToggle: 'Pole Wiatru',
  escapeRoadsToggle: 'Drogi Ewakuacji',

  // Wind Scenarios
  scenarioLabel: 'Scenariusz Wiatru',
  scenarioActual: 'Rzeczywisty wiatr ERA5',
  scenarioAtlanticSurge: 'Uderzenie Atlantyckie (+42° / 1.75×)',
  scenarioLevanteReversal: 'Zwrot Levante (E→W)',
  scenarioElNinoDrought: 'Susza El Niño (Wzmocnienie)',

  // Wildfire Region Selector & Timeline Phases
  wildfireSelectLabel: 'Region Pożaru',
  phasePreFire: 'Przed pożarem (-6m)',
  phaseActiveFire: 'Aktywny pożar',
  metricDate: 'Data',
  metricBurnedArea: 'Spalony obszar',

  // Telemetry & Context Readouts
  metricYear: 'Rok',
  metricHotspots: 'Detekcje Ognia',
  metricGulfStream: 'SST Golfsztromu',
  metricElNino: 'Indeks El Niño ONI',
  metricNdvi: 'Anomalia Paliwa NDVI',
  metricLag: 'Opóźnienie Bezwładności',
  metricWind: 'Wektor Wiatru',
  metricShear: 'Skręt Wiatru 3h Δθ',
  metricBurningCells: 'Aktywne Komórki H3',
  metricChokePoints: 'Punkty Krytyczne',
  metricAffectedPop: 'Zagrożona Ludność',
  metricEvacZones: 'Strefy Ewakuacji',
  metricEscapeRoutes: 'Trasy Ucieczki OSM',

  // Globe Inspect Tooltip
  inspectWaterTemp: 'SST Oceanu',
  inspectAirTemp: 'Powietrze 2m',
  inspectLand: 'Ląd',
  inspectOcean: 'Ocean',

  // Glossary & Legal Attribution Popup
  glossaryIntro: 'Połączenie 26 lat zharmonizowanych danych satelitarnych NASA z bezwładnością termiczną Golfsztromu i El Niño oraz lokalnym modelem rozprzestrzeniania wiatrowego.',
  glossaryTermInertiaTitle: 'Bezwładność Termiczna Oceanów (3–9 mies.)',
  glossaryTermInertiaDesc: 'Anomalie SST Golfsztromu na północnym Atlantyku oraz cykl El Niño (ONI) na Pacyfiku kształtują zimowe opady i letnie wyże blokujące na Iberii z wielomiesięcznym wyprzedzeniem.',
  glossaryTermHarmonizationTitle: 'Harmonizacja Kwantylna MODIS i VIIRS',
  glossaryTermHarmonizationDesc: 'Koryguje skok detekcji z 2012 r. po starcie sensora VIIRS 375m względem MODIS 1km, tworząc spójną linię bazową 2000–2026.',
  glossaryTermWindShearTitle: 'Kierunkowy Skręt Wiatru (Δθ / Δt)',
  glossaryTermWindShearDesc: 'Nagłe zmiany kierunku wiatru (uderzenia atlantyckie lub suchy wiatr Levante) zamieniają wąską flankę pożaru w szeroki front w kanionach SRTM.',
  glossaryTermChokePointsTitle: 'Przewężenia Wylesień i Pasów Ppoż.',
  glossaryTermChokePointsDesc: 'Strategiczne korytarze terenowe, w których pasy przeciwpożarowe lub wylesienia ograniczają bądź przyspieszają przejście ognia między komórkami H3.',
  legalTitle: 'Wymagane Atrybucje Otwartych Danych',
  legalNasa: 'NASA FIRMS (MCD14ML, VNP14IMGML), NASA/USGS SRTM 30m oraz NASA EOSDIS MODIS NDVI (MOD13Q1) — Domena Publiczna Rządu USA.',
  legalCopernicus: 'Zawiera zmodyfikowane informacje Copernicus Climate Change Service (C3S ERA5-Land) i Copernicus Marine Service (CMEMS) [2026].',
  legalNoaa: 'Temperatura powierzchni morza (OISST v2.1) oraz indeksy ENSO ONI / NAO udostępnione przez NOAA NCEI i Climate Prediction Center.',
  legalOsm: 'Sieć dróg ewakuacyjnych i granice gmin: © współautorzy OpenStreetMap (ODbL).',

  // Data Sources Popup
  sourcesBtn: 'Źródła danych',
  sourcesTitle: 'Źródła Danych Naukowych i Licencje',
  sourcesList: [
    {
      name: 'NASA FIRMS (MODIS MCD14ML & VIIRS VNP14IMGML)',
      url: 'https://firms.modaps.eosdis.nasa.gov/',
      license: 'Domena Publiczna USA',
      desc: '26-letnie detekcje aktywnych pożarów i mocy promieniowania ognia (FRP) na Półwyspie Iberyjskim.'
    },
    {
      name: 'NASA / USGS SRTM 30m & MODIS NDVI (MOD13Q1)',
      url: 'https://lpdaac.usgs.gov/',
      license: 'Domena Publiczna USA',
      desc: 'Dane topograficzne nachylenia terenu oraz 16-dniowe wskaźniki przesuszenia roślinności NDVI.'
    },
    {
      name: 'NOAA OISST v2.1 & CPC ENSO (ONI)',
      url: 'https://www.ncei.noaa.gov/products/optimum-interpolation-sst',
      license: 'Domena Publiczna USA',
      desc: 'Globalne pola temperatury powierzchni morza (0.25°) oraz historyczny szereg indeksu El Niño ONI.'
    },
    {
      name: 'Copernicus C3S (ERA5-Land) & CMEMS',
      url: 'https://cds.climate.copernicus.eu/',
      license: 'Licencja Copernicus (CC-BY 4.0)',
      desc: 'Godzinowe wektory wiatru na 10 m, porywy, temperatura powietrza na 2 m oraz reanaliza północnego Atlantyku.'
    },
    {
      name: 'Natural Earth 10m & 50m Wektory',
      url: 'https://www.naturalearthdata.com/',
      license: 'Domena Publiczna',
      desc: 'Wektorowe linie brzegowe, granice prowincji Półwyspu Iberyjskiego, obszary miejskie i sieć głównych dróg.'
    },
    {
      name: 'OpenStreetMap Contributors',
      url: 'https://www.openstreetmap.org/copyright',
      license: 'ODbL',
      desc: 'Wektorowe poligony lasów i terenów zalesionych, korytarze dróg ewakuacyjnych oraz granice gmin w Hiszpanii i Portugalii.'
    }
  ],

  // Region Bounding Box, Draw Mode & Date Range Controls
  regionIberiaAll: 'Półwysep Iberyjski (Cały)',
  regionCustomBbox: 'Własny Obszar Graniczny',
  regionBboxLabel: 'Obszar Graniczny',
  drawBboxBtn: 'Rysuj Obszar na Globusie',
  drawBboxActiveHint: 'Przeciągnij po globusie 3D, aby narysować ramkę obszaru',
  drawBboxShiftHint: 'Wskazówka: przytrzymaj Shift + przeciągnij na globusie',
  coordsBtn: 'Współrzędne i Daty',
  coordsTitle: 'Współrzędne Regionu i Zakres Dat',
  coordWest: 'Zachód Dł. (°)',
  coordSouth: 'Południe Szer. (°)',
  coordEast: 'Wschód Dł. (°)',
  coordNorth: 'Północ Szer. (°)',
  applyCoords: 'Zastosuj Obszar',
  focusBbox: 'Przybliż Globus',
  resetRegion: 'Resetuj Iberię',
  dateRangeLabel: 'Zakres Dat',
  dateStartLabel: 'Od',
  dateEndLabel: 'Do',
  presetFullArchive: '2000–2026',
  presetRecent5Yr: '2022–2026',
  preset2022Season: 'Szczyt 2022',
  preset2017Season: 'Szczyt 2017',

  // Accessible Color Ramps
  colorRampLabel: 'Paleta Barw',
  rampOkabeIto: 'Okabe-Ito (CVD-Safe)',
  rampCividis: 'Cividis (CVD-Safe)',
  rampViridis: 'Viridis (Jednorodna)',
  rampYlOrRd: 'YlOrRd (Sekwencyjna)',
  globeHotspotsToggle: 'Hotspoty',

  // Analytics & Burning Calendar Dashboard
  analyticsBtn: 'Analityka i Eksport',
  analyticsTitle: 'Analityka Zharmonizowanej Aktywności Pożarowej',
  analyticsExpand: 'Rozwiń',
  analyticsCollapse: 'Kompaktowy',
  analyticsMinimize: 'Ukryj Panel',
  analyticsShowPanel: 'Pokaż Analitykę',
  tabOverviewCalendar: 'Kalendarz Pożarów',
  tabHistoricalAnomalies: 'Historia i Anomalie',
  tabInputExport: 'Dane i Pobieranie',
  kpiHarmonizedFires: 'Zharmonizowane Pożary',
  kpiRawSensors: 'Surowe Detekcje',
  kpiMultiYearAnomaly: 'Anomalia Wieloletnia',
  kpiVsBaseline: 'vs średnia 2000–2026',
  kpiTotalFrp: 'Łączna Moc FRP',
  kpiMeanFrp: 'Średnia FRP',
  kpiPeakDate: 'Szczytowy Dzień',
  kpiActiveDays: 'dni z ogniem',
  kpiRegionArea: 'Powierzchnia Obszaru',
  burningCalendarTitle: 'Kalendarz Pożarów (Zharmonizowane Detekcje)',
  calendarMonthly: 'Rok × Miesiąc',
  calendarDaily: 'Miesiąc × Dzień',
  calendarNoData: 'Brak detekcji ognia dla wybranego regionu i zakresu dat.',
  calendarLow: 'Niska',
  calendarHigh: 'Szczyt',
  historicalFiresTitle: 'Wykryte Pożary: Zharmonizowane vs Surowy MODIS (2000–2026)',
  historicalFiresSubtitle: 'Harmonizacja kwantylowa koryguje skok sensora VIIRS z 2012 r. względem średniej wieloletniej.',
  legendHarmonized: 'Zharmonizowane (VIIRS-ekwiw.)',
  legendRawModis: 'Surowy MODIS (1 km)',
  legendMultiYearAvg: 'Średnia Wieloletnia',
  anomalyChartTitle: 'Anomalia względem Średniej Wieloletniej (Z-Score)',
  anomalyChartSubtitle: 'Standaryzowane odchylenie od średniej regionalnej (paleta przyjazna daltonistom).',
  anomalyAboveAvg: 'Powyżej średniej (+σ)',
  anomalyBelowAvg: 'Poniżej średniej (−σ)',

  // Data Input & Downloads
  inputDataTitle: 'Wejście Zharmonizowanych Danych Hotspotów',
  inputDataDesc: 'Analizuj wczytany zbiór NASA FIRMS dla Iberii lub zaimportuj własny plik CSV / JSON ze zharmonizowanymi hotspotami.',
  activeDatasetLabel: 'Aktywny Zbiór Danych',
  defaultDatasetName: 'NASA FIRMS Zharmonizowane (Iberia 2000–2026)',
  uploadFileBtn: 'Importuj CSV / JSON',
  downloadTemplateBtn: 'Szablon CSV',
  resetDatasetBtn: 'Przywróć Domyślny',
  importSuccessMsg: 'Wczytano własne rekordy zharmonizowanych hotspotów.',
  importErrorEmpty: 'Przesłany plik jest pusty.',
  importErrorNoRows: 'Brak poprawnych wierszy hotspotów (wymagane: date, lat, lon).',
  importErrorParse: 'Nie udało się odczytać pliku. Sprawdź poprawność formatu CSV lub JSON.',
  downloadTitle: 'Pobierz Analitykę i Wizualizacje',
  downloadCsvBtn: 'Hotspoty CSV',
  downloadJsonBtn: 'Analityka JSON',
  downloadSvgBtn: 'Wykresy SVG',
  downloadPngBtn: 'Raport PNG',
  recordsCountLabel: 'pasujących rekordów',
  backendLiveLabel: 'Dane na żywo NASA FIRMS',
  backendDownloadingLabel: 'Pobieranie danych z NASA FIRMS',
  backendOfflineLabel: 'Próba lokalna (API offline)',
  backendChunksLabel: 'paczek',

  // Map & Globe Layers
  layersBtn: 'Warstwy',
  layersTitle: 'Warstwy Globu',
  layersZoomBadge: 'Powiększenie',
  layersResetBtn: 'Resetuj',
  layersSectionFire: 'Pożary i Analiza',
  layersSectionBase: 'Kartografia',
  layerHotspots: 'Zharmonizowane Hotspoty',
  layerRegionBbox: 'Ramka Graniczna Regionu',
  layerWindStreamlines: 'Strumienie Wiatru',
  layerEscapeRoutes: 'Trasy Ewakuacyjne',
  layerLandOrtho: 'Ortofotomapa Satelitarna',
  layerOsmTiles: 'OpenStreetMap (Adaptacyjna)',
  layerForests: 'Pokrywa Leśna (MODIS)',
  layerUrbanAreas: 'Obszary Miejskie',
  layerBorders: 'Granice Administracyjne',
  layerRoads: 'Sieć Drogowa',
  layerGraticule: 'Siatka Współrzędnych'
};
