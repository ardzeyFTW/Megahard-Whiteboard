import { describe, expect, it } from 'vitest';
import { clipboardOwner, keyOwner } from './paneRouting';

const key = (k: string, extra: Partial<{ ctrlKey: boolean; shiftKey: boolean; code: string }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

describe('which board answers a key', () => {
  it("sends editing keys to the viewer's own board even after clicking the shared one", () => {
    for (const e of [key('z', { ctrlKey: true }), key('y', { ctrlKey: true }), key('d', { ctrlKey: true }), key('Delete'), key('Backspace'),
      key('p'), key('e'), key('ArrowLeft'), key('Enter'), key('v', { ctrlKey: true })]) {
      expect(keyOwner('shared', e)).toBe('notes');
    }
  });

  it('lets the shared board have moving around and selecting when it was clicked last', () => {
    for (const e of [key('=', { ctrlKey: true }), key('-', { ctrlKey: true }), key('0', { ctrlKey: true }), key('a', { ctrlKey: true }),
      key(' '), key('Escape'), key('!', { shiftKey: true, code: 'Digit1' })]) {
      expect(keyOwner('shared', e)).toBe('shared');
    }
  });

  it('gives everything to the own board when that was clicked last', () => {
    for (const e of [key('=', { ctrlKey: true }), key('a', { ctrlKey: true }), key(' '), key('z', { ctrlKey: true })]) {
      expect(keyOwner('notes', e)).toBe('notes');
    }
  });
});

describe('which board answers copy, cut and paste', () => {
  it('copies from the shared board only when it was clicked last and something is selected', () => {
    expect(clipboardOwner('shared', 'copy', true)).toBe('shared');
    expect(clipboardOwner('shared', 'copy', false)).toBe('notes');
    expect(clipboardOwner('notes', 'copy', true)).toBe('notes');
  });

  it("always cuts from and pastes into the viewer's own board", () => {
    for (const active of ['shared', 'notes'] as const) {
      expect(clipboardOwner(active, 'paste', true)).toBe('notes');
      expect(clipboardOwner(active, 'cut', true)).toBe('notes');
    }
  });
});
