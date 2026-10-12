import { describe, expect, it } from 'vitest';
import { buildJoinLink, normalizeServer, parseJoinHash, serverHost } from './serverAddress';

const ROOM = 'A'.repeat(22);
const SECRET = 'b'.repeat(32);

describe('normalizeServer', () => {
  it('accepts a workers.dev address, with or without https and trailing bits', () => {
    expect(normalizeServer('https://megahard-collab.alex.workers.dev')).toBe('https://megahard-collab.alex.workers.dev');
    expect(normalizeServer('megahard-collab.alex.workers.dev')).toBe('https://megahard-collab.alex.workers.dev');
    expect(normalizeServer('  https://Megahard-Collab.Alex.workers.dev/  ')).toBe('https://megahard-collab.alex.workers.dev');
    expect(normalizeServer('https://megahard-collab.alex.workers.dev/rooms?x=1#y')).toBe('https://megahard-collab.alex.workers.dev');
  });

  it('keeps a custom domain and a port', () => {
    expect(normalizeServer('https://share.example.org')).toBe('https://share.example.org');
    expect(normalizeServer('https://share.example.org:8443/')).toBe('https://share.example.org:8443');
  });

  it('allows plain http only for a server on this machine', () => {
    expect(normalizeServer('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeServer('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(normalizeServer('http://share.example.org')).toBeNull();
    expect(normalizeServer('ws://localhost:8787')).toBeNull();
    // Typed without a scheme, a local server is assumed to be plain http.
    expect(normalizeServer('127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(normalizeServer('localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeServer('https://localhost:8787')).toBe('https://localhost:8787');
  });

  it('refuses things that are not a server address', () => {
    for (const bad of ['', '   ', 'https://foo', 'not a url', 'javascript:alert(1)', 'https://user:pw@a.workers.dev', 'https://', 'x'.repeat(300)]) {
      expect(normalizeServer(bad)).toBeNull();
    }
    expect(normalizeServer(null)).toBeNull();
    expect(normalizeServer(undefined)).toBeNull();
  });
});

describe('join links', () => {
  const server = 'https://megahard-collab.alex.workers.dev';

  it('carry the server, and read back the same', () => {
    const link = buildJoinLink('https://ardzeyftw.github.io/Megahard-Whiteboard/app/#/board/123', ROOM, SECRET, server);
    expect(link.startsWith('https://ardzeyftw.github.io/Megahard-Whiteboard/app/#/join/')).toBe(true);
    const hash = link.slice(link.indexOf('#'));
    expect(parseJoinHash(hash)).toEqual({ roomId: ROOM, secret: SECRET, server });
  });

  it('keeps the address after "#", so it is never sent to the website', () => {
    const link = buildJoinLink('https://example.org/app/', ROOM, SECRET, server);
    expect(link.split('#')[0]).toBe('https://example.org/app/');
  });

  it('still reads links without a server (made before servers were per person)', () => {
    expect(parseJoinHash(`#/join/${ROOM}/${SECRET}`)).toEqual({ roomId: ROOM, secret: SECRET, server: null });
  });

  it('says a link is incomplete when something is cut off or wrong, and ignores other pages', () => {
    expect(parseJoinHash(`#/join/${ROOM}`)).toBe('incomplete');
    expect(parseJoinHash(`#/join/${ROOM}/short`)).toBe('incomplete');
    expect(parseJoinHash(`#/join/${ROOM}/${SECRET}?server=nonsense`)).toBe('incomplete');
    expect(parseJoinHash(`#/join/${ROOM}/${SECRET}?server=${encodeURIComponent('http://evil.example.org')}`)).toBe('incomplete');
    expect(parseJoinHash('#/board/abc')).toBeNull();
    expect(parseJoinHash('')).toBeNull();
  });
});

describe('serverHost', () => {
  it('shows just the host', () => {
    expect(serverHost('https://megahard-collab.alex.workers.dev')).toBe('megahard-collab.alex.workers.dev');
    expect(serverHost('http://localhost:8787')).toBe('localhost:8787');
  });
});
