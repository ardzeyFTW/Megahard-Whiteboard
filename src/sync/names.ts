// Display names for people on a shared board.
import { readPrefs, writePrefs } from '../prefs';
import { MAX_NAME } from './protocol';

const ADJECTIVES = ['Blue', 'Quick', 'Sunny', 'Brave', 'Calm', 'Clever', 'Gentle', 'Happy', 'Lucky', 'Merry', 'Swift', 'Witty', 'Bold', 'Cosy', 'Jolly', 'Mellow'];
const ANIMALS = ['Otter', 'Fox', 'Panda', 'Koala', 'Owl', 'Penguin', 'Dolphin', 'Hedgehog', 'Lynx', 'Badger', 'Falcon', 'Turtle', 'Rabbit', 'Heron', 'Moose', 'Seal'];

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** A friendly random name, like "Blue Otter". */
export const randomName = () => `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;

export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** The name this person used last time, if any. */
export function savedName(): string {
  const n = readPrefs().displayName;
  return typeof n === 'string' ? cleanName(n) : '';
}

export function rememberName(name: string) {
  writePrefs({ displayName: cleanName(name) });
}
