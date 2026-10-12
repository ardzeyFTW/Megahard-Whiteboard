export const FONT_FAMILY = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif';
export const LINE_HEIGHT = 1.3;
export const NOTE_PAD = 16;
export const NOTE_TEXT_COLOR = '#1f1f1f';

export const font = (size: number) => `${size}px ${FONT_FAMILY}`;

let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported in this browser');
    measureCtx = ctx;
  }
  return measureCtx;
}

export function measure(text: string, size: number): number {
  const ctx = measurer();
  ctx.font = font(size);
  return ctx.measureText(text).width;
}

const wrapCache = new Map<string, string[]>();

/** Word-wrap text to a max width; words longer than a line are broken by character. */
export function wrapText(text: string, size: number, maxW: number): string[] {
  const key = `${size}|${maxW}|${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;

  const ctx = measurer();
  ctx.font = font(size);
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const tokens = para.split(/(\s+)/).filter(Boolean);
    let line = '';
    for (const tok of tokens) {
      const candidate = line + tok;
      if (ctx.measureText(candidate).width <= maxW) {
        line = candidate;
        continue;
      }
      if (/^\s+$/.test(tok)) {
        out.push(line);
        line = '';
        continue;
      }
      if (line) out.push(line.trimEnd());
      line = '';
      if (ctx.measureText(tok).width <= maxW) {
        line = tok;
        continue;
      }
      let chunk = '';
      for (const ch of tok) {
        if (chunk && ctx.measureText(chunk + ch).width > maxW) {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }
    out.push(line);
  }

  if (wrapCache.size > 4000) wrapCache.clear();
  wrapCache.set(key, out);
  return out;
}

/** Size a text box. With autoWidth the box is as wide as its longest line. */
export function fitTextBox(text: string, size: number, w: number, autoWidth: boolean) {
  if (autoWidth) {
    let widest = 0;
    for (const line of text.split('\n')) widest = Math.max(widest, measure(line, size));
    w = Math.max(size * 0.6, Math.ceil(widest) + 2);
  }
  const lines = wrapText(text, size, w);
  return { w, h: Math.max(1, lines.length) * size * LINE_HEIGHT, lines };
}

const noteCache = new Map<string, { size: number; lines: string[] }>();

/** Pick the largest font size at which the note's text fits inside the note. */
export function fitNote(text: string, w: number, h: number): { size: number; lines: string[] } {
  const key = `${w}|${h}|${text}`;
  const hit = noteCache.get(key);
  if (hit) return hit;

  const innerW = Math.max(1, w - NOTE_PAD * 2);
  const innerH = Math.max(1, h - NOTE_PAD * 2);
  const start = Math.max(6, Math.round(Math.min(w, h) * 0.14));
  const min = Math.max(4, Math.min(w, h) * 0.035);
  const step = Math.max(1, start / 28);
  let result = { size: start, lines: wrapText(text, start, innerW) };
  for (let size = start; size >= min; size -= step) {
    const lines = wrapText(text, size, innerW);
    result = { size, lines };
    if (lines.length * size * LINE_HEIGHT <= innerH) break;
  }

  if (noteCache.size > 2000) noteCache.clear();
  noteCache.set(key, result);
  return result;
}
