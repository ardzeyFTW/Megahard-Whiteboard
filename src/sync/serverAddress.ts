// Every person who shares runs their own collaboration server (a free Cloudflare Worker), so a
// join link has to say which server holds the board. The address rides in the part of the link after
// "#", which browsers never send to the website, next to the room id and the secret.
import { ID_PATTERN, SECRET_PATTERN } from './protocol';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Turn what someone typed or a link carried into a server address (`https://name.workers.dev`),
 * or null if it isn't one we'd connect to. Only https is accepted, except for a server on this
 * machine (development). Anything after the host is dropped.
 */
export function normalizeServer(input: string | null | undefined): string | null {
  const text = (input ?? '').trim();
  if (!text || text.length > 200) return null;
  let url: URL;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
    url = new URL(hasScheme ? text : `https://${text}`);
    // Typed without a scheme, a server on this machine is plain http: there's no certificate to speak https.
    if (!hasScheme && LOCAL_HOSTS.has(url.hostname)) url = new URL(`http://${text}`);
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  // A real name has a dot ("a.workers.dev"): this catches a typo like "https://foo".
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return null;
  return url.origin;
}

/** The part of an address worth showing people: "name.workers.dev". */
export function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/** The link someone opens to join. Everything private is after "#", so it never reaches the web server. */
export function buildJoinLink(pageUrl: string, roomId: string, secret: string, server: string): string {
  return `${pageUrl.split('#')[0]}#/join/${roomId}/${secret}?server=${encodeURIComponent(server)}`;
}

export interface JoinLink {
  roomId: string;
  secret: string;
  /** Null for a link that doesn't say (made before servers were per person). */
  server: string | null;
}

/**
 * Read a join link's address bar part. Null if it isn't a join link at all, 'incomplete' if it
 * is one but something is missing or wrong (a cut-off copy, a bad server address).
 */
export function parseJoinHash(hash: string): JoinLink | 'incomplete' | null {
  if (!hash.startsWith('#/join/')) return null;
  const match = /^#\/join\/([^/?]+)\/([^/?]+)(?:\?(.*))?$/.exec(hash);
  if (!match || !ID_PATTERN.test(match[1]) || !SECRET_PATTERN.test(match[2])) return 'incomplete';
  const given = new URLSearchParams(match[3] ?? '').get('server');
  const server = given === null ? null : normalizeServer(given);
  if (given !== null && !server) return 'incomplete';
  return { roomId: match[1], secret: match[2], server };
}
