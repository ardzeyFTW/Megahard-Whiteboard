import { describe, expect, it } from 'vitest';
import { boundsOf, hitTest, normAngle, resizeBounds, rotateEl, transformEl, unionBounds } from './geometry';
import { sanitizeElement } from './model';
import type { ImageEl, LineEl, NoteEl, ShapeEl, StrokeEl } from './types';

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

describe('resizeBounds', () => {
  const from = { x: 100, y: 100, w: 200, h: 100 };
  const cx = 100 + 200 / 2; // 200
  const cy = 100 + 100 / 2; // 150

  it('resizes without alt anchoring to opposite corner', () => {
    // Drag bottom-right corner outwards without Alt
    const to = resizeBounds(from, 'se', { x: 350, y: 250 }, 4, false, false, false);
    expect(to.x).toBe(100);
    expect(to.y).toBe(100);
    expect(to.w).toBe(250);
    expect(to.h).toBe(150);
  });

  it('resizes with alt keeping the center fixed when dragging corners', () => {
    // Drag bottom-right corner inward from (300, 200) to (250, 175)
    // dx = 50, dy = 25 -> w = 100, h = 50
    const toShrink = resizeBounds(from, 'se', { x: 250, y: 175 }, 4, false, false, true);
    expect(toShrink.x + toShrink.w / 2).toBeCloseTo(cx);
    expect(toShrink.y + toShrink.h / 2).toBeCloseTo(cy);
    expect(toShrink.w).toBeCloseTo(100);
    expect(toShrink.h).toBeCloseTo(50);
    expect(toShrink.x).toBeCloseTo(150);
    expect(toShrink.y).toBeCloseTo(125);

    // Drag top-left corner 'nw' inward
    const toNw = resizeBounds(from, 'nw', { x: 150, y: 125 }, 4, false, false, true);
    expect(toNw.x + toNw.w / 2).toBeCloseTo(cx);
    expect(toNw.y + toNw.h / 2).toBeCloseTo(cy);
    expect(toNw.w).toBeCloseTo(100);
    expect(toNw.h).toBeCloseTo(50);

    // Drag top-right corner 'ne' outward
    const toNe = resizeBounds(from, 'ne', { x: 350, y: 50 }, 4, false, false, true);
    expect(toNe.x + toNe.w / 2).toBeCloseTo(cx);
    expect(toNe.y + toNe.h / 2).toBeCloseTo(cy);
    expect(toNe.w).toBeCloseTo(300);
    expect(toNe.h).toBeCloseTo(200);

    // Drag bottom-left corner 'sw' outward
    const toSw = resizeBounds(from, 'sw', { x: 50, y: 250 }, 4, false, false, true);
    expect(toSw.x + toSw.w / 2).toBeCloseTo(cx);
    expect(toSw.y + toSw.h / 2).toBeCloseTo(cy);
    expect(toSw.w).toBeCloseTo(300);
    expect(toSw.h).toBeCloseTo(200);
  });

  it('resizes with alt on edge handles keeping center and opposite axis intact', () => {
    // East handle 'e': width changes symmetrically, height stays 100
    const toE = resizeBounds(from, 'e', { x: 260, y: 150 }, 4, false, false, true);
    expect(toE.x + toE.w / 2).toBeCloseTo(cx);
    expect(toE.y + toE.h / 2).toBeCloseTo(cy);
    expect(toE.w).toBeCloseTo(120);
    expect(toE.h).toBeCloseTo(100);
    expect(toE.y).toBe(100);

    // West handle 'w': width changes symmetrically, height stays 100
    const toW = resizeBounds(from, 'w', { x: 140, y: 150 }, 4, false, false, true);
    expect(toW.x + toW.w / 2).toBeCloseTo(cx);
    expect(toW.y + toW.h / 2).toBeCloseTo(cy);
    expect(toW.w).toBeCloseTo(120);
    expect(toW.h).toBeCloseTo(100);

    // North handle 'n': height changes symmetrically, width stays 200
    const toN = resizeBounds(from, 'n', { x: 200, y: 120 }, 4, false, false, true);
    expect(toN.x + toN.w / 2).toBeCloseTo(cx);
    expect(toN.y + toN.h / 2).toBeCloseTo(cy);
    expect(toN.w).toBeCloseTo(200);
    expect(toN.h).toBeCloseTo(60);
    expect(toN.x).toBe(100);

    // South handle 's': height changes symmetrically, width stays 200
    const toS = resizeBounds(from, 's', { x: 200, y: 180 }, 4, false, false, true);
    expect(toS.x + toS.w / 2).toBeCloseTo(cx);
    expect(toS.y + toS.h / 2).toBeCloseTo(cy);
    expect(toS.w).toBeCloseTo(200);
    expect(toS.h).toBeCloseTo(60);
  });

  it('preserves aspect ratio with alt when keepRatio is true', () => {
    // Initial aspect ratio = 200 / 100 = 2.0
    // Dragging 'se' with keepRatio=true, shift=false, alt=true
    const to = resizeBounds(from, 'se', { x: 250, y: 125 }, 4, true, false, true);
    expect(to.x + to.w / 2).toBeCloseTo(cx);
    expect(to.y + to.h / 2).toBeCloseTo(cy);
    expect(to.w / to.h).toBeCloseTo(2.0);
    expect(to.w).toBeCloseTo(100);
    expect(to.h).toBeCloseTo(50);

    // Holding Shift flips keepRatio for freeform resize
    const toFree = resizeBounds(from, 'se', { x: 280, y: 190 }, 4, true, true, true);
    expect(toFree.x + toFree.w / 2).toBeCloseTo(cx);
    expect(toFree.y + toFree.h / 2).toBeCloseTo(cy);
    expect(toFree.w).toBeCloseTo(160);
    expect(toFree.h).toBeCloseTo(80);
    expect(toFree.w / toFree.h).toBeCloseTo(2.0);
  });

  it('correctly shrinks a group of images toward the center of the group', () => {
    const img1: ImageEl = { type: 'image', id: '1', x: 100, y: 100, w: 100, h: 100, asset: 'a1' };
    const img2: ImageEl = { type: 'image', id: '2', x: 300, y: 100, w: 100, h: 100, asset: 'a2' };
    const groupBounds = unionBounds([boundsOf(img1), boundsOf(img2)])!;
    expect(groupBounds).toEqual({ x: 100, y: 100, w: 300, h: 100 });
    const groupCenter = { x: groupBounds.x + groupBounds.w / 2, y: groupBounds.y + groupBounds.h / 2 };
    expect(groupCenter).toEqual({ x: 250, y: 150 });

    // Resize group by 50% with Alt (keepRatio = true)
    // Handle 'se' moved inward to dx = 75, dy = 25
    const to = resizeBounds(groupBounds, 'se', { x: 250 + 75, y: 150 + 25 }, 4, true, false, true);
    expect(to.x + to.w / 2).toBeCloseTo(250);
    expect(to.y + to.h / 2).toBeCloseTo(150);
    expect(to.w).toBeCloseTo(150);
    expect(to.h).toBeCloseTo(50);

    const transformedImg1 = transformEl(img1, groupBounds, to) as ImageEl;
    const transformedImg2 = transformEl(img2, groupBounds, to) as ImageEl;

    const newGroupBounds = unionBounds([boundsOf(transformedImg1), boundsOf(transformedImg2)])!;
    expect(newGroupBounds.x + newGroupBounds.w / 2).toBeCloseTo(groupCenter.x);
    expect(newGroupBounds.y + newGroupBounds.h / 2).toBeCloseTo(groupCenter.y);
    expect(newGroupBounds.w).toBeCloseTo(150);
    expect(newGroupBounds.h).toBeCloseTo(50);

    // img1 was on the left, now closer to center
    expect(transformedImg1.x).toBeCloseTo(175);
    expect(transformedImg1.w).toBeCloseTo(50);
    // img2 was on the right, now closer to center
    expect(transformedImg2.x).toBeCloseTo(275);
    expect(transformedImg2.w).toBeCloseTo(50);
  });

  it('clamps to min dimension when dragging past center with Alt', () => {
    // Dragging east handle far to the left past center
    const toPast = resizeBounds(from, 'e', { x: 50, y: 150 }, 4, false, false, true);
    expect(toPast.x + toPast.w / 2).toBeCloseTo(cx);
    expect(toPast.y + toPast.h / 2).toBeCloseTo(cy);
    expect(toPast.w).toBe(4);
    expect(toPast.h).toBe(100);
  });
});
