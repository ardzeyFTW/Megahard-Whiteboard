// End-to-end tests: runs the real server locally (wrangler dev) and connects to it with the app's
// own sync code, the way browsers would. No Cloudflare account needed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BoardSync } from '../../src/sync/boardSync';
import { RoomConnection, createRoom, hostRoomStatus, removeRoom, type ConnectionState } from '../../src/sync/connection';
import { MSG_AWARENESS, type CreatedRoom } from '../../src/sync/protocol';
import * as encoding from 'lib0/encoding';
import { uploadMissing } from '../../src/sync/assets';
import type { BoardDoc, El, StrokeEl } from '../../src/types';

const PORT = 8799;
const SERVER = `http://127.0.0.1:${PORT}`;
// Short timers so the room's whole life can be tested: open for 3 s after the host leaves, then kept 4 s for pickup.
const GRACE_S = 3;
const PICKUP_S = 4;
const SEAT_HOLD_S = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Inside the git-ignored .wrangler folder. Cleared before each run: Windows can hold the files for a while after the server stops.
const stateDir = join(__dirname, '..', '.wrangler', 'test-state');
let server: ChildProcess | null = null;

async function startServer() {
  server = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', stateDir,
    '--var', `GRACE_SECONDS:${GRACE_S}`, '--var', `PICKUP_SECONDS:${PICKUP_S}`, '--var', `SEAT_HOLD_SECONDS:${SEAT_HOLD_S}`, '--var', 'ROOM_LIMIT_MB:1', '--var', 'ROOMS_PER_HOUR:100',
  ], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev didn't start:\n${output}`)), 60000);
    const onData = (d: Buffer) => {
      output += d.toString();
      if (/Ready on/i.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server?.stdout?.on('data', onData);
    server?.stderr?.on('data', onData);
    server?.on('exit', (code) => reject(new Error(`wrangler dev exited (${code}):\n${output}`)));
  });
}

function stopServer() {
  if (!server?.pid) return;
  // wrangler starts its own child processes; end the whole tree.
  if (process.platform === 'win32') {
    const run = (cmd: string) => {
      try {
        execSync(cmd, { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    };
    run(`taskkill /pid ${server.pid} /T /F`);
    // On Windows the runtime (workerd) can outlive that and keep the port: stop whatever still listens on it.
    run(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`);
  } else server.kill('SIGTERM');
  server = null;
}

beforeAll(async () => {
  rmSync(stateDir, { recursive: true, force: true });
  await startServer();
}, 70000);
afterAll(stopServer);

// ---------------------------------------------------------------- helpers

const stroke = (id: string, x = 0): StrokeEl => ({ type: 'stroke', id, points: [x, 0, 0.5, x + 10, 10, 0.5], color: '#1f1f1f', size: 4 });
const board = (elements: El[]): BoardDoc => ({
  version: 1, id: 'b', name: 'Shared', createdAt: 0, updatedAt: 0,
  background: { color: '#ffffff', pattern: 'none' }, elements, assets: {}, camera: { x: 0, y: 0, zoom: 1 },
});
const ids = (els: El[]) => els.map((e) => e.id);

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const open: RoomConnection[] = [];

/** A person in a room: their board and their connection. */
function join_(room: CreatedRoom, secret: string, name: string, elements: El[] = [], seat?: string) {
  const sync = new BoardSync(board(elements));
  const conn = new RoomConnection({ server: SERVER, roomId: room.roomId, secret, name, ydoc: sync.ydoc, seat });
  conn.awareness.setLocalStateField('user', { name });
  open.push(conn);
  const person = {
    sync,
    conn,
    elements: sync.elements,
    set(next: El[]) {
      person.elements = next;
      sync.commit(next);
    },
    connected: () => waitFor(() => conn.state.kind === 'connected' && conn.state.synced && conn.state),
    failed: () => waitFor(() => conn.state.kind === 'failed' && conn.state),
    leave() {
      conn.destroy();
    },
  };
  sync.onExternalChange((c) => (person.elements = c.elements));
  return person;
}


/** A bare socket, to say things the app itself never would. Resolves once the server has let it in. */
async function rawGuest(room: CreatedRoom, secret: string, name: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/rooms/${room.roomId}/ws`);
  const welcomed = new Promise<void>((resolve, reject) => {
    ws.addEventListener('message', (e) => typeof e.data === 'string' && JSON.parse(e.data).t === 'welcome' && resolve());
    ws.addEventListener('error', () => reject(new Error('socket error')));
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ t: 'hello', secret, name }));
  await welcomed;
  return {
    /** Announce presence for one client id, with the state text exactly as given. */
    say(id: number, clock: number, state: string) {
      const inner = encoding.createEncoder();
      encoding.writeVarUint(inner, 1);
      encoding.writeVarUint(inner, id);
      encoding.writeVarUint(inner, clock);
      encoding.writeVarString(inner, state);
      const msg = encoding.createEncoder();
      encoding.writeVarUint(msg, MSG_AWARENESS);
      encoding.writeVarUint8Array(msg, encoding.toUint8Array(inner));
      ws.send(encoding.toUint8Array(msg));
    },
    close: () => ws.close(),
  };
}

afterAll(() => open.forEach((c) => c.destroy()));

// ---------------------------------------------------------------- tests

describe('collaboration server', () => {
  it('creates rooms with fresh random keys', async () => {
    const a = await createRoom(SERVER);
    const b = await createRoom(SERVER);
    expect(a.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set([a.roomId, a.hostKey, a.editSecret, a.viewSecret, b.roomId, b.hostKey]).size).toBe(6);
  });

  it('syncs a board both ways between the host and a guest', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host', [stroke('a'), stroke('b')]);
    expect((await host.connected()).role).toBe('host');
    const guest = join_(room, room.editSecret, 'Guest');
    expect((await guest.connected()).role).toBe('edit');
    await waitFor(() => guest.elements.length === 2);
    expect(guest.elements).toEqual(host.elements);

    guest.set([...guest.elements, stroke('from-guest', 50)]);
    await waitFor(() => host.elements.length === 3);
    host.set(host.elements.filter((e) => e.id !== 'a'));
    await waitFor(() => guest.elements.length === 2);
    expect(ids(guest.elements)).toEqual(['b', 'from-guest']);
    host.leave();
    guest.leave();
  });

  it('view-only people see changes but cannot make them', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host', [stroke('a')]);
    await host.connected();
    const viewer = join_(room, room.viewSecret, 'Viewer');
    expect((await viewer.connected()).role).toBe('view');
    await waitFor(() => viewer.elements.length === 1);

    viewer.set([...viewer.elements, stroke('sneaky')]);
    host.set([...host.elements, stroke('b')]);
    await waitFor(() => viewer.elements.some((e) => e.id === 'b'));
    await new Promise((r) => setTimeout(r, 300));
    expect(ids(host.elements)).toEqual(['a', 'b']);
    // Someone joining later doesn't get it either.
    const guest = join_(room, room.editSecret, 'Guest');
    await guest.connected();
    await waitFor(() => guest.elements.length === 2);
    expect(ids(guest.elements)).toEqual(['a', 'b']);
    [host, viewer, guest].forEach((p) => p.leave());
  });

  it('turns away wrong links and unknown rooms without retrying', async () => {
    const room = await createRoom(SERVER);
    const wrong = join_(room, 'x'.repeat(32), 'Nope');
    expect((await wrong.failed()).code).toBe('bad_secret');
    const missing = join_({ ...room, roomId: 'A'.repeat(22) }, room.editSecret, 'Lost');
    expect((await missing.failed()).code).toBe('not_found');
  });

  it('gives editing spots to the owner and 9 editors with different colours, and sends the rest in as viewers', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    const guests = [];
    for (let i = 0; i < 9; i++) {
      const g = join_(room, room.editSecret, `Guest ${i}`);
      expect((await g.connected()).role).toBe('edit');
      guests.push(g);
    }
    const state = (p: typeof host) => p.conn.state as Extract<ConnectionState, { kind: 'connected' }>;
    const colors = [host, ...guests].map((g) => state(g).color);
    expect(new Set(colors).size).toBe(10);

    // Every editing spot is taken: the next edit link joins as a viewer, and is told why.
    const tenth = join_(room, room.editSecret, 'Late');
    await tenth.connected();
    expect(state(tenth)).toMatchObject({ role: 'view', downgraded: true });
    // A viewer-link person is a viewer, but wasn't bumped from anything.
    const viewer = join_(room, room.viewSecret, 'Looker');
    await viewer.connected();
    expect(state(viewer)).toMatchObject({ role: 'view', downgraded: false });

    // The bumped person really can't change the board.
    tenth.set([stroke('sneaky')]);
    await sleep(300);
    expect(host.elements).toEqual([]);

    // The head count reaches everyone.
    await waitFor(() => state(host).room.editors === 10 && state(host).room.viewers === 2);
    expect(state(host).room).toMatchObject({ editorLimit: 10, editors: 10, viewers: 2 });

    // The spot of someone who just left is held for a short while, so a newcomer is a viewer for now.
    guests[3].leave();
    await sleep(200);
    const next = join_(room, room.editSecret, 'Next');
    await next.connected();
    expect(state(next).role).toBe('view');
    [host, ...guests, tenth, viewer, next].forEach((p) => p.leave());
  });

  it("holds a dropped editor's spot for a while, then frees it", async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    host.conn.setEditorLimit(2);
    const state = (p: typeof host) => p.conn.state as Extract<ConnectionState, { kind: 'connected' }>;
    const sam = join_(room, room.editSecret, 'Sam', [], 'sam-seat');
    expect((await sam.connected()).role).toBe('edit');
    sam.leave();
    await sleep(200);

    // Someone else tries for the spot while Sam's connection is down: they're a viewer.
    const other = join_(room, room.editSecret, 'Other');
    await other.connected();
    expect(state(other).role).toBe('view');
    // Sam comes back (same seat) and gets it back.
    const samAgain = join_(room, room.editSecret, 'Sam', [], 'sam-seat');
    expect((await samAgain.connected()).role).toBe('edit');
    samAgain.leave();
    other.leave();

    // After the hold runs out (2 s in this test server) the spot is free.
    await sleep(SEAT_HOLD_S * 1000 + 600);
    const later = join_(room, room.editSecret, 'Later');
    expect((await later.connected()).role).toBe('edit');
    [host, later].forEach((p) => p.leave());
  });

  it('lets the owner change how many can edit, without removing anyone', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    const state = (p: typeof host) => p.conn.state as Extract<ConnectionState, { kind: 'connected' }>;
    const a = join_(room, room.editSecret, 'A');
    const b = join_(room, room.editSecret, 'B');
    await a.connected();
    await b.connected();
    await waitFor(() => state(host).room.editors === 3);

    host.conn.setEditorLimit(1);
    await waitFor(() => state(a).room.editorLimit === 1);
    // A and B keep editing...
    a.set([stroke('from-a')]);
    await waitFor(() => host.elements.some((e) => e.id === 'from-a'));
    expect(state(b).role).toBe('edit');
    // ...but nobody new gets in to edit.
    const c = join_(room, room.editSecret, 'C');
    await c.connected();
    expect(state(c)).toMatchObject({ role: 'view', downgraded: true });

    // Nonsense and non-owners are ignored.
    host.conn.setEditorLimit(0);
    host.conn.setEditorLimit(11);
    a.conn.setEditorLimit(10);
    await sleep(300);
    expect(state(host).room.editorLimit).toBe(1);
    // Raising it again makes room for the next person.
    host.conn.setEditorLimit(10);
    await waitFor(() => state(c).room.editorLimit === 10);
    const d = join_(room, room.editSecret, 'D');
    expect((await d.connected()).role).toBe('edit');
    [host, a, b, c, d].forEach((p) => p.leave());
  });

  it('takes 10 viewers, turns away the 11th, but always lets the owner in', async () => {
    const room = await createRoom(SERVER);
    const viewers = [];
    for (let i = 0; i < 10; i++) {
      const v = join_(room, room.viewSecret, `Viewer ${i}`);
      expect((await v.connected()).role).toBe('view');
      viewers.push(v);
    }
    expect((await join_(room, room.viewSecret, 'Eleventh').failed()).code).toBe('full');
    // An edit link still gets an editing spot while there is one, even with the viewers full.
    const spot = join_(room, room.editSecret, 'Editor');
    expect((await spot.connected()).role).toBe('edit');
    const host = join_(room, room.hostKey, 'Host');
    expect((await host.connected()).role).toBe('host');
    [...viewers, spot, host].forEach((p) => p.leave());
  });

  it("viewers show who they are but can't send a cursor", async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    const viewer = join_(room, room.viewSecret, 'Viewer');
    await viewer.connected();
    const states = () => [...host.conn.awareness.getStates().values()] as { user?: { name: string }; presence?: unknown }[];
    await waitFor(() => states().some((s) => s.user?.name === 'Viewer'));
    viewer.conn.awareness.setLocalStateField('presence', { cursor: { x: 1, y: 2 } });
    await sleep(400);
    expect(states().find((s) => s.user?.name === 'Viewer')?.presence).toBeUndefined();

    // An editor's cursor does get through.
    const editor = join_(room, room.editSecret, 'Editor');
    await editor.connected();
    editor.conn.awareness.setLocalStateField('presence', { cursor: { x: 3, y: 4 } });
    await waitFor(() => states().find((s) => s.user?.name === 'Editor')?.presence);
    [host, viewer, editor].forEach((p) => p.leave());
  });

  it("passes the owner's view on to viewers, so they can follow it", async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    const viewer = join_(room, room.viewSecret, 'Viewer');
    await viewer.connected();
    const hostState = () => [...viewer.conn.awareness.getStates().values()].find((s) => (s as { user?: { name?: string } }).user?.name === 'Host') as { presence?: { view?: unknown } } | undefined;
    await waitFor(() => hostState());
    host.conn.awareness.setLocalStateField('presence', { cursor: { x: 1, y: 2 }, view: { x: -400, y: -300, w: 1200, h: 800 } });
    await waitFor(() => hostState()?.presence?.view);
    expect(hostState()?.presence?.view).toEqual({ x: -400, y: -300, w: 1200, h: 800 });
    [host, viewer].forEach((p) => p.leave());
  });

  it("a guest can't pose as the owner or steer the owner's view", async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    const editor = join_(room, room.editSecret, 'Editor');
    await editor.connected();
    type State = { user?: { name?: string; role?: string; color?: string }; presence?: { view?: unknown } };
    const seen = () => [...host.conn.awareness.getStates().values()].find((s) => (s as State).user?.name === 'Editor') as State | undefined;
    // The guest claims to be the owner and says where "the owner" is looking.
    editor.conn.awareness.setLocalStateField('user', { name: 'Editor', role: 'host', color: '#123456' });
    editor.conn.awareness.setLocalStateField('presence', { cursor: { x: 1, y: 2 }, view: { x: 0, y: 0, w: 10, h: 10 } });
    await waitFor(() => seen()?.presence);
    expect(seen()?.user?.role).toBe('edit');
    expect(seen()?.user?.color).not.toBe('#123456');
    expect(seen()?.presence?.view).toBeUndefined();
    [host, editor].forEach((p) => p.leave());
  });

  it("nobody can remove or change another person's presence", async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    const watcher = join_(room, room.editSecret, 'Watcher');
    await watcher.connected();
    const names = () => [...watcher.conn.awareness.getStates().values()].map((s) => (s as { user?: { name?: string } }).user?.name);
    await waitFor(() => names().includes('Host'));

    const hostId = host.conn.awareness.clientID;
    const intruder = await rawGuest(room, room.editSecret, 'Intruder');
    // Try to wipe the owner from everyone's list, then to rewrite their entry.
    intruder.say(hostId, 1_000_000, 'null');
    intruder.say(hostId, 1_000_001, JSON.stringify({ user: { name: 'Not the owner' } }));
    await sleep(500);
    expect(names()).toContain('Host');
    expect(names()).not.toContain('Not the owner');

    // A viewer can't smuggle a cursor past the filter by escaping the word "presence".
    const viewer = await rawGuest(room, room.viewSecret, 'Viewer');
    viewer.say(4_000_001, 1, '{"user":{"name":"Sneaky"},"pres\\u0065nce":{"cursor":{"x":1,"y":2}}}');
    await sleep(500);
    const sneaky = [...watcher.conn.awareness.getStates().values()].find((s) => (s as { user?: { name?: string } }).user?.name === 'Sneaky');
    expect((sneaky as { presence?: unknown } | undefined)?.presence).toBeUndefined();
    intruder.close();
    viewer.close();
    [host, watcher].forEach((p) => p.leave());
  });

  it('shows who is here, and removes people who leave', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Alex');
    await host.connected();
    const guest = join_(room, room.editSecret, 'Sam');
    await guest.connected();
    const names = (p: typeof host) => [...p.conn.awareness.getStates().values()].map((s) => s.user?.name).sort();
    await waitFor(() => names(host).length === 2 && names(guest).length === 2);
    expect(names(guest)).toEqual(['Alex', 'Sam']);
    guest.leave();
    await waitFor(() => names(host).length === 1);
    expect(names(host)).toEqual(['Alex']);
    host.leave();
  });

  it('tells guests when the host leaves and comes back', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    const guest = join_(room, room.editSecret, 'Guest');
    await guest.connected();
    const hostOnline = () => (guest.conn.state.kind === 'connected' ? guest.conn.state.room.hostOnline : null);
    expect(hostOnline()).toBe(true);
    host.leave();
    await waitFor(() => hostOnline() === false);
    const back = join_(room, room.hostKey, 'Host');
    await back.connected();
    await waitFor(() => hostOnline() === true);
    back.leave();
    guest.leave();
  });

  it('merges edits made offline when the connection comes back', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host', [stroke('a')]);
    await host.connected();
    const guest = join_(room, room.editSecret, 'Guest');
    await guest.connected();
    await waitFor(() => guest.elements.length === 1);

    // The host drops off and both keep drawing.
    host.leave();
    host.set([...host.elements, stroke('host-offline')]);
    guest.set([...guest.elements, stroke('guest-online')]);
    // The host reconnects with the same board.
    const conn = new RoomConnection({ server: SERVER, roomId: room.roomId, secret: room.hostKey, name: 'Host', ydoc: host.sync.ydoc });
    open.push(conn);
    await waitFor(() => host.elements.length === 3 && guest.elements.length === 3);
    expect(ids(host.elements).sort()).toEqual(ids(guest.elements).sort());
    conn.destroy();
    guest.leave();
  });

  it('keeps the board after a server restart', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host', [stroke('a'), stroke('b'), stroke('c')]);
    await host.connected();
    host.set([...host.elements, stroke('d')]);
    // Saves happen in batches, and straight away once everyone has left.
    await new Promise((r) => setTimeout(r, 300));
    host.leave();
    await new Promise((r) => setTimeout(r, 500));

    stopServer();
    await startServer();
    // The room may have closed meanwhile (the test timers are short), but the host can always collect it.
    const back = join_(room, room.hostKey, 'Host');
    await back.connected();
    await waitFor(() => back.elements.length === 4);
    expect(ids(back.elements)).toEqual(['a', 'b', 'c', 'd']);
    back.leave();
  }, 90000);
});

describe('room lifecycle', () => {
  const keys = (room: CreatedRoom) => ({ server: SERVER, roomId: room.roomId, hostKey: room.hostKey });

  it('stays open for a while after the host leaves, then closes; the host collects it and it is deleted', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host', [stroke('a')]);
    await host.connected();
    expect(await hostRoomStatus(keys(room))).toEqual({ state: 'live', closesIn: null });
    const guest = join_(room, room.editSecret, 'Guest');
    await guest.connected();
    await waitFor(() => guest.elements.length === 1);

    host.leave();
    const room_ = () => (guest.conn.state.kind === 'connected' ? guest.conn.state.room : null);
    await waitFor(() => room_()?.state === 'grace');
    expect(room_()?.closesIn).toBeGreaterThan(GRACE_S * 1000 - 1500);
    // The guest keeps drawing while the host is away.
    guest.set([...guest.elements, stroke('while-away')]);

    // Time runs out: the guest is told the board has closed, and nobody new can join.
    expect((await waitFor(() => guest.conn.state.kind === 'failed' && guest.conn.state, GRACE_S * 1000 + 4000)).code).toBe('closed');
    expect((await join_(room, room.editSecret, 'Late').failed()).code).toBe('closed');
    expect((await hostRoomStatus(keys(room))) as { state: string }).toMatchObject({ state: 'closed' });

    // The host comes back and gets the guest's changes.
    const back = join_(room, room.hostKey, 'Host', host.elements);
    await back.connected();
    expect(ids(back.elements).sort()).toEqual(['a', 'while-away']);
    expect(await removeRoom(keys(room), 'collected')).toBe(true);
    expect(await hostRoomStatus(keys(room))).toBe('gone');
    back.leave();
  }, 20000);

  it('the host coming back in time keeps the room open', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    host.leave();
    await sleep(GRACE_S * 1000 * 0.5);
    const back = join_(room, room.hostKey, 'Host');
    await back.connected();
    await sleep(GRACE_S * 1000);
    expect(await hostRoomStatus(keys(room))).toEqual({ state: 'live', closesIn: null });
    back.leave();
  }, 15000);

  it('stopping sharing disconnects everyone and deletes the room', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    const guest = join_(room, room.editSecret, 'Guest');
    await guest.connected();
    host.leave();
    expect(await removeRoom(keys(room), 'stopped')).toBe(true);
    expect((await guest.failed()).code).toBe('stopped');
    expect(await hostRoomStatus(keys(room))).toBe('gone');
    expect((await join_(room, room.editSecret, 'Late').failed()).code).toBe('not_found');
  });

  it('a closed room nobody collects is deleted after the pickup window', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host', [stroke('a')]);
    await host.connected();
    host.leave();
    await sleep((GRACE_S + 1) * 1000);
    expect((await hostRoomStatus(keys(room))) as { state: string }).toMatchObject({ state: 'closed' });
    await sleep((PICKUP_S + 1) * 1000);
    expect(await hostRoomStatus(keys(room))).toBe('gone');
  }, 20000);

  it('still closes if the server restarted while the host was connected', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    // The server goes away without the room seeing the host disconnect.
    stopServer();
    host.leave();
    await startServer();
    // Its "is the host still here?" check notices, starts the grace period, and the room closes after it.
    const states = new Set<string>();
    const end = Date.now() + (GRACE_S * 3 + 2) * 1000;
    while (!states.has('closed') && Date.now() < end) {
      const st = await hostRoomStatus(keys(room));
      states.add(typeof st === 'string' ? st : st.state);
      await sleep(250);
    }
    expect(states.has('gone')).toBe(false);
    expect(states.has('closed')).toBe(true);
  }, 90000);

  it('only the host key can check on or end a room', async () => {
    const room = await createRoom(SERVER);
    const res = await fetch(`${SERVER}/rooms/${room.roomId}/status`, { headers: { Authorization: `Bearer ${room.editSecret}` } });
    expect(res.status).toBe(403);
    const del = await fetch(`${SERVER}/rooms/${room.roomId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${room.viewSecret}` } });
    expect(del.status).toBe(403);
    expect((await hostRoomStatus(keys(room))) as { state: string }).toMatchObject({ state: 'grace' });
  });
});

describe('images', () => {
  /** Bytes that start like a PNG file. */
  const png = (size: number, fill = 7) => {
    const b = new Uint8Array(size).fill(fill);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return b;
  };
  const url = (room: CreatedRoom, id?: string) => `${SERVER}/rooms/${room.roomId}/assets${id ? `/${id}` : ''}`;
  const put = (room: CreatedRoom, secret: string, id: string, body: Uint8Array, type = 'image/png') =>
    fetch(url(room, id), { method: 'PUT', body, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': type } });
  const get = (room: CreatedRoom, secret: string, id: string) => fetch(url(room, id), { headers: { Authorization: `Bearer ${secret}` } });

  it('stores an image once, for anyone with a link to download', async () => {
    const room = await createRoom(SERVER);
    const bytes = png(3000);
    expect((await put(room, room.editSecret, 'pic-1', bytes)).status).toBe(201);
    const res = await get(room, room.viewSecret, 'pic-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    const list = await fetch(url(room), { headers: { Authorization: `Bearer ${room.hostKey}` } });
    expect(await list.json()).toEqual(['pic-1']);
  });

  it("can't be replaced once stored", async () => {
    const room = await createRoom(SERVER);
    await put(room, room.hostKey, 'pic', png(100, 1));
    expect((await put(room, room.editSecret, 'pic', png(100, 2))).status).toBe(200);
    expect(new Uint8Array(await (await get(room, room.hostKey, 'pic')).arrayBuffer())).toEqual(png(100, 1));
  });

  it('only takes real images, from people who can edit', async () => {
    const room = await createRoom(SERVER);
    expect((await put(room, room.viewSecret, 'a', png(100))).status).toBe(403);
    expect((await put(room, 'x'.repeat(32), 'a', png(100))).status).toBe(403);
    expect((await put(room, room.editSecret, 'a', new TextEncoder().encode('<html><script>alert(1)</script>'), 'image/png')).status).toBe(415);
    expect((await put(room, room.editSecret, 'a', png(100), 'text/html')).status).toBe(415);
    expect((await put(room, room.editSecret, 'bad id!', png(100))).status).toBe(415);
    expect((await get(room, room.viewSecret, 'missing')).status).toBe(404);
    expect((await get({ ...room, roomId: 'B'.repeat(22) }, room.editSecret, 'a')).status).toBe(404);
  });

  it('stops taking images when the room is full', async () => {
    const room = await createRoom(SERVER);
    // The test server allows 1 MB per room.
    expect((await put(room, room.editSecret, 'one', png(600 * 1024))).status).toBe(201);
    expect((await put(room, room.editSecret, 'two', png(600 * 1024))).status).toBe(507);
  });

  it('once closed, only the host can still download images', async () => {
    const room = await createRoom(SERVER);
    const host = join_(room, room.hostKey, 'Host');
    await host.connected();
    await put(room, room.editSecret, 'pic', png(500));
    host.leave();
    await sleep((GRACE_S + 1.5) * 1000);
    expect((await get(room, room.editSecret, 'pic')).status).toBe(410);
    expect((await put(room, room.editSecret, 'new', png(500))).status).toBe(410);
    expect((await get(room, room.hostKey, 'pic')).status).toBe(200);
  }, 15000);

  it("uploads just the images a room doesn't have yet", async () => {
    const room = await createRoom(SERVER);
    const src = (b: Uint8Array) => `data:image/png;base64,${Buffer.from(b).toString('base64')}`;
    await put(room, room.hostKey, 'have', png(200, 3));
    const els: El[] = ['have', 'need'].map((asset, i) => ({ type: 'image', id: `i${i}`, x: 0, y: 0, w: 10, h: 10, asset }));
    const ok = await uploadMissing({ server: SERVER, roomId: room.roomId, secret: room.hostKey }, els, { have: src(png(200, 9)), need: src(png(200, 4)) });
    expect(ok).toBe(true);
    // "have" kept its original bytes; "need" was uploaded.
    expect(new Uint8Array(await (await get(room, room.editSecret, 'have')).arrayBuffer())).toEqual(png(200, 3));
    expect(new Uint8Array(await (await get(room, room.editSecret, 'need')).arrayBuffer())).toEqual(png(200, 4));
  });
});

describe('abuse limits', () => {
  it('limits how many rooms one network can create per hour', async () => {
    // Locally the address header can be set by hand; on Cloudflare it's always set by Cloudflare.
    const make = (ip: string) => fetch(`${SERVER}/rooms`, { method: 'POST', headers: { 'CF-Connecting-IP': ip } });
    const codes = await Promise.all(Array.from({ length: 100 }, () => make('203.0.113.9').then((r) => r.status)));
    expect(codes.every((c) => c === 201)).toBe(true);
    expect((await make('203.0.113.9')).status).toBe(429);
    expect((await make('198.51.100.4')).status).toBe(201);
  }, 30000);

  it('only accepts requests from allowed websites', async () => {
    const res = await fetch(`${SERVER}/rooms`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    const ok = await fetch(`${SERVER}/rooms`, { method: 'POST', headers: { Origin: 'https://ardzeyftw.github.io', 'CF-Connecting-IP': '198.51.100.5' } });
    expect(ok.status).toBe(201);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://ardzeyftw.github.io');
  });
});
