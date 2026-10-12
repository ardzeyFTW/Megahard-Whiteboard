// Following the sharer's view. The sharer sends the part of the board they're looking at (a
// rectangle in board coordinates). A viewer's screen is a different shape, so instead of copying
// the camera we fit that rectangle into their own pane: they see what the sharer sees, however
// big or small their screen is, and glide there instead of jumping.
import type { Bounds, Camera } from '../types';

/**
 * How closely a viewer is following the sharer.
 * - locked: the same view, position and zoom.
 * - position: the same place, at the viewer's own zoom.
 * - off: looking around on their own.
 */
export type FollowMode = 'off' | 'locked' | 'position';

/** What the viewer did with the view while following. */
export type FollowDisturbance = 'pan' | 'zoom' | 'select';

/** Zooming keeps the place but lets go of the zoom; moving around or picking something lets go of everything. */
export function followAfterUser(mode: FollowMode, did: FollowDisturbance): FollowMode {
  if (mode === 'off') return 'off';
  return did === 'zoom' ? 'position' : 'off';
}

/** The eye button: start following, match the sharer's zoom again, or stop. */
export function followAfterClick(mode: FollowMode): FollowMode {
  return mode === 'locked' ? 'off' : 'locked';
}

export interface FollowTarget {
  /** The point at the middle of the sharer's view, and the zoom that fits their view in this pane. */
  cx: number;
  cy: number;
  zoom: number;
}

/** Where to look, and how closely, to see all of `view` in a pane of this size. Null when there's nothing sensible to show. */
export function followTarget(view: Bounds, width: number, height: number, minZoom: number, maxZoom: number): FollowTarget | null {
  if (!(width > 0 && height > 0 && view.w > 0 && view.h > 0)) return null;
  const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(width / view.w, height / view.h)));
  return { cx: view.x + view.w / 2, cy: view.y + view.h / 2, zoom };
}

/**
 * Move the camera part of the way to the target. `k` is how much of the remaining distance to cover
 * (0 to 1); with `snap` it goes all the way. `moving` is false once it has arrived.
 */
export function stepFollow(cam: Camera, target: FollowTarget, width: number, height: number, k: number, snap: boolean): { cam: Camera; moving: boolean } {
  const cx = cam.x + width / 2 / cam.zoom;
  const cy = cam.y + height / 2 / cam.zoom;
  const next = snap
    ? target
    : { cx: cx + (target.cx - cx) * k, cy: cy + (target.cy - cy) * k, zoom: cam.zoom * Math.pow(target.zoom / cam.zoom, k) };
  // Close enough: land exactly, so it stops redrawing.
  const px = Math.hypot(target.cx - next.cx, target.cy - next.cy) * next.zoom;
  const done = snap || (px < 0.3 && Math.abs(target.zoom / next.zoom - 1) < 0.002);
  const at = done ? target : next;
  return { cam: { zoom: at.zoom, x: at.cx - width / 2 / at.zoom, y: at.cy - height / 2 / at.zoom }, moving: !done };
}
