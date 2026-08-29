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
}

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  storageDir: "./data",
  corsOrigin: "http://localhost:5173",
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

function corsOriginsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): "*" | string[] {
  const raw = environment.CAPSULE_CORS_ORIGIN?.trim() || DEFAULTS.corsOrigin;
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

  return {
    host: environment.CAPSULE_HOST?.trim() || DEFAULTS.host,
    port: integerFromEnvironment(environment, "CAPSULE_PORT", DEFAULTS.port, {
      maximum: 65_535,
    }),
    storageDir: resolve(
      environment.CAPSULE_STORAGE_DIR?.trim() || DEFAULTS.storageDir,
    ),
    corsOrigins: corsOriginsFromEnvironment(environment),
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
  };
}
