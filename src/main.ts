import './styles.css';
import { loadBoard, loadGuestCache, loadShare, loadYState, pruneGuestCaches } from './db';
import { mountBoard } from './ui/boardView';
import { mountHome } from './ui/home';
import { closeAllModals, toast } from './ui/dom';
import { askName } from './ui/collab';
import { myServer } from './sync/config';
import { rememberName } from './sync/names';
import { parseJoinHash, serverHost } from './sync/serverAddress';
import type { BoardDoc } from './types';
import { BoardSync } from './sync/boardSync';

const root = document.getElementById('app') as HTMLElement;
let teardown: (() => void | Promise<void>) | null = null;
let queue = Promise.resolve();

async function route() {
  // Dialogs belong to the page they were opened on.
  closeAllModals();
  if (teardown) {
    const t = teardown;
    teardown = null;
    await t();
  }
  root.replaceChildren();

  const match = /^#\/board\/([\w-]+)$/.exec(location.hash);
  if (match) {
    const doc = await loadBoard(match[1]);
    if (doc) {
      // A board being shared reconnects to its room, starting from its saved Yjs document.
      const share = await loadShare(doc.id);
      const ystate = share ? await loadYState(doc.id) : undefined;
      teardown = mountBoard(root, doc, { share, ystate });
      return;
    }
    history.replaceState(null, '', '#/');
    toast('That board does not exist on this device');
  }

  const join = parseJoinHash(location.hash);
  if (join && join !== 'incomplete') {
    // The link says which server holds the board (links made before that fall back to this device's server).
    const server = join.server ?? myServer();
    if (server) {
      const { roomId, secret } = join;
      const here = location.hash;
      const name = await askName('Join a shared board', `Enter your name so others can see who’s here. This board is hosted on ${serverHost(server)}.`, 'Join');
      // The address changed while asking (e.g. Back): that page loads next instead.
      if (location.hash !== here) return;
      if (name) {
        rememberName(name);
        teardown = mountBoard(root, guestDoc(roomId), { guest: { roomId, secret, name, server }, ystate: (await loadGuestCache(roomId)) ?? BoardSync.EMPTY });
        return;
      }
    } else toast('That link doesn’t say which server holds the board. Ask for it to be sent again.', 5000);
    history.replaceState(null, '', '#/');
  } else if (join) {
    history.replaceState(null, '', '#/');
    toast('That link isn’t complete. Ask for it to be sent again.');
  }
  document.title = 'Megahard Whiteboard';
  teardown = await mountHome(root);
}

/** A guest's view of someone else's board. Its contents come from the room. */
function guestDoc(roomId: string): BoardDoc {
  const now = Date.now();
  return {
    version: 1, id: `room-${roomId}`, name: 'Shared board', createdAt: now, updatedAt: now,
    background: { color: '#ffffff', pattern: 'dots' }, elements: [], assets: {}, camera: { x: 0, y: 0, zoom: 1 },
  };
}

// Routes run one at a time so a board is fully saved before the next view loads.
const navigate = () => {
  // Close dialogs now, so a question waiting on the old page (like the name prompt) doesn't hold up the new one.
  closeAllModals();
  queue = queue.then(route).catch((err) => {
    console.error(err);
    toast('Something went wrong loading that page');
  });
};

window.addEventListener('hashchange', navigate);
window.addEventListener('megahard:db-blocked', () => {
  toast('Megahard Whiteboard was updated. Close its other tabs or windows to finish, and this page will continue.', 30000);
});
navigate();
void pruneGuestCaches().catch(() => undefined);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
