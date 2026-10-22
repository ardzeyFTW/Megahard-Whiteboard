import { getStrokeOutlinePoints, getStrokePoints } from 'perfect-freehand';
import type { Pt, ShapeKind, StrokeEl } from './types';
import { arrowSize, distToSegment } from './geometry';

interface StrokePaths {
  body: Path2D;
  heads: Path2D[];
}

const pathCache = new WeakMap<StrokeEl, StrokePaths>();

const avg = (a: number, b: number) => (a + b) / 2;

/** Matches perfect-freehand's internal pressure-change constant. */
const RATE_OF_PRESSURE_CHANGE = 0.275;

function simPressure(prev: number, distance: number, size: number): number {
  const sp = Math.min(1, distance / size);
  const rp = Math.min(1, 1 - sp);
  return Math.min(1, prev + (rp - prev) * (sp * RATE_OF_PRESSURE_CHANGE));
}

/** Turn a perfect-freehand outline into a smooth closed SVG path. */
export function outlineToSvg(points: number[][]): string {
  const len = points.length;
  let a = points[0];
  let b = points[1];
  const c = points[2];
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0]).toFixed(2)},${avg(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2; i < len - 1; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)} `;
  }
  return `${d}Z`;
}

/**
 * Compute the outline points for a stroke while stabilizing the tail of fast strokes.
 *
 * When a fast curved stroke (such as a quickly written "3") ends, the last few pointer samples
 * bunch up as the hand stops or lifts off. In perfect-freehand, those closely spaced tail points:
 *   1. Dump the accumulated streamline lag over a tiny distance, creating a sharp bend/pinch right
 *      before the end cap; and
 *   2. Drop step distance below `size`, causing `simulatePressure` to swell the radius back up into
 *      a round blob at the very tip.
 */
export function strokeOutline(el: Pick<StrokeEl, 'points' | 'size' | 'highlighter' | 'simulatePressure'>): number[][] {
  const p = el.points;
  const input: number[][] = [];
  for (let i = 0; i < p.length; i += 3) input.push([p[i], p[i + 1], p[i + 2]]);

  // Coalesce bunched deceleration/lift-off points at the end of a fast sweep so streamline
  // doesn't dump curve lag into a sharp terminal hook or split the final step into tiny segments.
  if (input.length >= 3) {
    let pace = 0;
    const startIdx = Math.max(1, input.length - 6);
    for (let i = startIdx; i < input.length - 1; i++) {
      const d = Math.hypot(input[i][0] - input[i - 1][0], input[i][1] - input[i - 1][1]);
      if (d > pace) pace = d;
    }
    let merged = 0;
    while (input.length >= 3 && merged < 3) {
      const n = input.length;
      const lastSeg = Math.hypot(input[n - 1][0] - input[n - 2][0], input[n - 1][1] - input[n - 2][1]);
      if (lastSeg >= pace * 0.55) break;
      const combined = Math.hypot(input[n - 1][0] - input[n - 3][0], input[n - 1][1] - input[n - 3][1]);
      if (combined <= pace * 1.25) {
        input.splice(n - 2, 1);
        merged++;
      } else {
        input[n - 2] = [
          (input[n - 2][0] + avg(input[n - 3][0], input[n - 1][0])) / 2,
          (input[n - 2][1] + avg(input[n - 3][1], input[n - 1][1])) / 2,
          input[n - 2][2],
        ];
        break;
      }
    }
  }

  const opts = {
    size: el.size,
    thinning: el.highlighter ? 0 : 0.5,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: !!el.simulatePressure,
    last: true,
  };

  const sp = getStrokePoints(input, opts);

  // Drop interior points within perfect-freehand's 3px end-noise threshold and recompute the
  // final point's vector and distance relative to the last kept point.
  if (sp.length >= 3) {
    const totalLength = sp[sp.length - 1].runningLength;
    while (sp.length >= 3 && totalLength - sp[sp.length - 2].runningLength < 3) {
      sp.splice(sp.length - 2, 1);
    }
    const last = sp[sp.length - 1];
    const prev = sp[sp.length - 2];
    const dx = prev.point[0] - last.point[0];
    const dy = prev.point[1] - last.point[1];
    const dist = Math.hypot(dx, dy);
    if (dist > 0) {
      last.distance = dist;
      last.vector = [dx / dist, dy / dist];
      last.runningLength = prev.runningLength + dist;
    }
  }

  // Prevent simulated pressure from swelling into a fat blob when the pointer slows at the tail.
  if (opts.simulatePressure && sp.length >= 2) {
    let prevPressure = sp
      .slice(0, 10)
      .reduce((acc, curr) => (acc + simPressure(acc, curr.distance, opts.size)) / 2, sp[0].pressure);
    const totalLength = sp[sp.length - 1].runningLength;
    const tailZone = Math.max(opts.size * 1.5, sp[Math.max(0, sp.length - 3)].distance * 1.5);
    for (let i = 0; i < sp.length; i++) {
      const isTail = i >= sp.length - 2 || totalLength - sp[i].runningLength <= tailZone;
      if (isTail && i > 0) {
        const noSwellDist = opts.size * (1 - prevPressure);
        if (sp[i].distance < noSwellDist) sp[i].distance = noSwellDist;
      }
      prevPressure = simPressure(prevPressure, sp[i].distance, opts.size);
    }
  }

  return getStrokeOutlinePoints(sp, opts);
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
    body = new Path2D(outlineToSvg(outline));
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
