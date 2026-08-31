/**
 * How many are here right now, without learning who any of them are.
 *
 * This sits awkwardly beside the rest of the project on purpose, so the limits
 * are worth stating before the code.
 *
 * CAPSULE has no accounts and keeps no counters about people, and
 * `capsule network` says plainly that the anonymity set cannot be measured
 * because there is nobody to count. That has not changed. What this counts is
 * **addresses that made a request recently**, which is not the same thing as
 * people: one person behind a phone and a laptop is two, a household behind
 * one router is one, and anybody routing through the mix network is counted as
 * the relay that forwarded for them rather than as themselves.
 *
 * It holds the same thing the rate limiter already holds and nothing more: a
 * salted digest of the address, with the salt rotating on the relay's own
 * schedule. When the salt rotates the old digests stop meaning anything, so a
 * digest cannot be followed from one window into the next, and nothing here
 * can be turned back into an address.
 */

/** How long an address counts as present after its last request. */
export const PRESENCE_WINDOW_MS = 5 * 60_000;

export interface PresenceSnapshot {
  /** Distinct addresses seen in the window. Not people. */
  clients: number;
  /** Highest `clients` this process has observed. */
  clientsPeak: number;
  relays: number;
  relaysPeak: number;
  windowSeconds: number;
  /** When this relay started counting, so a peak can be read in context. */
  since: string;
}

export class PresenceCounter {
  private readonly seen = new Map<string, number>();
  private clientsPeak = 0;
  private relaysPeak = 0;
  private readonly startedAt: string;

  constructor(
    private readonly windowMs: number = PRESENCE_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = new Date(this.now()).toISOString();
  }

  /** Records one request from an already-blinded address. */
  see(blindKey: string): void {
    if (!blindKey) return;
    this.seen.set(blindKey, this.now());
  }

  /**
   * Drops what has gone quiet.
   *
   * Called on every read rather than on a timer: a relay nobody is asking has
   * nothing to prune, and one that is busy prunes as a side effect of being
   * busy. It also means the map cannot outlive the traffic that filled it.
   */
  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, at] of this.seen) {
      if (at < cutoff) this.seen.delete(key);
    }
  }

  snapshot(relayCount: number): PresenceSnapshot {
    this.prune();
    const clients = this.seen.size;
    if (clients > this.clientsPeak) this.clientsPeak = clients;
    if (relayCount > this.relaysPeak) this.relaysPeak = relayCount;
    return {
      clients,
      clientsPeak: this.clientsPeak,
      relays: relayCount,
      relaysPeak: this.relaysPeak,
      windowSeconds: Math.round(this.windowMs / 1000),
      since: this.startedAt,
    };
  }
}
