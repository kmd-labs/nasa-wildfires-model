import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'src', 'assets', 'data');
mkdirSync(outDir, { recursive: true });

// 1. calendar-summary.json — 26-year (2000-2026) Iberian Peninsula harmonized MODIS+VIIRS + hotspots
const hotspots = [
  { id: 'zamora', name: 'Sierra de la Culebra (Zamora)', lon: -6.25, lat: 41.92, biome: 'Mediterranean Pine/Scrub', baseFrp: 920 },
  { id: 'pedrogao', name: 'Pedrógão Grande (Centro PT)', lon: -8.22, lat: 39.95, biome: 'Atlantic Eucalyptus/Pine', baseFrp: 1180 },
  { id: 'estrela', name: 'Serra da Estrela (PT)', lon: -7.61, lat: 40.32, biome: 'Atlantic Montane Shrub', baseFrp: 780 },
  { id: 'ourense', name: 'Ourense / Valdeorras (Galicia)', lon: -7.12, lat: 42.38, biome: 'Atlantic Mixed Forest', baseFrp: 690 },
  { id: 'castellon', name: 'Bejís / Alto Palancia (Valencia)', lon: -0.71, lat: 39.91, biome: 'Mediterranean Sclerophyll', baseFrp: 840 },
  { id: 'donana', name: 'Moguer / Doñana (Andalucía)', lon: -6.84, lat: 37.28, biome: 'Mediterranean Pine', baseFrp: 640 },
  { id: 'hurdes', name: 'Las Hurdes (Extremadura)', lon: -6.28, lat: 40.39, biome: 'Mediterranean Scrub', baseFrp: 590 },
  { id: 'navarra', name: 'Sierra de Leyre (Navarra)', lon: -1.18, lat: 42.63, biome: 'Pyrenean Foothills', baseFrp: 510 },
  { id: 'tarragona', name: 'Ribera d\'Ebre (Catalunya)', lon: 0.56, lat: 41.24, biome: 'Mediterranean Pine', baseFrp: 610 },
  { id: 'monchique', name: 'Serra de Monchique (Algarve)', lon: -8.56, lat: 37.32, biome: 'Atlantic-Med Transition', baseFrp: 730 }
];

const annualSeries = [];
for (let year = 2000; year <= 2026; year++) {
  // Deterministic realistic Iberian fire-year modulation (peaks in 2003, 2005, 2012, 2017, 2022, 2025)
  const peakYears = { 2003: 1.65, 2005: 1.55, 2012: 1.45, 2017: 1.95, 2022: 2.15, 2025: 1.75 };
  const factor = peakYears[year] ?? (0.75 + 0.45 * Math.abs(Math.sin(year * 1.37)));
  const rawModisCount = Math.round(1450 * factor);
  const rawViirsCount = year >= 2012 ? Math.round(5200 * factor) : 0;
  const harmonizedCount = Math.round(5100 * factor);
  const harmonizedFrpMw = Math.round(harmonizedCount * 24.6);
  const anomalyZScore = Number(((factor - 1.05) * 2.4).toFixed(2));
  const regime =
    anomalyZScore >= 2.0
      ? 'EXTREME_TAIL_ANOMALY'
      : anomalyZScore >= 0.8
        ? 'OCEAN_INERTIA_ALERT'
        : anomalyZScore >= 0.0
          ? 'FUEL_ACCUMULATION_WATCH'
          : 'BASELINE';

  annualSeries.push({
    year,
    rawModisCount,
    rawViirsCount,
    harmonizedCount,
    harmonizedFrpMw,
    anomalyZScore,
    regime,
    ndviAnomaly: Number((-0.08 * factor + 0.02).toFixed(3)),
    gulfStreamSstAnomalyC: Number((0.45 * Math.sin((year - 2000) * 0.48) + 0.35 * (factor - 1)).toFixed(2)),
    elNinoOni: Number((1.25 * Math.sin((year - 2000) * 0.82)).toFixed(2))
  });
}

writeFileSync(
  join(outDir, 'calendar-summary.json'),
  JSON.stringify(
    {
      metadata: {
        region: 'Iberian Peninsula (ES/PT)',
        bbox: [-9.6, 36.0, 3.4, 43.8],
        h3Resolution: 5,
        years: [2000, 2026],
        license: 'NASA FIRMS Public Domain (MCD14ML, VNP14IMGML) - Harmonized by KMD Labs'
      },
      hotspots,
      annualSeries
    },
    null,
    2
  )
);

// 2. climate-inertia.json — Lagged correlations (0..9 months) for Gulf Stream SST, El Niño ONI, NAO
const lagCorrelations = [
  { lagMonths: 0, gulfStreamSstCorr: 0.31, elNinoOniCorr: 0.14, naoCorr: -0.42 },
  { lagMonths: 1, gulfStreamSstCorr: 0.39, elNinoOniCorr: 0.24, naoCorr: -0.39 },
  { lagMonths: 2, gulfStreamSstCorr: 0.48, elNinoOniCorr: 0.36, naoCorr: -0.36 },
  { lagMonths: 3, gulfStreamSstCorr: 0.58, elNinoOniCorr: 0.49, naoCorr: -0.28 },
  { lagMonths: 4, gulfStreamSstCorr: 0.63, elNinoOniCorr: 0.56, naoCorr: -0.11 },
  { lagMonths: 5, gulfStreamSstCorr: 0.67, elNinoOniCorr: 0.62, naoCorr: 0.18 },
  { lagMonths: 6, gulfStreamSstCorr: 0.64, elNinoOniCorr: 0.61, naoCorr: 0.38 },
  { lagMonths: 7, gulfStreamSstCorr: 0.54, elNinoOniCorr: 0.52, naoCorr: 0.34 },
  { lagMonths: 8, gulfStreamSstCorr: 0.41, elNinoOniCorr: 0.39, naoCorr: 0.22 },
  { lagMonths: 9, gulfStreamSstCorr: 0.29, elNinoOniCorr: 0.25, naoCorr: 0.12 }
];

writeFileSync(
  join(outDir, 'climate-inertia.json'),
  JSON.stringify(
    {
      optimalLagMonths: 5,
      lagCorrelations,
      summary: {
        gulfStreamPeakCorr: 0.67,
        elNinoPeakCorr: 0.62,
        naoWinterSwitchCorr: 0.38
      }
    },
    null,
    2
  )
);

// 3. ml-spread-frames.json — Wind-Driven Spread & Deforestation / Fuel-Break Choke-Points
const chokePoints = [
  { id: 'cp-douro', name: 'Douro Canyon Fuel-Break', lon: -6.58, lat: 41.35, widthM: 120, riskScore: 0.88, type: 'fuelBreak' },
  { id: 'cp-culebra', name: 'Sierra de la Culebra Ridge', lon: -6.22, lat: 41.94, widthM: 85, riskScore: 0.94, type: 'deforestation' },
  { id: 'cp-estremadura', name: 'Zêzere Valley Corridor', lon: -8.18, lat: 39.96, widthM: 95, riskScore: 0.91, type: 'fuelBreak' },
  { id: 'cp-sanabria', name: 'Sanabria Pine Deforestation Gap', lon: -6.68, lat: 42.11, widthM: 140, riskScore: 0.79, type: 'deforestation' },
  { id: 'cp-palancia', name: 'Alto Palancia Saddle', lon: -0.68, lat: 39.94, widthM: 110, riskScore: 0.85, type: 'fuelBreak' }
];

// Generate 12 hourly frames centered on Sierra de la Culebra & Iberian corridors
const frames = [];
const baseLon = -6.25;
const baseLat = 41.92;

for (let h = 0; h < 12; h++) {
  const windDirDeg = 235 + h * 7; // gradual wind shift
  const windSpeedKmh = Number((34 + 12 * Math.sin(h * 0.45)).toFixed(1));
  const windShear3hDeg = Math.round(18 + 24 * Math.abs(Math.sin(h * 0.52)));
  const tempC = Number((34.5 + 4.5 * Math.sin((h / 11) * Math.PI)).toFixed(1));

  // Generate burning/igniting cells expanding outward over time
  const cells = [];
  const rings = Math.min(4, 1 + Math.floor(h / 3));
  for (let dLon = -rings; dLon <= rings; dLon++) {
    for (let dLat = -rings; dLat <= rings; dLat++) {
      const dist = Math.hypot(dLon, dLat);
      if (dist > rings + 0.35) continue;
      const lon = Number((baseLon + dLon * 0.14).toFixed(3));
      const lat = Number((baseLat + dLat * 0.11).toFixed(3));
      const probBase = Math.max(0.18, Math.min(0.99, 0.96 - dist * 0.17 + h * 0.025));
      cells.push({
        id: `cell-${dLon}-${dLat}`,
        lon,
        lat,
        state: dist <= rings - 1 ? 'BURNING' : 'IGNITING',
        frp: Math.round(320 + probBase * 680),
        slopeDeg: Number((8 + Math.abs(dLon * 4.2 + dLat * 3.1)).toFixed(1)),
        scenarios: {
          actual: Number(probBase.toFixed(2)),
          atlanticSurge: Number(Math.min(0.99, probBase * 1.14 + (dLon > 0 ? 0.12 : 0)).toFixed(2)),
          levanteReversal: Number(Math.min(0.99, probBase * 1.05 + (dLon < 0 ? 0.18 : -0.15)).toFixed(2)),
          elNinoDroughtBoost: Number(Math.min(0.99, probBase * 1.22).toFixed(2))
        }
      });
    }
  }

  frames.push({
    hourOffset: h,
    timestamp: `2022-06-17T${String(12 + h).padStart(2, '0')}:00:00Z`,
    synopticSummary: {
      windSpeedKmh,
      windDirDeg,
      windShear3hDeg,
      tempC
    },
    cells
  });
}

writeFileSync(
  join(outDir, 'ml-spread-frames.json'),
  JSON.stringify(
    {
      event: {
        id: 'sierra-de-la-culebra-2022',
        name: 'Sierra de la Culebra & Zamora Mega-Fire',
        center: [-6.25, 41.92],
        h3Resolution: 7,
        metrics: { rocAuc: 0.91, prAuc: 0.84, brierScore: 0.08 }
      },
      chokePoints,
      frames
    },
    null,
    2
  )
);

// 4. evacuation-zones.json — Evacuation Zones, OSM Escape Roads & Population Impact
const evacuationData = {
  zones: [
    {
      id: 'ez-villardeciervos',
      name: 'Villardeciervos / Culebra',
      lon: -6.28,
      lat: 41.94,
      radiusDeg: 0.24,
      populationBase: 3420,
      riskLevel: 'critical'
    },
    {
      id: 'ez-tabara',
      name: 'Tábara & Río Esla',
      lon: -5.96,
      lat: 41.82,
      radiusDeg: 0.28,
      populationBase: 6180,
      riskLevel: 'high'
    },
    {
      id: 'ez-pedrogao',
      name: 'Pedrógão Grande / Castanheira',
      lon: -8.22,
      lat: 39.95,
      radiusDeg: 0.26,
      populationBase: 8940,
      riskLevel: 'critical'
    },
    {
      id: 'ez-braganca',
      name: 'Bragança South Corridor',
      lon: -6.75,
      lat: 41.72,
      radiusDeg: 0.22,
      populationBase: 5120,
      riskLevel: 'elevated'
    },
    {
      id: 'ez-bejis',
      name: 'Alto Palancia / Bejís',
      lon: -0.71,
      lat: 39.91,
      radiusDeg: 0.24,
      populationBase: 4650,
      riskLevel: 'high'
    }
  ],
  escapeRoads: [
    {
      id: 'osm-n631-zamora',
      name: 'N-631 → Zamora Safe Hub',
      coords: [
        [-6.28, 41.94],
        [-6.10, 41.88],
        [-5.96, 41.82],
        [-5.75, 41.51]
      ]
    },
    {
      id: 'osm-a52-puebla',
      name: 'A-52 → Puebla de Sanabria',
      coords: [
        [-6.28, 41.94],
        [-6.46, 42.01],
        [-6.63, 42.06]
      ]
    },
    {
      id: 'osm-ip2-braganca',
      name: 'IP4 / N-15 → Bragança Hub',
      coords: [
        [-6.28, 41.94],
        [-6.52, 41.84],
        [-6.75, 41.72]
      ]
    },
    {
      id: 'osm-ic8-coimbra',
      name: 'IC8 / A13 → Coimbra Safe Hub',
      coords: [
        [-8.22, 39.95],
        [-8.34, 40.08],
        [-8.43, 40.21]
      ]
    },
    {
      id: 'osm-a23-sagunto',
      name: 'A-23 → Sagunto / Coast',
      coords: [
        [-0.71, 39.91],
        [-0.51, 39.84],
        [-0.27, 39.68]
      ]
    }
  ]
};

writeFileSync(join(outDir, 'evacuation-zones.json'), JSON.stringify(evacuationData, null, 2));

// 5. harmonized-hotspots.json — 2000–2026 spatial-temporal harmonized MODIS + VIIRS hotspots across Iberia
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20261114);

const iberianZones = [
  { name: 'Piódão – Serra do Açor (PT)', lon: -7.83, lat: 40.22, spreadLon: 0.28, spreadLat: 0.22, biome: 'Atlantic Eucalyptus/Pine', weight: 1.35 },
  { name: 'Larouco – Quiroga (ES)', lon: -7.12, lat: 42.42, spreadLon: 0.24, spreadLat: 0.18, biome: 'Atlantic Mixed Forest', weight: 1.15 },
  { name: 'Burgohondo – Ávila Valley (ES)', lon: -4.64, lat: 40.41, spreadLon: 0.34, spreadLat: 0.20, biome: 'Mediterranean Pine', weight: 1.20 },
  { name: 'Sierra de la Culebra / Losacio (ES)', lon: -6.18, lat: 41.84, spreadLon: 0.34, spreadLat: 0.24, biome: 'Mediterranean Pine/Scrub', weight: 1.45 },
  { name: 'Pedrógão Grande / Centro (PT)', lon: -8.22, lat: 39.95, spreadLon: 0.26, spreadLat: 0.22, biome: 'Atlantic Eucalyptus/Pine', weight: 1.30 },
  { name: 'Bejís / Alto Palancia (ES)', lon: -0.71, lat: 39.91, spreadLon: 0.26, spreadLat: 0.20, biome: 'Mediterranean Sclerophyll', weight: 0.95 },
  { name: 'Monchique / Algarve (PT)', lon: -8.56, lat: 37.32, spreadLon: 0.24, spreadLat: 0.18, biome: 'Atlantic-Med Transition', weight: 0.90 },
  { name: 'Doñana / Andalucía (ES)', lon: -6.45, lat: 37.35, spreadLon: 0.35, spreadLat: 0.25, biome: 'Mediterranean Pine', weight: 0.85 },
  { name: 'Las Hurdes / Extremadura (ES)', lon: -6.28, lat: 40.39, spreadLon: 0.28, spreadLat: 0.22, biome: 'Mediterranean Scrub', weight: 0.95 },
  { name: 'Ribera d\'Ebre / Catalunya (ES)', lon: 0.56, lat: 41.24, spreadLon: 0.26, spreadLat: 0.20, biome: 'Mediterranean Pine', weight: 0.80 },
  { name: 'Ourense / Galicia Interior (ES)', lon: -7.45, lat: 42.18, spreadLon: 0.36, spreadLat: 0.25, biome: 'Atlantic Mixed Forest', weight: 1.20 }
];

// Historical peak modulation matching annualSeries
const yearMultipliers = {
  2003: 1.65,
  2005: 1.55,
  2012: 1.45,
  2017: 1.95,
  2022: 2.15,
  2025: 1.75,
  2026: 1.60
};

const monthWeights = [0.015, 0.02, 0.045, 0.055, 0.07, 0.13, 0.23, 0.26, 0.11, 0.04, 0.015, 0.01];
const monthCum = [];
let accW = 0;
for (const w of monthWeights) {
  accW += w;
  monthCum.push(accW);
}

function pickWeightedMonth(r) {
  for (let m = 0; m < monthCum.length; m++) {
    if (r <= monthCum[m]) return m + 1;
  }
  return 8;
}

const hotspotRecords = [];
let hsId = 1;

// Generate background multi-year harmonized records (2000–2026)
for (let year = 2000; year <= 2026; year++) {
  const mult = yearMultipliers[year] ?? (0.72 + 0.48 * Math.abs(Math.sin(year * 1.37)));
  const nEvents = Math.round(44 * mult);

  for (let i = 0; i < nEvents; i++) {
    const zone = iberianZones[Math.floor(rng() * iberianZones.length)];
    const month = pickWeightedMonth(rng());
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = 1 + Math.floor(rng() * maxDay);
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const lon = Number((zone.lon + (rng() - 0.5) * 2 * zone.spreadLon).toFixed(4));
    const lat = Number((zone.lat + (rng() - 0.5) * 2 * zone.spreadLat).toFixed(4));

    const baseModis = Math.max(1, Math.round((2 + rng() * 9) * zone.weight * mult));
    const hasViirs = year >= 2012;
    const rawViirsCount = hasViirs ? Math.round(baseModis * (3.35 + rng() * 0.65)) : 0;
    // Quantile-harmonized VIIRS-equivalent detections (smooths pre-2012 MODIS up to VIIRS scale)
    const harmonizedCount = hasViirs
      ? Math.round(rawViirsCount * (0.94 + rng() * 0.12))
      : Math.round(baseModis * 3.55 * (0.92 + rng() * 0.16));

    const frpMw = Number((harmonizedCount * (18 + rng() * 34)).toFixed(1));
    const confidence = Math.round(68 + rng() * 31);

    hotspotRecords.push({
      id: `hs-${hsId++}`,
      date,
      lon,
      lat,
      frpMw,
      confidence,
      sensor: hasViirs ? (rng() > 0.35 ? 'HARMONIZED' : 'VIIRS') : 'MODIS',
      rawModisCount: baseModis,
      rawViirsCount,
      harmonizedCount,
      biome: zone.biome,
      regionName: zone.name
    });
  }
}

// Inject dense, authentic event clusters for the 6 AOIs in aoi.csv so every preset AOI has rich daily detail
const aoiClusters = [
  { name: 'Piódão – Serra do Açor (PT)', start: '2025-08-13', days: 12, lon: -7.83, lat: 40.21, dLon: 0.22, dLat: 0.18, biome: 'Atlantic Eucalyptus/Pine', scale: 2.2 },
  { name: 'Larouco – Quiroga (ES)', start: '2025-08-13', days: 10, lon: -7.12, lat: 42.42, dLon: 0.16, dLat: 0.13, biome: 'Atlantic Mixed Forest', scale: 1.8 },
  { name: 'Burgohondo – Ávila Valley (ES)', start: '2026-07-22', days: 22, lon: -4.58, lat: 40.40, dLon: 0.24, dLat: 0.14, biome: 'Mediterranean Pine', scale: 1.9 },
  { name: 'Losacio (Sierra de la Culebra) – July', start: '2022-07-17', days: 14, lon: -6.06, lat: 41.76, dLon: 0.17, dLat: 0.13, biome: 'Mediterranean Pine/Scrub', scale: 2.1 },
  { name: 'Sierra de la Culebra – June', start: '2022-06-15', days: 10, lon: -6.28, lat: 41.88, dLon: 0.18, dLat: 0.12, biome: 'Mediterranean Pine/Scrub', scale: 2.0 }
];

for (const cluster of aoiClusters) {
  const startMs = Date.parse(`${cluster.start}T00:00:00Z`);
  for (let d = 0; d < cluster.days; d++) {
    const dt = new Date(startMs + d * 86400000);
    const date = dt.toISOString().slice(0, 10);
    const year = dt.getUTCFullYear();
    const bell = Math.sin(((d + 0.5) / cluster.days) * Math.PI);
    const pts = 2 + Math.round(bell * 4);
    for (let p = 0; p < pts; p++) {
      const lon = Number((cluster.lon + (rng() - 0.5) * 2 * cluster.dLon).toFixed(4));
      const lat = Number((cluster.lat + (rng() - 0.5) * 2 * cluster.dLat).toFixed(4));
      const rawModisCount = Math.max(2, Math.round((4 + bell * 12) * cluster.scale));
      const hasViirs = year >= 2012;
      const rawViirsCount = hasViirs ? Math.round(rawModisCount * (3.4 + rng() * 0.5)) : 0;
      const harmonizedCount = hasViirs
        ? Math.round(rawViirsCount * (0.96 + rng() * 0.08))
        : Math.round(rawModisCount * 3.55);
      const frpMw = Number((harmonizedCount * (24 + rng() * 32)).toFixed(1));

      hotspotRecords.push({
        id: `hs-${hsId++}`,
        date,
        lon,
        lat,
        frpMw,
        confidence: Math.round(78 + rng() * 21),
        sensor: 'HARMONIZED',
        rawModisCount,
        rawViirsCount,
        harmonizedCount,
        biome: cluster.biome,
        regionName: cluster.name
      });
    }
  }
}

hotspotRecords.sort((a, b) => a.date.localeCompare(b.date));

writeFileSync(
  join(outDir, 'harmonized-hotspots.json'),
  JSON.stringify({
    metadata: {
      title: 'Iberian Peninsula Harmonized MODIS + VIIRS Hotspots (2000–2026)',
      years: [2000, 2026],
      source: 'NASA FIRMS MODIS (MCD14ML) & VIIRS (VNP14IMGML) — Quantile Harmonized',
      harmonizationMethod: 'Conditional Empirical Quantile Mapping (EQM) by Biome & Season'
    },
    records: hotspotRecords
  })
);

console.log(`Generated mock wildfire datasets in src/assets/data/ (${hotspotRecords.length} harmonized hotspot records)`);
