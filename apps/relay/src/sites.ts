import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAX_SITE_CAPABILITY_LENGTH,
  parseSiteName,
  verifySiteRecord,
  type CapsuleSiteRecord,
} from "@capsule/protocol";

/**
 * The relay's copy of the `.capsule` name space.
 *
 * A relay stores site records and hands them out. It never learns anything it
 * could use against a publisher or a visitor: the record is public by
 * definition, the capsule behind it is encrypted, and the signature means the
 * relay cannot alter what it stores without the change being detected at the
 * visitor.
 *
 * The one power a relay does have is silence — refusing to answer, or
 * answering with a record it knows is superseded. That is why records carry a
 * sequence number, why clients ask several relays, and why relays gossip
 * records to each other: withholding only works if every relay a visitor asks
 * is in on it.
 */

const SITES_FILE = "sites.json";
const SITES_SCHEMA_VERSION = 1;

function receivedAtOf(entry: unknown): number {
  const value = (entry as StoredSiteRecord)?.receivedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface SiteDirectoryOptions {
  maxSites: number;
  /**
   * Where records are kept so they survive a restart. Without it the
   * directory is memory-only, which is what the tests want and what a relay
   * running with no storage at all would get.
   */
  storageDir?: string;
  log?: (message: string, details?: Record<string, unknown>) => void;
  /** Injected in tests. */
  now?: () => number;
}

export interface StoredSiteRecord {
  record: CapsuleSiteRecord;
  receivedAt: number;
}

export type SiteAcceptance = "stored" | "superseded" | "rejected";

export class SiteDirectory {
  private readonly records = new Map<string, StoredSiteRecord>();
  private readonly now: () => number;
  private readonly path: string | undefined;
  /** A write in flight, and whether another is owed after it. */
  private writing: Promise<void> | undefined;
  private pending = false;

  constructor(private readonly options: SiteDirectoryOptions) {
    this.now = options.now ?? (() => Date.now());
    this.path = options.storageDir
      ? join(options.storageDir, SITES_FILE)
      : undefined;
  }

  /**
   * Reads back what the last run held.
   *
   * Every record is put through the same door it came in by: the name is
   * re-derived from the key, the signature is checked and the age limit
   * applies, so a file somebody edited on disk can no more inject a record
   * than a peer can. Records are restored newest first, which is the order
   * `maxSites` should cut at if the file holds more than this relay now
   * allows.
   */
  async initialize(): Promise<void> {
    if (!this.path) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      // Unreadable records are not fatal the way an unreadable identity is:
      // publishers re-announce and peers gossip, so the directory refills. A
      // relay that refused to start over this would be down for a reason its
      // operator cannot act on.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.report(
          "The stored site records could not be read; starting with none.",
          {
            path: this.path,
            error: String(error),
          },
        );
      }
      return;
    }

    const entries = (parsed as { records?: unknown })?.records;
    if (!Array.isArray(entries)) return;

    let restored = 0;
    let dropped = 0;
    const ordered = [...entries].sort(
      (left, right) => receivedAtOf(right) - receivedAtOf(left),
    );
    for (const entry of ordered) {
      const outcome = await this.take(
        (entry as StoredSiteRecord)?.record,
        Math.min(receivedAtOf(entry) || this.now(), this.now()),
      );
      if (outcome === "stored") restored += 1;
      else dropped += 1;
    }

    this.report("Site records restored", { restored, dropped });
    // Records that no longer verify — expired, or a file that was tampered
    // with — are gone from memory; take them off the disk too.
    if (dropped > 0) this.schedulePersist();
  }

  /** Waits for any write still owed, so a shutdown does not lose one. */
  async flush(): Promise<void> {
    await this.writing;
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * Takes a record if it verifies and is newer than what is held.
   *
   * Nothing here trusts the caller: the name is re-derived, the signature is
   * checked against the key inside the name, and the sequence must move
   * forward. A relay that got this wrong would let anyone replace anyone
   * else's site.
   */
  async accept(body: unknown): Promise<SiteAcceptance> {
    const outcome = await this.take(body, this.now());
    if (outcome === "stored") this.schedulePersist();
    return outcome;
  }

  /** The acceptance rules, shared by a live announcement and a restart. */
  private async take(
    body: unknown,
    receivedAt: number,
  ): Promise<SiteAcceptance> {
    const record = body as CapsuleSiteRecord;
    if (!record || typeof record !== "object") return "rejected";
    if (typeof record.name !== "string") return "rejected";
    if (
      typeof record.capability !== "string" ||
      record.capability.length > MAX_SITE_CAPABILITY_LENGTH
    ) {
      return "rejected";
    }

    const parsed = await parseSiteName(record.name);
    if (!parsed || parsed.name !== record.name) return "rejected";
    if (!(await verifySiteRecord(record, { now: this.now() }))) {
      return "rejected";
    }

    const held = this.records.get(parsed.name);
    if (held && held.record.sequence >= record.sequence) return "superseded";

    if (!held && this.records.size >= this.options.maxSites) {
      if (!this.evictOldest()) return "rejected";
    }
    this.records.set(parsed.name, {
      // Stored field by field so a caller cannot smuggle extra properties
      // through into whatever the relay hands out next.
      record: {
        version: record.version,
        name: record.name,
        sequence: record.sequence,
        publishedAt: record.publishedAt,
        capability: record.capability,
        ...(record.title ? { title: record.title } : {}),
        signature: record.signature,
      },
      receivedAt,
    });
    return "stored";
  }

  get(name: string): CapsuleSiteRecord | undefined {
    return this.records.get(name.trim().toLowerCase())?.record;
  }

  /** Newest first, for gossip and for a relay's own listing. */
  list(limit: number): CapsuleSiteRecord[] {
    return [...this.records.values()]
      .sort((left, right) => right.receivedAt - left.receivedAt)
      .slice(0, Math.max(0, limit))
      .map((entry) => entry.record);
  }

  /**
   * Asks for a write, and coalesces the ones asked for while it runs.
   *
   * A gossip round accepts records in a burst; writing the file once per
   * record would make the burst quadratic for no gain, and the file is only
   * ever read at startup. Callers do not wait for the disk — an announcement
   * is answered as soon as the record is held, and `flush` is what a shutdown
   * waits on.
   */
  private schedulePersist(): void {
    if (!this.path) return;
    this.pending = true;
    if (this.writing) return;
    this.writing = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        this.pending = false;
        await this.write();
      }
    } catch (error) {
      // Losing the file costs a restart's worth of records, not correctness,
      // so this is said out loud and the relay keeps serving from memory.
      this.report(
        "Could not write the site records; they will not survive a restart.",
        {
          path: this.path,
          error: String(error),
        },
      );
    } finally {
      this.writing = undefined;
    }
  }

  private async write(): Promise<void> {
    const path = this.path;
    if (!path) return;
    const payload = {
      schemaVersion: SITES_SCHEMA_VERSION,
      records: [...this.records.values()],
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Written beside the target and renamed over it, so a relay killed
    // mid-write leaves either the old file or the new one, never half of one.
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("base64url")}`;
    await writeFile(
      temporary,
      `${JSON.stringify(payload)}
`,
      { mode: 0o600 },
    );
    await rename(temporary, path);
  }

  private report(message: string, details?: Record<string, unknown>): void {
    this.options.log?.(message, details);
  }

  private evictOldest(): boolean {
    let oldestName: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [name, entry] of this.records) {
      if (entry.receivedAt < oldestAt) {
        oldestAt = entry.receivedAt;
        oldestName = name;
      }
    }
    if (!oldestName) return false;
    this.records.delete(oldestName);
    return true;
  }
}
