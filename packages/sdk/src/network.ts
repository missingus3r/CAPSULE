/**
 * Relay network discovery.
 *
 * CAPSULE has no directory server and no registry: a relay is any host that
 * answers `/v1/info`. Operators point their relay at one or more peers they
 * already trust, relays gossip the addresses they know, and clients walk that
 * graph one hop at a time. Nothing here grants a relay authority; a discovered
 * relay is only ever a candidate the client may choose to use.
 */

import {
  RELAY_API_VERSION,
  isPublicRelayOrigin,
  isRelayOrigin,
} from "@capsule/protocol";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface RelayLimits {
  maxCapsuleBytes: number;
  maxChunkBytes: number;
  maxManifestBytes: number;
  maxChunkCount: number;
}

export interface RelayInfo {
  url: string;
  relayId: string;
  publicKey: string;
  /** Curve25519 key this relay uses as a mix node, when it runs one. */
  mixPublicKey?: string;
  nickname?: string;
  software?: string;
  protocolVersions: number[];
  persistentCapsules: boolean;
  limits: RelayLimits;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  peerCount: number;
}

/**
 * A relay to start discovery from. Pinning `relayId` turns trust-on-first-use
 * into a check: if that address ever answers with a different identity, it is
 * discarded instead of quietly replacing the relay you meant.
 */
export type RelaySeed = string | { url: string; relayId?: string };

export interface DiscoverRelaysOptions {
  seeds: RelaySeed[];
  maxRelays?: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Follow relays on loopback and private addresses. Off by default: a relay
   * can put anything in its peer list, and following it into the client's own
   * network is how a relay turns a client into a port scanner. Turn it on only
   * for a local network you already run, which is also the only place a
   * private address can be a real relay.
   */
  allowPrivateRelays?: boolean;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RELAYS = 24;

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof globalThis.fetch !== "function") {
    throw new Error("No fetch implementation is available");
  }
  // Wrapped rather than referenced: the browser's fetch requires the global
  // object as its receiver.
  return (input, init) => globalThis.fetch(input, init);
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("A relay URL must use HTTP or HTTPS");
  }
  return url.origin;
}

function readInteger(value: unknown, minimum = 0): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum
    ? (value as number)
    : undefined;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

export function parseRelayInfo(value: unknown, url: string): RelayInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Relay returned an invalid /v1/info document");
  }
  const info = value as Record<string, unknown>;
  if (info.version !== RELAY_API_VERSION) {
    throw new Error(`Unsupported relay API version ${String(info.version)}`);
  }
  const limits = (info.limits ?? {}) as Record<string, unknown>;
  const maxCapsuleBytes = readInteger(limits.maxCapsuleBytes, 1);
  const maxChunkBytes = readInteger(limits.maxChunkBytes, 17);
  const maxManifestBytes = readInteger(limits.maxManifestBytes, 17);
  const maxChunkCount = readInteger(limits.maxChunkCount, 1);
  const maxTtlSeconds = readInteger(info.maxTtlSeconds, 1);
  const defaultTtlSeconds = readInteger(info.defaultTtlSeconds, 1);
  if (
    typeof info.relayId !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/u.test(info.relayId) ||
    typeof info.publicKey !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(info.publicKey) ||
    maxCapsuleBytes === undefined ||
    maxChunkBytes === undefined ||
    maxManifestBytes === undefined ||
    maxChunkCount === undefined ||
    maxTtlSeconds === undefined ||
    defaultTtlSeconds === undefined
  ) {
    throw new Error("Relay returned an incomplete /v1/info document");
  }

  const protocolVersions = Array.isArray(info.protocolVersions)
    ? info.protocolVersions.filter(
        (entry): entry is number => entry === 1 || entry === 2 || entry === 3,
      )
    : [1];

  // A relay may point at a different address than the one we reached, but only
  // a public one: otherwise any relay could redirect a client at the client's
  // own loopback interface. A relay we reached at a private address is already
  // one the caller chose to talk to, so its own address is kept.
  const declared = typeof info.url === "string" ? info.url : undefined;
  const address =
    declared && (isPublicRelayOrigin(declared) || declared === url)
      ? declared
      : url;

  return {
    url: normalizeOrigin(address),
    relayId: info.relayId,
    publicKey: info.publicKey,
    ...(typeof info.mixPublicKey === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(info.mixPublicKey)
      ? { mixPublicKey: info.mixPublicKey }
      : {}),
    ...(typeof info.nickname === "string" && info.nickname.trim()
      ? { nickname: info.nickname.trim().slice(0, 64) }
      : {}),
    ...(typeof info.software === "string" && info.software.trim()
      ? { software: info.software.trim().slice(0, 64) }
      : {}),
    protocolVersions: protocolVersions.length > 0 ? protocolVersions : [1],
    persistentCapsules: info.persistentCapsules === true,
    limits: {
      maxCapsuleBytes,
      maxChunkBytes,
      maxManifestBytes,
      maxChunkCount,
    },
    defaultTtlSeconds,
    maxTtlSeconds,
    peerCount: readInteger(info.peerCount) ?? 0,
  };
}

export async function fetchRelayInfo(
  relayUrl: string,
  options: {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Reject the relay unless it announces this identity. */
    expectRelayId?: string;
  } = {},
): Promise<RelayInfo> {
  const origin = normalizeOrigin(relayUrl);
  const request = resolveFetch(options.fetchImpl);
  const response = await withTimeout(
    (signal) => request(`${origin}/v1/info`, { signal }),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );
  if (!response.ok) {
    throw new Error(`Relay ${origin} answered ${response.status} on /v1/info`);
  }
  const info = parseRelayInfo(await response.json(), origin);
  if (options.expectRelayId && info.relayId !== options.expectRelayId) {
    throw new Error(
      `Relay ${origin} announced a different identity than the one pinned`,
    );
  }
  return info;
}

export async function fetchRelayPeers(
  relayUrl: string,
  options: {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    timeoutMs?: number;
    allowPrivateRelays?: boolean;
  } = {},
): Promise<string[]> {
  const origin = normalizeOrigin(relayUrl);
  const request = resolveFetch(options.fetchImpl);
  const response = await withTimeout(
    (signal) => request(`${origin}/v1/peers`, { signal }),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { peers?: unknown };
  if (!Array.isArray(body.peers)) return [];
  const urls: string[] = [];
  for (const peer of body.peers) {
    const candidate = (peer as { url?: unknown }).url;
    // A relay's peer list is written entirely by that relay. Following it
    // blindly would let any relay in the graph aim every client at the
    // client's own network.
    if (typeof candidate !== "string") continue;
    if (isPublicRelayOrigin(candidate)) {
      urls.push(candidate);
    } else if (options.allowPrivateRelays && isRelayOrigin(candidate)) {
      urls.push(candidate);
    }
  }
  return urls;
}

/**
 * Walks the relay graph starting from `seeds` and returns the relays that
 * answered. Failures are silent by design: an unreachable relay is a normal
 * state in an open network, not an error the caller must handle.
 */
export async function discoverRelays(
  options: DiscoverRelaysOptions,
): Promise<RelayInfo[]> {
  const maxRelays = options.maxRelays ?? DEFAULT_MAX_RELAYS;
  const queue: string[] = [];
  const queued = new Set<string>();
  const pinned = new Map<string, string>();

  for (const seed of options.seeds) {
    try {
      const url = typeof seed === "string" ? seed : seed.url;
      const origin = normalizeOrigin(url);
      if (typeof seed !== "string" && seed.relayId) {
        pinned.set(origin, seed.relayId);
      }
      if (queued.has(origin)) continue;
      queued.add(origin);
      queue.push(origin);
    } catch {
      // A malformed seed is ignored rather than failing the whole discovery.
    }
  }

  const found = new Map<string, RelayInfo>();
  const shared = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.allowPrivateRelays ? { allowPrivateRelays: true } : {}),
  };

  // One gossip hop past the seeds keeps discovery bounded and predictable.
  for (let hop = 0; hop < 2 && queue.length > 0; hop += 1) {
    const level = queue.splice(0, queue.length);
    const results = await Promise.allSettled(
      level.map(async (origin) => {
        const pin = pinned.get(origin);
        const info = await fetchRelayInfo(origin, {
          ...shared,
          ...(pin ? { expectRelayId: pin } : {}),
        });
        const peers =
          found.size + level.length < maxRelays
            ? await fetchRelayPeers(origin, shared).catch(() => [])
            : [];
        return { info, peers };
      }),
    );

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { info, peers } = result.value;
      if (!found.has(info.relayId) && found.size < maxRelays) {
        found.set(info.relayId, info);
      }
      for (const peer of peers) {
        const origin = normalizeOrigin(peer);
        if (queued.has(origin) || queued.size >= maxRelays * 2) continue;
        queued.add(origin);
        queue.push(origin);
      }
    }
  }

  return [...found.values()];
}

export interface RelaySelectionOptions {
  count: number;
  ciphertextBytes: number;
  chunkCount: number;
  persistent: boolean;
  ttlSeconds?: number;
  exclude?: string[];
  /**
   * Prefer relays that look like they belong to different operators. Two
   * relays under one domain are one operator with two names, and mirroring
   * across them buys availability but no independence.
   */
  preferDiverse?: boolean;
}

/**
 * A coarse grouping of relays that probably share an operator: the last two
 * labels of the hostname, or the address for a bare IP. It is a heuristic, not
 * proof of independence — a determined operator can register two domains.
 */
export function operatorHint(relayUrl: string): string {
  try {
    const host = new URL(relayUrl).hostname.toLowerCase();
    if (/^[0-9.]+$/u.test(host) || host.includes(":")) return host;
    const labels = host.split(".");
    return labels.slice(-2).join(".");
  } catch {
    return relayUrl;
  }
}

/** Picks relays able to accept a capsule, in random order to spread load. */
export function selectRelays(
  relays: RelayInfo[],
  options: RelaySelectionOptions,
): RelayInfo[] {
  const excluded = new Set(options.exclude ?? []);
  const excludedOperators = new Set(
    [...excluded].map((url) => operatorHint(url)),
  );
  const eligible = relays.filter((relay) => {
    if (excluded.has(relay.url)) return false;
    if (options.persistent && !relay.persistentCapsules) return false;
    if (
      options.ttlSeconds !== undefined &&
      options.ttlSeconds > relay.maxTtlSeconds
    ) {
      return false;
    }
    return (
      relay.limits.maxCapsuleBytes >= options.ciphertextBytes &&
      relay.limits.maxChunkCount >= options.chunkCount
    );
  });

  for (let index = eligible.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    const current = eligible[index] as RelayInfo;
    eligible[index] = eligible[swap] as RelayInfo;
    eligible[swap] = current;
  }

  if (options.preferDiverse === false) {
    return eligible.slice(0, Math.max(0, options.count));
  }

  const chosen: RelayInfo[] = [];
  const seenOperators = new Set(excludedOperators);
  const leftovers: RelayInfo[] = [];
  for (const relay of eligible) {
    const hint = operatorHint(relay.url);
    if (seenOperators.has(hint)) {
      leftovers.push(relay);
      continue;
    }
    seenOperators.add(hint);
    chosen.push(relay);
    if (chosen.length >= options.count) return chosen;
  }
  // Only once every distinct operator is used do we fall back to a second
  // relay from an operator already chosen.
  for (const relay of leftovers) {
    if (chosen.length >= options.count) break;
    chosen.push(relay);
  }
  return chosen;
}
