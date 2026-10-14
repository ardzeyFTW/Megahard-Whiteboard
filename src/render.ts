import type { Background, BoardDoc, Bounds, Camera, El } from './types';
import { arrowSize, boundsOf, rectsIntersect, rotationOf, shapeOutline, unionBounds } from './geometry';
import { arrowHeadPath, strokePaths } from './ink';
import { LINE_HEIGHT, NOTE_TEXT_COLOR, fitNote, font, wrapText } from './text';
import { isDark } from './util';

export class ImageCache {
  private map = new Map<string, HTMLImageElement>();

  constructor(private onLoad: () => void) {}

  /** Returns the image once it has loaded, starting the load on first request. */
  get(id: string, src: string | undefined): HTMLImageElement | null {
    if (!src) return null;
    let img = this.map.get(id);
    if (!img) {
      img = new Image();
      img.onload = () => this.onLoad();
      img.src = src;
      this.map.set(id, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** Wait until every image used by these elements has loaded (for exports and thumbnails). */
  async ensure(elements: El[], assets: Record<string, string>): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const el of elements) {
      if (el.type !== 'image') continue;
      this.get(el.asset, assets[el.asset]);
      const img = this.map.get(el.asset);
      if (!img || img.complete) continue;
      // Not img.decode(): in a background tab it may never finish, which would hold up saving.
      waits.push(new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 3000);
      }));
    }
    await Promise.all(waits);
  }
}

export interface DrawOpts {
  images: ImageCache;
  assets: Record<string, string>;
  editingId?: string | null;
}

/** Draws the background in screen space (identity transform, or DPR scale). */
export function drawBackground(ctx: CanvasRenderingContext2D, bg: Background, cam: Camera, w: number, h: number) {
  ctx.fillStyle = bg.color;
  ctx.fillRect(0, 0, w, h);
  if (bg.pattern === 'none') return;

  // The pattern is fixed to the board. When zoomed out far enough that it would turn into
  // noise, it fades out instead of re-spacing.
  const step = 40 * cam.zoom;
  const fade = Math.min(1, Math.max(0, (step - 10) / 8));
  if (fade <= 0) return;
  const ox = (((-cam.x * cam.zoom) % step) + step) % step;
  const oy = (((-cam.y * cam.zoom) % step) + step) % step;
  const dark = isDark(bg.color);
  ctx.save();
  ctx.globalAlpha = fade;

  const lines = bg.pattern === 'grid' || bg.pattern === 'gridDots';
  const dots = bg.pattern === 'dots' || bg.pattern === 'gridDots';
  // Snap to the pixel grid so lines stay crisp and dots sit exactly on the crossings.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = ox; x < w; x += step) xs.push(Math.round(x) + 0.5);
  for (let y = oy; y < h; y += step) ys.push(Math.round(y) + 0.5);

  if (lines) {
    // With dots on top, the lines step back so the crossings stand out.
    const a = bg.pattern === 'gridDots' ? (dark ? 0.06 : 0.05) : dark ? 0.1 : 0.08;
    ctx.strokeStyle = dark ? `rgba(255,255,255,${a})` : `rgba(15,23,42,${a})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of xs) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (const y of ys) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  }
  if (dots) {
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(15,23,42,0.22)';
    // Dots scale with the zoom (like the rest of the board), within readable limits.
    const r = Math.min(4, Math.max(0.9, step * 0.025)) * (lines ? 1.3 : 1);
    ctx.beginPath();
    for (const x of xs) {
      for (const y of ys) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
  ctx.restore();
}

function shapePath(el: Extract<El, { type: 'shape' }>): Path2D {
  const p = new Path2D();
  if (el.kind === 'ellipse') {
    p.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
    return p;
  }
  const poly = shapeOutline(el.kind, el.x, el.y, el.w, el.h);
  poly.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
  p.closePath();
  return p;
}

export function drawElement(ctx: CanvasRenderingContext2D, el: El, o: DrawOpts) {
  const rot = rotationOf(el);
  if (!rot || el.type === 'stroke' || el.type === 'line') {
    drawUpright(ctx, el, o);
    return;
  }
  // Turn the canvas about the element's center, then draw it as if it weren't turned.
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.translate(-cx, -cy);
  drawUpright(ctx, el, o);
  ctx.restore();
}

function drawUpright(ctx: CanvasRenderingContext2D, el: El, o: DrawOpts) {
  switch (el.type) {
    case 'stroke': {
      const { body, heads } = strokePaths(el);
      const alpha = el.opacity ?? (el.highlighter ? 0.4 : 1);
      ctx.fillStyle = el.color;
      ctx.globalAlpha = alpha;
      ctx.fill(body);
      if (heads.length && alpha < 1) {
        // Don't paint the arrowheads over the line again, or the overlap shows up darker.
        const b = boundsOf(el);
        const outside = new Path2D();
        outside.rect(b.x - 1, b.y - 1, b.w + 2, b.h + 2);
        outside.addPath(body);
        ctx.save();
        ctx.clip(outside, 'evenodd');
        heads.forEach((hd) => ctx.fill(hd));
        ctx.restore();
      } else {
        heads.forEach((hd) => ctx.fill(hd));
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'shape': {
      const p = shapePath(el);
      if (el.fill !== 'transparent') {
        ctx.fillStyle = el.fill;
        ctx.fill(p);
      }
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      ctx.lineJoin = 'round';
      ctx.stroke(p);
      break;
    }
    case 'line': {
      let { x2, y2 } = el;
      const len = Math.hypot(el.x2 - el.x1, el.y2 - el.y1);
      const head = arrowSize(el.strokeWidth);
      if (el.arrowEnd && len > head) {
        // Stop the shaft inside the arrowhead so the round cap doesn't poke through the tip.
        x2 -= ((el.x2 - el.x1) / len) * head * 0.6;
        y2 -= ((el.y2 - el.y1) / len) * head * 0.6;
      }
      ctx.strokeStyle = el.color;
      ctx.lineWidth = el.strokeWidth;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(el.x1, el.y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (el.arrowEnd) {
        ctx.fillStyle = el.color;
        ctx.fill(arrowHeadPath(el.x1, el.y1, el.x2, el.y2, head));
      }
      break;
    }
    case 'note': {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.16)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = el.color;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(el.x, el.y, el.w, el.h, 4);
      else ctx.rect(el.x, el.y, el.w, el.h);
      ctx.fill();
      ctx.restore();
      if (el.text && el.id !== o.editingId) {
        const fit = fitNote(el.text, el.w, el.h);
        const lh = fit.size * LINE_HEIGHT;
        ctx.save();
        ctx.beginPath();
        ctx.rect(el.x, el.y, el.w, el.h);
        ctx.clip();
        ctx.fillStyle = NOTE_TEXT_COLOR;
        ctx.font = font(fit.size);
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        let y = el.y + (el.h - fit.lines.length * lh) / 2 + (lh - fit.size) / 2;
        for (const line of fit.lines) {
          ctx.fillText(line, el.x + el.w / 2, y);
          y += lh;
        }
        ctx.restore();
      }
      break;
    }
    case 'text': {
      if (el.id === o.editingId) break;
      const lh = el.fontSize * LINE_HEIGHT;
      ctx.fillStyle = el.color;
      ctx.font = font(el.fontSize);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      wrapText(el.text, el.fontSize, el.w).forEach((line, i) => {
        ctx.fillText(line, el.x, el.y + i * lh + (lh - el.fontSize) / 2);
      });
      break;
    }
    case 'image': {
      const img = o.images.get(el.asset, o.assets[el.asset]);
      if (img) ctx.drawImage(img, el.x, el.y, el.w, el.h);
      else {
        ctx.fillStyle = 'rgba(128,128,128,0.15)';
        ctx.fillRect(el.x, el.y, el.w, el.h);
      }
      break;
    }
  }
}

export function drawElements(ctx: CanvasRenderingContext2D, els: El[], view: Bounds | null, o: DrawOpts) {
  for (const el of els) {
    if (view && !rectsIntersect(boundsOf(el), view)) continue;
    drawElement(ctx, el, o);
  }
}

export interface RenderTarget {
  padding: number;
  scale: number;
  maxW?: number;
  maxH?: number;
  /** Expand the area to this width/height ratio. */
  aspect?: number;
  minW?: number;
  minH?: number;
}

type Drawable = Pick<BoardDoc, 'elements' | 'background' | 'assets'>;

/** Render the whole board (or its content area) to an offscreen canvas. */
export function renderBoard(src: Drawable, images: ImageCache, t: RenderTarget): HTMLCanvasElement {
  const content = unionBounds(src.elements.map(boundsOf)) ?? { x: -320, y: -200, w: 640, h: 400 };
  const b = { x: content.x - t.padding, y: content.y - t.padding, w: content.w + t.padding * 2, h: content.h + t.padding * 2 };
  if (t.minW && b.w < t.minW) {
    b.x -= (t.minW - b.w) / 2;
    b.w = t.minW;
  }
  if (t.minH && b.h < t.minH) {
    b.y -= (t.minH - b.h) / 2;
    b.h = t.minH;
  }
  if (t.aspect) {
    if (b.w / b.h < t.aspect) {
      const nw = b.h * t.aspect;
      b.x -= (nw - b.w) / 2;
      b.w = nw;
    } else {
      const nh = b.w / t.aspect;
      b.y -= (nh - b.h) / 2;
      b.h = nh;
    }
  }

  let scale = t.scale;
  if (t.maxW) scale = Math.min(scale, t.maxW / b.w);
  if (t.maxH) scale = Math.min(scale, t.maxH / b.h);
  // Stay inside browser canvas limits.
  scale = Math.min(scale, 8192 / b.w, 8192 / b.h, Math.sqrt(40e6 / (b.w * b.h)));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(b.w * scale));
  canvas.height = Math.max(1, Math.round(b.h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  drawBackground(ctx, src.background, { x: b.x, y: b.y, zoom: scale }, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);
  drawElements(ctx, src.elements, null, { images, assets: src.assets });
  return canvas;
}

export async function makeThumbnail(src: Drawable, images = new ImageCache(() => undefined)): Promise<string> {
  await images.ensure(src.elements, src.assets);
  const canvas = renderBoard(src, images, { padding: 40, scale: 1, maxW: 400, maxH: 250, aspect: 1.6, minW: 900, minH: 560 });
  return canvas.toDataURL('image/jpeg', 0.72);
}
