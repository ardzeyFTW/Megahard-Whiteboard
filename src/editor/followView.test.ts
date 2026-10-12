import { describe, expect, it } from 'vitest';
import { followAfterClick, followAfterUser, followTarget, stepFollow } from './followView';

const view = { x: 100, y: 50, w: 800, h: 400 };

describe('followTarget', () => {
  it('fits the sharer’s view inside a pane of any shape', () => {
    // A pane the same shape and twice the size: zoom 2, centred on the same point.
    expect(followTarget(view, 1600, 800, 0.1, 2.5)).toEqual({ cx: 500, cy: 250, zoom: 2 });
    // A tall narrow pane has to fit the width.
    expect(followTarget(view, 400, 900, 0.1, 2.5)?.zoom).toBeCloseTo(0.5);
    // A short wide pane has to fit the height.
    expect(followTarget(view, 2000, 200, 0.1, 2.5)?.zoom).toBeCloseTo(0.5);
  });

  it('stays within the zoom limits', () => {
    expect(followTarget(view, 8000, 4000, 0.1, 2.5)?.zoom).toBe(2.5);
    expect(followTarget({ x: 0, y: 0, w: 100000, h: 100000 }, 500, 500, 0.1, 2.5)?.zoom).toBe(0.1);
  });

  it('shows nothing it cannot make sense of', () => {
    expect(followTarget({ x: 0, y: 0, w: 0, h: 10 }, 500, 500, 0.1, 2.5)).toBeNull();
    expect(followTarget(view, 0, 500, 0.1, 2.5)).toBeNull();
  });
});

describe('stepFollow', () => {
  const target = followTarget(view, 800, 400, 0.1, 2.5)!;

  it('jumps straight there when asked to snap', () => {
    const { cam, moving } = stepFollow({ x: -5000, y: 3000, zoom: 0.3 }, target, 800, 400, 0.2, true);
    expect(moving).toBe(false);
    expect(cam).toEqual({ x: 100, y: 50, zoom: 1 });
  });

  it('closes the gap a little each step, then lands exactly and stops', () => {
    let cam = { x: 0, y: 0, zoom: 1 };
    let last = Infinity;
    let steps = 0;
    for (; steps < 200; steps++) {
      const r = stepFollow(cam, target, 800, 400, 0.2, false);
      const distance = Math.hypot(r.cam.x - 100, r.cam.y - 50);
      expect(distance).toBeLessThanOrEqual(last);
      last = distance;
      cam = r.cam;
      if (!r.moving) break;
    }
    expect(steps).toBeLessThan(200);
    expect(cam).toEqual({ x: 100, y: 50, zoom: 1 });
  });

  it('keeps the middle of the view in place while only the zoom changes', () => {
    const t = followTarget({ x: 0, y: 0, w: 400, h: 200 }, 800, 400, 0.1, 2.5)!; // zoom 2, centre (200, 100)
    const from = { x: 200 - 400, y: 100 - 200, zoom: 1 }; // centred on (200, 100) at zoom 1
    const { cam } = stepFollow(from, t, 800, 400, 0.5, false);
    expect(cam.x + 800 / 2 / cam.zoom).toBeCloseTo(200);
    expect(cam.y + 400 / 2 / cam.zoom).toBeCloseTo(100);
    expect(cam.zoom).toBeGreaterThan(1);
    expect(cam.zoom).toBeLessThan(2);
  });
});

describe('followAfterUser', () => {
  it('zooming keeps following the place, at the viewer’s own zoom', () => {
    expect(followAfterUser('locked', 'zoom')).toBe('position');
    expect(followAfterUser('position', 'zoom')).toBe('position');
  });

  it('moving around or picking something stops following', () => {
    for (const did of ['pan', 'select'] as const) {
      expect(followAfterUser('locked', did)).toBe('off');
      expect(followAfterUser('position', did)).toBe('off');
    }
  });

  it('does nothing when not following', () => {
    expect(followAfterUser('off', 'zoom')).toBe('off');
    expect(followAfterUser('off', 'pan')).toBe('off');
  });
});

describe('followAfterClick', () => {
  it('starts following, and matches the sharer’s zoom again from the lighter state', () => {
    expect(followAfterClick('off')).toBe('locked');
    expect(followAfterClick('position')).toBe('locked');
  });

  it('stops following when already fully following', () => {
    expect(followAfterClick('locked')).toBe('off');
  });
});
