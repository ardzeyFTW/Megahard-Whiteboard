import { getStrokeOutlinePoints, type StrokePoint } from 'perfect-freehand';
import type { Pt, ShapeKind, StrokeEl } from './types';
import { arrowSize, distToSegment } from './geometry';

interface StrokePaths {
  body: Path2D;
  heads: Path2D[];
}

const pathCache = new WeakMap<StrokeEl, StrokePaths>();

const avg = (a: number, b: number) => (a + b) / 2;

/** Turn a perfect-freehand outline into a smooth closed SVG path without T-reflection rounding drift. */
export function outlineToSvg(points: number[][]): string {
  const len = points.length;
  let a = points[0];
  let b = points[1];
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)}`;
  for (let i = 1; i < len - 1; i++) {
    a = points[i];
    b = points[i + 1];
    d += ` Q${a[0].toFixed(2)},${a[1].toFixed(2)} ${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)}`;
  }
  return `${d} Z`;
}

/** Build a smooth closed Path2D directly from outline points in full floating-point precision. */
function outlineToPath(points: number[][]): Path2D {
  const path = new Path2D();
  const len = points.length;
  path.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < len - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    path.quadraticCurveTo(a[0], a[1], avg(a[0], b[0]), avg(a[1], b[1]));
  }
  path.closePath();
  return path;
}

/**
 * Build StrokePoints causally and compute the stroke outline.
 *
 * Every StrokePoint `0..i` depends only on input points `0..i`, avoiding perfect-freehand's
 * non-causal behaviors:
 *   1. `END_NOISE_THRESHOLD = 3` in `getStrokeOutlinePoints` skips `i = 0` whenever `totalLength < 3`,
 *      which made slow starts with small pens swell up into a large circle before collapsing at 3px.
 *   2. `last: true` in `getStrokePoints` leaves the tip unsmoothed on frame `k` and pulls it inward
 *      by `streamline` on frame `k + 1`, making tight curves visibly shift in real time while drawing.
 *   3. At the end of a fast sweep, angular momentum is carried across sharp deceleration/lift-off
 *      samples and simulated pressure recovers slowly, preventing a thin neck and terminal blob.
 */
export function strokeOutline(el: Pick<StrokeEl, 'points' | 'size' | 'highlighter' | 'simulatePressure'>): number[][] {
  const p = el.points;
  const rawPts: number[][] = [];
  for (let i = 0; i < p.length; i += 3) rawPts.push([p[i], p[i + 1], p[i + 2]]);
  if (rawPts.length === 0) return [];

  const pts =
    rawPts.length === 1
      ? [rawPts[0], [rawPts[0][0] + 0.01, rawPts[0][1] + 0.01, rawPts[0][2]]]
      : rawPts;

  const size = el.size;
  const simulatePressure = !!el.simulatePressure;
  // Minimum velocity reference so small pens (size 1–5) respond smoothly to hand speed instead of
  // treating 1px mouse steps as high-speed flicks.
  const velRef = Math.max(size, 6);
  let prevP = simulatePressure ? 0.5 : (pts[0][2] ?? 0.5);
  let fastPace = 0;

  const sp: StrokePoint[] = [
    {
      point: [pts[0][0], pts[0][1]],
      pressure: prevP,
      vector: [1, 1],
      distance: 0,
      runningLength: 0,
    },
  ];
  let prev = sp[0];

  for (let i = 1; i < pts.length; i++) {
    let rx = pts[i][0];
    let ry = pts[i][1];
    const rawDist = Math.hypot(rx - prev.point[0], ry - prev.point[1]);
    if (rawDist < 1e-4) continue;

    // When decelerating sharply from a fast sweep, carry angular momentum along prev.vector so
    // terminal lift-off hooks don't kink or pinch the neck before the end cap.
    if (sp.length > 1 && fastPace > size * 0.5 && rawDist < fastPace * 0.75) {
      const m = (1 - rawDist / (fastPace * 0.75)) * 0.85;
      const tx = prev.point[0] - prev.vector[0] * rawDist;
      const ty = prev.point[1] - prev.vector[1] * rawDist;
      rx = rx * (1 - m) + tx * m;
      ry = ry * (1 - m) + ty * m;
    }

    const t = 0.82;
    const px = prev.point[0] + (rx - prev.point[0]) * t;
    const py = prev.point[1] + (ry - prev.point[1]) * t;

    const dx = prev.point[0] - px;
    const dy = prev.point[1] - py;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-4) continue;

    if (fastPace > size * 0.5 && dist < Math.min(size * 0.2, fastPace * 0.15)) {
      continue;
    }

    fastPace = Math.max(rawDist, fastPace * 0.85);
    const vx = dx / dist;
    const vy = dy / dist;

    if (simulatePressure) {
      const speed = Math.min(1, rawDist / velRef);
      const targetP = 1 - speed;
      const rate = targetP < prevP ? speed * 0.275 : speed * 0.03;
      prevP = Math.min(1, prevP + (targetP - prevP) * rate);
    } else {
      prevP = pts[i][2] ?? 0.5;
    }

    prev = {
      point: [px, py],
      pressure: prevP,
      vector: [vx, vy],
      distance: dist,
      // Keep runningLength spaced by >= 4 so getStrokeOutlinePoints never skips i = 0 on slow starts
      // or tight curve points near the tip via its hardcoded END_NOISE_THRESHOLD = 3.
      runningLength: sp.length * 4,
    };
    sp.push(prev);
  }

  if (sp.length === 1) {
    sp.push({
      point: [pts[0][0] + 0.01, pts[0][1] + 0.01],
      pressure: prevP,
      vector: [-0.7071, -0.7071],
      distance: 0.01,
      runningLength: 4,
    });
  }
  sp[0].vector = sp[1].vector;

  return getStrokeOutlinePoints(sp, {
    size,
    thinning: el.highlighter ? 0 : 0.5,
    smoothing: 0.15,
    simulatePressure: false,
    last: true,
  });
}

export function arrowHeadPath(fromX: number, fromY: number, tipX: number, tipY: number, len: number): Path2D {
  const a = Math.atan2(tipY - fromY, tipX - fromX);
  const spread = 0.45;
  const p = new Path2D();
  p.moveTo(tipX, tipY);
  p.lineTo(tipX - len * Math.cos(a - spread), tipY - len * Math.sin(a - spread));
  p.lineTo(tipX - len * Math.cos(a + spread), tipY - len * Math.sin(a + spread));
  p.closePath();
  return p;
}

export function strokePaths(el: StrokeEl): StrokePaths {
  const cached = pathCache.get(el);
  if (cached) return cached;

  const p = el.points;
  const outline = strokeOutline(el);

  let body: Path2D;
  if (outline.length >= 4) {
    body = outlineToPath(outline);
  } else {
    body = new Path2D();
    body.arc(p[0], p[1], el.size / 2, 0, Math.PI * 2);
  }

  const heads: Path2D[] = [];
  const len = arrowSize(el.size);
  const n = p.length;
  if (el.arrow && n >= 6) {
    // Aim the head along the last stretch of the stroke, not just the final jittery segment.
    const tipX = p[n - 3], tipY = p[n - 2];
    let fromX = p[0], fromY = p[1];
    for (let i = n - 6; i >= 0; i -= 3) {
      if (Math.hypot(tipX - p[i], tipY - p[i + 1]) >= len) {
        fromX = p[i];
        fromY = p[i + 1];
        break;
      }
    }
    heads.push(arrowHeadPath(fromX, fromY, tipX, tipY, len));
  }
  if (el.arrowStart && n >= 6) {
    const tipX = p[0], tipY = p[1];
    let fromX = p[n - 3], fromY = p[n - 2];
    for (let i = 3; i < n; i += 3) {
      if (Math.hypot(tipX - p[i], tipY - p[i + 1]) >= len) {
        fromX = p[i];
        fromY = p[i + 1];
        break;
      }
    }
    heads.push(arrowHeadPath(fromX, fromY, tipX, tipY, len));
  }

  const result = { body, heads };
  pathCache.set(el, result);
  return result;
}

// ---------------------------------------------------------------------------
// Ink to shape: recognize rough lines, triangles, rectangles, diamonds and ellipses.

export type Recognized =
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'shape'; kind: ShapeKind; x: number; y: number; w: number; h: number };

function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [a, b];
  const left = simplify(pts.slice(0, idx + 1), eps);
  const right = simplify(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** Drop vertices that are almost straight or too close to a neighbour. */
function cleanCorners(poly: Pt[], minEdge: number): Pt[] {
  let out = poly.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i - 1 + out.length) % out.length];
      const cur = out[i];
      const next = out[(i + 1) % out.length];
      const ux = prev.x - cur.x, uy = prev.y - cur.y;
      const vx = next.x - cur.x, vy = next.y - cur.y;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      const angle = lu && lv ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)))) : Math.PI;
      if (angle > (150 * Math.PI) / 180 || lv < minEdge) {
        out = out.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function recognizeShape(flat: number[]): Recognized | null {
  const pts: Pt[] = [];
  for (let i = 0; i < flat.length; i += 3) pts.push({ x: flat[i], y: flat[i + 1] });
  if (pts.length < 4) return null;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const w = x1 - x0, h = y1 - y0;
  const diag = Math.hypot(w, h);
  if (diag < 24) return null;

  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const first = pts[0], last = pts[pts.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);

  // Straight line: endpoints nearly as far apart as the path is long.
  if (gap / length > 0.94) {
    let x2 = last.x, y2 = last.y;
    const angle = Math.atan2(y2 - first.y, x2 - first.x);
    const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
    if (Math.abs(angle - snapped) < (6 * Math.PI) / 180) {
      x2 = first.x + Math.cos(snapped) * gap;
      y2 = first.y + Math.sin(snapped) * gap;
    }
    return { type: 'line', x1: first.x, y1: first.y, x2, y2 };
  }

  // Closed shapes only from here on.
  if (gap > diag * 0.3 || Math.min(w, h) < diag * 0.15) return null;

  const loop = pts.concat([first]);
  let poly = simplify(loop, diag * 0.06);
  poly.pop();
  poly = cleanCorners(poly, diag * 0.08);

  const cx = x0 + w / 2, cy = y0 + h / 2;
  let err = 0;
  for (const p of pts) err += Math.abs(Math.hypot((p.x - cx) / (w / 2), (p.y - cy) / (h / 2)) - 1);
  err /= pts.length;

  const box = { type: 'shape' as const, x: x0, y: y0, w, h };
  const n = poly.length;
  if (n === 3) return { ...box, kind: 'triangle' };
  if (n === 4) {
    if (err < 0.06) return { ...box, kind: 'ellipse' };
    const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const mids = [{ x: cx, y: y0 }, { x: x1, y: cy }, { x: cx, y: y1 }, { x: x0, y: cy }];
    const nearest = (p: Pt, set: Pt[]) => Math.min(...set.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
    const toCorners = poly.reduce((s, p) => s + nearest(p, corners), 0);
    const toMids = poly.reduce((s, p) => s + nearest(p, mids), 0);
    return { ...box, kind: toMids < toCorners ? 'diamond' : 'rect' };
  }
  if (n >= 5 && err < 0.2) return { ...box, kind: 'ellipse' };
  return null;
}
