// Images on shared boards. The board only says which image goes where; the pictures themselves
// travel separately, stored once per room on the server.
import { blobToDataUrl, dataUrlToBlob } from '../storageFormat';
import { sanitizeAssets } from '../model';
import type { El } from '../types';

export interface AssetKeys {
  server: string;
  roomId: string;
  /** Host key, edit secret or view secret. */
  secret: string;
}

export type UploadResult = 'ok' | 'room_full' | 'too_big' | 'rejected' | 'offline';

const base = (keys: AssetKeys) => `${keys.server.replace(/\/$/, '')}/rooms/${encodeURIComponent(keys.roomId)}/assets`;
const auth = (keys: AssetKeys) => ({ Authorization: `Bearer ${keys.secret}` });

/** Upload one image (a data URL). Uploading one that's already there is fine. */
export async function uploadAsset(keys: AssetKeys, id: string, src: string): Promise<UploadResult> {
  try {
    const blob = dataUrlToBlob(src);
    const res = await fetch(`${base(keys)}/${encodeURIComponent(id)}`, {
      method: 'PUT', body: blob, headers: { ...auth(keys), 'Content-Type': blob.type },
    });
    if (res.ok) return 'ok';
    if (res.status === 507) return 'room_full';
    if (res.status === 413) return 'too_big';
    return 'rejected';
  } catch {
    return 'offline';
  }
}

/** Download one image as a data URL, checked like an imported one. Null if it isn't available (yet). */
export async function downloadAsset(keys: AssetKeys, id: string): Promise<string | null> {
  try {
    const res = await fetch(`${base(keys)}/${encodeURIComponent(id)}`, { headers: auth(keys), cache: 'no-store' });
    if (!res.ok) return null;
    const src = await blobToDataUrl(await res.blob());
    return sanitizeAssets({ [id]: src })[id] ?? null;
  } catch {
    return null;
  }
}

/** Ids of the images the room already has, or null if it can't be reached. */
export async function listRoomAssets(keys: AssetKeys): Promise<Set<string> | null> {
  try {
    const res = await fetch(base(keys), { headers: auth(keys), cache: 'no-store' });
    return res.ok ? new Set((await res.json()) as string[]) : null;
  } catch {
    return null;
  }
}

/** Images the board uses but this device doesn't have. */
export function missingAssets(elements: El[], assets: Record<string, string>): string[] {
  const ids = new Set<string>();
  for (const el of elements) if (el.type === 'image' && !assets[el.asset]) ids.add(el.asset);
  return [...ids];
}

/** Upload every image the board uses that the room doesn't have yet. Returns false if any failed. */
export async function uploadMissing(keys: AssetKeys, elements: El[], assets: Record<string, string>): Promise<boolean> {
  const there = await listRoomAssets(keys);
  if (!there) return false;
  let ok = true;
  const used = new Set(elements.flatMap((e) => (e.type === 'image' ? [e.asset] : [])));
  for (const id of used) {
    if (there.has(id) || !assets[id]) continue;
    if ((await uploadAsset(keys, id, assets[id])) !== 'ok') ok = false;
  }
  return ok;
}

/** Download every image the board uses that this device lacks. Returns false if any couldn't be fetched. */
export async function downloadMissing(keys: AssetKeys, elements: El[], assets: Record<string, string>): Promise<boolean> {
  let ok = true;
  for (const id of missingAssets(elements, assets)) {
    const src = await downloadAsset(keys, id);
    if (src) assets[id] = src;
    else ok = false;
  }
  return ok;
}
