import { describe, expect, it } from 'vitest';
import { isNewerVersion, parseSemver } from './version';

describe('parseSemver', () => {
  it('parses valid versions', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
    expect(parseSemver('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseSemver('v0.1.0')).toEqual([0, 1, 0]);
    expect(parseSemver('2.0')).toEqual([2, 0, 0]);
  });

  it('rejects invalid versions', () => {
    expect(parseSemver('invalid')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('detects newer versions correctly', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('v0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false);
  });
});
