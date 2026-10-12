// Connects a board's Yjs document to a room on the collaboration server, and keeps it connected.
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
  CLOSE_CODES, MSG_AWARENESS, MSG_SYNC, type ClientMessage, type CreatedRoom, type ErrorCode, type HostStatus, type Role, type RoomStatus, type ServerMessage,
} from './protocol';

export type ConnectionState =
  | { kind: 'connecting' }
  /** `downgraded`: joined with an edit link, but every editing spot was taken, so they're a viewer. */
  | { kind: 'connected'; role: Role; color: number; room: RoomStatus; synced: boolean; downgraded: boolean }
  /** Lost the connection and will retry. Edits keep working and sync on reconnect. */
  | { kind: 'offline'; retryIn: number }
  /** Won't retry: the room is gone, the link is wrong, or the room is full or closed. */
  | { kind: 'failed'; code: ErrorCode };

export interface ConnectionOptions {
  /** Server address, e.g. https://megahard-collab.example.workers.dev */
  server: string;
  roomId: string;
  /** Host key, edit secret or view secret. Sent inside the connection, never in the URL. */
  secret: string;
  name: string;
  ydoc: Y.Doc;
  /** Normally random per connection. Fixed here only so tests can reconnect as the same person. */
  seat?: string;
}

const RETRY_MIN = 1000;
const RETRY_MAX = 30000;
const FATAL = new Set<number>(Object.values(CLOSE_CODES));

function randomSeat(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class RoomConnection {
  readonly awareness: awarenessProtocol.Awareness;
  state: ConnectionState = { kind: 'connecting' };
  private ws: WebSocket | null = null;
  private retryDelay = RETRY_MIN;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private listeners = new Set<(s: ConnectionState) => void>();
  private readonly ydoc: Y.Doc;
  /** Random, and the same for every reconnect: lets a dropped editor get their editing spot back. */
  private readonly seat: string;

  constructor(private readonly opts: ConnectionOptions) {
    this.ydoc = opts.ydoc;
    this.seat = opts.seat ?? randomSeat();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.ydoc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    this.connect();
  }

  onState(fn: (s: ConnectionState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get role(): Role | null {
    return this.state.kind === 'connected' ? this.state.role : null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'local');
    this.ydoc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.awareness.destroy();
    this.ws?.close(1000);
    this.ws = null;
  }

  /** Owner only: how many people can edit, the owner included. Anyone already editing keeps their spot. */
  setEditorLimit(editors: number) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'set_limit', editors } satisfies ClientMessage));
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.listeners.forEach((fn) => fn(s));
  }

  private connect() {
    if (this.destroyed) return;
    this.setState({ kind: 'connecting' });
    const url = `${this.opts.server.replace(/^http/, 'ws').replace(/\/$/, '')}/rooms/${encodeURIComponent(this.opts.roomId)}/ws`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let fatal: ErrorCode | null = null;

    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', secret: this.opts.secret, name: this.opts.name, seat: this.seat }));
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'error') fatal = msg.code;
        else this.onControl(ws, msg);
        return;
      }
      this.onBinary(ws, new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Other people's cursors are stale until we're back.
      awarenessProtocol.removeAwarenessStates(
        this.awareness, [...this.awareness.getStates().keys()].filter((id) => id !== this.ydoc.clientID), this,
      );
      if (this.destroyed) return;
      if (fatal || FATAL.has(e.code)) {
        const code = fatal ?? (Object.keys(CLOSE_CODES) as ErrorCode[]).find((k) => CLOSE_CODES[k] === e.code) ?? 'bad_request';
        this.setState({ kind: 'failed', code });
        return;
      }
      const retryIn = this.retryDelay;
      this.retryDelay = Math.min(RETRY_MAX, this.retryDelay * 2);
      this.setState({ kind: 'offline', retryIn });
      this.retryTimer = setTimeout(() => this.connect(), retryIn);
    };
  }

  private onControl(ws: WebSocket, msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome': {
        this.retryDelay = RETRY_MIN;
        this.setState({ kind: 'connected', role: msg.role, color: msg.color, room: msg.room, synced: false, downgraded: msg.downgraded === true });
        // Ask for what we're missing. (The server asks us in turn, and we answer with our changes.)
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        sync.writeSyncStep1(encoder, this.ydoc);
        ws.send(encoding.toUint8Array(encoder));
        this.sendPresence(ws);
        break;
      }
      case 'status':
        if (this.state.kind === 'connected') this.setState({ ...this.state, room: msg.room });
        break;
      case 'resend_presence':
        this.sendPresence(ws);
        break;
    }
  }

  private onBinary(ws: WebSocket, data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      const kind = sync.readSyncMessage(decoder, encoder, this.ydoc, this);
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
      if (kind === sync.messageYjsSyncStep2 && this.state.kind === 'connected' && !this.state.synced) {
        this.setState({ ...this.state, synced: true });
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  /** Send our own changes as they happen. Changes made while offline go out in the next sync instead. */
  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.role === null || this.role === 'view') return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    sync.writeUpdate(encoder, update);
    this.ws.send(encoding.toUint8Array(encoder));
  };

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin !== 'local' || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.role === null) return;
    this.ws.send(this.presenceMessage([...added, ...updated, ...removed]));
  };

  private sendPresence(ws: WebSocket) {
    if (this.awareness.getLocalState() !== null) ws.send(this.presenceMessage([this.ydoc.clientID]));
  }

  private presenceMessage(clients: number[]): Uint8Array<ArrayBuffer> {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    return encoding.toUint8Array(encoder);
  }
}

/** Why a room couldn't be created: too many from this network lately, server trouble, or no connection. */
export class CreateRoomError extends Error {
  constructor(readonly reason: 'rate_limited' | 'busy' | 'offline') {
    super(`Could not start sharing (${reason})`);
  }
}

/** Create a room on the server. The host keeps the returned keys; only their hashes are stored there. */
export async function createRoom(server: string): Promise<CreatedRoom> {
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/$/, '')}/rooms`, { method: 'POST' });
  } catch {
    throw new CreateRoomError('offline');
  }
  if (res.status === 429) throw new CreateRoomError('rate_limited');
  // Anything else, including the free plan's daily limits running out, means "try later".
  if (!res.ok) throw new CreateRoomError('busy');
  return (await res.json()) as CreatedRoom;
}

/** Where a room is and how to reach it as its host. */
export interface HostKeys {
  server: string;
  roomId: string;
  hostKey: string;
}

const hostHeaders = (keys: HostKeys) => ({ Authorization: `Bearer ${keys.hostKey}` });
const roomUrl = (keys: HostKeys) => `${keys.server.replace(/\/$/, '')}/rooms/${encodeURIComponent(keys.roomId)}`;

/** The room's state, 'gone' if it no longer exists, or 'error' if the server couldn't be reached. */
export async function hostRoomStatus(keys: HostKeys): Promise<HostStatus | 'gone' | 'error'> {
  try {
    const res = await fetch(`${roomUrl(keys)}/status`, { headers: hostHeaders(keys), cache: 'no-store' });
    if (res.status === 404 || res.status === 403) return 'gone';
    return res.ok ? ((await res.json()) as HostStatus) : 'error';
  } catch {
    return 'error';
  }
}

/** End a room now. Returns false only if the server couldn't be reached (it then closes on its own timers). */
export async function removeRoom(keys: HostKeys, reason: 'stopped' | 'collected'): Promise<boolean> {
  try {
    const res = await fetch(`${roomUrl(keys)}?reason=${reason}`, { method: 'DELETE', headers: hostHeaders(keys) });
    return res.ok || res.status === 404 || res.status === 403;
  } catch {
    return false;
  }
}

/** Wait until the connection has synced, or has failed for good. */
export function whenSynced(conn: RoomConnection, timeoutMs = 20000): Promise<ConnectionState> {
  return new Promise((resolve) => {
    const done = (s: ConnectionState) => {
      clearTimeout(timer);
      off();
      resolve(s);
    };
    const check = (s: ConnectionState) => {
      if ((s.kind === 'connected' && s.synced) || s.kind === 'failed') done(s);
    };
    const timer = setTimeout(() => done(conn.state), timeoutMs);
    const off = conn.onState(check);
    check(conn.state);
  });
}
