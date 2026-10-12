// Counts how often one network creates rooms, so nobody can flood the server with them.
// One instance per (hashed) address. Counts live in memory only: nothing is stored.
import { DurableObject } from 'cloudflare:workers';

export class Limiter extends DurableObject {
  private hits: number[] = [];

  /** Record one use. False if `max` uses already happened within the last `windowMs`. */
  async allow(max: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < windowMs);
    if (this.hits.length >= max) return false;
    this.hits.push(now);
    return true;
  }
}
