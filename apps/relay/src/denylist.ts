import { readFile, stat } from "node:fs/promises";

/**
 * The content one operator has decided not to carry.
 *
 * A relay cannot moderate by inspection: a private capsule is ciphertext and
 * the key never came near it. What an operator can do is refuse a name or an
 * identifier they have been given a reason to refuse, and the only hard part
 * is making that refusal *stick*. Deleting a directory does not: gossip hands
 * the record back on the next round and the replicator fetches the bytes
 * again. A relay whose only working answer to a complaint is `systemctl stop`
 * takes every other capsule down with it, so the coarse tool is the one that
 * actually gets used. This is the fine one.
 *
 * Three things it deliberately is not:
 *
 * - **Not shared.** No relay can tell another what to refuse. There is no
 *   signature on this file and no endpoint that writes to it. What one relay
 *   drops stays reachable at every relay that kept it, which is the whole
 *   difference between an exit policy and a blocklist.
 * - **Not a lie.** A denied capsule answers exactly like one that was never
 *   here: the same 404 as a wrong identifier or an expired capsule. An
 *   operator's refusal is theirs to publish, not something the protocol
 *   announces on their behalf.
 * - **Not automatic.** Nothing adds entries but the operator, editing a file.
 *
 * The file is re-read when it changes, so an entry takes effect without a
 * restart — a relay that had to be bounced to answer a complaint would be a
 * relay that drops everyone's traffic to answer one.
 */

export interface DenylistOptions {
  /** Absolute path to the file. Without it, nothing is ever denied. */
  path: string | undefined;
  /** How often the file is checked for changes. Zero disables re-reading. */
  reloadIntervalMs?: number;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

export interface DenialEntry {
  /** A capsule identifier, or a `.capsule` name. */
  value: string;
  /** The operator's own note. Never served to anyone. */
  reason?: string;
}

interface DenylistFile {
  capsules?: unknown;
  sites?: unknown;
}

/** Accepts `"abc"` and `{ "id": "abc", "reason": "..." }` alike. */
function entryOf(raw: unknown, key: "id" | "name"): DenialEntry | undefined {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value ? { value } : undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  const value =
    typeof candidate[key] === "string" ? (candidate[key] as string).trim() : "";
  if (!value) return undefined;
  const reason =
    typeof candidate.reason === "string" ? candidate.reason.trim() : "";
  return reason ? { value, reason } : { value };
}

export class Denylist {
  private capsules = new Map<string, DenialEntry>();
  private sites = new Map<string, DenialEntry>();
  private signature: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Called after a reload that changed something, so copies can be purged. */
  private onChange: (() => void) | undefined;

  constructor(private readonly options: DenylistOptions) {}

  get size(): number {
    return this.capsules.size + this.sites.size;
  }

  get capsuleCount(): number {
    return this.capsules.size;
  }

  get siteCount(): number {
    return this.sites.size;
  }

  deniesCapsule(capsuleId: string): boolean {
    return this.capsules.has(capsuleId);
  }

  /** Denied capsule identifiers, so the operator's copies can be removed. */
  capsuleIds(): string[] {
    return [...this.capsules.keys()];
  }

  deniesSite(name: string): boolean {
    return this.sites.has(name.trim().toLowerCase());
  }

  /** Reads the file once and starts watching it, if there is one. */
  async initialize(onChange?: () => void): Promise<void> {
    this.onChange = onChange;
    await this.reload();
    const interval = this.options.reloadIntervalMs ?? 0;
    if (!this.options.path || interval <= 0) return;
    this.timer = setInterval(() => {
      void this.reload().then((changed) => {
        if (changed) this.onChange?.();
      });
    }, interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Re-reads the file if it looks different, and says whether anything moved.
   *
   * An unreadable or malformed file leaves the previous entries in place
   * rather than clearing them. The failure mode of a bad edit should be "the
   * new entry did not take", never "everything you had refused is being
   * served again".
   */
  async reload(): Promise<boolean> {
    const path = this.options.path;
    if (!path) return false;

    let signature: string;
    try {
      const details = await stat(path);
      signature = `${details.mtimeMs}:${details.size}`;
    } catch {
      // No file is the ordinary case: most relays deny nothing.
      const had = this.size;
      this.signature = undefined;
      this.capsules = new Map();
      this.sites = new Map();
      return had > 0;
    }
    if (signature === this.signature) return false;

    let parsed: DenylistFile;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as DenylistFile;
    } catch (error) {
      this.report("The denylist could not be read; keeping the entries held.", {
        path,
        error: String(error),
      });
      return false;
    }

    const capsules = new Map<string, DenialEntry>();
    for (const raw of Array.isArray(parsed?.capsules) ? parsed.capsules : []) {
      const entry = entryOf(raw, "id");
      if (entry) capsules.set(entry.value, entry);
    }
    const sites = new Map<string, DenialEntry>();
    for (const raw of Array.isArray(parsed?.sites) ? parsed.sites : []) {
      const entry = entryOf(raw, "name");
      if (entry) sites.set(entry.value.toLowerCase(), entry);
    }

    const changed =
      capsules.size !== this.capsules.size ||
      sites.size !== this.sites.size ||
      [...capsules.keys()].some((id) => !this.capsules.has(id)) ||
      [...sites.keys()].some((name) => !this.sites.has(name));

    this.capsules = capsules;
    this.sites = sites;
    this.signature = signature;
    if (changed) {
      this.report("Denylist loaded", {
        path,
        capsules: capsules.size,
        sites: sites.size,
      });
    }
    return changed;
  }

  private report(message: string, details?: Record<string, unknown>): void {
    this.options.log?.(message, details);
  }
}
