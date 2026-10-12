// Which collaboration server to use. Every person who shares runs their own (a free Cloudflare
// Worker), saved on this device. A copy of the app can also be built with VITE_COLLAB_URL set, which
// is used until the person chooses their own.
import { readPrefs, writePrefs } from '../prefs';
import { normalizeServer } from './serverAddress';

/** Set at build time for a copy of the app that comes with its own server. The official site doesn't set it. */
export const DEFAULT_SERVER: string | null = normalizeServer(String(import.meta.env.VITE_COLLAB_URL ?? ''));

/** The server this person shares through: the one they set up, or the build's default. Null until they set one up. */
export function myServer(): string | null {
  return normalizeServer(readPrefs().collabServer) ?? DEFAULT_SERVER;
}

export function saveMyServer(server: string | null) {
  writePrefs({ collabServer: server });
}

/** Opens Cloudflare's "Deploy to Cloudflare" page, which copies this project's server into the person's own account. */
export const DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/ardzeyFTW/Megahard-Whiteboard/tree/main/server';
export const SETUP_GUIDE_URL = 'https://github.com/ardzeyFTW/Megahard-Whiteboard/blob/main/docs/self-hosting.md';

/**
 * See whether an address is one of our servers that lets this website in. A server that doesn't
 * allow this website fails like one that's down, because the browser hides why.
 */
export async function checkServer(server: string): Promise<'ok' | 'unreachable' | 'not_ours'> {
  try {
    const res = await fetch(`${server}/`, { cache: 'no-store' });
    return /collaboration server/i.test(await res.text()) ? 'ok' : 'not_ours';
  } catch {
    return 'unreachable';
  }
}
