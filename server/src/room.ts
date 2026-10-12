// One shared board. Holds the live Yjs document, saves it in this object's own SQLite storage,
// and passes edits and presence between everyone connected.
//
// Sockets use the WebSocket Hibernation API: while nobody is sending anything the object can be
// evicted from memory without dropping connections, so idle rooms cost nothing. Anything that must
// survive that lives in SQLite or in each socket's attachment, and the document is reloaded on demand.
import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';
import {
  CLOSE_CODES, GRACE_SECONDS, MAX_EDITORS, MAX_NAME, MAX_VIEWERS, MSG_AWARENESS, MSG_SYNC, PERSON_COLORS, PICKUP_SECONDS, SEAT_HOLD_SECONDS,
  type ClientMessage, type ErrorCode, type HostStatus, type Role, type RoomStatus, type ServerMessage,
} from '../../src/sync/protocol';
import { sha256 } from './crypto';

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  LIMITER: DurableObjectNamespace<import('./limiter').Limiter>;
  ALLOWED_ORIGINS: string;
  /** Overrides for testing; normally 1 hour, 7 days and 50 MB. */
  GRACE_SECONDS?: string;
  PICKUP_SECONDS?: string;
  ROOM_LIMIT_MB?: string;
  ROOMS_PER_HOUR?: string;
  MAX_VIEWERS?: string;
  SEAT_HOLD_SECONDS?: string;
}

export type AssetResult = 'ok' | 'exists' | 'not_found' | 'forbidden' | 'closed' | 'too_big' | 'room_full' | 'bad_type';

/** Image types a room accepts, with a check that the bytes really are that type. */
const IMAGE_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ascii(b, 0, 4) === 'GIF8',
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'image/avif': (b) => ascii(b, 4, 8) === 'ftyp',
  'image/bmp': (b) => ascii(b, 0, 2) === 'BM',
  'image/svg+xml': (b) => /<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 4096))),
};
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
/** Largest single image. The app downsizes pictures well below this. */
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const ASSET_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Where the room is in its life. live: the host is here. grace: the host left; it closes at `closesAt`.
 * closed: guests can't join; the host can still collect it until `deleteAt`, then everything is deleted.
 */
type Life = { state: 'live' } | { state: 'grace'; closesAt: number } | { state: 'closed'; deleteAt: number };

export interface SecretHashes {
  host: string;
  edit: string;
  view: string;
}

/** Stored with each socket, so it survives hibernation (2 KB limit). */
interface Attachment {
  role?: Role;
  color?: number;
  /** Presence (awareness) client ids this socket has announced, with their latest clock. */
  presence?: [id: number, clock: number][];
  /** Which editing spot this socket holds, so the same person gets it back after a dropped connection. */
  seat?: string;
}

/** Viewers may only announce who they are, not move a cursor around: a few updates a second at most. */
const VIEWER_PRESENCE_BURST = 10;
const VIEWER_PRESENCE_PER_SECOND = 5;

/** SQLite rows are limited to 2 MB, so saved documents are split into parts this size. */
const PART_BYTES = 1024 * 1024;
/** Edits are saved in batches, at most this often, to stay well inside the free plan's daily writes. */
const SAVE_DELAY_MS = 2000;
/** Once this many batches are saved, they're merged into one. */
const COMPACT_AFTER = 100;
/** Largest message accepted from a browser. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export class Room extends DurableObject<Env> {
  private doc: Y.Doc | null = null;
  private pending: Uint8Array[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Editors who dropped off recently: their seat, until this time. Kept only in memory, which is fine if the room sleeps. */
  private held = new Map<string, number>();
  private viewerBudget = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.createTables();
  }

  private createTables() {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS doc (seq INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (seq, part))');
    // Images, also split into parts. Once stored, an image can't be replaced.
    sql.exec('CREATE TABLE IF NOT EXISTS asset_meta (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS asset_part (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))');
  }

  private get roomLimit() {
    return Number(this.env.ROOM_LIMIT_MB || 50) * 1024 * 1024;
  }

  private get graceMs() {
    return Number(this.env.GRACE_SECONDS || GRACE_SECONDS) * 1000;
  }

  private get seatHoldMs() {
    return Number(this.env.SEAT_HOLD_SECONDS || SEAT_HOLD_SECONDS) * 1000;
  }

  private get maxViewers() {
    return Number(this.env.MAX_VIEWERS || MAX_VIEWERS);
  }

  /** How many people can edit, the owner included. Set by the owner. */
  private get editorLimit(): number {
    return this.getMeta<number>('editorLimit') ?? MAX_EDITORS;
  }

  private get pickupMs() {
    return Number(this.env.PICKUP_SECONDS || PICKUP_SECONDS) * 1000;
  }

  // ------------------------------------------------------------ called by the Worker

  /** Set up a new room. Returns false if this room id is already in use. */
  async init(hashes: SecretHashes): Promise<boolean> {
    if (this.getMeta('hashes')) return false;
    this.setMeta('hashes', hashes);
    this.setMeta('createdAt', Date.now());
    // The host connects straight after creating the room. If they never do, it still closes and is deleted.
    await this.setLife({ state: 'grace', closesAt: Date.now() + this.graceMs });
    return true;
  }

  /** Room state for the host's app, which checks its shared boards when it opens. */
  async hostStatus(hostKey: string): Promise<HostStatus | 'not_found' | 'forbidden'> {
    const check = await this.checkHost(hostKey);
    if (check !== 'ok') return check;
    const { state, closesIn } = this.status();
    return { state, closesIn };
  }

  /**
   * End the room now: the host stopped sharing, deleted the board, or has collected the closed room.
   * Everyone still connected is told why and disconnected, then everything stored is deleted.
   */
  async remove(hostKey: string, reason: 'stopped' | 'collected'): Promise<'ok' | 'not_found' | 'forbidden'> {
    const check = await this.checkHost(hostKey);
    if (check !== 'ok') return check;
    for (const ws of this.ctx.getWebSockets()) this.fail(ws, reason === 'stopped' ? 'stopped' : 'closed');
    await this.wipe();
    return 'ok';
  }

  // ------------------------------------------------------------ images

  /** Which role a secret gives, or why it gives none. */
  private async roleFor(secret: string): Promise<Role | 'not_found' | 'forbidden'> {
    const hashes = this.getMeta<SecretHashes>('hashes');
    if (!hashes) return 'not_found';
    if (typeof secret !== 'string' || !secret) return 'forbidden';
    const hash = await sha256(secret);
    return hash === hashes.host ? 'host' : hash === hashes.edit ? 'edit' : hash === hashes.view ? 'view' : 'forbidden';
  }

  /** Store an image. Whoever adds an image uploads it before the board points to it. */
  async putAsset(secret: string, id: string, mime: string, data: ArrayBuffer): Promise<AssetResult> {
    const role = await this.roleFor(secret);
    if (role === 'not_found' || role === 'forbidden') return role;
    if (role === 'view') return 'forbidden';
    if (this.life().state === 'closed') return 'closed';
    const bytes = new Uint8Array(data);
    if (!ASSET_ID.test(id) || !IMAGE_TYPES[mime]?.(bytes)) return 'bad_type';
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) return 'too_big';
    const sql = this.ctx.storage.sql;
    if (sql.exec('SELECT 1 FROM asset_meta WHERE id = ?', id).toArray().length) return 'exists';
    if (this.bytesUsed() + bytes.length > this.roomLimit) return 'room_full';
    this.ctx.storage.transactionSync(() => {
      sql.exec('INSERT INTO asset_meta (id, mime, size) VALUES (?, ?, ?)', id, mime, bytes.length);
      for (let part = 0, at = 0; at < bytes.length; part++, at += PART_BYTES) {
        sql.exec('INSERT INTO asset_part (id, part, data) VALUES (?, ?, ?)', id, part, bytes.slice(at, at + PART_BYTES).buffer);
      }
    });
    return 'ok';
  }

  async getAsset(secret: string, id: string): Promise<{ mime: string; data: ArrayBuffer } | 'not_found' | 'forbidden' | 'closed'> {
    const role = await this.roleFor(secret);
    if (role === 'not_found' || role === 'forbidden') return role;
    if (this.life().state === 'closed' && role !== 'host') return 'closed';
    const sql = this.ctx.storage.sql;
    const meta = sql.exec<{ mime: string; size: number }>('SELECT mime, size FROM asset_meta WHERE id = ?', id).toArray()[0];
    if (!meta) return 'not_found';
    const parts = sql.exec<{ data: ArrayBuffer }>('SELECT data FROM asset_part WHERE id = ? ORDER BY part', id).toArray().map((r) => new Uint8Array(r.data));
    return { mime: meta.mime, data: joinParts(parts).slice().buffer };
  }

  /** Ids of the images stored, so an uploader can skip the ones already here. */
  async listAssets(secret: string): Promise<string[] | 'not_found' | 'forbidden'> {
    const role = await this.roleFor(secret);
    if (role === 'not_found' || role === 'forbidden') return role;
    return this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM asset_meta').toArray().map((r) => r.id);
  }

  /** Roughly how much this room stores: images plus the saved document. */
  private bytesUsed(): number {
    const sql = this.ctx.storage.sql;
    const images = sql.exec<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM asset_meta').one().n;
    const doc = sql.exec<{ n: number }>('SELECT COALESCE(SUM(length(data)), 0) AS n FROM doc').one().n;
    return images + doc;
  }

  private async checkHost(hostKey: string): Promise<'ok' | 'not_found' | 'forbidden'> {
    const hashes = this.getMeta<SecretHashes>('hashes');
    if (!hashes) return 'not_found';
    return typeof hostKey === 'string' && (await sha256(hostKey)) === hashes.host ? 'ok' : 'forbidden';
  }

  // ------------------------------------------------------------ life: timers

  private life(): Life {
    return this.getMeta<Life>('life') ?? { state: 'live' };
  }

  private async setLife(life: Life) {
    this.setMeta('life', life);
    if (life.state === 'grace') await this.ctx.storage.setAlarm(life.closesAt);
    else if (life.state === 'closed') await this.ctx.storage.setAlarm(life.deleteAt);
    // While live, check now and then that the host really is still here (see alarm()).
    else await this.ctx.storage.setAlarm(Date.now() + this.graceMs);
  }

  async alarm() {
    const life = this.life();
    const now = Date.now();
    if (life.state === 'live') {
      // If the server restarted while the host was connected, their leaving may never have been
      // noticed. Without this the room would stay open, and stored, forever.
      if (this.people().some((p) => p.att.role === 'host')) await this.ctx.storage.setAlarm(now + this.graceMs);
      else {
        await this.setLife({ state: 'grace', closesAt: now + this.graceMs });
        this.broadcastStatus();
      }
    } else if (life.state === 'grace') {
      if (now < life.closesAt) return void (await this.ctx.storage.setAlarm(life.closesAt));
      // The host has been gone too long: close the room. Only the host can still collect it.
      this.flush();
      this.compact();
      for (const p of this.people()) if (p.att.role !== 'host') this.fail(p.ws, 'closed');
      await this.setLife({ state: 'closed', deleteAt: now + this.pickupMs });
    } else if (life.state === 'closed') {
      if (now < life.deleteAt) return void (await this.ctx.storage.setAlarm(life.deleteAt));
      await this.wipe();
    }
  }

  /** Delete everything this room has stored. */
  private async wipe() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.pending = [];
    this.doc?.destroy();
    this.doc = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Leave empty tables, so a late request finds "not found" rather than an error.
    this.createTables();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({} satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------ socket events

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_MESSAGE_BYTES) return this.fail(ws, 'bad_request');
    const att = ws.deserializeAttachment() as Attachment;
    if (typeof message === 'string') return this.onControl(ws, att, message);
    if (!att.role) return; // Not signed in yet.

    const decoder = decoding.createDecoder(new Uint8Array(message));
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) this.onSync(ws, att, decoder);
    else if (type === MSG_AWARENESS) this.onPresence(ws, att, decoder);
  }

  async webSocketClose(ws: WebSocket) {
    this.leave(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.leave(ws);
  }

  private onControl(ws: WebSocket, att: Attachment, text: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.fail(ws, 'bad_request');
    }
    if (msg?.t === 'hello' && !att.role) return void this.onHello(ws, msg);
    if (msg?.t === 'set_limit' && att.role === 'host') {
      // Lowering it never removes anyone who's already editing: it only decides who gets in from now on.
      if (!Number.isInteger(msg.editors) || msg.editors < 1 || msg.editors > MAX_EDITORS) return;
      this.setMeta('editorLimit', msg.editors);
      this.broadcastStatus();
    }
  }

  private async onHello(ws: WebSocket, msg: Extract<ClientMessage, { t: 'hello' }>) {
    const hashes = this.getMeta<SecretHashes>('hashes');
    if (!hashes) return this.fail(ws, 'not_found');
    const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, MAX_NAME) : '';
    if (typeof msg.secret !== 'string' || !name) return this.fail(ws, 'bad_request');

    const hash = await sha256(msg.secret);
    const role: Role | null = hash === hashes.host ? 'host' : hash === hashes.edit ? 'edit' : hash === hashes.view ? 'view' : null;
    if (!role) return this.fail(ws, 'bad_secret');
    const life = this.life();
    if (life.state === 'closed' && role !== 'host') return this.fail(ws, 'closed');

    const others = this.people().filter((p) => p.ws !== ws);
    const seat = typeof msg.seat === 'string' && msg.seat.length > 0 && msg.seat.length <= 64 ? msg.seat : undefined;
    // An edit link only gives an editing spot while there is one. The owner's spot is always kept free.
    let given: Role = role;
    if (role === 'edit') {
      const seats = this.editorSeats(ws);
      if (!(seat && seats.has(seat)) && seats.size >= this.editorLimit - 1) given = 'view';
    }
    if (given === 'view' && others.filter((p) => p.att.role === 'view').length >= this.maxViewers) return this.fail(ws, 'full');
    // Editors (and the owner) get different colours: the first one nobody editing is using. Viewers show no cursor, so they just take a free one.
    const used = new Set(others.filter((p) => given === 'view' || p.att.role !== 'view').map((p) => p.att.color));
    const free = PERSON_COLORS.findIndex((_, i) => !used.has(i));
    const color = free >= 0 ? free : others.length % PERSON_COLORS.length;
    if (given === 'edit' && seat) this.held.delete(seat);
    ws.serializeAttachment({ role: given, color, presence: [], seat: given === 'edit' ? seat : undefined } satisfies Attachment);
    // The host is back in time: the room stays open.
    if (role === 'host' && life.state === 'grace') await this.setLife({ state: 'live' });

    this.send(ws, { t: 'welcome', role: given, color, room: this.status(), downgraded: given !== role || undefined });
    // Start syncing: tell them what we have; they answer with what we're missing, and ask in turn.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    sync.writeSyncStep1(encoder, this.loadDoc());
    ws.send(encoding.toUint8Array(encoder));
    for (const p of others) this.send(p.ws, { t: 'resend_presence' });
    // Everyone sees the new head count (the owner's Share dialog shows how many spots are used).
    this.broadcastStatus();
  }

  private onSync(ws: WebSocket, att: Attachment, decoder: decoding.Decoder) {
    const doc = this.loadDoc();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    if (att.role === 'view') {
      // View-only: answer their "what do you have", but never take changes from them.
      if (decoding.readVarUint(decoder) !== sync.messageYjsSyncStep1) return;
      sync.readSyncStep1(decoder, encoder, doc);
    } else {
      try {
        sync.readSyncMessage(decoder, encoder, doc, ws);
      } catch {
        return this.fail(ws, 'bad_request');
      }
    }
    if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
  }

  /**
   * Presence (cursors, names) isn't stored: it's passed on to everyone else. What gets passed on is
   * rebuilt here, because it comes from a browser we don't trust: the role and colour shown for a
   * person are the ones this server gave them, only the owner can say where they're looking, and
   * nobody can speak for another person's presence ids.
   */
  private onPresence(ws: WebSocket, att: Attachment, decoder: decoding.Decoder) {
    const entries: [id: number, clock: number, state: string][] = [];
    try {
      const update = decoding.readVarUint8Array(decoder);
      const d = decoding.createDecoder(update);
      const known = new Map(att.presence ?? []);
      for (let n = decoding.readVarUint(d); n > 0; n--) {
        const id = decoding.readVarUint(d);
        const clock = decoding.readVarUint(d);
        const state = this.cleanPresence(att, decoding.readVarString(d));
        // Viewers only say who they are. A cursor or selection from one is dropped, and so is a flood.
        if (state === null || (att.role === 'view' && !this.viewerMayAnnounce(ws))) return;
        if (!this.claimPresenceId(ws, att, id)) continue;
        if (state === 'null') known.delete(id);
        else known.set(id, clock);
        entries.push([id, clock, state]);
      }
      // A browser tab uses one id; a few are allowed for safety, more is ignored.
      att.presence = [...known].slice(-4);
      ws.serializeAttachment(att);
    } catch {
      return this.fail(ws, 'bad_request');
    }
    if (!entries.length) return;
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, entries.length);
    for (const [id, clock, state] of entries) {
      encoding.writeVarUint(inner, id);
      encoding.writeVarUint(inner, clock);
      encoding.writeVarString(inner, state);
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, encoding.toUint8Array(inner));
    const msg = encoding.toUint8Array(encoder);
    for (const p of this.people()) if (p.ws !== ws) p.ws.send(msg);
  }

  /** One person's announced state, with the parts this server knows better than they do filled in. Null: drop the update. */
  private cleanPresence(att: Attachment, state: string): string | null {
    if (state === 'null') return state;
    const obj = JSON.parse(state);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('bad presence');
    // Parsed rather than searched for as text, so escaped spellings can't slip past.
    if (att.role === 'view' && 'presence' in obj) return null;
    const user = obj.user && typeof obj.user === 'object' && !Array.isArray(obj.user) ? obj.user : {};
    obj.user = { ...user, role: att.role, ...(att.color !== undefined ? { color: PERSON_COLORS[att.color] } : {}) };
    if (att.role !== 'host' && obj.presence && typeof obj.presence === 'object') delete obj.presence.view;
    return JSON.stringify(obj);
  }

  /**
   * A socket may only announce its own presence ids. A person who reconnects brings the same id, so
   * a socket of the same kind (same role, and the same editing spot for an editor) takes it over;
   * nobody else can touch it.
   */
  private claimPresenceId(ws: WebSocket, att: Attachment, id: number): boolean {
    for (const p of this.people(ws)) {
      if (!p.att.presence?.some(([known]) => known === id)) continue;
      if (p.att.role !== att.role || (att.role === 'edit' && p.att.seat !== att.seat)) return false;
      p.ws.serializeAttachment({ ...p.att, presence: p.att.presence.filter(([known]) => known !== id) });
    }
    return true;
  }

  /** A small allowance per viewer: a burst when they arrive, then a few a second. */
  private viewerMayAnnounce(ws: WebSocket): boolean {
    const now = Date.now();
    const b = this.viewerBudget.get(ws) ?? { tokens: VIEWER_PRESENCE_BURST, at: now };
    b.tokens = Math.min(VIEWER_PRESENCE_BURST, b.tokens + ((now - b.at) / 1000) * VIEWER_PRESENCE_PER_SECOND);
    b.at = now;
    this.viewerBudget.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private leave(ws: WebSocket) {
    const att = (ws.deserializeAttachment() ?? {}) as Attachment;
    try {
      ws.close(1000);
    } catch {
      /* already closed */
    }
    if (!att.role) return;
    // An editor who drops off keeps their spot for a couple of minutes.
    if (att.role === 'edit' && att.seat) this.held.set(att.seat, Date.now() + this.seatHoldMs);
    // Tell everyone this person's cursor is gone.
    if (att.presence?.length) {
      const inner = encoding.createEncoder();
      encoding.writeVarUint(inner, att.presence.length);
      for (const [id, clock] of att.presence) {
        encoding.writeVarUint(inner, id);
        encoding.writeVarUint(inner, clock + 1);
        encoding.writeVarString(inner, 'null');
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, encoding.toUint8Array(inner));
      const msg = encoding.toUint8Array(encoder);
      for (const p of this.people(ws)) p.ws.send(msg);
    }
    if (att.role === 'host' && !this.people(ws).some((p) => p.att.role === 'host')) {
      // The host left: guests can carry on for a while.
      if (this.life().state === 'live') void this.setLife({ state: 'grace', closesAt: Date.now() + this.graceMs });
    }
    this.broadcastStatus(ws);
    // Nobody left: save now rather than waiting for the timer.
    if (!this.people(ws).length) this.flush();
  }

  // ------------------------------------------------------------ people & status

  /** Everyone signed in, with their socket info. `leaving` is a socket that is closing but may still be listed. */
  private people(leaving?: WebSocket): { ws: WebSocket; att: Attachment }[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== leaving)
      .map((ws) => ({ ws, att: (ws.deserializeAttachment() ?? {}) as Attachment }))
      .filter((p) => p.att.role);
  }

  /** Editing spots in use by people other than the owner: connected editors, and ones who dropped off a moment ago. */
  private editorSeats(leaving?: WebSocket): Set<string> {
    const now = Date.now();
    const seats = new Set<string>();
    this.people(leaving).forEach((p, i) => {
      if (p.att.role === 'edit') seats.add(p.att.seat ?? `anonymous-${i}`);
    });
    for (const [seat, until] of this.held) {
      if (until <= now) this.held.delete(seat);
      else seats.add(seat);
    }
    return seats;
  }

  private status(leaving?: WebSocket): RoomStatus {
    const people = this.people(leaving);
    const hostOnline = people.some((p) => p.att.role === 'host');
    const life = this.life();
    const counts = {
      editorLimit: this.editorLimit,
      editors: 1 + this.editorSeats(leaving).size,
      viewers: people.filter((p) => p.att.role === 'view').length,
      maxViewers: this.maxViewers,
    };
    // While the host is leaving, the new grace period may not be stored yet.
    if (life.state === 'live' && !hostOnline) return { state: 'grace', hostOnline, closesIn: this.graceMs, ...counts };
    return { state: life.state, hostOnline, closesIn: life.state === 'grace' ? Math.max(0, life.closesAt - Date.now()) : null, ...counts };
  }

  private broadcastStatus(leaving?: WebSocket) {
    const room = this.status(leaving);
    for (const p of this.people(leaving)) this.send(p.ws, { t: 'status', room });
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  private fail(ws: WebSocket, code: ErrorCode) {
    this.send(ws, { t: 'error', code });
    ws.serializeAttachment({} satisfies Attachment);
    try {
      ws.close(CLOSE_CODES[code], code);
    } catch {
      /* already closed */
    }
  }

  // ------------------------------------------------------------ document & storage

  /** The live document, loaded from storage the first time it's needed after waking up. */
  private loadDoc(): Y.Doc {
    if (this.doc) return this.doc;
    const doc = new Y.Doc({ gc: true });
    let batches = 0;
    let current = -1;
    let parts: Uint8Array[] = [];
    const apply = () => {
      if (!parts.length) return;
      Y.applyUpdate(doc, joinParts(parts));
      batches++;
      parts = [];
    };
    for (const row of this.ctx.storage.sql.exec<{ seq: number; data: ArrayBuffer }>('SELECT seq, data FROM doc ORDER BY seq, part')) {
      if (row.seq !== current) {
        apply();
        current = row.seq;
      }
      parts.push(new Uint8Array(row.data));
    }
    apply();

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Pass the change on to everyone except whoever sent it.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      sync.writeUpdate(encoder, update);
      const msg = encoding.toUint8Array(encoder);
      for (const p of this.people()) if (p.ws !== origin) p.ws.send(msg);
      this.queueSave(update);
    });
    this.doc = doc;
    if (batches > COMPACT_AFTER) this.compact();
    return doc;
  }

  private queueSave(update: Uint8Array) {
    this.pending.push(update);
    this.saveTimer ??= setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** Write waiting edits as one batch. */
  private flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.pending.length) return;
    const update = Y.mergeUpdates(this.pending);
    this.pending = [];
    const sql = this.ctx.storage.sql;
    const next = (sql.exec<{ n: number | null }>('SELECT MAX(seq) AS n FROM doc').one().n ?? -1) + 1;
    this.ctx.storage.transactionSync(() => writeParts(sql, next, update));
    if (next + 1 > COMPACT_AFTER) this.compact();
  }

  /** Replace all saved batches with one snapshot of the whole document. */
  private compact() {
    if (!this.doc) return;
    const snapshot = Y.encodeStateAsUpdate(this.doc);
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM doc');
      writeParts(sql, 0, snapshot);
    });
  }

  private getMeta<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private setMeta(key: string, value: unknown) {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }
}

function writeParts(sql: SqlStorage, seq: number, bytes: Uint8Array) {
  for (let part = 0, at = 0; at < bytes.length || part === 0; part++, at += PART_BYTES) {
    sql.exec('INSERT INTO doc (seq, part, data) VALUES (?, ?, ?)', seq, part, bytes.slice(at, at + PART_BYTES).buffer);
  }
}

function joinParts(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
