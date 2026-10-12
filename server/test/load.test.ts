// Load check: how much does a classroom cost? One owner, a few editors and 40 viewers in one room,
// against the real server (wrangler dev) started with MAX_VIEWERS=40. Counts the messages every
// browser sends and receives, and compares them with the free plan's limits.
//
// Opt-in, because it takes a minute:  LOAD=1 npm test -- load      (PowerShell: $env:LOAD=1; npm test -- load)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BoardSync } from '../../src/sync/boardSync';
import { RoomConnection, createRoom } from '../../src/sync/connection';
import type { CreatedRoom } from '../../src/sync/protocol';
import type { BoardDoc, StrokeEl } from '../../src/types';

const PORT = 8798;
const SERVER = `http://127.0.0.1:${PORT}`;
const VIEWERS = 40;
const EDITORS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stateDir = join(__dirname, '..', '.wrangler', 'load-state');
let server: ChildProcess | null = null;

// Count every WebSocket message in and out (the app's own connection code uses the global WebSocket).
const tally = { sent: 0, sentBytes: 0, received: 0, receivedBytes: 0 };
const NativeWebSocket = globalThis.WebSocket;
class CountingWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener('message', (e: MessageEvent) => {
      tally.received++;
      tally.receivedBytes += typeof e.data === 'string' ? e.data.length : (e.data as ArrayBuffer).byteLength;
    });
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    tally.sent++;
    tally.sentBytes += typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength ?? 0;
    super.send(data as string);
  }
}

async function startServer() {
  server = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', stateDir,
    '--var', `MAX_VIEWERS:${VIEWERS}`, '--var', 'ROOMS_PER_HOUR:100',
  ], { cwd: join(__dirname, '..'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  });
}

function stopServer() {
  if (!server?.pid) return;
  if (process.platform === 'win32') {
    const run = (cmd: string) => {
      try {
        execSync(cmd, { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    };
    run(`taskkill /pid ${server.pid} /T /F`);
    run(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`);
  } else server.kill('SIGTERM');
  server = null;
}

const board = (): BoardDoc => ({
  version: 1, id: 'b', name: 'Class', createdAt: 0, updatedAt: 0,
  background: { color: '#ffffff', pattern: 'none' }, elements: [], assets: {}, camera: { x: 0, y: 0, zoom: 1 },
});
const stroke = (id: string, x: number): StrokeEl => ({ type: 'stroke', id, points: [x, 0, 0.5, x + 40, 20, 0.5, x + 80, 5, 0.5], color: '#1f1f1f', size: 4 });

const active = process.env.LOAD ? describe : describe.skip;

active('a classroom: owner, editors and 40 viewers', () => {
  beforeAll(async () => {
    globalThis.WebSocket = CountingWebSocket as unknown as typeof WebSocket;
    rmSync(stateDir, { recursive: true, force: true });
    await startServer();
  }, 70000);
  afterAll(() => {
    globalThis.WebSocket = NativeWebSocket;
    stopServer();
  });

  it('measures what a lecture costs', async () => {
    const room: CreatedRoom = await createRoom(SERVER);
    const people: { sync: BoardSync; conn: RoomConnection; name: string; role: string }[] = [];
    const join = (secret: string, name: string, role: string) => {
      const sync = new BoardSync(board());
      const conn = new RoomConnection({ server: SERVER, roomId: room.roomId, secret, name, ydoc: sync.ydoc });
      conn.awareness.setLocalStateField('user', { name, role });
      const p = { sync, conn, name, role };
      people.push(p);
      return p;
    };
    const synced = (p: (typeof people)[number]) => {
      const t0 = Date.now();
      return new Promise<number>((resolve, reject) => {
        const poll = setInterval(() => {
          const s = p.conn.state;
          if (s.kind === 'connected' && s.synced) {
            clearInterval(poll);
            resolve(Date.now() - t0);
          } else if (s.kind === 'failed') {
            clearInterval(poll);
            reject(new Error(`${p.name} failed: ${s.code}`));
          } else if (Date.now() - t0 > 30000) {
            clearInterval(poll);
            reject(new Error(`${p.name} never synced`));
          }
        }, 20);
      });
    };

    const host = join(room.hostKey, 'Owner', 'host');
    await synced(host);

    // The join storm: everyone arrives at once.
    const before = { ...tally };
    const t0 = Date.now();
    const editors = Array.from({ length: EDITORS }, (_, i) => join(room.editSecret, `Editor ${i}`, 'edit'));
    const viewers = Array.from({ length: VIEWERS }, (_, i) => join(room.viewSecret, `Viewer ${i}`, 'view'));
    await Promise.all([...editors, ...viewers].map(synced));
    const stormMs = Date.now() - t0;
    const storm = { sent: tally.sent - before.sent, received: tally.received - before.received };
    expect(viewers.every((v) => v.conn.role === 'view')).toBe(true);
    // The 41st viewer is turned away.
    const extra = join(room.viewSecret, 'One too many', 'view');
    await expect(synced(extra)).rejects.toThrow(/full/);

    // Let everyone's name arrive, then record a quiet minute-equivalent: 20 s of a lecture.
    await sleep(1500);
    const lectureStart = { ...tally };
    const seconds = 20;
    let strokes = 0;
    const end = Date.now() + seconds * 1000;
    let tick = 0;
    while (Date.now() < end) {
      tick++;
      // The owner draws a stroke every 400 ms, and moves their cursor 10 times a second.
      if (tick % 4 === 0) host.sync.commit([...host.sync.elements, stroke(`s${strokes++}`, strokes * 5)]);
      host.conn.awareness.setLocalStateField('presence', { cursor: { x: tick * 3, y: tick }, trail: [[tick * 3, tick, 40]], ts: tick * 100 });
      // Editors move their cursors too. The app never sends a viewer's cursor, so viewers send nothing here
      // (the server dropping a modified browser's cursor is covered in room.test.ts).
      for (const e of editors) e.conn.awareness.setLocalStateField('presence', { cursor: { x: tick, y: tick * 2 } });
      await sleep(100);
    }
    await sleep(800);
    const lecture = { sent: tally.sent - lectureStart.sent, received: tally.received - lectureStart.received, bytesIn: tally.receivedBytes - lectureStart.receivedBytes };

    // Everyone got every stroke.
    const missing = viewers.filter((v) => v.sync.elements.length !== strokes).length;

    // Free plan: 100,000 requests a day, and 20 incoming WebSocket messages count as 1.
    const perSecond = lecture.sent / seconds;
    const requestsPerHour = (perSecond * 3600) / 20;
    const hoursPerDay = 100000 / requestsPerHour;
    console.log('\n' + [
      `Join storm: ${EDITORS} editors + ${VIEWERS} viewers synced in ${stormMs} ms; ${storm.sent} messages sent by browsers, ${storm.received} received.`,
      `Lecture (${seconds} s, owner drawing ${strokes} strokes, owner and 3 editors moving cursors, 40 viewers watching):`,
      `  incoming to the server: ${lecture.sent} messages (${perSecond.toFixed(1)}/s)`,
      `  outgoing from the server: ${lecture.received} messages, ${(lecture.bytesIn / 1024).toFixed(0)} KB (${(lecture.bytesIn / 1024 / seconds).toFixed(0)} KB/s)`,
      `  free plan: about ${requestsPerHour.toFixed(0)} requests/hour, so a lecture like this fits about ${hoursPerDay.toFixed(1)} hours a day (100,000 requests).`,
      `  viewers missing strokes: ${missing} of ${VIEWERS}`,
    ].join('\n') + '\n');
    expect(missing).toBe(0);
    // Viewer cursors never reach anyone: only the owner's and editors' do.
    const seen = [...host.conn.awareness.getStates().values()] as { user?: { role?: string }; presence?: unknown }[];
    expect(seen.filter((s) => s.user?.role === 'view' && s.presence).length).toBe(0);
    people.forEach((p) => p.conn.destroy());
  }, 120000);
});
