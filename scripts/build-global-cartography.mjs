import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../src/assets/data');
const TMP_DIR = '/tmp/global-carto';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

function roundCoord(c, scale = 300) {
  return Math.round(c * scale) / scale;
}

function perpDistSq(pt, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = pt[0] - a[0];
    const ey = pt[1] - a[1];
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / lenSq));
  const px = a[0] + t * dx;
  const py = a[1] + t * dy;
  const ex = pt[0] - px;
  const ey = pt[1] - py;
  return ex * ex + ey * ey;
}

function rdpSimplify(points, epsilon) {
  if (points.length <= 2) return points;
  const epsSq = epsilon * epsilon;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop();
    if (end - start <= 1) continue;
    let maxDistSq = -1;
    let maxIdx = -1;
    const a = points[start];
    const b = points[end];
    for (let i = start + 1; i < end; i++) {
      const d = perpDistSq(points[i], a, b);
      if (d > maxDistSq) {
        maxDistSq = d;
        maxIdx = i;
      }
    }
    if (maxDistSq > epsSq && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
}

function quantizeAndDedupe(coords, scale = 300, epsilon = 0.01) {
  const simplified = epsilon > 0 && coords.length > 3 ? rdpSimplify(coords, epsilon) : coords;
  const out = [];
  let lx = null;
  let ly = null;
  for (const pt of simplified) {
    if (!pt || pt.length < 2) continue;
    const x = roundCoord(pt[0], scale);
    const y = roundCoord(pt[1], scale);
    if (x !== lx || y !== ly) {
      out.push([x, y]);
      lx = x;
      ly = y;
    }
  }
  return out;
}

function downloadFile(url, outPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 200) {
      return resolve(outPath);
    }
    const req = https.get(url, { headers: { 'User-Agent': 'kmd-wildfires/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const stream = fs.createWriteStream(outPath);
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve(outPath);
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function runPool(tasks, concurrency = 10) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function streamGeoJson(url, onFeature) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
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
            onFeature(JSON.parse(featStr));
          } catch {
            // partial feature chunk
          }
          buffer = buffer.slice(nextIdx);
        }
      });
      res.on('end', () => {
        if (buffer.startsWith('{"type":"Feature"')) {
          const endIdx = buffer.lastIndexOf('}');
          if (endIdx !== -1) {
            try {
              onFeature(JSON.parse(buffer.slice(0, endIdx + 1)));
            } catch {}
          }
        }
        resolve();
      });
    }).on('error', reject);
  });
}

async function buildGlobalUrbanAreas() {
  console.log('1/4 Downloading & simplifying global 10m urban areas (ne_10m_urban_areas)...');
  const url = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_urban_areas.geojson';
  const rings = [];

  await streamGeoJson(url, (feat) => {
    const area = feat.properties?.area_sqkm ?? 0;
    if (area < 12) return;
    const geom = feat.geometry;
    if (!geom) return;

    const pushRing = (coords) => {
      const simplified = quantizeAndDedupe(coords, 250, 0.008);
      if (simplified.length >= 4) rings.push(simplified);
    };

    if (geom.type === 'Polygon') {
      if (geom.coordinates[0]) pushRing(geom.coordinates[0]);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (poly[0]) pushRing(poly[0]);
      }
    }
  });

  const target = path.join(DATA_DIR, 'global-cities-10m.json');
  fs.writeFileSync(target, JSON.stringify(rings));
  console.log(`Saved ${target}: ${rings.length} global urban polygons (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
}

async function buildGlobalRoads() {
  console.log('2/4 Downloading & simplifying global 10m roads (ne_10m_roads)...');
  const url = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson';
  const highways = [];
  const secondary = [];

  const lineSpan = (pts) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return Math.hypot(maxX - minX, maxY - minY);
  };

  await streamGeoJson(url, (feat) => {
    const type = feat.properties?.type ?? '';
    if (type.toLowerCase().includes('ferry')) return;

    const isExpressway = feat.properties?.expressway === 1;
    const isMajor = type === 'Major Highway' || type === 'Beltway' || isExpressway;
    const geom = feat.geometry;
    if (!geom) return;

    const processLine = (coords) => {
      const eps = isMajor ? 0.012 : 0.022;
      const simp = quantizeAndDedupe(coords, 200, eps);
      if (simp.length < 2) return;
      if (!isMajor && lineSpan(simp) < 0.08) return;
      if (isMajor) highways.push(simp);
      else secondary.push(simp);
    };

    if (geom.type === 'LineString') {
      processLine(geom.coordinates);
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) processLine(line);
    }
  });

  const target = path.join(DATA_DIR, 'global-roads-10m.json');
  fs.writeFileSync(target, JSON.stringify({ highways, secondary }));
  console.log(`Saved ${target}: ${highways.length} highways, ${secondary.length} secondary (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
}

async function buildGlobalStates() {
  console.log('3/4 Downloading & simplifying global admin-1 borders (ne_10m_admin_1_states_provinces_lines)...');
  const url = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces_lines.geojson';
  const data = await fetchJson(url);
  const lines = [];

  for (const feat of data.features || []) {
    const geom = feat.geometry;
    if (!geom) continue;
    const pushLine = (coords) => {
      const simp = quantizeAndDedupe(coords, 200, 0.015);
      if (simp.length >= 2) lines.push(simp);
    };
    if (geom.type === 'LineString') pushLine(geom.coordinates);
    else if (geom.type === 'MultiLineString') {
      for (const l of geom.coordinates) pushLine(l);
    }
  }

  const target = path.join(DATA_DIR, 'global-states-10m.json');
  fs.writeFileSync(target, JSON.stringify(lines));
  console.log(`Saved ${target}: ${lines.length} global admin-1 lines (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
}

async function buildGlobalForestsRaster() {
  console.log('4/4 Downloading NASA GIBS MODIS Combined IGBP Land Cover 2022 global tiles (10x5 = 50 tiles)...');
  const tileDir = path.join(TMP_DIR, 'modis-igbp');
  fs.mkdirSync(tileDir, { recursive: true });

  const tilePaths = [];
  const tasks = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 10; col++) {
      const url = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual/default/2022-01-01/500m/3/${row}/${col}.png`;
      const out = path.join(tileDir, `r${row}_c${col}.png`);
      tilePaths.push(out);
      tasks.push(() => downloadFile(url, out));
    }
  }
  await runPool(tasks, 10);

  const stitchedPath = path.join(TMP_DIR, 'igbp-global-raw.png');
  execFileSync('montage', [...tilePaths, '-tile', '10x5', '-geometry', '+0+0', stitchedPath]);

  const scaledNearest = path.join(TMP_DIR, 'igbp-4k-nearest.png');
  execFileSync('convert', [stitchedPath, '-filter', 'Point', '-resize', '4096x2048!', scaledNearest]);

  const target = path.join(DATA_DIR, 'global-forests-4k.png');
  execFileSync('python3', [
    '-c',
    `
import subprocess, sys
w, h = 4096, 2048
raw = subprocess.check_output(['convert', sys.argv[1], '-depth', '8', 'rgb:-'])
out = bytearray(w * h * 4)

# NASA GIBS MODIS IGBP classification RGB -> emerald forest canopy RGBA
# Classes 1..5 = Forests; Class 8 = Woody Savannas / Mediterranean oak woodlands
LUT = {
    (33, 138, 33):   (21, 115, 58, 195),   # 1: Evergreen Needleleaf
    (49, 204, 49):   (22, 138, 66, 210),   # 2: Evergreen Broadleaf
    (152, 204, 49):  (48, 150, 74, 185),   # 3: Deciduous Needleleaf
    (150, 250, 150): (58, 165, 82, 190),   # 4: Deciduous Broadleaf
    (141, 186, 141): (40, 148, 72, 185),   # 5: Mixed Forests
    (218, 235, 157): (92, 162, 86, 105),   # 8: Woody Savannas (subtle)
}

n = w * h
for i in range(n):
    s = i * 3
    rgba = LUT.get((raw[s], raw[s+1], raw[s+2]))
    if rgba:
        d = i * 4
        out[d], out[d+1], out[d+2], out[d+3] = rgba

p = subprocess.Popen(['convert', '-size', f'{w}x{h}', '-depth', '8', 'rgba:-', '-strip', '-define', 'png:compression-level=9', sys.argv[2]], stdin=subprocess.PIPE)
p.communicate(out)
if p.returncode != 0:
    sys.exit(p.returncode)
`,
    scaledNearest,
    target
  ]);
  console.log(`Saved ${target}: NASA MODIS IGBP global forest canopy map (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
}

async function main() {
  await buildGlobalUrbanAreas();
  await buildGlobalRoads();
  await buildGlobalStates();
  await buildGlobalForestsRaster();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
