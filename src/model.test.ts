import { describe, expect, it } from 'vitest';
import { sanitizeBoard } from './model';

describe('sanitizeBoard', () => {
  it('preserves valid updatedAt and createdAt numeric timestamps', () => {
    const raw = {
      id: 'old-id',
      name: 'My Board',
      createdAt: 1700000000000,
      updatedAt: 1700000500000,
      background: { color: '#ffffff', pattern: 'none' },
      elements: [],
      assets: {},
      camera: { x: 10, y: 20, zoom: 1.5 },
    };

    const doc = sanitizeBoard(raw);
    expect(doc).not.toBeNull();
    expect(doc?.id).not.toBe('old-id'); // Always gets a fresh id
    expect(doc?.name).toBe('My Board');
    expect(doc?.createdAt).toBe(1700000000000);
    expect(doc?.updatedAt).toBe(1700000500000);
  });

  it('parses string timestamps into numbers', () => {
    const raw = {
      name: 'Dated Board',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T12:00:00.000Z',
    };

    const doc = sanitizeBoard(raw);
    expect(doc).not.toBeNull();
    expect(doc?.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(doc?.updatedAt).toBe(Date.parse('2026-01-02T12:00:00.000Z'));
  });

  it('falls back to createdAt if updatedAt is missing', () => {
    const raw = {
      name: 'Created Only',
      createdAt: 1700000000000,
    };

    const doc = sanitizeBoard(raw);
    expect(doc).not.toBeNull();
    expect(doc?.createdAt).toBe(1700000000000);
    expect(doc?.updatedAt).toBe(1700000000000);
  });

  it('falls back to fallbackTime if both timestamps are missing', () => {
    const raw = {
      name: 'Timeless Board',
    };

    const doc = sanitizeBoard(raw, 1699999999000);
    expect(doc).not.toBeNull();
    expect(doc?.createdAt).toBe(1699999999000);
    expect(doc?.updatedAt).toBe(1699999999000);
  });

  it('returns null for non-object inputs', () => {
    expect(sanitizeBoard(null)).toBeNull();
    expect(sanitizeBoard(undefined)).toBeNull();
    expect(sanitizeBoard('string')).toBeNull();
    expect(sanitizeBoard(42)).toBeNull();
  });
});
