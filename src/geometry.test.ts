import { describe, expect, it } from 'vitest';
import { boundsOf, hitTest, normAngle, rotateEl, transformEl } from './geometry';
import { sanitizeElement } from './model';
import type { LineEl, NoteEl, ShapeEl, StrokeEl } from './types';

const rect = (over: Partial<ShapeEl> = {}): ShapeEl => ({
  type: 'shape', id: 'a', kind: 'rect', x: 0, y: 0, w: 100, h: 20, stroke: '#000000', fill: 'transparent', strokeWidth: 0, ...over,
});

describe('rotation', () => {
  it('turns a box about a point by moving its center and recording the angle', () => {
    const el = rotateEl(rect(), { x: 0, y: 0 }, Math.PI / 2) as ShapeEl;
    // Center (50, 10) swings to (-10, 50); the box itself stays 100 × 20.
    expect(el.x + el.w / 2).toBeCloseTo(-10);
    expect(el.y + el.h / 2).toBeCloseTo(50);
    expect(el.w).toBe(100);
    expect(el.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('turns ink and lines by moving their points', () => {
    const line: LineEl = { type: 'line', id: 'l', x1: 10, y1: 0, x2: 20, y2: 0, color: '#000000', strokeWidth: 2, arrowEnd: false };
    const turned = rotateEl(line, { x: 0, y: 0 }, Math.PI / 2) as LineEl;
    expect([turned.x1, turned.y1, turned.x2, turned.y2].map(Math.round)).toEqual([0, 10, 0, 20]);

    const stroke: StrokeEl = { type: 'stroke', id: 's', points: [10, 0, 0.5, 20, 0, 0.7], color: '#000000', size: 2 };
    const out = rotateEl(stroke, { x: 0, y: 0 }, Math.PI) as StrokeEl;
    expect(out.points.map((v) => Math.round(v * 10) / 10)).toEqual([-10, 0, 0.5, -20, 0, 0.7]);
  });

  it('drops the angle once a full turn is made', () => {
    const half = rotateEl(rect(), { x: 50, y: 10 }, Math.PI);
    expect((rotateEl(half, { x: 50, y: 10 }, Math.PI) as ShapeEl).rotation).toBeUndefined();
    expect(normAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(normAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2);
  });

  it('bounds a turned box by the space it covers', () => {
    const b = boundsOf(rect({ rotation: Math.PI / 2 }));
    expect(b.w).toBeCloseTo(20);
    expect(b.h).toBeCloseTo(100);
    expect(b.x).toBeCloseTo(40);
    expect(b.y).toBeCloseTo(-40);
  });

  it('hit-tests a turned box where it really is', () => {
    const el = rect({ rotation: Math.PI / 2, fill: '#ffffff' });
    // Turned upright: now 20 wide and 100 tall around (50, 10).
    expect(hitTest(el, { x: 50, y: 55 }, 0)).toBe(true);
    expect(hitTest(el, { x: 5, y: 10 }, 0)).toBe(false);
    expect(hitTest(rect({ fill: '#ffffff' }), { x: 5, y: 10 }, 0)).toBe(true);
  });

  it('scales a turned box along its own axes', () => {
    const note: NoteEl = { type: 'note', id: 'n', x: 0, y: 0, w: 100, h: 20, color: '#fff4a3', text: '', rotation: Math.PI / 2 };
    // Stretching the board's width scales the note's height, since the note lies on its side.
    const out = transformEl(note, { x: 0, y: 0, w: 20, h: 100 }, { x: 0, y: 0, w: 40, h: 100 }) as NoteEl;
    expect(out.w).toBeCloseTo(100);
    expect(out.h).toBeCloseTo(40);
    expect(out.rotation).toBe(Math.PI / 2);
  });

  it('keeps a valid angle from outside and ignores a bad one', () => {
    const raw = { type: 'shape', id: 'x', kind: 'rect', x: 0, y: 0, w: 5, h: 5, strokeWidth: 2 };
    expect((sanitizeElement({ ...raw, rotation: 1 }) as ShapeEl).rotation).toBe(1);
    expect((sanitizeElement({ ...raw, rotation: 'spin' }) as ShapeEl).rotation).toBeUndefined();
    expect((sanitizeElement({ ...raw, rotation: Math.PI * 2 }) as ShapeEl).rotation).toBeUndefined();
  });
});
