import { createHash, randomBytes } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { RelayConfig } from "./config.js";
import {
  RelayHttpError,
  badRequest,
  insufficientStorage,
  payloadTooLarge,
} from "./errors.js";
import { loadRelayIdentity, type RelayIdentity } from "./identity.js";
import { PeerDirectory, type RelayAnnouncement } from "./peers.js";
import { SenderQuota } from "./quota.js";
import {
  CapsuleStorage,
  parseBearerToken,
  parseChunkIndex,
  type CreateCapsuleInput,
} from "./storage.js";

const RELAY_API_VERSION = 1;
const RELAY_SOFTWARE = "capsule-relay/1.0.0";
const SUPPORTED_PROTOCOL_VERSIONS = [1, 2, 3];
const IP_SALT_ROTATION_MS = 60 * 60_000;
/**
 * Delays for the first gossip attempts. A relay and the peer it was pointed at
 * are often started together, so the first attempt regularly arrives before the
 * peer is listening. Without these retries such a relay would sit alone until
 * the next full interval, which is the difference between joining the network
 * in seconds and joining it in minutes.
 */
const BOOTSTRAP_DELAYS_MS = [0, 2_000, 8_000, 30_000, 120_000];

interface CapsuleParameters {
  id: string;
}

interface ChunkParameters extends CapsuleParameters {
  index: string;
}

export interface RelayRuntimeOptions {
  /** Injected for tests so peer gossip can run against in-process relays. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  identity?: RelayIdentity;
}

function createInputFromBody(
  body: unknown,
  defaultTtlSeconds: number,
): CreateCapsuleInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("invalid_request", "Request body must be a JSON object");
  }
  const candidate = body as Record<string, unknown>;
  const allowed = new Set([
    "encryptedManifest",
    "chunkCount",
    "totalCiphertextBytes",
    "expiresInSeconds",
  ]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw badRequest(
      "invalid_request",
      "Request body contains unsupported properties",
    );
  }
  if (typeof candidate.encryptedManifest !== "string") {
    throw badRequest(
      "invalid_manifest",
      "encryptedManifest must be a base64url string",
    );
  }
  if (typeof candidate.chunkCount !== "number") {
    throw badRequest("invalid_chunk_count", "chunkCount must be a number");
  }
  if (typeof candidate.totalCiphertextBytes !== "number") {
    throw badRequest(
      "invalid_total_ciphertext_bytes",
      "totalCiphertextBytes must be a number",
    );
  }
  if (
    candidate.expiresInSeconds !== undefined &&
    candidate.expiresInSeconds !== null &&
    typeof candidate.expiresInSeconds !== "number"
  ) {
    throw badRequest(
      "invalid_expiry",
      "expiresInSeconds must be a number or null",
    );
  }
  return {
    encryptedManifest: candidate.encryptedManifest,
    chunkCount: candidate.chunkCount,
    totalCiphertextBytes: candidate.totalCiphertextBytes,
    expiresInSeconds:
      candidate.expiresInSeconds === undefined
        ? defaultTtlSeconds
        : (candidate.expiresInSeconds as number | null),
  };
}

function announcementFromBody(body: unknown): RelayAnnouncement {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("invalid_request", "Request body must be a JSON object");
  }
  const candidate = body as Record<string, unknown>;
  const required = [
    "url",
    "relayId",
    "publicKey",
    "announcedAt",
    "nonce",
    "signature",
  ];
  for (const field of required) {
    if (typeof candidate[field] !== "string") {
      throw badRequest("invalid_announcement", `${field} must be a string`);
    }
  }
  return {
    url: candidate.url as string,
    relayId: candidate.relayId as string,
    publicKey: candidate.publicKey as string,
    announcedAt: candidate.announcedAt as string,
    nonce: candidate.nonce as string,
    signature: candidate.signature as string,
  };
}

/**
 * Wraps a logger configuration so request logs carry the method and path but
 * never the client address, port or headers.
 */
function blindLogger(
  logger: FastifyServerOptions["logger"],
): FastifyServerOptions["logger"] {
  if (!logger || typeof logger !== "object") return logger;
  const options = logger as Record<string, unknown>;
  return {
    ...options,
    serializers: {
      req: (request: { method?: string; url?: string }) => ({
        method: request.method,
        url: request.url,
      }),
      res: (reply: { statusCode?: number }) => ({
        statusCode: reply.statusCode,
      }),
      ...((options.serializers as Record<string, unknown>) ?? {}),
    },
  } as FastifyServerOptions["logger"];
}

function originMatcher(
  origins: RelayConfig["corsOrigins"],
): (origin: string | undefined) => boolean {
  if (origins === "*") return () => true;
  const allowed = new Set(origins);
  return (origin) => origin === undefined || allowed.has(origin);
}

export async function buildRelayServer(
  config: RelayConfig,
  fastifyOptions: FastifyServerOptions = {},
  runtime: RelayRuntimeOptions = {},
): Promise<FastifyInstance> {
  const storage = new CapsuleStorage(config);
  await storage.initialize();
  const identity =
    runtime.identity ?? (await loadRelayIdentity(config.storageDir));

  // The relay never needs to know who a client is, so the fields that would
  // put an address into a log line are dropped before the logger sees them.
  const logger = config.ipBlind
    ? blindLogger(fastifyOptions.logger)
    : fastifyOptions.logger;
  const app = Fastify({
    ...fastifyOptions,
    ...(logger !== undefined ? { logger } : {}),
    bodyLimit: Math.max(config.maxManifestBytes * 2, 64 * 1024),
    trustProxy: false,
  });

  const peers = new PeerDirectory(config, identity, {
    ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
    log: (message, details) => app.log.info(details ?? {}, message),
  });
  await peers.initialize();

  const isAllowedOrigin = originMatcher(config.corsOrigins);
  await app.register(cors, {
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 86_400,
    strictPreflight: true,
  });

  // Rate limiting needs to tell clients apart without keeping a list of who
  // they are: the address is hashed with a secret that rotates on its own, so
  // the relay can count requests but cannot reconstruct an address later.
  let addressSalt = randomBytes(16);
  const saltTimer = config.ipBlind
    ? setInterval(() => {
        addressSalt = randomBytes(16);
      }, IP_SALT_ROTATION_MS)
    : undefined;
  saltTimer?.unref();
  const blindKey = (request: FastifyRequest): string =>
    createHash("sha256")
      .update(addressSalt)
      .update(request.ip ?? "")
      .digest("base64url");

  await app.register(rateLimit, {
    global: true,
    hook: "onRequest",
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    enableDraftSpec: true,
    ...(config.ipBlind ? { keyGenerator: blindKey } : {}),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "rate_limit_exceeded",
      code: "rate_limit_exceeded",
      message: `Rate limit exceeded; retry in ${context.after}`,
    }),
  });

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: config.maxChunkBytes },
    (_request, body, done) => done(null, body),
  );

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RelayHttpError) {
      if (error.statusCode === 401) {
        reply.header("WWW-Authenticate", 'Bearer realm="capsule-relay"');
      }
      return reply.status(error.statusCode).send({
        error: error.code,
        code: error.code,
        message: error.message,
      });
    }
    // Fastify plugins may throw plain response objects instead of Error instances.
    const normalizedError = error as Error & {
      code?: string;
      statusCode?: number;
    };
    if (normalizedError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      const normalized = payloadTooLarge(
        "Request body exceeds the configured limit",
      );
      return reply.status(normalized.statusCode).send({
        error: normalized.code,
        code: normalized.code,
        message: normalized.message,
      });
    }
    if (
      typeof normalizedError.statusCode === "number" &&
      normalizedError.statusCode >= 400 &&
      normalizedError.statusCode < 500
    ) {
      const isRateLimit =
        normalizedError.statusCode === 429 &&
        normalizedError.code === "rate_limit_exceeded";
      return reply.status(normalizedError.statusCode).send({
        error: isRateLimit ? "rate_limit_exceeded" : "invalid_request",
        code: isRateLimit ? "rate_limit_exceeded" : "invalid_request",
        message:
          normalizedError.message ||
          (isRateLimit ? "Rate limit exceeded" : "Invalid request"),
      });
    }
    app.log.error({ err: error }, "Unhandled relay request error");
    return reply.status(500).send({
      error: "internal_error",
      code: "internal_error",
      message: "Internal relay error",
    });
  });

  app.get("/health", async (_request, reply) => {
    try {
      await storage.checkHealth();
      return { status: "ok", version: 1, timestamp: new Date().toISOString() };
    } catch (error) {
      app.log.error({ err: error }, "Relay storage health check failed");
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  app.get("/healthz", async () => ({
    status: "ok",
    version: 1,
    timestamp: new Date().toISOString(),
  }));

  const limits = () => ({
    maxCapsuleBytes: config.maxCapsuleBytes,
    maxChunkBytes: config.maxChunkBytes,
    maxManifestBytes: config.maxManifestBytes,
    maxChunkCount: config.maxChunkCount,
  });

  app.get("/v1/config", async () => ({
    version: RELAY_API_VERSION,
    protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    maxCapsuleBytes: config.maxCapsuleBytes,
    maxChunkBytes: config.maxChunkBytes,
    maxManifestBytes: config.maxManifestBytes,
    maxChunkCount: config.maxChunkCount,
    defaultTtlSeconds: config.defaultTtlSeconds,
    maxTtlSeconds: config.maxTtlSeconds,
    persistentCapsules: config.allowPersistentCapsules,
    limits: limits(),
    ttl: {
      defaultSeconds: config.defaultTtlSeconds,
      maxSeconds: config.maxTtlSeconds,
      persistentAllowed: config.allowPersistentCapsules,
    },
    rateLimit: {
      max: config.rateLimitMax,
      windowMs: config.rateLimitWindowMs,
      createMax: config.createRateLimitMax,
    },
  }));

  // The identity card of a relay. Anyone can run one: publish this endpoint,
  // point the relay at a peer, and clients discover it through the directory.
  app.get("/v1/info", async () => ({
    version: RELAY_API_VERSION,
    software: RELAY_SOFTWARE,
    protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    relayId: identity.relayId,
    publicKey: identity.publicKey,
    ...(config.publicUrl ? { url: config.publicUrl } : {}),
    ...(config.nickname ? { nickname: config.nickname } : {}),
    persistentCapsules: config.allowPersistentCapsules,
    limits: limits(),
    defaultTtlSeconds: config.defaultTtlSeconds,
    maxTtlSeconds: config.maxTtlSeconds,
    peerCount: peers.size,
    acceptsAnnouncements: true,
  }));

  app.get("/v1/peers", async () => ({
    version: RELAY_API_VERSION,
    self: {
      relayId: identity.relayId,
      publicKey: identity.publicKey,
      ...(config.publicUrl ? { url: config.publicUrl } : {}),
      ...(config.nickname ? { nickname: config.nickname } : {}),
    },
    peers: peers.list(),
  }));

  app.post(
    "/v1/peers/announce",
    {
      config: {
        rateLimit: {
          max: Math.min(config.createRateLimitMax, 60),
          timeWindow: config.rateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      const announcement = announcementFromBody(request.body);
      const accepted = await peers.accept(announcement);
      if (!accepted) {
        throw badRequest(
          "invalid_announcement",
          "The announcement could not be verified",
        );
      }
      return reply.status(202).send({
        version: RELAY_API_VERSION,
        self: {
          relayId: identity.relayId,
          publicKey: identity.publicKey,
          ...(config.publicUrl ? { url: config.publicUrl } : {}),
          ...(config.nickname ? { nickname: config.nickname } : {}),
        },
        peers: peers.list(),
      });
    },
  );

  const persistentQuota = new SenderQuota(config.maxPersistentBytesPerSender);

  app.post(
    "/v1/capsules",
    {
      config: {
        rateLimit: {
          max: config.createRateLimitMax,
          timeWindow: config.rateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      const input = createInputFromBody(request.body, config.defaultTtlSeconds);
      // Storage without expiry is the scarce resource, so it is metered per
      // sender as well as globally.
      const meteredAddress =
        input.expiresInSeconds === null ? (request.ip ?? "") : undefined;
      if (meteredAddress !== undefined) {
        storage.validateCreateInput(input);
        if (
          !persistentQuota.reserve(meteredAddress, input.totalCiphertextBytes)
        ) {
          throw insufficientStorage(
            "This relay limits how much one sender may store without expiry",
          );
        }
      }
      try {
        const created = await storage.create(input);
        return reply.status(201).send(created);
      } catch (error) {
        if (meteredAddress !== undefined) {
          persistentQuota.release(meteredAddress, input.totalCiphertextBytes);
        }
        throw error;
      }
    },
  );

  app.put<{ Params: ChunkParameters }>(
    "/v1/capsules/:id/chunks/:index",
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        throw badRequest(
          "invalid_chunk",
          "Chunk body must use application/octet-stream",
        );
      }
      await storage.putChunk(
        request.params.id,
        parseChunkIndex(request.params.index),
        request.body,
        parseBearerToken(request.headers.authorization),
      );
      return reply.status(204).send();
    },
  );

  app.post<{ Params: CapsuleParameters }>(
    "/v1/capsules/:id/finalize",
    async (request) => {
      return storage.finalize(
        request.params.id,
        parseBearerToken(request.headers.authorization),
      );
    },
  );

  app.get<{ Params: CapsuleParameters }>(
    "/v1/capsules/:id/manifest",
    async (request, reply) => {
      const record = await storage.readRecord(request.params.id);
      storage.authorize(
        record,
        parseBearerToken(request.headers.authorization),
        "read",
      );
      storage.assertNotExpired(record);
      const manifest = await storage.manifest(record);
      return reply.type("application/octet-stream").send(manifest);
    },
  );

  app.get<{ Params: ChunkParameters }>(
    "/v1/capsules/:id/chunks/:index",
    async (request, reply) => {
      const record = await storage.readRecord(request.params.id);
      storage.authorize(
        record,
        parseBearerToken(request.headers.authorization),
        "read",
      );
      storage.assertNotExpired(record);
      const chunk = await storage.chunk(
        record,
        parseChunkIndex(request.params.index),
      );
      return reply.type("application/octet-stream").send(chunk);
    },
  );

  app.get<{ Params: CapsuleParameters }>(
    "/v1/capsules/:id/status",
    async (request) => {
      const record = await storage.readRecord(request.params.id);
      storage.authorizeStatus(
        record,
        parseBearerToken(request.headers.authorization),
      );
      storage.assertNotExpired(record);
      return storage.status(record);
    },
  );

  app.delete<{ Params: CapsuleParameters }>(
    "/v1/capsules/:id",
    async (request, reply) => {
      await storage.delete(
        request.params.id,
        parseBearerToken(request.headers.authorization),
      );
      return reply.status(204).send();
    },
  );

  let cleanupInFlight: Promise<void> | undefined;
  const runCleanup = (): void => {
    if (cleanupInFlight) return;
    cleanupInFlight = storage
      .cleanupExpired()
      .then(({ removed, errors }) => {
        if (removed > 0 || errors > 0)
          app.log.info({ removed, errors }, "Capsule cleanup completed");
      })
      .catch((error: unknown) =>
        app.log.error({ err: error }, "Capsule cleanup failed"),
      )
      .finally(() => {
        cleanupInFlight = undefined;
      });
  };
  const cleanupTimer =
    config.cleanupIntervalMs > 0
      ? setInterval(runCleanup, config.cleanupIntervalMs)
      : undefined;
  cleanupTimer?.unref();

  let peerSyncInFlight: Promise<void> | undefined;
  const runPeerSync = (): void => {
    if (peerSyncInFlight) return;
    peerSyncInFlight = peers
      .sync()
      .then(({ peers: known, added }) => {
        if (added !== 0)
          app.log.info({ known, added }, "Relay directory updated");
      })
      .catch((error: unknown) =>
        app.log.error({ err: error }, "Relay directory sync failed"),
      )
      .finally(() => {
        peerSyncInFlight = undefined;
      });
  };
  const shouldGossip =
    config.peerSyncIntervalMs > 0 &&
    (config.peers.length > 0 || config.publicUrl !== undefined);
  const peerTimer = shouldGossip
    ? setInterval(runPeerSync, config.peerSyncIntervalMs)
    : undefined;
  peerTimer?.unref();

  const bootstrapTimers = new Set<NodeJS.Timeout>();
  let bootstrapAttempt = 0;
  const bootstrap = (): void => {
    if (!shouldGossip) return;
    if (peers.size > 0 || bootstrapAttempt >= BOOTSTRAP_DELAYS_MS.length)
      return;
    const wait = BOOTSTRAP_DELAYS_MS[bootstrapAttempt] ?? 0;
    bootstrapAttempt += 1;
    const timer = setTimeout(() => {
      bootstrapTimers.delete(timer);
      void peers
        .sync()
        .catch((error: unknown) =>
          app.log.warn({ err: error }, "Relay bootstrap attempt failed"),
        )
        .finally(bootstrap);
    }, wait);
    timer.unref();
    bootstrapTimers.add(timer);
  };
  bootstrap();

  app.decorate("capsulePeers", peers);
  app.decorate("capsuleIdentity", identity);
  app.decorate("capsuleStorage", storage);

  app.addHook("onClose", async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (peerTimer) clearInterval(peerTimer);
    if (saltTimer) clearInterval(saltTimer);
    for (const timer of bootstrapTimers) clearTimeout(timer);
    bootstrapTimers.clear();
    await cleanupInFlight;
    await peerSyncInFlight;
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    capsulePeers: PeerDirectory;
    capsuleIdentity: RelayIdentity;
    capsuleStorage: CapsuleStorage;
  }
}
