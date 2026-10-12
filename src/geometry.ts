import type { Bounds, El, Pt, ShapeKind } from './types';
import { fitTextBox } from './text';

export const arrowSize = (strokeWidth: number) => Math.max(12, strokeWidth * 3.5);

export function normRect(x: number, y: number, w: number, h: number): Bounds {
  return { x: w < 0 ? x + w : x, y: h < 0 ? y + h : y, w: Math.abs(w), h: Math.abs(h) };
}

export function inflate(b: Bounds, d: number): Bounds {
  return { x: b.x - d, y: b.y - d, w: b.w + d * 2, h: b.h + d * 2 };
}

export function rectContains(b: Bounds, p: Pt): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

export function rectInside(inner: Bounds, outer: Bounds): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function rectsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (!list.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of list) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Elements are immutable, so bounds can be cached per object.
const boundsCache = new WeakMap<El, Bounds>();

export function boundsOf(el: El): Bounds {
  const cached = boundsCache.get(el);
  if (cached) return cached;
  let b: Bounds;
  if (el.type === 'stroke') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const p = el.points;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    const pad = el.size / 2 + (el.arrow || el.arrowStart ? arrowSize(el.size) * 0.5 : 0);
    b = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  } else if (el.type === 'line') {
    const pad = el.strokeWidth / 2 + (el.arrowEnd ? arrowSize(el.strokeWidth) * 0.5 : 0);
    b = inflate(normRect(el.x1, el.y1, el.x2 - el.x1, el.y2 - el.y1), pad);
  } else if (el.type === 'shape') {
    b = inflate(normRect(el.x, el.y, el.w, el.h), el.strokeWidth / 2);
  } else {
    b = normRect(el.x, el.y, el.w, el.h);
  }
  boundsCache.set(el, b);
  return b;
}

/** Outline of a shape as a polygon (ellipses are sampled). */
export function shapeOutline(kind: ShapeKind, x: number, y: number, w: number, h: number): Pt[] {
  switch (kind) {
    case 'rect':
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    case 'triangle':
      return [{ x: x + w / 2, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    case 'diamond':
      return [{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }];
    case 'ellipse': {
      const pts: Pt[] = [];
      const cx = x + w / 2, cy = y + h / 2;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        pts.push({ x: cx + Math.cos(a) * (w / 2), y: cy + Math.sin(a) * (h / 2) });
      }
      return pts;
    }
  }
}

function nearPolyline(pts: number[], p: Pt, r: number): boolean {
  if (pts.length <= 3) return Math.hypot(p.x - pts[0], p.y - pts[1]) <= r;
  for (let i = 3; i < pts.length; i += 3) {
    if (distToSegment(p.x, p.y, pts[i - 3], pts[i - 2], pts[i], pts[i + 1]) <= r) return true;
  }
  return false;
}

function nearPolygon(poly: Pt[], p: Pt, r: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (distToSegment(p.x, p.y, a.x, a.y, b.x, b.y) <= r) return true;
  }
  return false;
}

/** Click hit test: shapes are hit anywhere inside, ink only near its path. */
export function hitTest(el: El, p: Pt, tol: number): boolean {
  if (!rectContains(inflate(boundsOf(el), tol), p)) return false;
  switch (el.type) {
    case 'stroke':
      return nearPolyline(el.points, p, el.size / 2 + tol);
    case 'line':
      return distToSegment(p.x, p.y, el.x1, el.y1, el.x2, el.y2) <= el.strokeWidth / 2 + tol;
    case 'shape': {
      const poly = shapeOutline(el.kind, el.x, el.y, el.w, el.h);
      return pointInPolygon(p, poly) || nearPolygon(poly, p, el.strokeWidth / 2 + tol);
    }
    default:
      return true;
  }
}

/** Eraser hit test: only ink, lines and shapes can be erased; hollow shapes only at their outline. */
export function eraseHit(el: El, p: Pt, r: number): boolean {
  if (!rectContains(inflate(boundsOf(el), r), p)) return false;
  switch (el.type) {
    case 'stroke':
      return nearPolyline(el.points, p, el.size / 2 + r);
    case 'line':
      return distToSegment(p.x, p.y, el.x1, el.y1, el.x2, el.y2) <= el.strokeWidth / 2 + r;
    case 'shape': {
      const poly = shapeOutline(el.kind, el.x, el.y, el.w, el.h);
      if (el.fill !== 'transparent' && pointInPolygon(p, poly)) return true;
      return nearPolygon(poly, p, el.strokeWidth / 2 + r);
    }
    default:
      return false;
  }
}

/** Liang–Barsky: the stretch of segment a→b inside rectangle r as [t0, t1] along it, or null when it misses. */
export function clipSegment(ax: number, ay: number, bx: number, by: number, r: Bounds): [number, number] | null {
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x, r.x + r.w - ax, ay - r.y, r.y + r.h - ay];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  // A segment that only grazes a corner or an edge isn't cut.
  const len = Math.hypot(dx, dy);
  if (len > 0 && (t1 - t0) * len < 1e-3) return null;
  return [t0, t1];
}

/**
 * Remove the parts of a polyline ([x, y, pressure] triples) that fall inside r.
 * Returns the pieces left over, or null when nothing was inside.
 */
export function cutPolyline(pts: number[], r: Bounds): number[][] | null {
  const n = pts.length / 3;
  if (n === 1) return rectContains(r, { x: pts[0], y: pts[1] }) ? [] : null;
  const at = (a: number, t: number) => [
    pts[a] + (pts[a + 3] - pts[a]) * t,
    pts[a + 1] + (pts[a + 4] - pts[a + 1]) * t,
    pts[a + 2] + (pts[a + 5] - pts[a + 2]) * t,
  ];
  const pieces: number[][] = [];
  let cur: number[] = [];
  let cut = false;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 3, b = a + 3;
    const c = clipSegment(pts[a], pts[a + 1], pts[b], pts[b + 1], r);
    // Start a new piece at a, unless a is inside (or the previous cut already put its exit point there).
    if (!cur.length && (!c || c[0] > 0)) cur.push(pts[a], pts[a + 1], pts[a + 2]);
    if (!c) {
      cur.push(pts[b], pts[b + 1], pts[b + 2]);
      continue;
    }
    cut = true;
    if (c[0] > 0) cur.push(...at(a, c[0]));
    if (cur.length >= 6) pieces.push(cur);
    cur = [];
    if (c[1] < 1) cur.push(...at(a, c[1]), pts[b], pts[b + 1], pts[b + 2]);
  }
  if (!cut) return null;
  if (cur.length >= 6) pieces.push(cur);
  return pieces;
}

/** Lasso selection: ink needs most of its points inside; everything else needs its center inside. */
export function inLasso(el: El, poly: Pt[]): boolean {
  if (el.type === 'stroke') {
    const n = el.points.length / 3;
    const stride = Math.max(1, Math.floor(n / 60)) * 3;
    let inside = 0, total = 0;
    for (let i = 0; i < el.points.length; i += stride) {
      total++;
      if (pointInPolygon({ x: el.points[i], y: el.points[i + 1] }, poly)) inside++;
    }
    return total > 0 && inside / total >= 0.6;
  }
  const b = boundsOf(el);
  return pointInPolygon({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, poly);
}

export function translateEl(el: El, dx: number, dy: number): El {
  switch (el.type) {
    case 'stroke': {
      const p = el.points.slice();
      for (let i = 0; i < p.length; i += 3) {
        p[i] += dx;
        p[i + 1] += dy;
      }
      return { ...el, points: p };
    }
    case 'line':
      return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy };
    default:
      return { ...el, x: el.x + dx, y: el.y + dy };
  }
}

/** Map an element from one bounding box to another (used for resizing a selection). */
export function transformEl(el: El, from: Bounds, to: Bounds): El {
  const sx = from.w > 1e-6 ? to.w / from.w : 1;
  const sy = from.h > 1e-6 ? to.h / from.h : 1;
  const X = (x: number) => to.x + (x - from.x) * sx;
  const Y = (y: number) => to.y + (y - from.y) * sy;
  switch (el.type) {
    case 'stroke': {
      const p = el.points.slice();
      for (let i = 0; i < p.length; i += 3) {
        p[i] = X(p[i]);
        p[i + 1] = Y(p[i + 1]);
      }
      return { ...el, points: p, size: Math.max(0.5, el.size * Math.sqrt(sx * sy)) };
    }
    case 'line':
      return { ...el, x1: X(el.x1), y1: Y(el.y1), x2: X(el.x2), y2: Y(el.y2) };
    case 'text': {
      const fontSize = Math.max(4, el.fontSize * sy);
      const autoWidth = el.autoWidth && Math.abs(sx - sy) < 1e-3;
      const box = fitTextBox(el.text, fontSize, Math.max(fontSize, el.w * sx), autoWidth);
      return { ...el, x: X(el.x), y: Y(el.y), fontSize, w: box.w, h: box.h, autoWidth };
    }
    default:
      return { ...el, x: X(el.x), y: Y(el.y), w: el.w * sx, h: el.h * sy };
  }
}
