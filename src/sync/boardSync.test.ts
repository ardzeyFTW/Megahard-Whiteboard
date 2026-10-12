import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BoardSync, longestIncreasing, type RemoteChange } from './boardSync';
import type { BoardDoc, El, NoteEl, ShapeEl, StrokeEl } from '../types';

const stroke = (id: string, x = 0): StrokeEl => ({ type: 'stroke', id, points: [x, 0, 0.5, x + 10, 10, 0.5], color: '#1f1f1f', size: 4 });
const shape = (id: string, x = 0): ShapeEl => ({
  type: 'shape', id, kind: 'rect', x, y: 0, w: 50, h: 40, stroke: '#1f1f1f', fill: 'transparent', strokeWidth: 3,
});
const note = (id: string, text = ''): NoteEl => ({ type: 'note', id, x: 0, y: 0, w: 200, h: 200, color: '#fff4a3', text });

function board(elements: El[]): BoardDoc {
  return {
    version: 1, id: 'b1', name: 'Test', createdAt: 0, updatedAt: 0,
    background: { color: '#ffffff', pattern: 'none' }, elements, assets: {}, camera: { x: 0, y: 0, zoom: 1 },
  };
}

const ids = (els: El[]) => els.map((e) => e.id);

/** A board editor stand-in: keeps the element array the way Editor does. */
function editor(sync: BoardSync) {
  const ed = { elements: sync.elements, changes: [] as RemoteChange[] };
  sync.onExternalChange((c) => {
    ed.elements = c.elements;
    ed.changes.push(c);
  });
  return {
    get elements() {
      return ed.elements;
    },
    changes: ed.changes,
    set(next: El[]) {
      ed.elements = next;
      sync.commit(next);
    },
  };
}

/** Load a fresh copy of the document, as another device would. */
const reload = (sync: BoardSync) => new BoardSync(board([]), Y.encodeStateAsUpdate(sync.ydoc));

/** Connect two documents so every change is passed straight to the other, like a live room. */
function link(a: BoardSync, b: BoardSync) {
  a.ydoc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b.ydoc, u, 'remote'));
  b.ydoc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a.ydoc, u, 'remote'));
}

describe('BoardSync', () => {
  it('loads a board and keeps its paint order', () => {
    const els = [stroke('a'), shape('b'), note('c')];
    const sync = new BoardSync(board(els));
    expect(sync.elements).toBe(els);
    expect(reload(sync).elements).toEqual(els);
  });

  it('stores adds, edits and deletes', () => {
    const sync = new BoardSync(board([stroke('a'), shape('b')]));
    const ed = editor(sync);
    ed.set([...ed.elements, note('c', 'hi')]);
    ed.set(ed.elements.map((e) => (e.id === 'b' ? shape('b', 99) : e)));
    ed.set(ed.elements.filter((e) => e.id !== 'a'));
    const copy = reload(sync).elements;
    expect(copy).toEqual([shape('b', 99), note('c', 'hi')]);
    expect(ed.changes).toHaveLength(0);
  });

  it('keeps order through bring to front, send to back and inserts in the middle', () => {
    const sync = new BoardSync(board(['a', 'b', 'c', 'd'].map((id) => stroke(id))));
    const ed = editor(sync);
    const [a, b, c, d] = ed.elements;
    ed.set([a, c, d, b]); // b to front
    expect(ids(reload(sync).elements)).toEqual(['a', 'c', 'd', 'b']);
    ed.set([d, a, c, b]); // d to back
    expect(ids(reload(sync).elements)).toEqual(['d', 'a', 'c', 'b']);
    // The area eraser splits a stroke: the extra pieces go right after the original.
    ed.set([d, a, stroke('a2'), stroke('a3'), c, b]);
    expect(ids(reload(sync).elements)).toEqual(['d', 'a', 'a2', 'a3', 'c', 'b']);
  });

  it('only rewrites elements that moved in the order', () => {
    const sync = new BoardSync(board(['a', 'b', 'c', 'd', 'e'].map((id) => stroke(id))));
    const ed = editor(sync);
    const written: string[] = [];
    sync.ydoc.getMap('elements').observe((e) => written.push(...e.keysChanged));
    const [a, b, c, d, e] = ed.elements;
    ed.set([a, c, d, e, b]);
    expect(written).toEqual(['b']);
  });

  it('undoes one gesture at a time, split by checkpoints', () => {
    const sync = new BoardSync(board([shape('a')]));
    const ed = editor(sync);
    // Add a stroke.
    sync.checkpoint();
    ed.set([...ed.elements, stroke('s')]);
    // Drag the shape: many small moves, one undo step.
    sync.checkpoint();
    for (let x = 1; x <= 5; x++) ed.set(ed.elements.map((e) => (e.id === 'a' ? shape('a', x * 10) : e)));

    sync.undo();
    expect(ed.elements).toEqual([shape('a', 0), stroke('s')]);
    sync.undo();
    expect(ed.elements).toEqual([shape('a', 0)]);
    expect(sync.canUndo).toBe(false);
    sync.redo();
    sync.redo();
    expect(ed.elements).toEqual([shape('a', 50), stroke('s')]);
  });

  it('a new change clears redo', () => {
    const sync = new BoardSync(board([]));
    const ed = editor(sync);
    sync.checkpoint();
    ed.set([stroke('a')]);
    sync.undo();
    expect(sync.canRedo).toBe(true);
    sync.checkpoint();
    ed.set([stroke('b')]);
    expect(sync.canRedo).toBe(false);
  });

  it('an empty text box that is added and removed in one step leaves nothing to undo', () => {
    const sync = new BoardSync(board([stroke('a')]));
    const ed = editor(sync);
    sync.checkpoint();
    ed.set([...ed.elements, stroke('b')]);
    // Add a text box, then remove it again on finishing the edit with no text.
    sync.checkpoint();
    const t: El = { type: 'text', id: 't', x: 0, y: 0, w: 10, h: 20, text: '', color: '#1f1f1f', fontSize: 24, autoWidth: true };
    ed.set([...ed.elements, t]);
    ed.set(ed.elements.filter((e) => e.id !== 't'));
    // One undo should take away stroke b, not do nothing.
    sync.undo();
    expect(ids(ed.elements)).toEqual(['a']);
  });

  it('undo only undoes your own changes', () => {
    const host = new BoardSync(board([shape('a')]));
    const guest = reload(host);
    link(host, guest);
    const h = editor(host), g = editor(guest);
    host.checkpoint();
    h.set([...h.elements, stroke('mine')]);
    guest.checkpoint();
    g.set([...g.elements, stroke('theirs')]);
    host.undo();
    expect(ids(h.elements)).toEqual(['a', 'theirs']);
    expect(ids(g.elements)).toEqual(['a', 'theirs']);
  });

  it('merges edits made apart, and deleted elements stay deleted', () => {
    // The host shares, then goes offline. The guest keeps editing.
    const host = new BoardSync(board([stroke('keep'), stroke('gone'), shape('moved')]));
    const saved = Y.encodeStateAsUpdate(host.ydoc);
    const guest = new BoardSync(board([]), saved);
    const h = editor(host), g = editor(guest);

    g.set(g.elements.filter((e) => e.id !== 'gone'));
    g.set([...g.elements, note('new', 'from guest')]);
    h.set(h.elements.map((e) => (e.id === 'moved' ? shape('moved', 300) : e)));
    h.set([...h.elements, stroke('offline')]);

    // The host comes back and both sides sync.
    Y.applyUpdate(host.ydoc, Y.encodeStateAsUpdate(guest.ydoc, Y.encodeStateVector(host.ydoc)));
    Y.applyUpdate(guest.ydoc, Y.encodeStateAsUpdate(host.ydoc, Y.encodeStateVector(guest.ydoc)));

    const expected = ['keep', 'moved', 'new', 'offline'];
    expect(ids(h.elements).sort()).toEqual(expected);
    expect(h.elements).toEqual(g.elements);
    expect(h.elements.find((e) => e.id === 'moved')).toEqual(shape('moved', 300));
  });

  it('two people reordering at once still agree on one order', () => {
    const host = new BoardSync(board(['a', 'b', 'c'].map((id) => stroke(id))));
    const guest = reload(host);
    const h = editor(host), g = editor(guest);
    const [a, b, c] = h.elements;
    h.set([b, c, a]);
    g.set([a, c, b].map((e) => g.elements.find((x) => x.id === e.id) as El));
    Y.applyUpdate(host.ydoc, Y.encodeStateAsUpdate(guest.ydoc));
    Y.applyUpdate(guest.ydoc, Y.encodeStateAsUpdate(host.ydoc));
    expect(ids(h.elements)).toEqual(ids(g.elements));
  });

  it('skips invalid elements from someone else', () => {
    const host = new BoardSync(board([stroke('a')]));
    const h = editor(host);
    const bad = new Y.Doc();
    Y.applyUpdate(bad, Y.encodeStateAsUpdate(host.ydoc));
    bad.getMap('elements').set('x', { type: 'stroke', id: 'x', points: 'nope', z: 'a5' });
    bad.getMap('elements').set('y', { ...stroke('other-id'), z: 'a6' });
    bad.getMap('elements').set('z', { ...stroke('z'), z: 'a7', color: 'javascript:alert(1)' });
    Y.applyUpdate(host.ydoc, Y.encodeStateAsUpdate(bad), 'remote');
    expect(ids(h.elements)).toEqual(['a', 'z']);
    expect((h.elements[1] as StrokeEl).color).toBe('#1f1f1f');
  });

  it('shares the board name and background', () => {
    const host = new BoardSync(board([]));
    const guest = reload(host);
    link(host, guest);
    const seen: RemoteChange[] = [];
    guest.onExternalChange((c) => seen.push(c));
    host.setMeta({ name: 'Plans', background: { color: '#000000', pattern: 'dots' } });
    expect(seen[0].name).toBe('Plans');
    expect(seen[0].background).toEqual({ color: '#000000', pattern: 'dots' });
  });
});

describe('longestIncreasing', () => {
  it('finds the longest run of increasing keys and skips missing ones', () => {
    expect([...longestIncreasing(['a', 'c', 'b', 'd'])].sort()).toEqual([0, 2, 3]);
    expect([...longestIncreasing(['a', undefined, 'b'])].sort()).toEqual([0, 2]);
    expect(longestIncreasing([]).size).toBe(0);
  });
});
