import { describe, expect, it } from 'vitest';
import { filterPoint } from './inkFilter';
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
