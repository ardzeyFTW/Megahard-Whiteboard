// Messages between the app and the collaboration server (server/). Shared by both sides.
//
// Binary WebSocket frames carry Yjs data, starting with a message type (y-protocols format).
// Text frames carry JSON control messages: the first message from the app must be `hello`.

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

/**
 * Most people who can edit at once, the owner included. The owner can lower this for their board.
 * Everyone past it who opens an edit link joins as a viewer.
 */
export const MAX_EDITORS = 10;
/** Most viewers at once (a server can raise it with its MAX_VIEWERS setting). The owner can always get in. */
export const MAX_VIEWERS = 10;
/** How long an editor who drops off keeps their spot, so a wifi blip doesn't hand it to someone else. */
export const SEAT_HOLD_SECONDS = 120;
export const MAX_NAME = 40;

/** Each person in a room gets a different one of these, by index. */
export const PERSON_COLORS = [
  '#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#d6409f', '#12a594', '#ffb224', '#3e63dd', '#7c6f64',
];

/** host: the board's owner. edit: anyone with the edit link. view: anyone with the view-only link. */
export type Role = 'host' | 'edit' | 'view';

export interface RoomStatus {
  /** live: host connected. grace: host left, closes in `closesIn` ms. closed: only the host can still collect it. */
  state: 'live' | 'grace' | 'closed';
  hostOnline: boolean;
  /** Milliseconds until the room closes, while in grace. Relative, so clocks don't need to agree. */
  closesIn: number | null;
  /** How many people can edit, the owner included, and how many of those spots are taken (the owner's always is). */
  editorLimit: number;
  editors: number;
  /** Viewers here now, and the most the room takes. */
  viewers: number;
  maxViewers: number;
}

export type ClientMessage =
  /** `seat` is random and kept for as long as the app stays open, so a dropped editor gets their spot back. */
  | { t: 'hello'; secret: string; name: string; seat?: string }
  /** Owner only: how many people can edit, the owner included. */
  | { t: 'set_limit'; editors: number };

export type ErrorCode = 'not_found' | 'bad_secret' | 'full' | 'closed' | 'stopped' | 'bad_request';

export type ServerMessage =
  /** `downgraded`: they used an edit link but every editing spot was taken, so they joined as a viewer. */
  | { t: 'welcome'; role: Role; color: number; room: RoomStatus; downgraded?: boolean }
  | { t: 'status'; room: RoomStatus }
  | { t: 'error'; code: ErrorCode }
  /** Someone joined: send your presence again so they see you straight away. */
  | { t: 'resend_presence' };

/** WebSocket close codes the server uses after an error message. */
export const CLOSE_CODES: Record<ErrorCode, number> = {
  bad_request: 4000,
  closed: 4001,
  stopped: 4002,
  bad_secret: 4003,
  not_found: 4004,
  full: 4009,
};

/** Response to POST /rooms. */
export interface CreatedRoom {
  roomId: string;
  hostKey: string;
  editSecret: string;
  viewSecret: string;
}

/** How long a room stays open after the host leaves, and how long a closed room waits for the host to collect it. */
export const GRACE_SECONDS = 60 * 60;
export const PICKUP_SECONDS = 7 * 24 * 60 * 60;

/** Response to GET /rooms/:id/status (host only). */
export interface HostStatus {
  state: RoomStatus['state'];
  closesIn: number | null;
}

/** Room ids and secrets: random bytes in URL-safe base64, no padding. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{32}$/;
