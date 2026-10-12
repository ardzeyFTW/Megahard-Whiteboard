import type { Pt } from './types';

/**
 * Pointer positions are whole screen pixels, so slow, straight movement comes out as little
 * stair steps. They're one pixel on screen, but zoomed out that is a lot of board, and once you
 * zoom back in they show up as wobble beside a pen that only looked a pixel or two wide.
 *
 * This pulls each new point toward the previous one by an amount that depends on how far the
 * pointer moved, measured in screen pixels: slow, tiny movements (where the noise is) are
 * smoothed, while quick strokes pass through almost unchanged.
 */
const SMOOTHING_PX = 2;

export function filterPoint(prev: Pt, raw: Pt, zoom: number): Pt {
  const d = Math.hypot(raw.x - prev.x, raw.y - prev.y) * zoom;
  const a = d / (d + SMOOTHING_PX);
  return { x: prev.x + (raw.x - prev.x) * a, y: prev.y + (raw.y - prev.y) * a };
}
