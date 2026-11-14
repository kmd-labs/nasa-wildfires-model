import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../src/assets/data');
const TMP_DIR = '/tmp/ortho-build';

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function downloadFile(url, outPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 500) {
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

async function buildGlobalOrtho() {
  console.log('1/2 Fetching NASA GIBS BlueMarble 500m EPSG:4326 Matrix 3 (10x5 = 50 tiles -> 4096x2048)...');
  const dir = path.join(TMP_DIR, 'bm');
  fs.mkdirSync(dir, { recursive: true });

  const tilePaths = [];
  const tasks = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 10; col++) {
      const url = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/3/${row}/${col}.jpeg`;
      const out = path.join(dir, `r${row}_c${col}.jpg`);
      tilePaths.push(out);
      tasks.push(() => downloadFile(url, out));
    }
  }
  await runPool(tasks, 10);

  const rawOut = path.join(TMP_DIR, 'earth-ortho-raw.jpg');
  const finalOut = path.join(DATA_DIR, 'earth-ortho-4k.jpg');
  execFileSync('montage', [
    ...tilePaths,
    '-tile', '10x5',
    '-geometry', '+0+0',
    rawOut
  ]);
  execFileSync('convert', [
    rawOut,
    '-resize', '4096x2048!',
    '-quality', '82',
    '-sampling-factor', '4:2:0',
    '-strip',
    finalOut
  ]);
  console.log(`Saved global orthophoto: ${finalOut} (${(fs.statSync(finalOut).size / 1024).toFixed(1)} KB)`);
}

async function buildIberiaOrtho() {
  console.log('2/2 Fetching Esri World Imagery z=8 tiles for Iberia & SW Europe (12x10 = 120 tiles)...');
  const dir = path.join(TMP_DIR, 'esri');
  fs.mkdirSync(dir, { recursive: true });

  const z = 8;
  const xMin = 120;
  const xMax = 131; // 12 cols: -11.25° to +5.625°
  const yMin = 91;
  const yMax = 100; // 10 rows: +45.089°N to +34.307°N

  const tilePaths = [];
  const tasks = [];
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
      const out = path.join(dir, `z${z}_y${y}_x${x}.jpg`);
      tilePaths.push(out);
      tasks.push(() => downloadFile(url, out));
    }
  }
  await runPool(tasks, 12);

  const rawOut = path.join(TMP_DIR, 'iberia-ortho-raw.jpg');
  const finalOut = path.join(DATA_DIR, 'iberia-ortho.jpg');
  execFileSync('montage', [
    ...tilePaths,
    '-tile', `${xMax - xMin + 1}x${yMax - yMin + 1}`,
    '-geometry', '+0+0',
    rawOut
  ]);
  execFileSync('convert', [
    rawOut,
    '-resize', '2560x2133!',
    '-quality', '82',
    '-sampling-factor', '4:2:0',
    '-strip',
    finalOut
  ]);
  console.log(`Saved Iberia high-res orthophoto: ${finalOut} (${(fs.statSync(finalOut).size / 1024).toFixed(1)} KB)`);
}

async function main() {
  await buildGlobalOrtho();
  await buildIberiaOrtho();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
