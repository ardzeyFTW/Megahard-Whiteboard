// Keeps a board's elements in a Yjs document, so changes from several people (and undo) merge cleanly.
// The editor keeps working with a plain, immutable El[] array; this class turns array changes into
// Yjs updates and Yjs updates back into a new array.
import * as Y from 'yjs';
import { generateNKeysBetween } from 'fractional-indexing';
import type { Background, BoardDoc, El, Pattern } from '../types';
import { sanitizeElement } from '../model';

/** Transaction origin for changes made in this editor. Only these are undoable. */
const LOCAL = 'local';
const PATTERNS: Pattern[] = ['none', 'grid', 'dots', 'gridDots'];

/** How an element is stored: the element itself plus `z`, a fractional index giving its paint order. */
type StoredEl = El & { z: string };

export interface RemoteChange {
  elements: El[];
  /** Ids that were changed or removed. */
  changed: Set<string>;
  name?: string;
  background?: Background;
}

export class BoardSync {
  readonly ydoc: Y.Doc;
  private readonly yEls: Y.Map<StoredEl>;
  private readonly yMeta: Y.Map<unknown>;
  private readonly undoManager: Y.UndoManager;
  /** The array the editor has now, and each element's paint-order key. */
  private current: El[] = [];
  private readonly zOf = new Map<string, string>();
  private listeners = new Set<(change: RemoteChange) => void>();

  /** A document with nothing in it yet: what a guest starts from before the room's board arrives. */
  static readonly EMPTY: Uint8Array = Y.encodeStateAsUpdate(new Y.Doc());

  /** Starts from `state` (a saved Yjs document) when given, otherwise from the board's elements. */
  constructor(doc: BoardDoc, state?: Uint8Array) {
    this.ydoc = new Y.Doc();
    this.yEls = this.ydoc.getMap('elements');
    this.yMeta = this.ydoc.getMap('meta');
    if (state) {
      Y.applyUpdate(this.ydoc, state);
      this.current = this.readAll();
    } else {
      this.ydoc.transact(() => {
        const keys = generateNKeysBetween(null, null, doc.elements.length);
        doc.elements.forEach((el, i) => {
          this.yEls.set(el.id, stored(el, keys[i]));
          this.zOf.set(el.id, keys[i]);
        });
        this.yMeta.set('name', doc.name);
        this.yMeta.set('background', doc.background);
      });
      this.current = doc.elements;
    }

    // One undo step per gesture: steps are split only by checkpoint(), never by time.
    this.undoManager = new Y.UndoManager(this.yEls, { trackedOrigins: new Set([LOCAL]), captureTimeout: Infinity });
    this.yEls.observe((event, tx) => {
      if (tx.origin === LOCAL) return;
      this.applyExternal(event.keysChanged);
    });
    this.yMeta.observe((event, tx) => {
      if (tx.origin === LOCAL) return;
      const change: RemoteChange = { elements: this.current, changed: new Set() };
      if (event.keysChanged.has('name')) change.name = this.name;
      if (event.keysChanged.has('background')) change.background = this.background;
      if (change.name === undefined && !change.background) return;
      this.listeners.forEach((fn) => fn(change));
    });
  }

  get elements(): El[] {
    return this.current;
  }

  /** The board's name, if the document has a valid one. */
  get name(): string | undefined {
    const v = this.yMeta.get('name');
    return typeof v === 'string' && v.trim() && v.length <= 200 ? v : undefined;
  }

  /** The board's background, if the document has a valid one. */
  get background(): Background | undefined {
    const v = this.yMeta.get('background') as Partial<Background> | undefined;
    if (!v || typeof v.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v.color) || !PATTERNS.includes(v.pattern as Pattern)) return undefined;
    return { color: v.color, pattern: v.pattern as Pattern };
  }

  /** The whole document, for saving. */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  get canUndo() {
    return this.undoManager.canUndo();
  }

  get canRedo() {
    return this.undoManager.canRedo();
  }

  /** Called with the new element array whenever something other than this editor changes the board (undo included). */
  onExternalChange(fn: (change: RemoteChange) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start a new undo step: the next change won't be merged into the previous one. */
  checkpoint() {
    this.undoManager.stopCapturing();
  }

  undo() {
    this.undoManager.undo();
  }

  redo() {
    this.undoManager.redo();
  }

  setMeta(patch: { name?: string; background?: Background }) {
    this.ydoc.transact(() => {
      if (patch.name !== undefined) this.yMeta.set('name', patch.name);
      if (patch.background !== undefined) this.yMeta.set('background', patch.background);
    }, LOCAL);
  }

  /** Record the editor's new element array. Only elements that actually changed are written. */
  commit(next: El[]) {
    const prev = this.current;
    if (next === prev) return;
    const prevById = new Map(prev.map((e) => [e.id, e] as const));
    const nextIds = new Set(next.map((e) => e.id));
    const z = this.orderKeys(prev, next);

    this.ydoc.transact(() => {
      for (const el of prev) {
        if (!nextIds.has(el.id)) {
          this.yEls.delete(el.id);
          this.zOf.delete(el.id);
        }
      }
      next.forEach((el, i) => {
        if (prevById.get(el.id) === el && this.zOf.get(el.id) === z[i]) return;
        this.yEls.set(el.id, stored(el, z[i]));
        this.zOf.set(el.id, z[i]);
      });
    }, LOCAL);
    this.current = next;
  }

  /**
   * Paint-order keys for `next`. Elements whose relative order didn't change keep their key, so a
   * reorder only rewrites the elements that moved.
   */
  private orderKeys(prev: El[], next: El[]): string[] {
    const old = next.map((e) => this.zOf.get(e.id));
    // Fast path: same elements in the same order, which is what moving, resizing and typing do.
    if (prev.length === next.length && prev.every((e, i) => e.id === next[i].id)) return old as string[];

    const keep = longestIncreasing(old);
    const z = new Array<string>(next.length);
    let i = 0;
    while (i < next.length) {
      if (keep.has(i)) {
        z[i] = old[i] as string;
        i++;
        continue;
      }
      // A run of elements that need new keys, between the kept neighbours on either side.
      let j = i;
      while (j < next.length && !keep.has(j)) j++;
      const lo = i > 0 ? z[i - 1] : null;
      const hi = j < next.length ? (old[j] as string) : null;
      generateNKeysBetween(lo, hi, j - i).forEach((k, n) => (z[i + n] = k));
      i = j;
    }
    return z;
  }

  /** Rebuild the element array after changes that didn't come from commit(). */
  private applyExternal(changed: Set<string>) {
    const byId = new Map(this.current.map((e) => [e.id, e] as const));
    for (const id of changed) {
      const v = this.yEls.get(id);
      const el = v ? readStored(id, v) : null;
      if (el) {
        byId.set(id, el.el);
        this.zOf.set(id, el.z);
      } else {
        byId.delete(id);
        this.zOf.delete(id);
      }
    }
    this.current = sortByZ([...byId.values()], this.zOf);
    const change: RemoteChange = { elements: this.current, changed };
    this.listeners.forEach((fn) => fn(change));
  }

  private readAll(): El[] {
    const els: El[] = [];
    this.yEls.forEach((v, id) => {
      const r = readStored(id, v);
      if (!r) return;
      els.push(r.el);
      this.zOf.set(id, r.z);
    });
    return sortByZ(els, this.zOf);
  }
}

/** The element as stored: without undefined fields (they'd only take space) and with its order key. */
function stored(el: El, z: string): StoredEl {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) if (v !== undefined) out[k] = v;
  out.z = z;
  return out as unknown as StoredEl;
}

/** Check a stored element before using it: it may come from someone else's browser. Invalid ones are skipped. */
function readStored(id: string, v: unknown): { el: El; z: string } | null {
  if (!v || typeof v !== 'object') return null;
  const { z, ...rest } = v as Record<string, unknown>;
  if (typeof z !== 'string' || !z) return null;
  const el = sanitizeElement(rest, { fitText: false });
  return el && el.id === id ? { el, z } : null;
}

function sortByZ(els: El[], zOf: Map<string, string>): El[] {
  return els.sort((a, b) => {
    const za = zOf.get(a.id) as string, zb = zOf.get(b.id) as string;
    return za < zb ? -1 : za > zb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Indices of a longest strictly increasing run of keys (undefined entries are never kept). */
export function longestIncreasing(keys: (string | undefined)[]): Set<number> {
  // Patience sorting: tails[k] is the index ending the best run of length k + 1.
  const tails: number[] = [];
  const prevIdx = new Array<number>(keys.length).fill(-1);
  keys.forEach((k, i) => {
    if (k === undefined) return;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((keys[tails[mid]] as string) < k) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prevIdx[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const out = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i !== -1; i = prevIdx[i]) out.add(i);
  return out;
}
