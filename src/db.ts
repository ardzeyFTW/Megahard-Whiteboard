// All boards live in IndexedDB on this device. Only a board its owner shares is sent to the
// collaboration server (see src/sync/), and only while it is shared.
import * as Y from 'yjs';
import type { BoardDoc, BoardMeta } from './types';
import { uid } from './util';
import { packDoc, unpackDoc, type StoredDoc } from './storageFormat';

const DB_NAME = 'megahard-whiteboard';
const DB_VERSION = 2;
const BOARDS = 'boards';
const META = 'meta';
/** Yjs state of boards that have been shared, so changes from others merge correctly. Key: board id. */
const YSTATE = 'ystate';
/** Keys for boards this device is sharing. Key: board id. */
const SHARES = 'shares';
/** Temporary copies of boards other people shared with us, so a reload is instant. Key: room id. */
const GUESTS = 'guests';

export interface ShareRecord {
  boardId: string;
  server: string;
  roomId: string;
  hostKey: string;
  editSecret: string;
  viewSecret: string;
  createdAt: number;
}

interface GuestCache {
  /** The shared board's Yjs state. Empty until the first save. */
  state: Uint8Array;
  savedAt: number;
  /** A viewer's own board for this room, so joining the same link again reopens it. */
  notesBoardId?: string;
}

/** Guest copies older than this are removed (rooms are deleted by then anyway). */
const GUEST_CACHE_DAYS = 8;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(BOARDS)) db.createObjectStore(BOARDS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(YSTATE)) db.createObjectStore(YSTATE);
        if (!db.objectStoreNames.contains(SHARES)) db.createObjectStore(SHARES, { keyPath: 'boardId' });
        if (!db.objectStoreNames.contains(GUESTS)) db.createObjectStore(GUESTS);
      };
      req.onsuccess = () => {
        // Let a newer version of the app, open in another tab, upgrade the database.
        req.result.onversionchange = () => {
          req.result.close();
          dbPromise = null;
        };
        resolve(req.result);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
      // An older version of the app, open in another tab or window, is holding the database and
      // the upgrade waits until it's closed. Let the page explain that.
      req.onblocked = () => window.dispatchEvent(new Event('megahard:db-blocked'));
    });
  }
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const sortRecent = <T extends { updatedAt: number; createdAt: number; name: string }>(items: T[]): T[] =>
  items.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt) || a.name.localeCompare(b.name));

export async function listBoards(): Promise<BoardMeta[]> {
  const db = await openDb();
  const all = await result(db.transaction(META).objectStore(META).getAll() as IDBRequest<BoardMeta[]>);
  return sortRecent(all);
}

export async function loadBoard(id: string): Promise<BoardDoc | undefined> {
  const db = await openDb();
  const stored = await result(db.transaction(BOARDS).objectStore(BOARDS).get(id) as IDBRequest<StoredDoc | undefined>);
  return stored ? unpackDoc(stored) : undefined;
}

export async function loadAllBoards(): Promise<BoardDoc[]> {
  const db = await openDb();
  const all = await result(db.transaction(BOARDS).objectStore(BOARDS).getAll() as IDBRequest<StoredDoc[]>);
  const docs = await Promise.all(all.map(unpackDoc));
  return sortRecent(docs);
}

/**
 * Save a board in the compact storage format. The previous thumbnail is kept when no new
 * one is given. Returns the board's approximate size in bytes.
 */
export async function saveBoard(doc: BoardDoc, thumbnail?: string): Promise<number> {
  const { stored, bytes } = packDoc(doc);
  const db = await openDb();
  const tx = db.transaction([BOARDS, META], 'readwrite');
  tx.objectStore(BOARDS).put(stored);
  const meta = tx.objectStore(META);
  const prev = meta.get(doc.id);
  prev.onsuccess = () => {
    const old = prev.result as BoardMeta | undefined;
    const next: BoardMeta = {
      id: doc.id,
      name: doc.name,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      thumbnail: thumbnail ?? old?.thumbnail,
    };
    next.size = bytes + (next.thumbnail?.length ?? 0);
    meta.put(next);
  };
  await done(tx);
  return bytes;
}

/** Boards saved before sizes were tracked get re-saved once (which also packs them). */
export async function backfillSizes(metas: BoardMeta[]): Promise<boolean> {
  const missing = metas.filter((m) => m.size == null);
  for (const m of missing) {
    const doc = await loadBoard(m.id);
    if (doc) await saveBoard(doc);
  }
  return missing.length > 0;
}

export async function deleteBoard(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([BOARDS, META, YSTATE, SHARES], 'readwrite');
  tx.objectStore(BOARDS).delete(id);
  tx.objectStore(META).delete(id);
  tx.objectStore(YSTATE).delete(id);
  tx.objectStore(SHARES).delete(id);
  await done(tx);
}

export async function renameBoard(id: string, name: string): Promise<void> {
  const doc = await loadBoard(id);
  if (!doc) return;
  doc.name = name;
  doc.updatedAt = Date.now();
  await saveBoard(doc);
  // A shared board takes its name from its Yjs document, so rename it there too.
  const state = await loadYState(id);
  if (state) {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, state);
    ydoc.getMap('meta').set('name', name);
    await saveYState(id, Y.encodeStateAsUpdate(ydoc));
  }
}

export async function duplicateBoard(id: string): Promise<BoardDoc | undefined> {
  const doc = await loadBoard(id);
  if (!doc) return undefined;
  const db = await openDb();
  const meta = await result(db.transaction(META).objectStore(META).get(id) as IDBRequest<BoardMeta | undefined>);
  const now = Date.now();
  const copy: BoardDoc = { ...doc, id: uid(), name: `${doc.name} (copy)`, createdAt: now, updatedAt: now };
  await saveBoard(copy, meta?.thumbnail);
  return copy;
}

export async function storageInfo(): Promise<{ usage?: number; quota?: number; persisted: boolean }> {
  try {
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    return { usage: est.usage, quota: est.quota, persisted };
  } catch {
    return { persisted: false };
  }
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- sharing

async function getOne<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return result(db.transaction(store).objectStore(store).get(key) as IDBRequest<T | undefined>);
}

async function write(store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  fn(tx.objectStore(store));
  await done(tx);
}

export const loadShare = (boardId: string) => getOne<ShareRecord>(SHARES, boardId);
export const saveShare = (share: ShareRecord) => write(SHARES, (s) => s.put(share));

export async function listShares(): Promise<ShareRecord[]> {
  const db = await openDb();
  return result(db.transaction(SHARES).objectStore(SHARES).getAll() as IDBRequest<ShareRecord[]>);
}

/** Forget that a board is shared. Its Yjs state goes too: it's only needed while shared. */
export async function deleteShare(boardId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SHARES, YSTATE], 'readwrite');
  tx.objectStore(SHARES).delete(boardId);
  tx.objectStore(YSTATE).delete(boardId);
  await done(tx);
}

export const loadYState = (boardId: string) => getOne<Uint8Array>(YSTATE, boardId);
export const saveYState = (boardId: string, state: Uint8Array) => write(YSTATE, (s) => s.put(state, boardId));

export async function loadGuestCache(roomId: string): Promise<Uint8Array | undefined> {
  const state = (await getOne<GuestCache>(GUESTS, roomId))?.state;
  return state?.length ? state : undefined;
}

/** Change one guest record, keeping the parts the change doesn't mention. */
async function updateGuest(roomId: string, change: (old: GuestCache | undefined) => GuestCache): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(GUESTS, 'readwrite');
  const store = tx.objectStore(GUESTS);
  const req = store.get(roomId) as IDBRequest<GuestCache | undefined>;
  req.onsuccess = () => store.put(change(req.result), roomId);
  await done(tx);
}

export const saveGuestCache = (roomId: string, state: Uint8Array) =>
  updateGuest(roomId, (old) => ({ ...old, state, savedAt: Date.now() }));

/** The board a viewer keeps beside this room's board, if they've started one. */
export async function loadGuestNotes(roomId: string): Promise<string | undefined> {
  return (await getOne<GuestCache>(GUESTS, roomId))?.notesBoardId;
}

export const saveGuestNotes = (roomId: string, notesBoardId: string) =>
  updateGuest(roomId, (old) => ({ state: new Uint8Array(0), ...old, notesBoardId, savedAt: Date.now() }));

export const deleteGuestCache = (roomId: string) => write(GUESTS, (s) => s.delete(roomId));

/** Remove guest copies of rooms that must be long gone. */
export async function pruneGuestCaches(): Promise<void> {
  const cutoff = Date.now() - GUEST_CACHE_DAYS * 24 * 3600 * 1000;
  await write(GUESTS, (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (!((c.value as GuestCache).savedAt > cutoff)) c.delete();
      c.continue();
    };
  });
}
