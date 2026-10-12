import { describe, expect, it } from 'vitest';
import { CURSOR_DELAY_MS, CursorTrack, type Trail } from './cursorTrack';

/** A pointer moving right at 1 unit per ms, sampled every 16 ms, sent every 100 ms by a clock that starts at 1000. */
function batch(sendAt: number, latency = 20): { trail: Trail; arrival: number } {
  const points: Trail['points'] = [];
  for (let ago = 96; ago >= 0; ago -= 16) points.push([sendAt + 1000 - ago, 0, ago]);
  return { trail: { ts: sendAt + 1000, points }, arrival: sendAt + latency };
}

describe('CursorTrack', () => {
  it('has no position until something arrives', () => {
    const t = new CursorTrack();
    expect(t.at(0)).toBeNull();
    expect(t.settled(0)).toBe(true);
  });

  it('moves at a steady speed even though updates arrive in bursts', () => {
    const t = new CursorTrack();
    const sends = [0, 100, 200, 300, 400, 500];
    // Updates arrive with uneven delays (20-70 ms).
    const delays = [20, 70, 25, 60, 20, 45];
    sends.forEach((s, i) => {
      const b = batch(s, delays[i]);
      t.push(b.trail, b.arrival);
    });
    // Sample the playback every 10 ms between 350 and 650: a steady speed means every step is the same size.
    const xs: number[] = [];
    for (let now = 350; now <= 650; now += 10) xs.push(t.at(now)!.x);
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    const [min, max] = [Math.min(...steps), Math.max(...steps)];
    expect(max - min).toBeLessThan(0.5);
    expect(min).toBeGreaterThan(9);
  });

  it('shows the cursor a little behind real time and then stops at the last position', () => {
    const t = new CursorTrack();
    const b = batch(0, 20);
    t.push(b.trail, b.arrival);
    // The last point was recorded at sender time 1000, which arrives at 20 ms.
    expect(t.settled(20)).toBe(false);
    expect(t.settled(20 + CURSOR_DELAY_MS + 5)).toBe(true);
    expect(t.at(5000)).toEqual({ x: 1000, y: 0 });
  });

  it('does not slide across the board after a long pause', () => {
    const t = new CursorTrack();
    t.push({ ts: 1000, points: [[0, 0, 0]] }, 1000);
    t.push({ ts: 5000, points: [[900, 0, 0]] }, 5000);
    // Halfway through the pause the cursor is still where it stopped.
    expect(t.at(3000)).toEqual({ x: 0, y: 0 });
    expect(t.at(5000 + CURSOR_DELAY_MS + 10)).toEqual({ x: 900, y: 0 });
  });

  it('ignores points that are not newer than ones it already has', () => {
    const t = new CursorTrack();
    t.push({ ts: 1000, points: [[10, 0, 0]] }, 1000);
    t.push({ ts: 900, points: [[999, 0, 0]] }, 1010);
    expect(t.at(2000)).toEqual({ x: 10, y: 0 });
  });
});
