// How boards are packed for IndexedDB, to use as little space as possible:
//  - stroke points become a Float32Array (4 bytes per number instead of 8), and the
//    pressure value is dropped when it is the same everywhere (mouse and touch strokes);
//  - images are stored as binary Blobs instead of base64 text, a third smaller.
// In memory and in .mh files boards keep the plain format from types.ts.
import type { BoardDoc, El, StrokeEl } from './types';

const DEFAULT_PRESSURE = 0.5;

interface StoredStroke extends Omit<StrokeEl, 'points'> {
  points: Float32Array;
  /** Numbers per point: 2 (x, y) or 3 (x, y, pressure). */
  stride: 2 | 3;
}

export interface StoredDoc extends Omit<BoardDoc, 'elements' | 'assets'> {
  elements: (El | StoredStroke)[];
  assets: Record<string, Blob | string>;
}

function hasConstantPressure(points: number[]) {
  for (let i = 2; i < points.length; i += 3) if (points[i] !== DEFAULT_PRESSURE) return false;
  return true;
}

function packStroke(el: StrokeEl): StoredStroke {
  const p = el.points;
  const stride = hasConstantPressure(p) ? 2 : 3;
  const out = new Float32Array((p.length / 3) * stride);
  for (let i = 0, j = 0; i < p.length; i += 3, j += stride) {
    out[j] = p[i];
    out[j + 1] = p[i + 1];
    if (stride === 3) out[j + 2] = p[i + 2];
  }
  return { ...el, points: out, stride };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function unpackStroke(el: StoredStroke): StrokeEl {
  const { stride, points: packed, ...rest } = el;
  const n = packed.length / stride;
  const points = new Array<number>(n * 3);
  for (let i = 0; i < n; i++) {
    points[i * 3] = round2(packed[i * stride]);
    points[i * 3 + 1] = round2(packed[i * stride + 1]);
    points[i * 3 + 2] = stride === 3 ? round2(packed[i * stride + 2]) : DEFAULT_PRESSURE;
  }
  return { ...rest, points };
}

// Decoding a large image from base64 on every autosave would be wasteful, so remember the Blob.
const blobCache = new Map<string, { src: string; blob: Blob }>();

export function dataUrlToBlob(src: string): Blob {
  const comma = src.indexOf(',');
  const mime = /^data:([^;,]+)/.exec(src)?.[1] ?? 'application/octet-stream';
  const bin = atob(src.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function assetBlob(id: string, src: string): Blob {
  const cached = blobCache.get(id);
  if (cached && cached.src === src) return cached.blob;
  const blob = dataUrlToBlob(src);
  blobCache.set(id, { src, blob });
  return blob;
}

/** Bytes for everything except stroke points and images, which are counted separately. */
function otherBytes(doc: BoardDoc): number {
  return JSON.stringify(doc, (key, value) => (key === 'points' || key === 'assets' ? undefined : value)).length;
}

/** Pack a board for storage and report roughly how many bytes it takes. */
export function packDoc(doc: BoardDoc): { stored: StoredDoc; bytes: number } {
  let bytes = otherBytes(doc);
  const elements = doc.elements.map((el) => {
    if (el.type !== 'stroke') return el;
    const packed = packStroke(el);
    bytes += packed.points.byteLength;
    return packed;
  });
  const assets: Record<string, Blob> = {};
  for (const [id, src] of Object.entries(doc.assets)) {
    const blob = assetBlob(id, src);
    assets[id] = blob;
    bytes += blob.size;
  }
  return { stored: { ...doc, elements, assets }, bytes };
}

/** Turn a stored board back into the in-memory format. Older, unpacked boards pass through as is. */
export async function unpackDoc(stored: StoredDoc): Promise<BoardDoc> {
  const elements = stored.elements.map((el) =>
    el.type === 'stroke' && el.points instanceof Float32Array ? unpackStroke(el as StoredStroke) : (el as El));
  const assets: Record<string, string> = {};
  for (const [id, value] of Object.entries(stored.assets ?? {})) {
    if (typeof value === 'string') assets[id] = value;
    else {
      const src = await blobToDataUrl(value);
      blobCache.set(id, { src, blob: value });
      assets[id] = src;
    }
  }
  return { ...stored, elements, assets };
}

/** Quick size estimate without packing, e.g. before adding an image. */
export function estimateDocBytes(doc: BoardDoc): number {
  let bytes = otherBytes(doc);
  for (const el of doc.elements) {
    if (el.type === 'stroke') bytes += (el.points.length / 3) * (hasConstantPressure(el.points) ? 2 : 3) * 4;
  }
  for (const src of Object.values(doc.assets)) bytes += Math.round(src.length * 0.75);
  return bytes;
}
