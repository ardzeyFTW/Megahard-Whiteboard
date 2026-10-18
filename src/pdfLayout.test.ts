import { describe, expect, it } from 'vitest';
import { formatPageRange, layoutPages, parsePageRange, rotatedSize, turn } from './pdfLayout';

describe('parsePageRange', () => {
  it('reads singles, ranges and open ends', () => {
    expect(parsePageRange('1-3, 5', 10)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('8-', 10)).toEqual([8, 9, 10]);
    expect(parsePageRange('-2', 10)).toEqual([1, 2]);
    expect(parsePageRange('3 1 2', 10)).toEqual([1, 2, 3]);
  });
  it('ignores pages past the end and repeats', () => {
    expect(parsePageRange('2-99', 4)).toEqual([2, 3, 4]);
    expect(parsePageRange('1,1,1-2', 4)).toEqual([1, 2]);
    expect(parsePageRange('9', 4)).toBeNull();
  });
  it('rejects text that is not a page list', () => {
    expect(parsePageRange('', 5)).toBeNull();
    expect(parsePageRange('abc', 5)).toBeNull();
    expect(parsePageRange('0', 5)).toBeNull();
    expect(parsePageRange('4-2', 5)).toBeNull();
    expect(parsePageRange('-', 5)).toBeNull();
  });
});

describe('formatPageRange', () => {
  it('joins runs', () => {
    expect(formatPageRange([1, 2, 3, 5, 7, 8])).toBe('1-3, 5, 7-8');
    expect(formatPageRange([])).toBe('');
  });
  it('round-trips with parsePageRange', () => {
    expect(parsePageRange(formatPageRange([2, 3, 4, 9]), 12)).toEqual([2, 3, 4, 9]);
  });
});

describe('rotation', () => {
  it('turns in quarter steps either way', () => {
    expect(turn(270)).toBe(0);
    expect(turn(0, -1)).toBe(270);
    expect(turn(90, 2)).toBe(270);
  });
  it('swaps width and height on a quarter turn only', () => {
    expect(rotatedSize(100, 200, 90)).toEqual({ w: 200, h: 100 });
    expect(rotatedSize(100, 200, 180)).toEqual({ w: 100, h: 200 });
  });
});

describe('layoutPages', () => {
  const page = { w: 100, h: 140 };
  it('stacks pages top to bottom', () => {
    const l = layoutPages([page, page, page], { mode: 'vertical', columns: 2, gap: 10 });
    expect(l.positions).toEqual([{ x: 0, y: 0 }, { x: 0, y: 150 }, { x: 0, y: 300 }]);
    expect(l).toMatchObject({ w: 100, h: 440 });
  });
  it('lines pages up left to right', () => {
    const l = layoutPages([page, page], { mode: 'horizontal', columns: 2, gap: 10 });
    expect(l.positions).toEqual([{ x: 0, y: 0 }, { x: 110, y: 0 }]);
    expect(l).toMatchObject({ w: 210, h: 140 });
  });
  it('fills a grid row by row', () => {
    const l = layoutPages([page, page, page, page, page], { mode: 'grid', columns: 2, gap: 10 });
    expect(l.positions[1]).toEqual({ x: 110, y: 0 });
    expect(l.positions[2]).toEqual({ x: 0, y: 150 });
    expect(l.positions[4]).toEqual({ x: 0, y: 300 });
    expect(l).toMatchObject({ w: 210, h: 440 });
  });
  it('never makes more columns than pages', () => {
    const l = layoutPages([page, page], { mode: 'grid', columns: 6, gap: 0 });
    expect(l).toMatchObject({ w: 200, h: 140 });
  });
  it('centers a narrower page in its column', () => {
    const l = layoutPages([{ w: 200, h: 100 }, { w: 100, h: 100 }], { mode: 'vertical', columns: 1, gap: 0 });
    expect(l.positions[1]).toEqual({ x: 50, y: 100 });
  });
  it('is empty with no pages', () => {
    expect(layoutPages([], { mode: 'grid', columns: 3, gap: 8 })).toEqual({ positions: [], w: 0, h: 0 });
  });
});
