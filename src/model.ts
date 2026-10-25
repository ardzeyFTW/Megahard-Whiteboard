import type { Background, BoardDoc, Camera, El, NoteEl, ShapeKind, TextEl } from './types';
import { clamp, uid } from './util';
import { fitTextBox } from './text';
import { defaultBackground } from './prefs';

export function newBoardDoc(name = 'Untitled board', background = defaultBackground()): BoardDoc {
  const now = Date.now();
  return {
    version: 1,
    id: uid(),
    name,
    createdAt: now,
    updatedAt: now,
    background,
    elements: [],
    assets: {},
    camera: { x: 0, y: 0, zoom: 1 },
  };
}

export function createNote(cx: number, cy: number, color: string, text = ''): NoteEl {
  return { type: 'note', id: uid(), x: cx - 100, y: cy - 100, w: 200, h: 200, color, text };
}

export function createText(x: number, y: number, text: string, opts: { fontSize?: number; color?: string } = {}): TextEl {
  const fontSize = opts.fontSize ?? 24;
  const box = fitTextBox(text, fontSize, 0, true);
  return { type: 'text', id: uid(), x, y, w: box.w, h: box.h, text, color: opts.color ?? '#1f1f1f', fontSize, autoWidth: true };
}

// ---------------------------------------------------------------------------
// Validation for anything that comes from outside the app (files, clipboard).

const SHAPE_KINDS: ShapeKind[] = ['rect', 'ellipse', 'triangle', 'diamond'];
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const parseTime = (v: unknown, fallback: number): number => {
  if (num(v) && v > 0) return v;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
};
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const color = (v: unknown, fallback: string) =>
  typeof v === 'string' && /^(#[0-9a-fA-F]{3,8}|transparent)$/.test(v) ? v : fallback;
const MAX_TEXT = 20000;
/** A turn in radians, kept only when it's a real, non-zero angle. */
const turn = (v: unknown) => (num(v) && v % (Math.PI * 2) !== 0 ? v % (Math.PI * 2) : undefined);
const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/**
 * `fitText: false` keeps a text box's stored size instead of measuring it again. Used for boards
 * shared live, so everyone sees the same box whatever fonts their device has.
 */
export function sanitizeElement(raw: unknown, opts: { fitText?: boolean } = {}): El | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 100) && r.id ? r.id : uid();
  const box = [r.x, r.y, r.w, r.h];
  switch (r.type) {
    case 'stroke': {
      const pts = r.points;
      if (!Array.isArray(pts) || pts.length < 3 || pts.length % 3 !== 0 || !pts.every(num) || !num(r.size)) return null;
      return {
        type: 'stroke', id, points: pts.slice(), color: color(r.color, '#1f1f1f'), size: clamp(r.size, 0.5, 500),
        highlighter: r.highlighter === true || undefined, arrow: r.arrow === true || undefined,
        arrowStart: r.arrowStart === true || undefined, opacity: num(r.opacity) ? clamp(r.opacity, 0.05, 1) : undefined,
        simulatePressure: r.simulatePressure === true || undefined,
      };
    }
    case 'shape':
      if (!box.every(num) || !num(r.strokeWidth)) return null;
      return {
        type: 'shape', id, kind: SHAPE_KINDS.includes(r.kind as ShapeKind) ? (r.kind as ShapeKind) : 'rect',
        x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number,
        stroke: color(r.stroke, '#1f1f1f'), fill: color(r.fill, 'transparent'), strokeWidth: clamp(r.strokeWidth, 0.5, 100),
        rotation: turn(r.rotation),
      };
    case 'line':
      if (![r.x1, r.y1, r.x2, r.y2].every(num) || !num(r.strokeWidth)) return null;
      return {
        type: 'line', id, x1: r.x1 as number, y1: r.y1 as number, x2: r.x2 as number, y2: r.y2 as number,
        color: color(r.color, '#1f1f1f'), strokeWidth: clamp(r.strokeWidth, 0.5, 100), arrowEnd: r.arrowEnd === true,
      };
    case 'note':
      if (!box.every(num)) return null;
      return {
        type: 'note', id, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number,
        color: color(r.color, '#fff4a3'), text: str(r.text, MAX_TEXT) ? r.text : '', rotation: turn(r.rotation),
      };
    case 'text': {
      if (!box.every(num) || !num(r.fontSize)) return null;
      const text = str(r.text, MAX_TEXT) ? r.text : '';
      const fontSize = clamp(r.fontSize, 4, 2000);
      const autoWidth = r.autoWidth === true;
      const fit = opts.fitText === false ? { w: r.w as number, h: r.h as number } : fitTextBox(text, fontSize, Math.max(fontSize, r.w as number), autoWidth);
      return { type: 'text', id, x: r.x as number, y: r.y as number, w: fit.w, h: fit.h, text, color: color(r.color, '#1f1f1f'), fontSize, autoWidth, rotation: turn(r.rotation) };
    }
    case 'image':
      if (!box.every(num) || !str(r.asset, 100)) return null;
      return { type: 'image', id, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number, asset: r.asset, rotation: turn(r.rotation) };
    default:
      return null;
  }
}

export function sanitizeElements(raw: unknown): El[] {
  if (!Array.isArray(raw)) return [];
  const out: El[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const el = sanitizeElement(item);
    if (!el) continue;
    if (seen.has(el.id)) el.id = uid();
    seen.add(el.id);
    out.push(el);
  }
  return out;
}

export function sanitizeAssets(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.length <= 100 && typeof v === 'string' && SAFE_IMAGE.test(v)) out[k] = v;
  }
  return out;
}

/** Validate an imported board. Always gets a fresh id so it never overwrites an existing board. */
export function sanitizeBoard(raw: unknown, fallbackTime?: number): BoardDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const bg = (r.background ?? {}) as Record<string, unknown>;
  const background: Background = {
    color: color(bg.color, '#ffffff'),
    pattern: bg.pattern === 'grid' || bg.pattern === 'dots' || bg.pattern === 'gridDots' ? bg.pattern : 'none',
  };
  const cam = (r.camera ?? {}) as Record<string, unknown>;
  const camera: Camera =
    num(cam.x) && num(cam.y) && num(cam.zoom) ? { x: cam.x, y: cam.y, zoom: clamp(cam.zoom, 0.05, 3.5) } : { x: 0, y: 0, zoom: 1 };
  const now = fallbackTime && Number.isFinite(fallbackTime) ? fallbackTime : Date.now();
  const updatedAt = parseTime(r.updatedAt, parseTime(r.createdAt, now));
  const createdAt = parseTime(r.createdAt, updatedAt);
  const assets = sanitizeAssets(r.assets);
  const elements = sanitizeElements(r.elements).filter((e) => e.type !== 'image' || e.asset in assets);
  return {
    version: 1,
    id: uid(),
    name: str(r.name, 200) && r.name.trim() ? r.name.trim() : 'Imported board',
    createdAt,
    updatedAt,
    background,
    elements,
    assets,
    camera,
  };
}

/** Keep only the assets that elements still reference. */
export function referencedAssets(elements: El[], assets: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of elements) if (el.type === 'image' && assets[el.asset]) out[el.asset] = assets[el.asset];
  return out;
}
