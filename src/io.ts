// Board files: plain JSON so they are easy to inspect, diff and convert.
import type { BoardDoc } from './types';
import { referencedAssets, sanitizeBoard } from './model';

export const FILE_EXT = '.mh';
export const FILE_ACCEPT = '.mh,.megahard,.json,application/json';

interface BoardFile {
  format: 'megahard-whiteboard';
  version: 1;
  board: BoardDoc;
}

interface BackupFile {
  format: 'megahard-whiteboard-backup';
  version: 1;
  exportedAt: string;
  boards: BoardDoc[];
}

const forExport = (doc: BoardDoc): BoardDoc => ({ ...doc, assets: referencedAssets(doc.elements, doc.assets) });

const compact = (_key: string, value: unknown) =>
  typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 100) / 100 : value;

export function boardFileBlob(doc: BoardDoc): Blob {
  const file: BoardFile = { format: 'megahard-whiteboard', version: 1, board: forExport(doc) };
  return new Blob([JSON.stringify(file, compact)], { type: 'application/json' });
}

export function backupBlob(docs: BoardDoc[]): Blob {
  const file: BackupFile = { format: 'megahard-whiteboard-backup', version: 1, exportedAt: new Date().toISOString(), boards: docs.map(forExport) };
  return new Blob([JSON.stringify(file, compact)], { type: 'application/json' });
}

/** Parse a board file or a backup file. Every board gets a new id. */
export async function parseImport(file: File): Promise<BoardDoc[]> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} is not a Megahard Whiteboard file`);
  }
  const d = data as { format?: string; board?: unknown; boards?: unknown } | null;
  let raws: unknown[] = [];
  if (d?.format === 'megahard-whiteboard') raws = [d.board];
  else if (d?.format === 'megahard-whiteboard-backup' && Array.isArray(d.boards)) raws = d.boards;
  else throw new Error(`${file.name} is not a Megahard Whiteboard file`);
  return raws.map(sanitizeBoard).filter((b): b is BoardDoc => b !== null);
}

/** Save a file, using the native save dialog where the browser supports it. */
export async function saveBlob(blob: Blob, filename: string): Promise<boolean> {
  const w = window as unknown as {
    showSaveFilePicker?: (opts: { suggestedName: string }) => Promise<{
      createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>;
    }>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: filename });
      const stream = await handle.createWritable();
      await stream.write(blob);
      await stream.close();
      return true;
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return false;
      // Fall through to a regular download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
