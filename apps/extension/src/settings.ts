/**
 * What the extension remembers, and deliberately what it does not.
 *
 * It keeps the relays to ask, the highest sequence number seen for each name —
 * without which a relay could quietly serve an old version of a site forever —
 * and the names the visitor has allowed to run scripts. It keeps no history,
 * no per-visit record and nothing that survives without being asked for.
 */

export const DEFAULT_RELAYS: string[] = ["http://localhost:8787"];

export interface Settings {
  relays: string[];
  /** Highest sequence seen per `.capsule` name. Rollback protection. */
  pins: Record<string, number>;
  /** Names allowed to run scripts, one explicit decision at a time. */
  scriptSites: string[];
  /**
   * Route through the mix network when enough relays are reachable.
   *
   * On by default. Reading a site otherwise tells the relay holding it which
   * name an address asked for, which is the one thing a reader most wants
   * kept apart from who they are. It costs seconds per page, and it falls
   * back to a direct request — visibly — when there are not enough relays to
   * lay a path through.
   */
  mix: boolean;
}

const DEFAULTS: Settings = {
  relays: DEFAULT_RELAYS,
  pins: {},
  scriptSites: [],
  mix: true,
};

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return {
    relays: Array.isArray(stored.relays)
      ? (stored.relays as string[])
      : DEFAULTS.relays,
    pins:
      stored.pins && typeof stored.pins === "object"
        ? (stored.pins as Record<string, number>)
        : {},
    scriptSites: Array.isArray(stored.scriptSites)
      ? (stored.scriptSites as string[])
      : [],
    mix: typeof stored.mix === "boolean" ? stored.mix : DEFAULTS.mix,
  };
}

export async function writeSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Turns relay URLs into the host permission patterns Chrome wants. */
export function originsOf(relays: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const relay of relays) {
    try {
      const url = new URL(relay);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      origins.add(`${url.protocol}//${url.host}/*`);
    } catch {
      // A relay that is not a URL cannot be asked for anything anyway.
    }
  }
  return [...origins];
}

/** Accepts only an origin: no path, no query, no credentials. */
export function normalizeRelayUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
