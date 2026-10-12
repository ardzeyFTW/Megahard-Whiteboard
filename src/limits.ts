// Limits for the browser version, so boards never grow past what the browser will reliably keep.
import { listBoards, storageInfo } from './db';

const MB = 1024 * 1024;

export const LIMITS = {
  /** Most boards kept in this browser. */
  maxBoards: 50,
  /** Total space for all boards (lowered automatically if the browser offers less). */
  storage: 500 * MB,
  /** Most space a single board may use. */
  perBoard: 50 * MB,
  /** Show a warning at this share of a limit. */
  warnAt: 0.8,
};

export interface Usage {
  boards: number;
  bytes: number;
  budget: number;
}

export async function getUsage(): Promise<Usage> {
  const [metas, info] = await Promise.all([listBoards(), storageInfo()]);
  // Never plan on more than half of what the browser says it can store for this site.
  const budget = info.quota ? Math.min(LIMITS.storage, Math.floor(info.quota * 0.5)) : LIMITS.storage;
  return { boards: metas.length, bytes: metas.reduce((sum, m) => sum + (m.size ?? 0), 0), budget };
}
