import { describe, expect, it } from 'vitest';
import { sortRecent } from './db';

describe('sortRecent', () => {
  it('sorts by updatedAt descending', () => {
    const items = [
      { name: 'Older', updatedAt: 100, createdAt: 100 },
      { name: 'Newer', updatedAt: 200, createdAt: 100 },
    ];
    sortRecent(items);
    expect(items.map((i) => i.name)).toEqual(['Newer', 'Older']);
  });

  it('breaks ties using createdAt descending', () => {
    const items = [
      { name: 'Created Earlier', updatedAt: 200, createdAt: 100 },
      { name: 'Created Later', updatedAt: 200, createdAt: 150 },
    ];
    sortRecent(items);
    expect(items.map((i) => i.name)).toEqual(['Created Later', 'Created Earlier']);
  });

  it('breaks remaining ties alphabetically by name', () => {
    const items = [
      { name: 'Board B', updatedAt: 200, createdAt: 100 },
      { name: 'Board A', updatedAt: 200, createdAt: 100 },
    ];
    sortRecent(items);
    expect(items.map((i) => i.name)).toEqual(['Board A', 'Board B']);
  });
});
