import { DEFAULT_SEEDS, parseSeedRefs } from "@capsule/protocol";
import type { RelayInfo, RelaySeed } from "@capsule/sdk";

/**
 * Where this browser starts looking, and why it prefers not to.
 *
 * A seed that ships with the software is believed before anything else a fresh
 * install sees, which makes it the most valuable address in the network to
 * impersonate. Two things keep that in check and neither is optional.
 *
 * **It is pinned.** A seed carries the identifier its relay must prove it
 * holds, and the proof is a signature over a challenge generated a moment ago
 * rather than an identifier repeated back. Nothing is believed on the strength
 * of a URL.
 *
 * **It is only for the first time.** Relays learned on one visit are kept, and
 * tried before the seed on the next. A default seed should be how a browser
 * finds the network once, not a party it depends on for good — an address that
 * everybody keeps asking is an address worth seizing.
 */

const CACHE_KEY = "capsule.relays";
const MAX_CACHED = 20;
/** Old enough that the network has probably moved on. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedRelays {
  savedAt: number;
  relays: Array<{ url: string; relayId: string }>;
}

/** Relays this browser reached before, newest run first. */
export function cachedSeeds(): RelaySeed[] {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CachedRelays;
    if (!Array.isArray(parsed?.relays)) return [];
    if (Date.now() - (parsed.savedAt ?? 0) > CACHE_TTL_MS) return [];
    return (
      parsed.relays
        .filter(
          (relay) =>
            typeof relay?.url === "string" &&
            typeof relay?.relayId === "string",
        )
        .slice(0, MAX_CACHED)
        // Pinned to what they announced last time, so a relay that changed hands
        // between visits is refused rather than followed.
        .map((relay) => ({ url: relay.url, relayId: relay.relayId }))
    );
  } catch {
    return [];
  }
}

/** Remembers what discovery found, so the seed is not needed again. */
export function rememberRelays(relays: readonly RelayInfo[]): void {
  if (relays.length === 0) return;
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        relays: relays
          .slice(0, MAX_CACHED)
          .map((relay) => ({ url: relay.url, relayId: relay.relayId })),
      } satisfies CachedRelays),
    );
  } catch {
    // Storage can be denied. Discovery still worked; only the shortcut is lost.
  }
}

/**
 * Everything worth asking, in the order worth asking it.
 *
 * The relay this app is configured to store on comes first because it is the
 * one somebody chose. Then relays remembered from earlier visits, then the
 * seeds that shipped — last, so a default is a fallback rather than a habit.
 */
export function discoverySeeds(relayUrl: string): RelaySeed[] {
  const seeds: RelaySeed[] = [relayUrl];
  const seen = new Set([relayUrl]);
  for (const seed of [...cachedSeeds(), ...parseSeedRefs(DEFAULT_SEEDS)]) {
    const url = typeof seed === "string" ? seed : seed.url;
    if (seen.has(url)) continue;
    seen.add(url);
    seeds.push(seed);
  }
  return seeds;
}
