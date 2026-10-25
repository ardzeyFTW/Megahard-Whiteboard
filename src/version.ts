export const APP_VERSION = '0.1.3';
export const GITHUB_REPO = 'ardzeyFTW/Megahard-Whiteboard';
export const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  url: string;
  name?: string;
  publishedAt?: string;
  body?: string;
}

/** Parses "v1.2.3" or "1.2.3" into [major, minor, patch] numbers. */
export function parseSemver(v: string): [number, number, number] | null {
  const clean = v.replace(/^v/i, '').trim();
  const parts = clean.split('.').map((p) => parseInt(p, 10));
  if (parts.length >= 2 && parts.every((n) => !isNaN(n))) {
    return [parts[0], parts[1], parts[2] ?? 0];
  }
  return null;
}

/** Returns true if remote is strictly newer than local. */
export function isNewerVersion(remote: string, local: string = APP_VERSION): boolean {
  const r = parseSemver(remote);
  const l = parseSemver(local);
  if (!r || !l) return false;
  if (r[0] !== l[0]) return r[0] > l[0];
  if (r[1] !== l[1]) return r[1] > l[1];
  return r[2] > l[2];
}

const CACHE_KEY = 'megahard:update_check';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function checkUpdate(force = false): Promise<UpdateInfo | null> {
  try {
    if (!force) {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { time: number; data: UpdateInfo };
        if (Date.now() - parsed.time < CACHE_TTL_MS) {
          return parsed.data;
        }
      }
    }

    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const tag = (data.tag_name ?? '') as string;
    const cleanTag = tag.replace(/^v/i, '');
    const available = isNewerVersion(cleanTag, APP_VERSION);

    const info: UpdateInfo = {
      available,
      currentVersion: APP_VERSION,
      latestVersion: cleanTag || APP_VERSION,
      url: data.html_url || RELEASES_PAGE,
      name: data.name,
      publishedAt: data.published_at,
      body: data.body,
    };

    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), data: info }));
    } catch {
      // sessionStorage might fail in private browsing
    }

    return info;
  } catch {
    return null;
  }
}

/** Whether the app is running in the dedicated desktop Electron app. */
export const isElectron = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);

export function getInstallerUrl(version = APP_VERSION): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/Megahard-Whiteboard-Setup-${version}.exe`;
}
