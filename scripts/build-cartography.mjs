import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../src/assets/data');

const BBOX = {
  minLon: -25.0,
  maxLon: 32.0,
  minLat: 20.0,
  maxLat: 72.0
};

function roundCoord(c, scale = 500) {
  return Math.round(c * scale) / scale;
}

function simplifyPoints(coords, scale = 500) {
  const result = [];
  let lastX = null;
  let lastY = null;
  for (const pt of coords) {
    if (!pt || pt.length < 2) continue;
    const rx = roundCoord(pt[0], scale);
    const ry = roundCoord(pt[1], scale);
    if (rx !== lastX || ry !== lastY) {
      result.push([rx, ry]);
      lastX = rx;
      lastY = ry;
    }
  }
  return result;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to GET ${url}: HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function streamGeoJson(url, onFeature) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to GET ${url}: HTTP ${res.statusCode}`));
      }
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('{"type":"Feature"')) !== -1) {
          const nextIdx = buffer.indexOf('{"type":"Feature"', idx + 1);
          if (nextIdx === -1) break;
          const featStr = buffer.slice(idx, nextIdx).replace(/,\s*$/, '');
          try {
            const feat = JSON.parse(featStr);
            onFeature(feat);
          } catch {
            // ignore partial chunk
          }
          buffer = buffer.slice(nextIdx);
        }
      });
      res.on('end', () => {
        if (buffer.startsWith('{"type":"Feature"')) {
          const endIdx = buffer.lastIndexOf('}');
          if (endIdx !== -1) {
            try {
              const feat = JSON.parse(buffer.slice(0, endIdx + 1));
              onFeature(feat);
            } catch {}
          }
        }
        resolve();
      });
    }).on('error', reject);
  });
}

function buildSpatialTester(landFeatures, filterCodes = null) {
  const polys = [];
  for (const f of landFeatures) {
    if (filterCodes && !filterCodes.has(f.properties?.code)) continue;
    const g = f.geometry;
    if (!g) continue;
    const arr = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const p of arr) {
      const r = p[0];
      if (!r || r.length < 4) continue;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of r) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      polys.push({ r, holes: p.slice(1), x0, x1, y0, y1, code: f.properties?.code });
    }
  }

  function ptInRing(px, py, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  return function onLand(px, py) {
    for (const p of polys) {
      if (px < p.x0 || px > p.x1 || py < p.y0 || py > p.y1) continue;
      if (ptInRing(px, py, p.r)) {
        let inHole = false;
        for (const h of p.holes) {
          if (h.length >= 4 && ptInRing(px, py, h)) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }
    return false;
  };
}

async function buildLandAndCountries() {
  console.log('1/5 Extracting 10m Euro-Mediterranean & North African land + 50m rest-of-world countries...');
  const countries10mUrl = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson';
  const countries50mUrl = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

  const target10mCodes = new Set([
    'ESP', 'PRT', 'AND', 'GIB',
    'FRA', 'MCO',
    'GBR', 'IRL', 'IMN', 'JEY', 'GGY',
    'BEL', 'NLD', 'LUX', 'DEU', 'CHE', 'AUT', 'LIE',
    'ITA', 'SMR', 'VAT', 'MLT',
    'POL', 'CZE', 'SVK', 'HUN',
    'SVN', 'HRV', 'BIH', 'SRB', 'MNE', 'ALB', 'MKD', 'KOS', 'GRC',
    'BGR', 'ROU', 'MDA', 'UKR', 'BLR', 'LTU', 'LVA', 'EST',
    'DNK', 'NOR', 'SWE', 'FIN', 'ISL', 'FRO',
    'MAR', 'DZA', 'TUN', 'LBY', 'EGY', 'ESH', 'MRT',
    'TUR', 'CYP'
  ]);

  const features = [];
  const foundCodes = new Set();

  await streamGeoJson(countries10mUrl, (feat) => {
    const code = feat.properties?.ADM0_A3 || feat.properties?.ISO_A3;
    if (!target10mCodes.has(code)) return;

    const geom = feat.geometry;
    if (!geom) return;

    if (geom.type === 'Polygon') {
      geom.coordinates = geom.coordinates.map(r => simplifyPoints(r, 400)).filter(r => r.length >= 4);
      if (geom.coordinates.length === 0) return;
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates = geom.coordinates
        .map(poly => poly.map(r => simplifyPoints(r, 400)).filter(r => r.length >= 4))
        .filter(poly => poly.length > 0);
      if (geom.coordinates.length === 0) return;
    } else {
      return;
    }

    foundCodes.add(code);
    features.push({
      type: 'Feature',
      properties: { code, name: feat.properties?.NAME, res: '10m' },
      geometry: geom
    });
  });

  const c50 = await fetchJson(countries50mUrl);
  for (const feat of c50.features || []) {
    const code = feat.properties?.ADM0_A3 || feat.properties?.ISO_A3;
    if (foundCodes.has(code) || target10mCodes.has(code)) continue;
    const geom = feat.geometry;
    if (!geom) continue;
    if (geom.type === 'Polygon') {
      geom.coordinates = geom.coordinates.map(r => simplifyPoints(r, 100)).filter(r => r.length >= 4);
      if (geom.coordinates.length === 0) continue;
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates = geom.coordinates
        .map(poly => poly.map(r => simplifyPoints(r, 100)).filter(r => r.length >= 4))
        .filter(poly => poly.length > 0);
      if (geom.coordinates.length === 0) continue;
    } else {
      continue;
    }
    features.push({
      type: 'Feature',
      properties: { code, name: feat.properties?.NAME, res: '50m' },
      geometry: geom
    });
  }

  const targetPath = path.join(DATA_DIR, 'uk-land-10m.json');
  fs.writeFileSync(targetPath, JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`Saved unified 10m+50m land to ${targetPath}: ${features.length} countries (${(fs.statSync(targetPath).size / 1024).toFixed(1)} KB)`);
  return features;
}

async function buildStates10m(onLand) {
  console.log('2/5 Extracting 10m Admin-1 provincial/regional boundaries (clipped to land)...');
  const borders1Url = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces_lines.geojson';
  const b1 = await fetchJson(borders1Url);

  const regionalCodes = new Set([
    'ESP', 'PRT', 'FRA', 'ITA', 'DEU', 'GBR', 'IRL',
    'BEL', 'NLD', 'LUX', 'CHE', 'AUT', 'POL', 'CZE', 'SVK', 'HUN',
    'MAR', 'DZA', 'TUN', 'NOR', 'SWE', 'DNK'
  ]);

  const regional = [];

  const addClippedLine = (coords) => {
    const simp = simplifyPoints(coords, 400);
    let cur = [];
    for (const pt of simp) {
      if (onLand(pt[0], pt[1])) {
        cur.push(pt);
      } else {
        if (cur.length >= 2) regional.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 2) regional.push(cur);
  };

  for (const feat of b1.features || []) {
    const code = feat.properties?.ADM0_A3;
    if (!regionalCodes.has(code)) continue;
    const geom = feat.geometry;
    if (!geom) continue;
    if (geom.type === 'LineString') addClippedLine(geom.coordinates);
    else if (geom.type === 'MultiLineString') {
      for (const l of geom.coordinates) addClippedLine(l);
    }
  }

  const targetPath = path.join(DATA_DIR, 'uk-states-10m.json');
  fs.writeFileSync(targetPath, JSON.stringify(regional));
  console.log(`Saved 10m regional boundaries to ${targetPath}: ${regional.length} lines (${(fs.statSync(targetPath).size / 1024).toFixed(1)} KB)`);
}

async function buildCities10m(onLand) {
  console.log('3/5 Extracting 10m urban boundaries (strictly inside 10m land)...');
  const urbanUrl = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_urban_areas.geojson';
  const cityLimits = [];

  await streamGeoJson(urbanUrl, (feat) => {
    const [minX, minY, maxX, maxY] = feat.bbox || [-180, -90, 180, 90];
    if (maxX < BBOX.minLon || minX > BBOX.maxLon || maxY < BBOX.minLat || minY > BBOX.maxLat) return;

    const area = feat.properties?.area_sqkm ?? 0;
    if (area < 12) return;

    const processRing = (coords) => {
      const ring = simplifyPoints(coords, 400);
      if (ring.length < 4) return;
      // Compute centroid of urban polygon
      let cx = 0, cy = 0;
      for (const [x, y] of ring) {
        cx += x;
        cy += y;
      }
      cx /= ring.length;
      cy /= ring.length;

      // Filter/pull any coastal harbor vertices slightly inland so no city vertex steps over the coastline
      const clamped = [];
      for (const [x, y] of ring) {
        if (onLand(x, y)) {
          clamped.push([x, y]);
        } else {
          // Binary search towards centroid
          let ax = x, ay = y;
          let found = false;
          for (let s = 1; s <= 5; s++) {
            const t = s / 5;
            const tx = x + (cx - x) * t;
            const ty = y + (cy - y) * t;
            if (onLand(tx, ty)) {
              ax = roundCoord(tx, 400);
              ay = roundCoord(ty, 400);
              found = true;
              break;
            }
          }
          if (found) clamped.push([ax, ay]);
        }
      }
      if (clamped.length >= 4) {
        cityLimits.push(clamped);
      }
    };

    const geom = feat.geometry;
    if (!geom) return;
    if (geom.type === 'Polygon') {
      for (const ring of geom.coordinates) processRing(ring);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        for (const ring of poly) processRing(ring);
      }
    }
  });

  const targetPath = path.join(DATA_DIR, 'uk-cities-10m.json');
  fs.writeFileSync(targetPath, JSON.stringify(cityLimits));
  console.log(`Saved 10m cities to ${targetPath}: ${cityLimits.length} polygons (${(fs.statSync(targetPath).size / 1024).toFixed(1)} KB)`);
  return cityLimits;
}

async function buildRoads10m(onLand) {
  console.log('4/5 Extracting 10m highway & secondary road network (strictly clipped to 10m land)...');
  const roadsUrl = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson';
  const highways = [];
  const secondary = [];

  await streamGeoJson(roadsUrl, (feat) => {
    const [minX, minY, maxX, maxY] = feat.bbox || [-180, -90, 180, 90];
    if (maxX < BBOX.minLon || minX > BBOX.maxLon || maxY < BBOX.minLat || minY > BBOX.maxLat) return;

    const type = feat.properties?.type;
    if (type && type.toLowerCase().includes('ferry')) return;

    const isExpressway = feat.properties?.expressway === 1;
    const isMajor = type === 'Major Highway' || type === 'Beltway' || isExpressway;

    const processLine = (coords) => {
      const simp = simplifyPoints(coords, 400);
      let cur = [];
      for (const pt of simp) {
        if (onLand(pt[0], pt[1])) {
          cur.push(pt);
        } else {
          if (cur.length >= 2) {
            if (isMajor) highways.push(cur);
            else secondary.push(cur);
          }
          cur = [];
        }
      }
      if (cur.length >= 2) {
        if (isMajor) highways.push(cur);
        else secondary.push(cur);
      }
    };

    const geom = feat.geometry;
    if (!geom) return;
    if (geom.type === 'LineString') {
      processLine(geom.coordinates);
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) processLine(line);
    }
  });

  const targetPath = path.join(DATA_DIR, 'uk-roads-10m.json');
  fs.writeFileSync(targetPath, JSON.stringify({ highways, secondary }));
  console.log(`Saved 10m roads to ${targetPath}: ${highways.length} highways, ${secondary.length} secondary (${(fs.statSync(targetPath).size / 1024).toFixed(1)} KB)`);
}

function buildContourIberiaForests(landFeatures, cityRings) {
  console.log('5/5 Generating Marching-Squares GIS forest & woodland contour polygons across Iberia & SW Europe...');
  const forestCountrySet = new Set(['ESP', 'PRT', 'AND', 'FRA', 'MAR', 'DZA']);
  const onIberia = buildSpatialTester(landFeatures, forestCountrySet);

  // Build spatial lookup for cities so forests wrap naturally around urban areas
  const iberiaCities = [];
  for (const r of cityRings) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of r) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 >= -9.8 && x0 <= 4.6 && y1 >= 34.5 && y0 <= 45.8) {
      iberiaCities.push({ r, x0: x0 - 0.03, x1: x1 + 0.03, y0: y0 - 0.03, y1: y1 + 0.03 });
    }
  }

  function nearCity(px, py) {
    for (const c of iberiaCities) {
      if (px >= c.x0 && px <= c.x1 && py >= c.y0 && py <= c.y1) return true;
    }
    return false;
  }

  // Deterministic 2D value/gradient noise for realistic dendritic mountain/valley contours
  function hash2(ix, iy) {
    let h = (ix * 374761393 + iy * 668265263) ^ 0x5bf03635;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function vnoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy);
    const b = hash2(ix + 1, iy);
    const c = hash2(ix, iy + 1);
    const d = hash2(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  function fbm(lon, lat) {
    // High-frequency anisotropic ridge-and-valley multi-octave noise
    const u = lon * 1.15 + lat * 0.35;
    const v = -lon * 0.35 + lat * 1.35;
    let val = 0;
    let amp = 0.54;
    let freq = 7.5;
    for (let o = 0; o < 5; o++) {
      const n = vnoise(u * freq + o * 17.3, v * freq + o * 31.7);
      const ridge = 1.0 - Math.abs(2.0 * n - 1.0);
      val += (0.40 * n + 0.60 * ridge * ridge) * amp;
      freq *= 2.12;
      amp *= 0.52;
    }
    return val;
  }

  // Distance to segment helper for mountain ranges & forested belts
  function distToSpine(px, py, pts) {
    let minD = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const d = Math.hypot((px - cx) * 0.82, py - cy);
      if (d < minD) minD = d;
    }
    return minD;
  }

  // Real Iberian forest massifs, mountain systems, pine belts & dehesa/montado corridors
  const massifs = [
    // Atlantic Green Belt (Galicia, Minho, Trás-os-Montes, Asturias, Cantabria, Basque Country)
    { pts: [[-9.1, 43.1], [-8.2, 43.4], [-7.3, 43.5], [-6.2, 43.1], [-4.8, 43.2], [-3.5, 43.1], [-2.2, 43.0], [-1.2, 42.9]], r: 0.65, w: 0.85 },
    { pts: [[-8.6, 42.1], [-8.2, 42.8], [-7.6, 43.1], [-7.0, 42.7], [-6.7, 42.0]], r: 0.62, w: 0.82 },
    { pts: [[-8.5, 41.8], [-7.9, 41.9], [-7.2, 41.9], [-6.4, 41.9]], r: 0.55, w: 0.78 },
    // Northern & Central Portugal (Pinhal Interior, Beiras, Lousã, Estrela, Caramulo, Marão, Leiria)
    { pts: [[-8.4, 41.3], [-7.9, 41.3], [-7.8, 40.8], [-8.2, 40.5], [-8.9, 39.8]], r: 0.55, w: 0.82 },
    { pts: [[-8.4, 40.2], [-7.9, 40.2], [-7.5, 40.4], [-7.1, 40.3]], r: 0.52, w: 0.82 },
    { pts: [[-8.3, 39.8], [-7.9, 39.8], [-7.4, 39.5], [-7.2, 39.2]], r: 0.48, w: 0.76 },
    // Alentejo Montado & SW Portugal (Sintra, Grândola, Monchique, Caldeirão)
    { pts: [[-8.6, 39.1], [-8.1, 38.9], [-7.6, 38.7], [-7.4, 38.2]], r: 0.48, w: 0.65 },
    { pts: [[-8.7, 38.2], [-8.5, 37.7], [-8.6, 37.3], [-7.9, 37.3]], r: 0.42, w: 0.75 },
    // Pyrenees & Pre-Pyrenees (Navarra, Aragón, Andorra, Catalonia)
    { pts: [[-1.5, 42.9], [-0.4, 42.7], [0.7, 42.6], [1.6, 42.5], [2.4, 42.3], [3.0, 42.3]], r: 0.58, w: 0.86 },
    { pts: [[-0.8, 42.4], [0.3, 42.2], [1.4, 42.1], [2.4, 41.8], [2.8, 41.9]], r: 0.50, w: 0.76 },
    // Catalonian Coastal & Pre-Coastal Ranges (Montseny, Prades, Ports de Tortosa-Beseit)
    { pts: [[2.5, 41.8], [1.9, 41.5], [1.0, 41.3], [0.2, 40.8]], r: 0.42, w: 0.74 },
    // Sistema Central (Gata, Francia, Gredos, Guadarrama, Ayllón) & Tierra de Pinares
    { pts: [[-6.8, 40.3], [-5.9, 40.4], [-5.0, 40.3], [-4.1, 40.8], [-3.2, 41.2]], r: 0.52, w: 0.84 },
    { pts: [[-4.7, 41.3], [-4.1, 41.3], [-3.6, 41.4]], r: 0.38, w: 0.68 },
    // Montes de León & Sanabria
    { pts: [[-6.7, 42.4], [-6.1, 42.3], [-5.6, 42.7]], r: 0.45, w: 0.74 },
    // Sistema Ibérico North (Demanda, Urbión, Cebollera, Soria-Burgos, Moncayo)
    { pts: [[-3.3, 42.3], [-2.8, 42.0], [-2.5, 41.8], [-1.8, 41.7]], r: 0.52, w: 0.82 },
    // Sistema Ibérico South (Alto Tajo, Serranía de Cuenca, Albarracín, Maestrazgo, Gúdar, Espadán)
    { pts: [[-2.3, 40.7], [-1.9, 40.3], [-1.5, 40.3], [-0.7, 40.4], [-0.2, 40.5], [-0.4, 39.8]], r: 0.60, w: 0.84 },
    // Valencian & Murcian Massifs (Cabriel, Caroig, Mariola, Segura, Moratalla, Espuña)
    { pts: [[-1.4, 39.5], [-0.9, 39.1], [-0.5, 38.7]], r: 0.45, w: 0.72 },
    { pts: [[-2.3, 38.5], [-1.9, 38.2], [-1.5, 37.9]], r: 0.44, w: 0.72 },
    // Extremadura & Montes de Toledo (Monfragüe, Villuercas, Cabañeros, Cíjara, San Pedro)
    { pts: [[-6.7, 39.3], [-5.9, 39.8], [-5.3, 39.5], [-4.4, 39.4], [-4.0, 39.4]], r: 0.52, w: 0.76 },
    { pts: [[-5.2, 39.2], [-4.7, 38.9], [-4.3, 38.6]], r: 0.45, w: 0.70 },
    // Sierra Morena (Aracena, Sierra Norte Sevilla, Hornachuelos, Cardeña, Andújar, Despeñaperros)
    { pts: [[-7.0, 37.9], [-6.0, 37.9], [-5.0, 38.1], [-4.0, 38.3], [-3.3, 38.4]], r: 0.52, w: 0.80 },
    // Baetic Ranges (Cazorla, Segura, Las Villas, Mágina, Sierra Nevada, Filabres, Almijara, Nieves, Alcornocales, Doñana)
    { pts: [[-3.0, 37.8], [-2.7, 38.1], [-2.4, 38.4]], r: 0.48, w: 0.86 },
    { pts: [[-3.6, 37.1], [-3.0, 37.1], [-2.4, 37.2]], r: 0.44, w: 0.76 },
    { pts: [[-5.6, 36.2], [-5.5, 36.7], [-4.9, 36.7], [-4.0, 36.9]], r: 0.46, w: 0.80 },
    { pts: [[-6.7, 37.2], [-6.4, 37.0]], r: 0.32, w: 0.72 },
    // Mallorca Serra de Tramuntana
    { pts: [[2.4, 39.6], [2.7, 39.75], [3.05, 39.9]], r: 0.25, w: 0.78 },
    // SW France: Forêt des Landes, Dordogne/Périgord & Corbières/Cévennes
    { pts: [[-1.25, 43.65], [-1.15, 44.25], [-0.95, 44.85], [-0.35, 44.35]], r: 0.58, w: 0.86 },
    { pts: [[0.55, 44.95], [1.25, 45.05], [1.95, 45.25]], r: 0.48, w: 0.76 },
    { pts: [[2.15, 43.35], [2.85, 43.65], [3.65, 44.15]], r: 0.50, w: 0.80 },
    // Northern Morocco & Algeria: Rif Mountains & Tell Atlas
    { pts: [[-5.45, 35.55], [-4.55, 35.05], [-3.85, 34.95]], r: 0.46, w: 0.78 },
    { pts: [[-1.85, 34.75], [-0.65, 35.05], [1.25, 35.85], [3.45, 36.45]], r: 0.45, w: 0.74 }
  ];

  const minLon = -9.6, maxLon = 4.4, minLat = 34.6, maxLat = 45.5;
  const step = 0.026; // High-detail 10m-grade grid across Iberia & SW Europe
  const cols = Math.ceil((maxLon - minLon) / step) + 1;
  const rows = Math.ceil((maxLat - minLat) / step) + 1;

  const grid = new Float32Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    const lat = minLat + r * step;
    for (let c = 0; c < cols; c++) {
      const lon = minLon + c * step;
      // Require point and 0.02° neighbors on Iberian land
      if (
        !onIberia(lon, lat) ||
        !onIberia(lon - 0.02, lat) ||
        !onIberia(lon + 0.02, lat) ||
        !onIberia(lon, lat - 0.02) ||
        !onIberia(lon, lat + 0.02) ||
        nearCity(lon, lat)
      ) {
        grid[r * cols + c] = 0;
        continue;
      }

      let env = 0.25;
      for (const m of massifs) {
        const d = distToSpine(lon, lat, m.pts);
        if (d < m.r) {
          const t = 1.0 - d / m.r;
          const v = m.w * t * t * (3 - 2 * t);
          if (v > env) env = v;
        }
      }

      const n = fbm(lon, lat);
      grid[r * cols + c] = env * 0.48 + n * 0.68;
    }
  }

  // Extract closed contour rings via Marching Squares topological edge stitching
  const thresh = 0.548;
  const segments = [];

  const interp = (v0, v1) => {
    const dv = v1 - v0;
    if (Math.abs(dv) < 1e-6) return 0.5;
    return Math.max(0.05, Math.min(0.95, (thresh - v0) / dv));
  };

  for (let r = 0; r < rows - 1; r++) {
    const y0 = minLat + r * step;
    const y1 = minLat + (r + 1) * step;
    for (let c = 0; c < cols - 1; c++) {
      const x0 = minLon + c * step;
      const x1 = minLon + (c + 1) * step;

      const v0 = grid[r * cols + c];             // bottom-left
      const v1 = grid[r * cols + (c + 1)];       // bottom-right
      const v2 = grid[(r + 1) * cols + (c + 1)]; // top-right
      const v3 = grid[(r + 1) * cols + c];       // top-left

      const idx =
        (v0 >= thresh ? 1 : 0) |
        (v1 >= thresh ? 2 : 0) |
        (v2 >= thresh ? 4 : 0) |
        (v3 >= thresh ? 8 : 0);

      if (idx === 0 || idx === 15) continue;

      const edgeInfo = (e) => {
        if (e === 0) return { key: `H:${c}:${r}`, pt: [x0 + step * interp(v0, v1), y0] };
        if (e === 1) return { key: `V:${c + 1}:${r}`, pt: [x1, y0 + step * interp(v1, v2)] };
        if (e === 2) return { key: `H:${c}:${r + 1}`, pt: [x0 + step * interp(v3, v2), y1] };
        return { key: `V:${c}:${r}`, pt: [x0, y0 + step * interp(v0, v3)] };
      };

      const pairs = {
        1: [[3, 0]],
        2: [[0, 1]],
        3: [[3, 1]],
        4: [[1, 2]],
        5: [[3, 2], [1, 0]],
        6: [[0, 2]],
        7: [[3, 2]],
        8: [[2, 3]],
        9: [[2, 0]],
        10: [[0, 3], [2, 1]],
        11: [[2, 1]],
        12: [[1, 3]],
        13: [[1, 0]],
        14: [[0, 3]]
      }[idx];

      for (const [eA, eB] of pairs) {
        segments.push({ a: edgeInfo(eA), b: edgeInfo(eB) });
      }
    }
  }

  // Stitch directed segments into closed rings using exact topological edge keys
  const startMap = new Map();
  for (let i = 0; i < segments.length; i++) {
    const k = segments[i].a.key;
    if (!startMap.has(k)) startMap.set(k, []);
    startMap.get(k).push(i);
  }

  const used = new Uint8Array(segments.length);
  const outers = [];
  const holes = [];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const startKey = segments[i].a.key;
    const ring = [segments[i].a.pt, segments[i].b.pt];
    let curKey = segments[i].b.key;

    while (curKey !== startKey) {
      const candidates = startMap.get(curKey);
      if (!candidates) break;
      let nextIdx = -1;
      for (const cand of candidates) {
        if (!used[cand]) {
          nextIdx = cand;
          break;
        }
      }
      if (nextIdx === -1) break;
      used[nextIdx] = 1;
      ring.push(segments[nextIdx].b.pt);
      curKey = segments[nextIdx].b.key;
    }

    if (curKey === startKey && ring.length >= 8) {
      let area2 = 0;
      for (let j = 0; j < ring.length - 1; j++) {
        area2 += ring[j][0] * ring[j + 1][1] - ring[j + 1][0] * ring[j][1];
      }
      if (area2 < -0.00005) {
        const rev = ring.slice().reverse();
        const simp = simplifyPoints(rev, 400);
        if (simp.length >= 5) {
          simp.push([simp[0][0], simp[0][1]]);
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (const [x, y] of simp) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
          outers.push({ ring: simp, holes: [], area: -area2, x0, x1, y0, y1 });
        }
      } else if (area2 > 0.00010) {
        const rev = ring.slice().reverse();
        const simp = simplifyPoints(rev, 400);
        if (simp.length >= 5) {
          simp.push([simp[0][0], simp[0][1]]);
          holes.push({ ring: simp, area: area2 });
        }
      }
    }
  }

  function ptInPolyRing(px, py, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  for (const h of holes) {
    const [hx, hy] = h.ring[0];
    let bestOuter = null;
    for (const o of outers) {
      if (o.area <= h.area) continue;
      if (hx < o.x0 || hx > o.x1 || hy < o.y0 || hy > o.y1) continue;
      if (ptInPolyRing(hx, hy, o.ring)) {
        if (!bestOuter || o.area < bestOuter.area) {
          bestOuter = o;
        }
      }
    }
    if (bestOuter) {
      bestOuter.holes.push(h.ring);
    }
  }

  const features = outers.map(o => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [o.ring, ...o.holes]
    }
  }));

  const targetPath = path.join(DATA_DIR, 'iberia-forests.json');
  fs.writeFileSync(targetPath, JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`Saved Marching-Squares Iberian forest contours to ${targetPath}: ${features.length} non-overlapping GIS polygons with ${holes.length} valley clearings (${(fs.statSync(targetPath).size / 1024).toFixed(1)} KB)`);
}

async function main() {
  if (process.argv.includes('--forests-only')) {
    const land = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'uk-land-10m.json'), 'utf8'));
    const cities = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'uk-cities-10m.json'), 'utf8'));
    buildContourIberiaForests(land.features, cities);
    return;
  }
  const landFeatures = await buildLandAndCountries();
  const onLand = buildSpatialTester(landFeatures);
  await buildStates10m(onLand);
  const cityRings = await buildCities10m(onLand);
  await buildRoads10m(onLand);
  buildContourIberiaForests(landFeatures, cityRings);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
