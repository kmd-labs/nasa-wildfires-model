export type LonLat = [number, number];

function cross2d(a: LonLat, b: LonLat, p: LonLat): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function intersectSegments(p1: LonLat, p2: LonLat, a: LonLat, b: LonLat): LonLat {
  const dcX = a[0] - b[0];
  const dcY = a[1] - b[1];
  const dpX = p1[0] - p2[0];
  const dpY = p1[1] - p2[1];
  const n1 = a[0] * b[1] - a[1] * b[0];
  const n2 = p1[0] * p2[1] - p1[1] * p2[0];
  const denom = dcX * dpY - dcY * dpX;
  if (Math.abs(denom) < 1e-12) return p1;
  return [(n1 * dpX - n2 * dcX) / denom, (n1 * dpY - n2 * dcY) / denom];
}

/** Sutherland-Hodgman polygon clip against a single triangle (ensured CCW). */
export function clipPolygonToTriangle(
  subject: LonLat[],
  tri: [LonLat, LonLat, LonLat]
): LonLat[] {
  const [t0, t1, t2] = tri;
  const clipEdges: [LonLat, LonLat][] =
    cross2d(t0, t1, t2) >= 0
      ? [[t0, t1], [t1, t2], [t2, t0]]
      : [[t0, t2], [t2, t1], [t1, t0]];

  let output = subject;
  for (const [edgeA, edgeB] of clipEdges) {
    if (output.length === 0) return [];
    const input = output;
    output = [];
    let prev = input[input.length - 1];
    let prevIn = cross2d(edgeA, edgeB, prev) >= -1e-11;
    for (const curr of input) {
      const currIn = cross2d(edgeA, edgeB, curr) >= -1e-11;
      if (currIn) {
        if (!prevIn) output.push(intersectSegments(prev, curr, edgeA, edgeB));
        output.push(curr);
      } else if (prevIn) {
        output.push(intersectSegments(prev, curr, edgeA, edgeB));
      }
      prev = curr;
      prevIn = currIn;
    }
  }
  return output;
}

/** Constant screen-pixel hitbox radii invariant across zoom levels. */
export const VERTEX_HIT_RADIUS_PX = 6.5;
export const EDGE_HIT_RADIUS_PX = 4.5;

export type ScreenPt = [number, number];

/** Find index of nearest vertex within maxPx in screen pixel space. */
export function findNearestVertexPx(
  px: number,
  py: number,
  pts: (ScreenPt | null)[],
  maxPx = VERTEX_HIT_RADIUS_PX
): number {
  let bestIdx = -1;
  let bestDist = maxPx;
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    if (!pt) continue;
    const d = Math.hypot(px - pt[0], py - pt[1]);
    if (d <= bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Find index of nearest polygon edge within maxPx in screen pixel space. */
export function findNearestEdgePx(
  px: number,
  py: number,
  pts: (ScreenPt | null)[],
  maxPx = EDGE_HIT_RADIUS_PX
): number {
  let bestEdge = -1;
  let bestDist = maxPx;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!a || !b) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 1e-6 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lenSq)) : 0;
    const d = Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
    if (d <= bestDist) {
      bestDist = d;
      bestEdge = i;
    }
  }
  return bestEdge;
}
