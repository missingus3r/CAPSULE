import { resolve } from "node:path";

export interface RelayConfig {
  host: string;
  port: number;
  storageDir: string;
  corsOrigins: "*" | string[];
  maxCapsuleBytes: number;
  maxChunkBytes: number;
  maxManifestBytes: number;
  maxChunkCount: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  cleanupIntervalMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  createRateLimitMax: number;
  /** Public origin other relays and clients can reach; enables announcing. */
  publicUrl: string | undefined;
  /** Optional human-readable label shown in the relay directory. */
  nickname: string | undefined;
  /** Relays used to bootstrap into the network. */
  peers: string[];
  maxPeers: number;
  peerSyncIntervalMs: number;
  /** Allows peers on loopback/private addresses; needed for local networks. */
  allowPrivatePeers: boolean;
  /** Accepts capsules without expiry when the operator opts in. */
  allowPersistentCapsules: boolean;
  /** Ceiling for the ciphertext this relay stores without expiry. */
  maxPersistentBytes: number;
  /** Ceiling for one sender's share of the storage without expiry. */
  maxPersistentBytesPerSender: number;
  /** Leading zero bits an announcement digest must have to be accepted. */
  announceWorkBits: number;
  /** Relays kept per apparent operator, so one domain cannot fill the list. */
  maxPeersPerOperator: number;
  /**
   * Runs as a bridge: unlisted, reachable only with the bridge line, and
   * indistinguishable from an ordinary web server to anyone without it.
   */
  bridgeMode: boolean;
  /** base64url 32 bytes. Generated and persisted when bridge mode is on. */
  bridgeKey: string | undefined;
  /** File served to everyone who is not an authenticated client. */
  bridgeDecoyFile: string | undefined;
  /**
   * Announces this relay on the local network so a client with no internet,
   * no DNS and no seed list can still find it. Off by default: a beacon tells
   * everyone on the wire that CAPSULE is running here.
   */
  lanBeacon: boolean;
  /** Serves and gossips `.capsule` site records. */
  sitesEnabled: boolean;
  /** Site records held before the oldest is dropped. */
  maxSites: number;
  /** Records pulled from one peer per gossip round. */
  siteGossipLimit: number;
  /** Keeps raw client addresses out of logs and rate-limit state. */
  ipBlind: boolean;
  /** Acts as a node in the mix network. */
  mixEnabled: boolean;
  /** Packets this node may be holding at once before it refuses more. */
  mixMaxQueued: number;
  /** Ceiling for the delay a sender may ask a node to wait. */
  mixMaxDelayMs: number;
  /** Mean of the exponential delay this node picks for its own cover traffic. */
  mixMeanDelayMs: number;
  /** How long a packet identifier is remembered so it cannot be replayed. */
  mixReplayWindowMs: number;
  mixMailboxDepth: number;
  mixMailboxTtlMs: number;
  mixSendTimeoutMs: number;
  /** How often this node sends a packet to itself. Zero turns cover off. */
  mixCoverIntervalMs: number;
  /** Hops in a path this node builds for its own loops. */
  mixPathLength: number;
  /**
   * Requests per window allowed on the mix endpoints.
   *
   * Mix traffic is nothing like API traffic: relays forward for each other
   * continuously and clients poll a mailbox while they wait. Counting it
   * against the ordinary limit starves the network at exactly the moment it is
   * working. What bounds the mix is `mixMaxQueued`, not this.
   */
  mixRateLimitMax: number;
}

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  storageDir: "./data",
  // Every spelling of "this machine" on the dev server port. `localhost` and
  // `127.0.0.1` are the same host but different origins to a browser, and a
  // developer who types one instead of the other gets a failure the browser
  // deliberately reports as an unhelpful network error.
  corsOrigin: "http://localhost:5173,http://127.0.0.1:5173,http://[::1]:5173",
  maxCapsuleBytes: 100 * 1024 * 1024,
  maxChunkBytes: 1024 * 1024 + 24,
  maxManifestBytes: 256 * 1024,
  maxChunkCount: 10_000,
  defaultTtlSeconds: 24 * 60 * 60,
  maxTtlSeconds: 7 * 24 * 60 * 60,
  cleanupIntervalMs: 60_000,
  rateLimitMax: 300,
  rateLimitWindowMs: 60_000,
  createRateLimitMax: 30,
  maxPeers: 200,
  peerSyncIntervalMs: 5 * 60_000,
  maxPersistentBytes: 1024 * 1024 * 1024,
  announceWorkBits: 18,
  maxPeersPerOperator: 4,
  maxSites: 5_000,
  siteGossipLimit: 200,
  mixMaxQueued: 2048,
  mixMaxDelayMs: 5 * 60_000,
  mixMeanDelayMs: 5_000,
  mixReplayWindowMs: 60 * 60_000,
  mixMailboxDepth: 256,
  mixMailboxTtlMs: 60 * 60_000,
  mixSendTimeoutMs: 15_000,
  mixCoverIntervalMs: 30_000,
  mixPathLength: 3,
  mixRateLimitMax: 12_000,
} as const;

function integerFromEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: { minimum?: number; maximum?: number } = {},
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function booleanFromEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean value`);
}

function originFromEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const raw = environment[name]?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials`);
  }
  return url.origin;
}

function peersFromEnvironment(environment: NodeJS.ProcessEnv): string[] {
  const raw = environment.CAPSULE_PEERS?.trim();
  if (!raw) return [];
  const peers: string[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Invalid peer relay: ${value}`);
    }
    if (!peers.includes(url.origin)) peers.push(url.origin);
  }
  return peers;
}

function corsOriginsFromEnvironment(
  environment: NodeJS.ProcessEnv,
  isPublic: boolean,
): "*" | string[] {
  // A relay meant to be reachable by anyone has to answer browsers it has
  // never heard of. Capabilities are bearer tokens sent explicitly, never
  // cookies, so a permissive CORS policy grants no ambient authority.
  const fallback = isPublic ? "*" : DEFAULTS.corsOrigin;
  const raw = environment.CAPSULE_CORS_ORIGIN?.trim() || fallback;
  if (raw === "*") return "*";

  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0)
    throw new Error("CAPSULE_CORS_ORIGIN must contain at least one origin");
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== origin
    ) {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
  }
  return origins;
}

export function loadRelayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RelayConfig {
  const maxTtlSeconds = integerFromEnvironment(
    environment,
    "CAPSULE_MAX_TTL_SECONDS",
    DEFAULTS.maxTtlSeconds,
  );
  const defaultTtlSeconds = integerFromEnvironment(
    environment,
    "CAPSULE_DEFAULT_TTL_SECONDS",
    Math.min(DEFAULTS.defaultTtlSeconds, maxTtlSeconds),
    { maximum: maxTtlSeconds },
  );

  const rateLimitMax = integerFromEnvironment(
    environment,
    "CAPSULE_RATE_LIMIT_MAX",
    DEFAULTS.rateLimitMax,
  );

  const nickname = environment.CAPSULE_RELAY_NAME?.trim().slice(0, 64);
  const publicUrl = originFromEnvironment(environment, "CAPSULE_PUBLIC_URL");
  const maxPersistentBytes = integerFromEnvironment(
    environment,
    "CAPSULE_MAX_PERSISTENT_BYTES",
    DEFAULTS.maxPersistentBytes,
    { minimum: 0 },
  );

  return {
    host: environment.CAPSULE_HOST?.trim() || DEFAULTS.host,
    port: integerFromEnvironment(environment, "CAPSULE_PORT", DEFAULTS.port, {
      maximum: 65_535,
      minimum: 0,
    }),
    storageDir: resolve(
      environment.CAPSULE_STORAGE_DIR?.trim() || DEFAULTS.storageDir,
    ),
    corsOrigins: corsOriginsFromEnvironment(
      environment,
      publicUrl !== undefined,
    ),
    maxCapsuleBytes: integerFromEnvironment(
      environment,
      "CAPSULE_MAX_CAPSULE_BYTES",
      DEFAULTS.maxCapsuleBytes,
    ),
    maxChunkBytes: integerFromEnvironment(
      environment,
      "CAPSULE_MAX_CHUNK_BYTES",
      DEFAULTS.maxChunkBytes,
      { minimum: 16 },
    ),
    maxManifestBytes: integerFromEnvironment(
      environment,
      "CAPSULE_MAX_MANIFEST_BYTES",
      DEFAULTS.maxManifestBytes,
    ),
    maxChunkCount: integerFromEnvironment(
      environment,
      "CAPSULE_MAX_CHUNK_COUNT",
      DEFAULTS.maxChunkCount,
    ),
    defaultTtlSeconds,
    maxTtlSeconds,
    cleanupIntervalMs: integerFromEnvironment(
      environment,
      "CAPSULE_CLEANUP_INTERVAL_MS",
      DEFAULTS.cleanupIntervalMs,
      { minimum: 0 },
    ),
    rateLimitMax,
    rateLimitWindowMs: integerFromEnvironment(
      environment,
      "CAPSULE_RATE_LIMIT_WINDOW_MS",
      DEFAULTS.rateLimitWindowMs,
    ),
    createRateLimitMax: integerFromEnvironment(
      environment,
      "CAPSULE_CREATE_RATE_LIMIT_MAX",
      Math.min(DEFAULTS.createRateLimitMax, rateLimitMax),
      { maximum: rateLimitMax },
    ),
    publicUrl,
    nickname: nickname || undefined,
    peers: peersFromEnvironment(environment),
    maxPeers: integerFromEnvironment(
      environment,
      "CAPSULE_MAX_PEERS",
      DEFAULTS.maxPeers,
    ),
    peerSyncIntervalMs: integerFromEnvironment(
      environment,
      "CAPSULE_PEER_SYNC_INTERVAL_MS",
      DEFAULTS.peerSyncIntervalMs,
      { minimum: 0 },
    ),
    allowPrivatePeers: booleanFromEnvironment(
      environment,
      "CAPSULE_ALLOW_PRIVATE_PEERS",
      false,
    ),
    lanBeacon: booleanFromEnvironment(environment, "CAPSULE_LAN", false),
    bridgeMode: booleanFromEnvironment(environment, "CAPSULE_BRIDGE", false),
    bridgeKey: (environment.CAPSULE_BRIDGE_KEY ?? "").trim() || undefined,
    bridgeDecoyFile:
      (environment.CAPSULE_BRIDGE_DECOY ?? "").trim() || undefined,
    sitesEnabled: booleanFromEnvironment(
      environment,
      "CAPSULE_SITES_ENABLED",
      true,
    ),
    maxSites: integerFromEnvironment(
      environment,
      "CAPSULE_MAX_SITES",
      DEFAULTS.maxSites,
      { minimum: 0 },
    ),
    siteGossipLimit: integerFromEnvironment(
      environment,
      "CAPSULE_SITE_GOSSIP_LIMIT",
      DEFAULTS.siteGossipLimit,
      { minimum: 0, maximum: 1000 },
    ),
    allowPersistentCapsules: booleanFromEnvironment(
      environment,
      "CAPSULE_ALLOW_PERSISTENT_CAPSULES",
      false,
    ),
    maxPersistentBytes,
    maxPersistentBytesPerSender: integerFromEnvironment(
      environment,
      "CAPSULE_MAX_PERSISTENT_BYTES_PER_SENDER",
      Math.max(1, Math.floor(maxPersistentBytes / 8)),
      { minimum: 0, maximum: Math.max(1, maxPersistentBytes) },
    ),
    announceWorkBits: integerFromEnvironment(
      environment,
      "CAPSULE_ANNOUNCE_POW_BITS",
      DEFAULTS.announceWorkBits,
      { minimum: 0, maximum: 28 },
    ),
    maxPeersPerOperator: integerFromEnvironment(
      environment,
      "CAPSULE_MAX_PEERS_PER_OPERATOR",
      DEFAULTS.maxPeersPerOperator,
    ),
    ipBlind: booleanFromEnvironment(environment, "CAPSULE_IP_BLIND", true),
    mixEnabled: booleanFromEnvironment(
      environment,
      "CAPSULE_MIX_ENABLED",
      true,
    ),
    mixMaxQueued: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_MAX_QUEUED",
      DEFAULTS.mixMaxQueued,
    ),
    mixMaxDelayMs: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_MAX_DELAY_MS",
      DEFAULTS.mixMaxDelayMs,
      { minimum: 0 },
    ),
    mixMeanDelayMs: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_MEAN_DELAY_MS",
      DEFAULTS.mixMeanDelayMs,
      { minimum: 0 },
    ),
    mixReplayWindowMs: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_REPLAY_WINDOW_MS",
      DEFAULTS.mixReplayWindowMs,
    ),
    mixMailboxDepth: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_MAILBOX_DEPTH",
      DEFAULTS.mixMailboxDepth,
    ),
    mixMailboxTtlMs: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_MAILBOX_TTL_MS",
      DEFAULTS.mixMailboxTtlMs,
    ),
    mixSendTimeoutMs: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_SEND_TIMEOUT_MS",
      DEFAULTS.mixSendTimeoutMs,
    ),
    mixCoverIntervalMs: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_COVER_INTERVAL_MS",
      DEFAULTS.mixCoverIntervalMs,
      { minimum: 0 },
    ),
    mixPathLength: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_PATH_LENGTH",
      DEFAULTS.mixPathLength,
      { minimum: 1, maximum: 5 },
    ),
    mixRateLimitMax: integerFromEnvironment(
      environment,
      "CAPSULE_MIX_RATE_LIMIT_MAX",
      DEFAULTS.mixRateLimitMax,
    ),
  };
}
