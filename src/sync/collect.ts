// When the app opens, bring home the shared boards whose rooms have closed while their owner was
// away: merge in what others changed, save it, and let the server delete its copy.
import { deleteShare, listShares, loadBoard, loadYState, saveBoard, type ShareRecord } from '../db';
import { makeThumbnail } from '../render';
import { BoardSync } from './boardSync';
import { RoomConnection, hostRoomStatus, removeRoom, whenSynced } from './connection';
import { savedName } from './names';
import { downloadMissing } from './assets';

let running: Promise<string[]> | null = null;

/** Collect every closed room. Resolves to the names of boards that were updated. */
export function collectClosedRooms(): Promise<string[]> {
  running ??= run().finally(() => (running = null));
  return running;
}

async function run(): Promise<string[]> {
  const updated: string[] = [];
  for (const share of await listShares()) {
    try {
      const status = await hostRoomStatus(share);
      // The room expired or was removed: the board just isn't shared any more.
      if (status === 'gone') await deleteShare(share.boardId);
      else if (status !== 'error' && status.state === 'closed') {
        const name = await collect(share);
        if (name) updated.push(name);
      }
    } catch (err) {
      console.error(err);
    }
  }
  return updated;
}

async function collect(share: ShareRecord): Promise<string | null> {
  const doc = await loadBoard(share.boardId);
  if (!doc) {
    await removeRoom(share, 'stopped');
    await deleteShare(share.boardId);
    return null;
  }
  const sync = new BoardSync(doc, await loadYState(share.boardId));
  const conn = new RoomConnection({ server: share.server, roomId: share.roomId, secret: share.hostKey, name: savedName() || 'Owner', ydoc: sync.ydoc });
  let complete: boolean;
  try {
    const state = await whenSynced(conn);
    if (state.kind !== 'connected') return null; // Try again next time.
    // Images guests added come too. If some can't be fetched, the board is saved but the room kept for next time.
    complete = await downloadMissing({ server: share.server, roomId: share.roomId, secret: share.hostKey }, sync.elements, doc.assets);
    doc.elements = sync.elements;
    doc.name = sync.name ?? doc.name;
    doc.background = sync.background ?? doc.background;
    doc.updatedAt = Date.now();
    await saveBoard(doc, await makeThumbnail(doc).catch(() => undefined));
  } finally {
    conn.destroy();
  }
  if (!complete) return doc.name;
  // Saved: now the server's copy can go.
  await removeRoom(share, 'collected');
  await deleteShare(share.boardId);
  return doc.name;
}
