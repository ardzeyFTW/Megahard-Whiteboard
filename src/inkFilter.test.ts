import { describe, expect, it } from 'vitest';
import { filterPoint } from './inkFilter';
import { strokeOutline } from './ink';
import type { Pt } from './types';

/** A slow diagonal drawn with the mouse: whole screen pixels, so it comes out as stair steps. */
function drawSlowLine(zoom: number, smooth: boolean): Pt[] {
  const out: Pt[] = [{ x: 0, y: 0 }];
  for (let i = 1; i <= 200; i++) {
    const raw = { x: Math.round(i * 0.9) / zoom, y: Math.round(i * 0.45) / zoom };
    out.push(smooth ? filterPoint(out[out.length - 1], raw, zoom) : raw);
  }
  return out;
}

/** Worst distance from the ideal line, in screen pixels. */
function worstWobble(pts: Pt[], zoom: number): number {
  const len = Math.hypot(0.9, 0.45);
  let worst = 0;
  for (const p of pts) worst = Math.max(worst, Math.abs((p.x * zoom * 0.45 - p.y * zoom * 0.9) / len));
  return worst;
}

/** Vertical thickness of an outline polygon at a given x coordinate. */
function verticalSpanAtX(outline: number[][], x: number): number {
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [x0, y0] = outline[j];
    const [x1, y1] = outline[i];
    if ((x0 <= x && x <= x1) || (x1 <= x && x <= x0)) {
      const t = x1 === x0 ? 0.5 : (x - x0) / (x1 - x0);
      const y = y0 + t * (y1 - y0);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return maxY > minY ? maxY - minY : 0;
}

describe('filterPoint', () => {
  it('smooths pixel stair steps, in screen pixels, at any zoom', () => {
    for (const zoom of [0.1, 1, 8]) {
      const raw = worstWobble(drawSlowLine(zoom, false), zoom);
      const smoothed = worstWobble(drawSlowLine(zoom, true), zoom);
      expect(smoothed).toBeLessThan(raw);
    }
  });

  it('gives the same result for the same screen movement at any zoom', () => {
    const a = filterPoint({ x: 0, y: 0 }, { x: 1, y: 1 }, 1);
    const b = filterPoint({ x: 0, y: 0 }, { x: 10, y: 10 }, 0.1);
    expect(b.x).toBeCloseTo(a.x * 10);
    expect(b.y).toBeCloseTo(a.y * 10);
  });

  it('lets fast movement through almost untouched', () => {
    const p = filterPoint({ x: 0, y: 0 }, { x: 200, y: 0 }, 1);
    expect(p.x).toBeGreaterThan(197);
  });
});

describe('strokeOutline', () => {
  it('does not swell into a terminal blob after a thin neck when finishing a fast curved stroke', () => {
    // Bottom curve of a fast "3" sweeping left, then decelerating with a slight lift-off hook at the end.
    const points = [
      160, 290, 0.5,
      175, 305, 0.5,
      172, 323, 0.5,
      152, 336, 0.5,
      125, 340, 0.5,
      106, 339, 0.5,
      100, 334, 0.5,
      99, 333, 0.5,
    ];
    const outline = strokeOutline({ points, size: 24, simulatePressure: true });

    const neckSpan = verticalSpanAtX(outline, 122);
    const tipSpan = verticalSpanAtX(outline, 102);

    expect(neckSpan).toBeGreaterThan(14);
    // The tip before the end cap should not bulge wider than the preceding fast sweep.
    expect(tipSpan).toBeLessThanOrEqual(neckSpan + 0.15);
  });
});
