// Sharing on the board screen: the Share button and dialog for the board's owner, and the join
// flow, people list and status banners for everyone.
import type { BoardDoc } from '../types';
import type { Editor, LiveStroke, LocalPresence, RemotePerson, ToolInHand } from '../editor/editor';
import type { Pt } from '../types';
import { CreateRoomError, RoomConnection, createRoom, removeRoom, type ConnectionState } from '../sync/connection';
import { MAX_EDITORS, PERSON_COLORS, type ErrorCode, type Role } from '../sync/protocol';
import { myServer } from '../sync/config';
import { buildJoinLink, serverHost } from '../sync/serverAddress';
import { focusServerInput, serverForm } from './serverForm';
import type { Trail, TrailPoint } from '../sync/cursorTrack';
import type { Bounds } from '../types';
import { cleanName, randomName, rememberName, savedName } from '../sync/names';
import { downloadAsset, downloadMissing, missingAssets, uploadAsset, uploadMissing, type AssetKeys } from '../sync/assets';
import { deleteGuestCache, deleteShare, saveShare, saveYState, type ShareRecord } from '../db';
import { closeAllModals, confirmDialog, h, showModal, textButton, toast } from './dom';
import { icon } from './icons';

export interface CollabOptions {
  /** This device's board, already shared. */
  share?: ShareRecord;
  /** Someone else's board, joined with a link. */
  guest?: { roomId: string; secret: string; name: string; server: string };
}

export interface Person {
  id: number;
  name: string;
  color: string;
  role: Role;
  me: boolean;
  cursor: Pt | null;
}

/** How often this person's cursor and live stroke are sent, at most. */
const PRESENCE_MS = 100;
/** Longest live stroke sent while drawing (numbers: 3 per point). The finished stroke arrives in full anyway. */
const MAX_LIVE_POINTS = 6000;
/** Most recent pointer positions sent with each update, so others can replay the motion smoothly. */
const MAX_TRAIL_POINTS = 8;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown): Pt | null => {
  const p = v as Pt | null;
  return p && num(p.x) && num(p.y) ? { x: p.x, y: p.y } : null;
};
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 100).slice(0, 500) : [];
function toolInHand(v: unknown): ToolInHand | null {
  const t = v as { kind?: unknown; color?: unknown; mode?: unknown } | null;
  if (!t) return null;
  if ((t.kind === 'pen' || t.kind === 'highlighter') && typeof t.color === 'string' && HEX.test(t.color)) return { kind: t.kind, color: t.color };
  if (t.kind === 'eraser') return { kind: 'eraser', mode: t.mode === 'area' ? 'area' : 'stroke' };
  if (t.kind === 'lasso' || t.kind === 'shape') return { kind: t.kind };
  return null;
}

/** A rectangle of the board from another browser, checked. */
function viewRect(v: unknown): Bounds | null {
  const r = v as Bounds | null;
  return r && num(r.x) && num(r.y) && num(r.w) && num(r.h) && r.w > 1 && r.h > 1 && r.w < 1e7 && r.h < 1e7 ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
}

/** A trail of recent pointer positions from another browser, checked. */
function trailOf(v: unknown): Trail | null {
  const t = v as { ts?: unknown; trail?: unknown } | null;
  if (!t || !num(t.ts) || !Array.isArray(t.trail) || t.trail.length > 16) return null;
  const points: TrailPoint[] = [];
  for (const p of t.trail as unknown[]) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(num) || p[2] < 0 || p[2] > 2000) return null;
    points.push([p[0], p[1], p[2]]);
  }
  return { ts: t.ts, points };
}

function liveStroke(v: unknown): LiveStroke | null {
  const s = v as Partial<LiveStroke> | null;
  if (!s || !Array.isArray(s.points) || s.points.length % 3 || s.points.length > MAX_LIVE_POINTS || !s.points.every(num)) return null;
  if (typeof s.color !== 'string' || !HEX.test(s.color) || !num(s.size)) return null;
  return {
    points: s.points, color: s.color, size: Math.min(Math.max(s.size, 0.5), 500), highlighter: s.highlighter === true,
    opacity: num(s.opacity) ? Math.min(Math.max(s.opacity, 0.05), 1) : undefined,
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const ROLES: Role[] = ['host', 'edit', 'view'];

/** A live connection to a room, plus who's in it. */
class Session {
  readonly conn: RoomConnection;
  private listeners = new Set<() => void>();
  /** Who's here, as text: the people list only redraws when this changes, not on every cursor move. */
  private peopleKey = '';
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPresence: LocalPresence | null = null;
  private lastSent = '';
  /** Where the pointer has been since the last update was sent. */
  private samples: { x: number; y: number; t: number }[] = [];

  constructor(server: string, roomId: string, secret: string, name: string, private readonly ed: Editor) {
    this.conn = new RoomConnection({ server, roomId, secret, name, ydoc: ed.sync.ydoc });
    this.conn.onState((s) => {
      if (s.kind === 'connected') this.conn.awareness.setLocalStateField('user', { name, color: PERSON_COLORS[s.color], role: s.role });
      this.emit();
    });
    this.conn.awareness.on('change', () => {
      ed.setRemotePeople(this.remotePeople());
      const key = this.people().map((p) => `${p.id}|${p.name}|${p.color}|${p.role}`).join(',');
      if (key !== this.peopleKey) {
        this.peopleKey = key;
        this.emit();
      }
    });
    ed.onPresence = (p) => this.queuePresence(p);
  }

  /** Send this person's cursor, selection and live stroke, at most every PRESENCE_MS. */
  private queuePresence(p: LocalPresence) {
    // Viewers only say who they are: others don't see their cursor, which keeps a crowd of viewers cheap.
    if (this.conn.role === 'view') return;
    this.pendingPresence = p;
    const last = this.samples[this.samples.length - 1];
    if (!p.cursor) this.samples = [];
    else if (!last || last.x !== p.cursor.x || last.y !== p.cursor.y) {
      this.samples.push({ x: p.cursor.x, y: p.cursor.y, t: performance.now() });
      if (this.samples.length > 64) this.samples.shift();
    }
    this.presenceTimer ??= setTimeout(() => {
      this.presenceTimer = null;
      const next = this.pendingPresence;
      if (!next) return;
      const stroke = next.stroke && { ...next.stroke, points: next.stroke.points.slice(-MAX_LIVE_POINTS) };
      const round = (v: number) => Math.round(v * 10) / 10;
      const now = performance.now();
      // The last few positions, thinned evenly (always keeping the newest), with how long ago each was.
      const kept = this.samples.length > MAX_TRAIL_POINTS
        ? Array.from({ length: MAX_TRAIL_POINTS }, (_, i) => this.samples[Math.round((i * (this.samples.length - 1)) / (MAX_TRAIL_POINTS - 1))])
        : this.samples;
      this.samples = [];
      const trail = kept.map((s): TrailPoint => [round(s.x), round(s.y), Math.round(now - s.t)]);
      const value = {
        cursor: next.cursor && { x: round(next.cursor.x), y: round(next.cursor.y) },
        selection: next.selection.slice(0, 500),
        editing: next.editing,
        stroke,
        tool: next.tool,
        trail: trail.length ? trail : undefined,
        // Only the owner says where they're looking: viewers follow it.
        view: this.conn.role === 'host' && next.view
          ? { x: round(next.view.x), y: round(next.view.y), w: round(next.view.w), h: round(next.view.h) }
          : undefined,
      };
      const text = JSON.stringify(value);
      if (text === this.lastSent) return;
      this.lastSent = text;
      // The clock goes in after the comparison: it changes every time.
      this.conn.awareness.setLocalStateField('presence', trail.length ? { ...value, ts: now } : value);
    }, PRESENCE_MS);
  }

  /** Everyone else, with what they're doing, checked: it all comes from other browsers. */
  private remotePeople(): RemotePerson[] {
    const out: RemotePerson[] = [];
    for (const person of this.people()) {
      if (person.me) continue;
      const st = this.conn.awareness.getStates().get(person.id) as { presence?: Record<string, unknown> } | undefined;
      const pr = st?.presence ?? {};
      const trail = trailOf(pr);
      out.push({
        id: person.id, name: person.name, color: person.color,
        cursor: point(pr.cursor), selection: ids(pr.selection),
        editing: typeof pr.editing === 'string' && pr.editing.length <= 100 ? pr.editing : null,
        stroke: liveStroke(pr.stroke),
        tool: toolInHand(pr.tool),
        trail: trail && { ...trail, seq: this.conn.awareness.meta.get(person.id)?.clock ?? 0 },
        isHost: person.role === 'host',
        view: viewRect(pr.view),
      });
    }
    return out;
  }

  get state(): ConnectionState {
    return this.conn.state;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  /** Everyone here, from their presence. Names and colours come from other browsers, so they're checked. */
  people(): Person[] {
    const me = this.conn.awareness.clientID;
    const out: Person[] = [];
    this.conn.awareness.getStates().forEach((st, id) => {
      const u = (st as { user?: { name?: unknown; color?: unknown; role?: unknown } }).user;
      if (!u || typeof u.name !== 'string') return;
      out.push({
        id,
        name: cleanName(u.name) || 'Someone',
        color: typeof u.color === 'string' && HEX.test(u.color) ? u.color : '#888888',
        role: ROLES.includes(u.role as Role) ? (u.role as Role) : 'edit',
        me: id === me,
        cursor: point((st as { presence?: { cursor?: unknown } }).presence?.cursor),
      });
    });
    const rank = (p: Person) => (p.me ? 0 : p.role === 'host' ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  destroy() {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.ed.onPresence = null;
    this.ed.setRemotePeople([]);
    this.listeners.clear();
    this.conn.destroy();
  }
}

// ---------------------------------------------------------------- name input

/** A name box that requires a name, and offers a random animal name. */
function nameField(onInput: (valid: boolean) => void) {
  const suggestion = randomName();
  const input = h('input', {
    class: 'text-input', type: 'text', value: savedName(), maxlength: 40, placeholder: `e.g. ${suggestion}`,
    'aria-label': 'Your name', autocomplete: 'nickname', spellcheck: 'false',
  });
  const use = h('button', { class: 'chip', type: 'button' }, `Use “${suggestion}”`);
  const sync = () => {
    use.hidden = !!cleanName(input.value);
    onInput(!!cleanName(input.value));
  };
  use.addEventListener('click', () => {
    input.value = suggestion;
    sync();
    input.focus();
  });
  input.addEventListener('input', sync);
  queueMicrotask(sync);
  const el = h('label', { class: 'name-field' }, h('span', { class: 'field-label' }, 'Your name'), input, use);
  return { el, input, value: () => cleanName(input.value) };
}

/** Ask for a display name before joining. Resolves to null if cancelled. */
export function askName(title: string, message: string, confirmLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const ok = textButton(confirmLabel, () => submit(), 'btn primary');
    const field = nameField((valid) => (ok.disabled = !valid));
    const submit = () => {
      const name = field.value();
      if (!name) return;
      result = name;
      close();
    };
    field.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const close = showModal(title, h('div', { class: 'share-dialog' }, h('p', {}, message), field.el),
      [textButton('Cancel', () => close()), ok], () => resolve(result));
    field.input.focus();
  });
}

// ---------------------------------------------------------------- people list

/** Everyone here. Clicking someone (whose cursor is on the board) moves the view to them. */
function peopleList(people: Person[], goTo: (p: Pt) => void) {
  if (!people.length) return h('p', { class: 'muted' }, 'Connecting…');
  return h('ul', { class: 'people' }, ...people.map((p) => {
    const cursor = p.cursor;
    const row = h(cursor && !p.me ? 'button' : 'div', { class: 'person', type: cursor && !p.me ? 'button' : null, title: cursor && !p.me ? `Go to ${p.name}` : null },
      h('span', { class: 'person-dot', style: { background: p.color } }),
      h('span', { class: 'person-name' }, p.name),
      p.me ? h('span', { class: 'muted' }, ' (you)') : null,
      p.role === 'host' ? h('span', { class: 'role-tag' }, 'Owner') : p.role === 'view' ? h('span', { class: 'role-tag' }, 'View only') : null);
    if (cursor && !p.me) row.addEventListener('click', () => goTo(cursor));
    return h('li', {}, row);
  }));
}

const ERROR_TEXT: Record<ErrorCode, string> = {
  not_found: "This shared board doesn't exist any more. Sharing may have ended.",
  closed: 'This shared board has closed. The owner keeps the board.',
  stopped: 'The owner stopped sharing this board.',
  bad_secret: "This link doesn't work. Check that it was copied in full.",
  full: 'This board is full right now. Try again in a little while.',
  bad_request: 'Something went wrong connecting to this board.',
};

// ---------------------------------------------------------------- setup

export interface Collab {
  /** Share button for the top bar, or null when sharing isn't available. */
  button: HTMLElement | null;
  /** Status messages shown at the top of the board. */
  banner: HTMLElement;
  /** True while this board's Yjs document needs saving (it's shared). */
  keepsYState(): boolean;
  /** Joined someone's board as a viewer: they can look and copy, and get a board of their own beside it. */
  isViewer(): boolean;
  destroy(): void;
}

/**
 * Wire sharing into a board screen. `onChange` is called whenever something the rest of the
 * screen shows may have changed (role, connection).
 */
export function setupCollab(ed: Editor, doc: BoardDoc, opts: CollabOptions, onChange: () => void): Collab {
  const guest = opts.guest ?? null;
  let share = opts.share ?? null;
  let session: Session | null = null;
  let zoomedToContent = false;
  /** Role from the last time we were connected: offline edits by an editor still count. */
  let lastRole: Role | null = null;
  /** When the room closes, on this device's clock, while the owner is away. */
  let closesAt: number | null = null;
  let lastRoom: unknown = null;
  /** Joined with an edit link while every editing spot was taken: told once, and told again if a spot opens up. */
  let downgradedNotice = false;
  let wasDowngraded = false;
  let collecting = false;
  /** For images: the room and this person's secret. */
  let keys: AssetKeys | null = null;
  /** Images have been checked since this connection was made. */
  let assetsChecked = false;
  // Keeps the "closes in N min" countdown current.
  const ticker = guest ? setInterval(() => refresh(), 30000) : 0;
  const banner = h('div', { class: 'share-banner', role: 'status', 'aria-live': 'polite' });
  /** The server holding this board. For an owner who hasn't set one up yet it's null, and the Share dialog helps them. */
  let server: string | null = guest ? guest.server : (share?.server ?? myServer());
  /** The owner is changing their server address, rather than starting to share. */
  let settingUp = false;

  const button = h('button', { class: 'share-btn', type: 'button' });
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', () => (guest ? showPeople() : showShareDialog()));

  function start(roomId: string, secret: string, name: string) {
    keys = { server: server as string, roomId, secret };
    session = new Session(server as string, roomId, secret, name, ed);
    session.onChange(refresh);
    refresh();
  }

  // ------------------------------------------------------------ images
  const fetching = new Set<string>();
  const attempts = new Map<string, number>();

  /** Fetch images others added. One that isn't uploaded yet is tried again a little later. */
  function fetchMissing() {
    if (!keys) return;
    const k = keys;
    for (const id of missingAssets(doc.elements, doc.assets)) {
      if (fetching.has(id)) continue;
      fetching.add(id);
      void downloadAsset(k, id).then((src) => {
        fetching.delete(id);
        if (src) {
          attempts.delete(id);
          ed.addAssets({ [id]: src });
          return;
        }
        const n = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, n);
        if (n <= 6 && keys === k) setTimeout(fetchMissing, Math.min(30000, 1000 * 2 ** n));
      });
    }
  }
  ed.sync.onExternalChange(() => fetchMissing());

  /** Upload a new image before it goes on the board, so everyone can see it. */
  ed.beforeNewAssets = async (assets) => {
    if (!session || !keys) return true;
    for (const [id, src] of Object.entries(assets)) {
      const result = await uploadAsset(keys, id, src);
      if (result === 'ok') continue;
      // The owner keeps every image anyway: it's uploaded as soon as they're back online.
      if (result === 'offline' && !guest) continue;
      toast(result === 'room_full' ? 'This shared board is full (50 MB). Remove some images to add more.'
        : result === 'too_big' ? 'That image is too large to share.'
        : result === 'offline' ? 'Images can’t be added while you’re offline.'
        : 'That image couldn’t be shared.');
      return false;
    }
    return true;
  };

  function refresh() {
    const s = session?.state;
    const count = session ? session.people().length : 0;
    if (s?.kind !== 'connected') assetsChecked = false;
    else if (s.synced && !assetsChecked && keys) {
      // Freshly connected: send any images the room lacks (added offline, or before sharing), fetch the rest.
      assetsChecked = true;
      if (s.role !== 'view') void uploadMissing(keys, doc.elements, doc.assets);
      fetchMissing();
    }
    if (s?.kind === 'connected') {
      lastRole = s.role;
      if (s.room !== lastRoom) {
        lastRoom = s.room;
        closesAt = s.room.closesIn === null ? null : Date.now() + s.room.closesIn;
      }
    }
    if (guest && s?.kind === 'connected') {
      if (s.downgraded && !downgradedNotice) {
        downgradedNotice = wasDowngraded = true;
        const limit = s.room.editorLimit;
        const why = limit === 1 ? 'The owner has kept editing to themselves' : `All ${limit} editing spots on this board are taken`;
        const close = showModal('Editing spots are full', h('p', {},
          `${why}, so you joined as a viewer. You can watch everything live. Open this link again later to try for a spot.`),
        [textButton('OK', () => close(), 'btn primary')]);
      } else if (wasDowngraded && !s.downgraded && s.role === 'edit') {
        wasDowngraded = false;
        toast('An editing spot opened up. You can edit now.', 4000);
      }
    }
    // Guests can edit only once they've joined with an edit link.
    if (guest) ed.setReadOnly(s?.kind === 'failed' || lastRole === null || lastRole === 'view');

    let label: string, iconName: 'share' | 'users' = 'users', cls = '';
    if (!session) {
      label = 'Share';
      iconName = 'share';
    } else if (s?.kind === 'connected') label = count > 1 ? `${count} here` : guest ? 'Joined' : 'Sharing';
    else if (s?.kind === 'failed') {
      label = 'Not connected';
      cls = 'warn';
    } else {
      label = 'Connecting…';
      cls = 'warn';
    }
    button.className = `share-btn ${cls}`.trim();
    button.title = guest ? 'People on this board' : session ? 'Sharing: links and people' : 'Share this board';
    button.replaceChildren(icon(iconName), h('span', {}, label));

    // Status line at the top of the board.
    const lines: string[] = [];
    if (guest && lastRole === null && s?.kind === 'offline') lines.push(`Can’t reach ${serverHost(guest.server)}, the server holding this board. Trying again…`);
    else if (s?.kind === 'offline' || (s?.kind === 'connecting' && lastRole)) lines.push('Reconnecting… Your changes are kept and will sync.');
    if (guest && s?.kind === 'connected') {
      if (s.role === 'view') lines.push(s.downgraded ? 'View only. All editing spots are taken.' : 'View only');
      if (!s.room.hostOnline) {
        const mins = closesAt === null ? null : Math.max(1, Math.ceil((closesAt - Date.now()) / 60000));
        lines.push(mins === null ? 'The owner has left.' : `The owner has left. This board stays open for ${mins} more min.`);
      }
    }
    banner.replaceChildren(...lines.map((t) => h('div', { class: 'banner-line' }, t)));
    banner.hidden = !lines.length;

    if (s?.kind === 'connected' && s.synced && !zoomedToContent) {
      zoomedToContent = true;
      if (guest) ed.zoomToFit(false);
    }
    if (s?.kind === 'failed') onFailed(s.code);
    // The room closed while the owner was away and now they're back: bring everyone's changes home.
    if (!guest && s?.kind === 'connected' && s.synced && s.room.state === 'closed') void collect();
    onChange();
  }

  let failedShown = false;
  function onFailed(code: ErrorCode) {
    if (failedShown) return;
    failedShown = true;
    if (guest) {
      ed.setReadOnly(true);
      // The board is the owner's: once the room is gone, so is this device's temporary copy.
      if (code === 'closed' || code === 'stopped' || code === 'not_found') void deleteGuestCache(guest.roomId);
      const ended = code === 'closed' || code === 'stopped';
      // However the message is closed (button, X, Esc, click outside) there's nothing left to see
      // here, so go home. The link is replaced, so Back doesn't bring the dead link back.
      const close = showModal(ended ? 'Sharing has ended' : "Can't open this board", h('p', {}, ERROR_TEXT[code]),
        [textButton('Back to my boards', () => close(), 'btn primary')],
        () => {
          if (location.hash.startsWith('#/join/')) location.replace('#/');
        });
    } else if (code === 'not_found' || code === 'bad_secret' || code === 'closed' || code === 'stopped') {
      // The room is gone (it expired or was removed): this board just isn't shared any more.
      void stopLocally();
      toast('Sharing for this board has ended');
    }
  }

  async function stopLocally() {
    session?.destroy();
    session = null;
    share = null;
    keys = null;
    await deleteShare(doc.id);
    refresh();
  }

  /** Save the board with everyone's changes, then let the server delete its copy. */
  async function collect() {
    if (collecting || !share || !keys) return;
    collecting = true;
    const sh = share;
    // Images guests added must be here before the server's copy goes.
    const assets = { ...doc.assets };
    const complete = await downloadMissing(keys, doc.elements, assets);
    ed.addAssets(assets);
    if (!complete) {
      // Stay connected and try again shortly; the room isn't deleted until everything is here.
      setTimeout(() => {
        collecting = false;
        refresh();
      }, 15000);
      return;
    }
    await ed.flushSave(true);
    session?.destroy();
    session = null;
    await removeRoom(sh, 'collected');
    await stopLocally();
    collecting = false;
    toast('Sharing has ended while you were away. Everyone’s changes are saved in this board.', 5000);
  }

  /** From the people list: close the dialog and look at where that person is. */
  function goTo(p: Pt) {
    closeAllModals();
    ed.centerOn(p);
  }

  // ------------------------------------------------------------ owner: Share dialog
  function showShareDialog() {
    // The address may have been set or changed in Settings since this board opened.
    if (!share) server = myServer();
    const body = h('div', { class: 'share-dialog' });
    let unsubscribe = () => undefined as void;
    const render = () => {
      unsubscribe();
      const heading = body.closest('.modal')?.querySelector('h2');
      if (heading) heading.textContent = share ? 'Sharing' : 'Share board';
      if (share && session) {
        body.replaceChildren(...sharedView(share, session));
        unsubscribe = session.onChange(() => body.replaceChildren(...sharedView(share as ShareRecord, session as Session)));
      } else if (!server || settingUp) body.replaceChildren(...serverSetupView());
      else body.replaceChildren(...startView());
    };

    /** Sharing runs on a server the person owns (a free Cloudflare Worker): help them set one up and paste its address. */
    function serverSetupView() {
      const form = serverForm({
        current: server,
        onCancel: settingUp && server ? () => { settingUp = false; render(); } : undefined,
        onChange: (address) => {
          server = address;
          settingUp = false;
          render();
        },
      });
      queueMicrotask(() => focusServerInput(body));
      return [
        h('p', {}, 'To share a board you need a small sharing server of your own. It’s free, takes about 5 minutes, and only you need one: the people you invite just open your link.'),
        h('ol', { class: 'share-facts' },
          h('li', {}, 'Make a free Cloudflare account if you don’t have one (no card needed).'),
          h('li', {}, 'Press “Deploy my server” and follow the steps. It puts a copy of the server in your own account.'),
          h('li', {}, 'Copy the address it gives you (it ends in workers.dev) and paste it below.')),
        ...form,
      ];
    }

    function startView() {
      const startBtn = textButton('Start sharing', () => void begin(), 'btn primary', 'share');
      const field = nameField((valid) => (startBtn.disabled = !valid));
      field.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !startBtn.disabled) void begin();
      });
      async function begin() {
        const name = field.value();
        if (!name) return;
        startBtn.disabled = true;
        startBtn.lastChild!.textContent = 'Starting…';
        try {
          rememberName(name);
          const created = await createRoom(server as string);
          // Images go up first, so they're there when the first guest arrives.
          if (!(await uploadMissing({ server: server as string, roomId: created.roomId, secret: created.hostKey }, doc.elements, doc.assets))) {
            await removeRoom({ server: server as string, roomId: created.roomId, hostKey: created.hostKey }, 'stopped');
            throw new Error('Could not upload the images');
          }
          share = { boardId: doc.id, server: server as string, ...created, createdAt: Date.now() };
          await saveShare(share);
          await saveYState(doc.id, ed.sync.encodeState());
          start(share.roomId, share.hostKey, name);
          render();
        } catch (err) {
          console.error(err);
          const reason = err instanceof CreateRoomError ? err.reason : 'busy';
          toast(reason === 'rate_limited' ? 'You’ve started sharing a lot of boards recently. Try again in an hour.'
            : reason === 'offline' ? 'Couldn’t start sharing. Check your connection and try again.'
            : 'Sharing is busy right now. Try again a bit later.', 5000);
          startBtn.disabled = false;
          startBtn.lastChild!.textContent = 'Start sharing';
        }
      }
      queueMicrotask(() => field.input.focus());
      return [
        h('p', {}, 'Invite people to draw on this board with you, live. Anyone with the link can join.'),
        h('ul', { class: 'share-facts' },
          h('li', {}, 'The board stays on your device. Your own sharing server keeps a copy only while it’s shared, and deletes it at most 7 days after.'),
          h('li', {}, 'If you leave, others can keep going for 1 hour. Their changes come back to you next time you open the app.'),
          h('li', {}, 'People with the view-only link get a board of their own beside yours, kept on their device. They can copy things from your board into it, but can’t save your board itself.'),
          h('li', {}, 'Shared boards aren’t end-to-end encrypted.')),
        field.el,
        h('p', { class: 'muted limit-note' }, 'Your sharing server is set up. It’s also in Settings, where its address stays hidden until you open it. ',
          h('button', { class: 'text-link', type: 'button', onclick: () => { settingUp = true; render(); } }, 'Change')),
        h('div', { class: 'dialog-buttons' }, startBtn),
      ];
    }

    function sharedView(sh: ShareRecord, sess: Session) {
      const st = sess.state;
      const status = st.kind === 'connected' ? 'Live' : st.kind === 'failed' ? 'Not connected' : 'Connecting…';
      return [
        h('p', { class: `share-status ${st.kind === 'connected' ? 'ok' : 'warn'}` }, h('span', { class: 'status-dot' }), status),
        linkRow('Can edit', joinLink(sh.roomId, sh.editSecret, sh.server)),
        linkRow('View only', joinLink(sh.roomId, sh.viewSecret, sh.server)),
        limitRow(sess),
        h('h3', {}, `People here (${sess.people().length})`),
        peopleList(sess.people(), goTo),
        h('div', { class: 'dialog-buttons' }, textButton('Stop sharing', () => void stop(), 'btn danger')),
      ];
    }

    async function stop() {
      const ok = await confirmDialog('Stop sharing?', 'Everyone else is disconnected straight away, and the links stop working. The board stays on your device.', 'Stop sharing', true);
      if (!ok || !share) return;
      const sh = share;
      session?.destroy();
      session = null;
      const reached = await removeRoom(sh, 'stopped');
      await stopLocally();
      render();
      toast(reached ? 'Sharing stopped' : 'Sharing stopped here. The server couldn’t be reached, so the links close on their own within an hour.', reached ? 2800 : 6000);
    }

    render();
    showModal(share ? 'Sharing' : 'Share board', body, [], () => unsubscribe());
  }

  // ------------------------------------------------------------ guest: people dialog
  function showPeople() {
    const body = h('div', { class: 'share-dialog' });
    const render = () => {
      const st = session?.state;
      body.replaceChildren(
        st?.kind === 'connected' && st.role === 'view' ? h('p', { class: 'muted' }, 'You can look around, but not change this board.') : '',
        peopleList(session?.people() ?? [], goTo),
        h('div', { class: 'dialog-buttons' }, textButton('Leave board', () => {
          close();
          location.hash = '#/';
        })));
    };
    render();
    const unsubscribe = session?.onChange(render);
    const close = showModal('People here', body, [], () => unsubscribe?.());
  }

  if (guest) start(guest.roomId, guest.secret, guest.name);
  else if (share) start(share.roomId, share.hostKey, savedName() || 'Owner');
  else refresh();

  return {
    button,
    banner,
    keepsYState: () => !!share,
    isViewer: () => !!guest && lastRole === 'view',
    destroy() {
      clearInterval(ticker);
      keys = null;
      ed.beforeNewAssets = null;
      session?.destroy();
      session = null;
    },
  };
}

/** How many people can edit at once (the owner counts as one), with how many spots are used. */
function limitRow(sess: Session) {
  const st = sess.state;
  if (st.kind !== 'connected') return '';
  const { editorLimit, editors, viewers, maxViewers } = st.room;
  const step = (label: string, to: number) => {
    const b = textButton('', () => sess.conn.setEditorLimit(to), 'btn stepper-btn', label === '+' ? 'plus' : 'minus');
    b.setAttribute('aria-label', label === '+' ? 'Allow one more editor' : 'Allow one fewer editor');
    b.disabled = to < 1 || to > MAX_EDITORS;
    return b;
  };
  return h('div', { class: 'limit-row' },
    h('div', { class: 'limit-line' },
      h('span', { class: 'field-label' }, 'People who can edit, including you'),
      h('div', { class: 'stepper' }, step('-', editorLimit - 1), h('output', { class: 'stepper-value', 'aria-live': 'polite' }, String(editorLimit)), step('+', editorLimit + 1))),
    h('p', { class: 'muted limit-note' },
      `${editors} of ${editorLimit} editing ${editorLimit === 1 ? 'spot' : 'spots'} used. When they’re full, anyone opening the edit link joins as a viewer. ${viewers} of ${maxViewers} viewer places used.`));
}

function linkRow(label: string, link: string) {
  const input = h('input', { class: 'text-input link-input', type: 'text', value: link, readonly: true, 'aria-label': `${label} link` });
  input.addEventListener('focus', () => input.select());
  const copy = textButton('Copy', () => {
    navigator.clipboard.writeText(link).then(
      () => toast(`${label} link copied`),
      () => {
        input.select();
        toast('Press Ctrl+C to copy the link');
      });
  }, 'btn', 'copy');
  return h('div', { class: 'link-row' }, h('span', { class: 'field-label' }, label), h('div', { class: 'link-line' }, input, copy));
}

/** The link someone opens to join. It names the server holding the board, and everything private is after "#", so none of it reaches the web server. */
export function joinLink(roomId: string, secret: string, server: string): string {
  return buildJoinLink(location.href, roomId, secret, server);
}
