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

export interface SiteDirectoryOptions {
  maxSites: number;
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

  constructor(private readonly options: SiteDirectoryOptions) {
    this.now = options.now ?? (() => Date.now());
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
      receivedAt: this.now(),
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
