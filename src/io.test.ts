import { describe, expect, it } from 'vitest';
import { boardFileBlob, backupBlob, parseImport } from './io';
import type { BoardDoc } from './types';

function makeTestDoc(id: string, name: string, updatedAt: number, createdAt = updatedAt - 1000): BoardDoc {
  return {
    version: 1,
    id,
    name,
    createdAt,
    updatedAt,
    background: { color: '#ffffff', pattern: 'none' },
    elements: [],
    assets: {},
    camera: { x: 0, y: 0, zoom: 1 },
  };
}

describe('io import and export', () => {
  it('exports single board file and imports with timestamps intact', async () => {
    const original = makeTestDoc('b1', 'Test Board 1', 1710000500000, 1710000000000);
    const blob = boardFileBlob(original);
    const text = await blob.text();
    const file = new File([text], 'test.mh', { type: 'application/json', lastModified: 1710000999000 });

    const imported = await parseImport(file);
    expect(imported).toHaveLength(1);
    expect(imported[0].name).toBe('Test Board 1');
    expect(imported[0].createdAt).toBe(1710000000000);
    expect(imported[0].updatedAt).toBe(1710000500000);
    expect(imported[0].id).not.toBe('b1');
  });

  it('exports backup file and imports multiple boards preserving individual timestamps and order', async () => {
    const docs = [
      makeTestDoc('b3', 'Recent Board', 1720000300000),
      makeTestDoc('b2', 'Middle Board', 1720000200000),
      makeTestDoc('b1', 'Oldest Board', 1720000100000),
    ];
    const blob = backupBlob(docs);
    const text = await blob.text();
    const file = new File([text], 'backup.mh', { type: 'application/json' });

    const imported = await parseImport(file);
    expect(imported).toHaveLength(3);
    expect(imported[0].name).toBe('Recent Board');
    expect(imported[0].updatedAt).toBe(1720000300000);

    expect(imported[1].name).toBe('Middle Board');
    expect(imported[1].updatedAt).toBe(1720000200000);

    expect(imported[2].name).toBe('Oldest Board');
    expect(imported[2].updatedAt).toBe(1720000100000);
  });

  it('falls back to file.lastModified when imported single board lacks timestamps', async () => {
    const fileContent = JSON.stringify({
      format: 'megahard-whiteboard',
      version: 1,
      board: {
        name: 'Legacy Board',
        background: { color: '#ffffff', pattern: 'none' },
        elements: [],
        assets: {},
      },
    });
    const file = new File([fileContent], 'legacy.mh', {
      type: 'application/json',
      lastModified: 1690000000000,
    });

    const imported = await parseImport(file);
    expect(imported).toHaveLength(1);
    expect(imported[0].name).toBe('Legacy Board');
    expect(imported[0].updatedAt).toBe(1690000000000);
    expect(imported[0].createdAt).toBe(1690000000000);
  });
});
