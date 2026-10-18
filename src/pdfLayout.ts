// Pure helpers for importing a PDF: which pages to take, and where each one goes on the board.

export type PageRotation = 0 | 90 | 180 | 270;

/** How imported pages are arranged: one column, one row, or a grid with a fixed number of columns. */
export type StackMode = 'vertical' | 'horizontal' | 'grid';

/** In a grid: fill each row before starting the next (1 2 / 3 4), or each column (1 3 / 2 4). */
export type GridFill = 'across' | 'down';

export interface StackOptions {
  mode: StackMode;
  /** Columns when mode is 'grid'. */
  columns: number;
  /** Which way a grid fills. Rows and columns of one page wide ignore it. */
  fill: GridFill;
  /** Space between pages, in board units. */
  gap: number;
}

export const DEFAULT_STACK: StackOptions = { mode: 'vertical', columns: 2, fill: 'across', gap: 40 };
export const MAX_GRID_COLUMNS = 12;

export const turn = (r: PageRotation, quarterTurns = 1): PageRotation =>
  ((((r + 90 * quarterTurns) % 360) + 360) % 360) as PageRotation;

/** A page's size once the person's rotation is applied (a quarter turn swaps width and height). */
export function rotatedSize(w: number, h: number, r: PageRotation): { w: number; h: number } {
  return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
}

/**
 * Turn "1-3, 5, 8-" into page numbers (1-based, ascending, no repeats, only pages that exist).
 * Returns null when the text isn't a page list. An open end ("8-") runs to the last page.
 */
export function parsePageRange(text: string, pageCount: number): number[] | null {
  const pages = new Set<number>();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)(?:(-|–)(\d*))?$/.exec(part);
    if (!m || (!m[1] && !m[3])) return null;
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : pageCount) : from;
    if (from < 1 || to < from) return null;
    for (let p = from; p <= Math.min(to, pageCount); p++) pages.add(p);
  }
  return pages.size ? [...pages].sort((a, b) => a - b) : null;
}

/** The opposite of parsePageRange: [1,2,3,5] becomes "1-3, 5". */
export function formatPageRange(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

export interface Placed {
  x: number;
  y: number;
}

/**
 * Where each page's top-left goes, with the whole block's top-left at (0, 0). A single column runs top
 * to bottom and a single row left to right; a grid goes by `fill`. A page smaller than its neighbours
 * sits in the middle of its cell.
 */
export function layoutPages(sizes: { w: number; h: number }[], opts: StackOptions): { positions: Placed[]; w: number; h: number } {
  const n = sizes.length;
  if (!n) return { positions: [], w: 0, h: 0 };
  const wanted = opts.mode === 'vertical' ? 1 : opts.mode === 'horizontal' ? n : Math.max(1, Math.min(Math.floor(opts.columns) || 1, n));
  const down = opts.mode === 'grid' && opts.fill === 'down';
  // Filling down, the rows come first and the columns are however many it takes.
  const rows = Math.ceil(n / wanted);
  const cols = down ? Math.ceil(n / rows) : wanted;
  const cellOf = (i: number) => (down ? { c: Math.floor(i / rows), r: i % rows } : { c: i % cols, r: Math.floor(i / cols) });
  const colW = new Array<number>(cols).fill(0);
  const rowH = new Array<number>(rows).fill(0);
  sizes.forEach((s, i) => {
    const { c, r } = cellOf(i);
    colW[c] = Math.max(colW[c], s.w);
    rowH[r] = Math.max(rowH[r], s.h);
  });
  const colX: number[] = [];
  const rowY: number[] = [];
  let x = 0;
  for (const w of colW) {
    colX.push(x);
    x += w + opts.gap;
  }
  let y = 0;
  for (const hh of rowH) {
    rowY.push(y);
    y += hh + opts.gap;
  }
  const positions = sizes.map((s, i) => {
    const { c, r } = cellOf(i);
    return { x: colX[c] + (colW[c] - s.w) / 2, y: rowY[r] + (rowH[r] - s.h) / 2 };
  });
  return { positions, w: x - opts.gap, h: y - opts.gap };
}
