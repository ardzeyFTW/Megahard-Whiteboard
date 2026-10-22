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

  it('does not swell up at the start when drawing very slowly with a small pen size', () => {
    for (const size of [1, 2]) {
      const points = [0, 0, 0.5];
      for (let step = 1; step <= 10; step++) {
        const raw = { x: step * 0.8, y: 0 };
        const prev = { x: points[points.length - 3], y: points[points.length - 2] };
        const f = filterPoint(prev, raw, 1);
        points.push(f.x, f.y, 0.5);

        const outline = strokeOutline({ points, size, simulatePressure: true });
        const minY = Math.min(...outline.map((p) => p[1]));
        const maxY = Math.max(...outline.map((p) => p[1]));
        const height = maxY - minY;

        // Height should stay close to the pen size, never ballooning to 2x–3x size while length < 3.
        expect(height).toBeGreaterThan(size * 0.9);
        expect(height).toBeLessThan(size * 1.15);
      }
    }
  });

  it('keeps tight curves stable in real time as new points are added', () => {
    const allPoints: number[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = i * 0.4;
      allPoints.push(20 + 4 * Math.cos(a), 20 + 4 * Math.sin(a), 0.5);
    }
    const early = strokeOutline({ points: allPoints.slice(0, 6 * 3), size: 1.5, simulatePressure: true });
    const later = strokeOutline({ points: allPoints, size: 1.5, simulatePressure: true });

    // The first several left-side outline points of the tight curve must not jump when later points arrive.
    for (let i = 0; i < 4; i++) {
      expect(later[i][0]).toBeCloseTo(early[i][0], 5);
      expect(later[i][1]).toBeCloseTo(early[i][1], 5);
    }
  });
});
