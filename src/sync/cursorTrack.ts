// Plays back another person's cursor smoothly.
//
// Each presence update carries the last few pointer positions with how long before sending each
// one was recorded, plus the sender's clock. We line those up on our own clock and show the cursor
// a little in the past, always between two known positions, so the motion is continuous instead of
// hopping to each new update.
import type { Pt } from '../types';

/** The cursor is shown this long behind real time, enough to cover uneven arrival of updates. */
export const CURSOR_DELAY_MS = 150;
/** Updates used to estimate how long the fastest ones take to arrive. */
const WINDOW = 20;
/** Two positions further apart in time than this are not joined: the cursor waits, then moves on. */
const GAP_MS = 400;
/** Older positions than this (behind what's being shown) are dropped. */
const KEEP_MS = 500;

/** Pointer positions as sent: x, y and milliseconds before `ts` that it was recorded. */
export type TrailPoint = [x: number, y: number, ago: number];

export interface Trail {
  /** The sender's clock when this was sent. Only differences matter. */
  ts: number;
  points: TrailPoint[];
}

interface Sample extends Pt {
  /** On the sender's clock. */
  t: number;
}

export class CursorTrack {
  private samples: Sample[] = [];
  /** How long recent updates took to arrive, measured against the sender's clock. */
  private delays: number[] = [];

  /** Add an update that arrived at local time `arrival`. */
  push(trail: Trail, arrival: number) {
    this.delays.push(arrival - trail.ts);
    if (this.delays.length > WINDOW) this.delays.shift();
    for (const [x, y, ago] of trail.points) {
      const t = trail.ts - ago;
      const last = this.samples[this.samples.length - 1];
      if (last && t <= last.t) continue;
      this.samples.push({ x, y, t });
    }
  }

  /** Where the cursor should be drawn at local time `now`, or null if nothing has arrived. */
  at(now: number): Pt | null {
    const s = this.samples;
    if (!s.length) return null;
    const rt = now - Math.min(...this.delays) - CURSOR_DELAY_MS;
    // Forget what's long past, keeping the one just before the moment shown.
    while (s.length > 2 && s[1].t < rt - KEEP_MS) s.shift();
    if (rt <= s[0].t) return { x: s[0].x, y: s[0].y };
    for (let i = 1; i < s.length; i++) {
      if (rt > s[i].t) continue;
      const a = s[i - 1], b = s[i];
      if (b.t - a.t > GAP_MS) return { x: a.x, y: a.y };
      const k = (rt - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    const end = s[s.length - 1];
    return { x: end.x, y: end.y };
  }

  /** True once playback has reached the newest position, so nothing more will move until an update arrives. */
  settled(now: number): boolean {
    const last = this.samples[this.samples.length - 1];
    return !last || now - Math.min(...this.delays) - CURSOR_DELAY_MS >= last.t;
  }
}
