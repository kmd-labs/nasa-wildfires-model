import type { ColorRampId, MultiPolygonCoords, PolygonRing } from '../models/wildfire.model';

/** Minimal shape of a hotspot pixel square (matches `GlobePixelSquare`). */
export interface GlowSquare {
  lon: number;
  lat: number;
  halfLon: number;
  halfLat: number;
}

/**
 * One outer edge of a hotspot cluster, in degrees. `nx` / `ny` is the outward normal
 * (one of them is 0, the other ±1); `wLon` / `wLat` is the cell size along each axis.
 */
export interface GlowEdge {
  lon0: number;
  lat0: number;
  lon1: number;
  lat1: number;
  nx: number;
  ny: number;
  wLon: number;
  wLat: number;
}

/**
 * Glow colour (RGB 0–255) per colour ramp. The sequential YlOrRd ramp keeps a fire red; the
 * colour-vision-deficiency-safe ramps use a colour from their own palette instead, because a
 * pure red rim is exactly what those viewers cannot tell apart:
 *  - Okabe-Ito: its vermilion (#d55e00), the CVD-safe stand-in for red,
 *  - Cividis and Viridis: their bright yellow end (#ffea46, #fde725), which every CVD type sees.
 */
const HOTSPOT_GLOW_RGB_BY_RAMP: Record<ColorRampId, [number, number, number]> = {
  ylOrRd: [255, 42, 28],
  okabeIto: [213, 94, 0],
  cividis: [255, 234, 70],
  viridis: [253, 231, 37]
};

export function hotspotGlowRgb(ramp: ColorRampId): [number, number, number] {
  return HOTSPOT_GLOW_RGB_BY_RAMP[ramp] ?? HOTSPOT_GLOW_RGB_BY_RAMP.ylOrRd;
}

/** Two quick pulses when hotspots appear, then one slow pulse every 3 s. */
const INTRO_PULSE_MS = 500;
const INTRO_PULSES = 2;
const CYCLE_MS = 3000;
const CYCLE_PULSE_MS = 1300;
/** Resting glow between pulses, so the outline never disappears. */
const BASE_LEVEL = 0.32;
/** Glow level shown without animation (prefers-reduced-motion). */
export const STATIC_GLOW_LEVEL = 0.7;

/**
 * Glow strength 0–1 at `elapsedMs` after the hotspots appeared.
 * Never flashes more than twice a second (well under the 3 flashes/s safety limit).
 */
export function hotspotGlowLevel(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs);
  const introEnd = INTRO_PULSE_MS * INTRO_PULSES;
  let shape: number;
  if (t < introEnd) {
    shape = Math.sin(((t % INTRO_PULSE_MS) / INTRO_PULSE_MS) * Math.PI) ** 2;
  } else {
    const c = (t - introEnd) % CYCLE_MS;
    shape = c < CYCLE_PULSE_MS ? Math.sin((c / CYCLE_PULSE_MS) * Math.PI) ** 2 : 0;
  }
  return BASE_LEVEL + (1 - BASE_LEVEL) * shape;
}

/** True when the glow is between pulses and does not change (lets callers skip redraws). */
export function hotspotGlowIsResting(elapsedMs: number): boolean {
  const introEnd = INTRO_PULSE_MS * INTRO_PULSES;
  return elapsedMs >= introEnd && (elapsedMs - introEnd) % CYCLE_MS >= CYCLE_PULSE_MS;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function pointInRing(lon: number, lat: number, ring: PolygonRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInMultiPolygon(lon: number, lat: number, multi: MultiPolygonCoords): boolean {
  for (const poly of multi) {
    if (!poly.length || !pointInRing(lon, lat, poly[0])) continue;
    if (!poly.slice(1).some(hole => pointInRing(lon, lat, hole))) return true;
  }
  return false;
}

interface Grid {
  dLon: number;
  dLat: number;
  cells: Set<string>;
  list: { row: number; col: number }[];
}

const key = (row: number, col: number) => `${row}:${col}`;

/**
 * Outer boundary of the union of hotspot squares: an edge is kept when the square on its
 * other side is empty (on the same sensor grid and on any other grid, e.g. MODIS 1 km next to
 * VIIRS 375 m). With `region`, edges whose midpoint lies outside the region are dropped, so the
 * glow follows the clipped squares.
 */
export function clusterOutlineEdges(squares: readonly GlowSquare[], region?: MultiPolygonCoords): GlowEdge[] {
  const grids = new Map<string, Grid>();
  for (const sq of squares) {
    const dLon = sq.halfLon * 2;
    const dLat = sq.halfLat * 2;
    if (!(dLon > 0) || !(dLat > 0)) continue;
    const gk = `${dLon.toPrecision(8)}|${dLat.toPrecision(8)}`;
    let g = grids.get(gk);
    if (!g) {
      g = { dLon, dLat, cells: new Set(), list: [] };
      grids.set(gk, g);
    }
    const row = Math.round(sq.lat / dLat);
    const col = Math.round(sq.lon / dLon);
    const k = key(row, col);
    if (!g.cells.has(k)) {
      g.cells.add(k);
      g.list.push({ row, col });
    }
  }
  const all = [...grids.values()];
  const covered = (lon: number, lat: number, self: Grid): boolean =>
    all.some(g => g !== self && g.cells.has(key(Math.round(lat / g.dLat), Math.round(lon / g.dLon))));

  const edges: GlowEdge[] = [];
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // [nx (east), ny (north)]
  for (const g of all) {
    const hx = g.dLon / 2;
    const hy = g.dLat / 2;
    for (const { row, col } of g.list) {
      const lon = col * g.dLon;
      const lat = row * g.dLat;
      for (const [nx, ny] of dirs) {
        if (g.cells.has(key(row + ny, col + nx))) continue;
        const mx = lon + nx * hx;
        const my = lat + ny * hy;
        // probe just outside the edge for a square of another sensor grid
        if (all.length > 1 && covered(mx + nx * hx * 0.25, my + ny * hy * 0.25, g)) continue;
        if (region && region.length && !pointInMultiPolygon(mx - nx * hx * 0.01, my - ny * hy * 0.01, region)) continue;
        const ex = ny !== 0 ? hx : 0; // edge runs east-west when the normal points north/south
        const ey = nx !== 0 ? hy : 0;
        edges.push({ lon0: mx - ex, lat0: my - ey, lon1: mx + ex, lat1: my + ey, nx, ny, wLon: g.dLon, wLat: g.dLat });
      }
    }
  }
  return edges;
}
