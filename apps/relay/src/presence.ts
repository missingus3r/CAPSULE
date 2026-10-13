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

import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** How long an address counts as present after its last request. */
export const PRESENCE_WINDOW_MS = 5 * 60_000;

export interface PresenceSnapshot {
  /** Distinct addresses seen in the window. Not people. */
  clients: number;
  /** Highest `clients` this relay has observed. */
  clientsPeak: number;
  relays: number;
  relaysPeak: number;
  windowSeconds: number;
  /** When this relay started counting, so a peak can be read in context. */
  since: string;
}

/**
 * What survives a restart: two peaks and the moment counting began.
 *
 * Three numbers and nothing about anybody. A peak that went back to zero
 * every time the relay was restarted said how long the process had been up,
 * which is not what an operator reading "peak" takes it to mean.
 */
export interface PresenceRecord {
  clientsPeak: number;
  relaysPeak: number;
  since: string;
}

const PRESENCE_FILE = "presence.json";

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Reads the record a previous run left, or nothing if there is none to trust. */
export async function readPresenceRecord(
  storageDir: string,
): Promise<PresenceRecord | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(storageDir, PRESENCE_FILE), "utf8"),
    ) as Partial<PresenceRecord> | null;
    if (
      !parsed ||
      !isCount(parsed.clientsPeak) ||
      !isCount(parsed.relaysPeak) ||
      typeof parsed.since !== "string" ||
      !Number.isFinite(Date.parse(parsed.since))
    ) {
      return undefined;
    }
    return {
      clientsPeak: parsed.clientsPeak,
      relaysPeak: parsed.relaysPeak,
      since: new Date(parsed.since).toISOString(),
    };
  } catch {
    // Missing or unreadable: counting starts over, which costs a peak.
    return undefined;
  }
}

export async function writePresenceRecord(
  storageDir: string,
  record: PresenceRecord,
): Promise<void> {
  const path = join(storageDir, PRESENCE_FILE);
  // Written beside the target and renamed over it, so a relay killed
  // mid-write leaves either the old file or the new one, never half of one.
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("base64url")}`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export class PresenceCounter {
  private readonly seen = new Map<string, number>();
  private clientsPeak = 0;
  private relaysPeak = 0;
  private readonly startedAt: string;
  /** Whether the record differs from what was last handed out to be kept. */
  private unsaved: boolean;

  constructor(
    private readonly windowMs: number = PRESENCE_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
    restored?: PresenceRecord,
  ) {
    this.startedAt = restored?.since ?? new Date(this.now()).toISOString();
    this.clientsPeak = restored?.clientsPeak ?? 0;
    this.relaysPeak = restored?.relaysPeak ?? 0;
    // A relay counting for the first time has a start to remember.
    this.unsaved = restored === undefined;
  }

  /** Records one request from an already-blinded address. */
  see(blindKey: string): void {
    if (!blindKey) return;
    this.seen.set(blindKey, this.now());
    // A peak nobody was watching still happened. The map can only be a new
    // peak when it has outgrown the old one, so that is the only time it is
    // worth pruning here to find out.
    if (this.seen.size > this.clientsPeak) {
      this.prune();
      this.raiseClientsPeak(this.seen.size);
    }
  }

  private raiseClientsPeak(clients: number): void {
    if (clients <= this.clientsPeak) return;
    this.clientsPeak = clients;
    this.unsaved = true;
  }

  /**
   * The record, if it changed since it was last asked for.
   *
   * Asking marks it as kept, so a caller writes once per change rather than
   * once per request.
   */
  takeRecord(): PresenceRecord | undefined {
    if (!this.unsaved) return undefined;
    this.unsaved = false;
    return {
      clientsPeak: this.clientsPeak,
      relaysPeak: this.relaysPeak,
      since: this.startedAt,
    };
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
    this.raiseClientsPeak(clients);
    if (relayCount > this.relaysPeak) {
      this.relaysPeak = relayCount;
      this.unsaved = true;
    }
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
