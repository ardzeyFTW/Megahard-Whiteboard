// HTTP entry point: creates rooms and hands WebSocket connections to the right room.
import { ID_PATTERN, type CreatedRoom } from '../../src/sync/protocol';
import { randomToken, sha256 } from './crypto';
import type { AssetResult, Env } from './room';

export { Room } from './room';
export { Limiter } from './limiter';

/** Most rooms one network may create per hour (ROOMS_PER_HOUR can change it, e.g. for tests). */
const ROOMS_PER_HOUR = 10;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    // Browsers always send Origin, so other websites can't use this server from their pages.
    if (origin && !originAllowed(origin, env.ALLOWED_ORIGINS)) return new Response('Origin not allowed', { status: 403 });
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' },
      });
    }

    if (url.pathname === '/rooms' && request.method === 'POST') {
      // Only a hash of the address is used, and only to count.
      const who = await sha256(request.headers.get('CF-Connecting-IP') ?? 'local');
      if (!(await env.LIMITER.get(env.LIMITER.idFromName(who)).allow(Number(env.ROOMS_PER_HOUR || ROOMS_PER_HOUR), 3600_000))) {
        return new Response('Too many shared boards from here. Try again later.', { status: 429, headers: { ...cors, 'Retry-After': '3600' } });
      }
      return json(await createRoom(env), 201, cors);
    }

    const ws = /^\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (ws && request.method === 'GET') {
      if (!ID_PATTERN.test(ws[1])) return new Response('Not found', { status: 404, headers: cors });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426, headers: cors });
      return env.ROOMS.get(env.ROOMS.idFromName(ws[1])).fetch(request);
    }

    // Images: list, upload or download. The link's secret goes in the Authorization header.
    const asset = /^\/rooms\/([^/]+)\/assets(?:\/([^/]+))?$/.exec(url.pathname);
    if (asset && ID_PATTERN.test(asset[1])) return assetRequest(request, env, asset[1], asset[2], cors);

    // Host only: check on a shared board, or end it. The host key goes in the Authorization header.
    const room = /^\/rooms\/([^/]+)(\/status)?$/.exec(url.pathname);
    if (room && ID_PATTERN.test(room[1]) && (room[2] ? request.method === 'GET' : request.method === 'DELETE')) {
      const key = bearer(request);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room[1]));
      const result = room[2] ? await stub.hostStatus(key) : await stub.remove(key, url.searchParams.get('reason') === 'collected' ? 'collected' : 'stopped');
      if (result === 'not_found') return new Response('Not found', { status: 404, headers: cors });
      if (result === 'forbidden') return new Response('Forbidden', { status: 403, headers: cors });
      return result === 'ok' ? new Response(null, { status: 204, headers: cors }) : json(result, 200, cors);
    }

    if (url.pathname === '/') return new Response('Megahard Whiteboard collaboration server', { headers: cors });
    return new Response('Not found', { status: 404, headers: cors });
  },
} satisfies ExportedHandler<Env>;

const bearer = (request: Request) => /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';

const ASSET_STATUS: Record<Exclude<AssetResult, 'ok' | 'exists'>, number> = {
  not_found: 404, forbidden: 403, closed: 410, too_big: 413, room_full: 507, bad_type: 415,
};

async function assetRequest(request: Request, env: Env, roomId: string, assetId: string | undefined, cors: Record<string, string>): Promise<Response> {
  const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const secret = bearer(request);
  const fail = (code: keyof typeof ASSET_STATUS) => new Response(code, { status: ASSET_STATUS[code], headers: cors });

  if (!assetId) {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    const ids = await room.listAssets(secret);
    return typeof ids === 'string' ? fail(ids) : json(ids, 200, cors);
  }
  if (request.method === 'PUT') {
    const mime = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    const result = await room.putAsset(secret, assetId, mime, await request.arrayBuffer());
    return result === 'ok' || result === 'exists' ? new Response(null, { status: result === 'ok' ? 201 : 200, headers: cors }) : fail(result);
  }
  if (request.method === 'GET') {
    const result = await room.getAsset(secret, assetId);
    if (typeof result === 'string') return fail(result);
    return new Response(result.data, {
      headers: {
        ...cors,
        'Content-Type': result.mime,
        // Only ever an image: never run it as a page, never guess another type.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment',
        'Cache-Control': 'private, no-store',
      },
    });
  }
  return new Response('Method not allowed', { status: 405, headers: cors });
}

async function createRoom(env: Env): Promise<CreatedRoom> {
  for (;;) {
    const created: CreatedRoom = { roomId: randomToken(16), hostKey: randomToken(24), editSecret: randomToken(24), viewSecret: randomToken(24) };
    const room = env.ROOMS.get(env.ROOMS.idFromName(created.roomId));
    const hashes = { host: await sha256(created.hostKey), edit: await sha256(created.editSecret), view: await sha256(created.viewSecret) };
    // A clash between random 128-bit ids won't happen in practice, but try again if it does.
    if (await room.init(hashes)) return created;
  }
}

/** Exact match, or a pattern ending in ":*" for any port. */
export function originAllowed(origin: string, allowed: string): boolean {
  return allowed.split(',').map((a) => a.trim()).filter(Boolean).some((a) =>
    a.endsWith(':*') ? origin === a.slice(0, -2) || (origin.startsWith(a.slice(0, -1)) && /^\d+$/.test(origin.slice(a.length - 1))) : origin === a,
  );
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
