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
  notFound,
  payloadTooLarge,
} from "./errors.js";
import { loadRelayIdentity, type RelayIdentity } from "./identity.js";
import { MixNode, type MixPeer } from "./mix.js";
import { PeerDirectory, type RelayAnnouncement } from "./peers.js";
import { SenderQuota } from "./quota.js";
import { SiteDirectory } from "./sites.js";
import {
  CapsuleStorage,
  parseBearerToken,
  parseChunkIndex,
  type CreateCapsuleInput,
} from "./storage.js";
import {
  MixOp,
  PACKET_BYTES,
  nodeIdFor,
  type MixRequest,
  type MixResponse,
} from "@capsule/mixnet";

const RELAY_API_VERSION = 1;
const RELAY_SOFTWARE = "capsule-relay/1.2.0";
const SUPPORTED_PROTOCOL_VERSIONS = [1, 2, 3];
const IP_SALT_ROTATION_MS = 60 * 60_000;
/**
 * Delays for the first gossip attempts. A relay and the peer it was pointed at
 * are often started together, so the first attempt regularly arrives before the
 * peer is listening. Without these retries such a relay would sit alone until
 * the next full interval, which is the difference between joining the network
 * in seconds and joining it in minutes.
 */
const BOOTSTRAP_DELAYS_MS = [0, 1_000, 3_000, 8_000, 20_000, 60_000, 120_000];

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

  const sites = new SiteDirectory({ maxSites: config.maxSites });

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
    ...(config.mixEnabled ? { mixPublicKey: identity.mixPublicKey } : {}),
    mixEnabled: config.mixEnabled,
    limits: limits(),
    defaultTtlSeconds: config.defaultTtlSeconds,
    maxTtlSeconds: config.maxTtlSeconds,
    peerCount: peers.size,
    acceptsAnnouncements: true,
    sitesEnabled: config.sitesEnabled,
    siteCount: sites.size,
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

  // --- `.capsule` sites ------------------------------------------------------

  if (config.sitesEnabled) {
    app.get<{ Querystring: { limit?: string } }>(
      "/v1/sites",
      async (request) => ({
        version: RELAY_API_VERSION,
        records: sites.list(
          Math.min(
            Number.parseInt(request.query.limit ?? "", 10) || 200,
            config.siteGossipLimit,
          ),
        ),
      }),
    );

    app.get<{ Params: { name: string } }>(
      "/v1/sites/:name",
      async (request) => {
        const record = sites.get(request.params.name);
        if (!record) throw notFound();
        return { version: RELAY_API_VERSION, record };
      },
    );

    app.put<{ Params: { name: string } }>(
      "/v1/sites/:name",
      {
        config: {
          rateLimit: {
            max: Math.min(config.createRateLimitMax, 60),
            timeWindow: config.rateLimitWindowMs,
          },
        },
      },
      async (request, reply) => {
        const body = request.body as { name?: unknown } | null;
        if (!body || typeof body !== "object") {
          throw badRequest("invalid_record", "Expected a site record");
        }
        // The name in the path and the name in the record must agree, or a
        // publisher could store a valid record where nobody will look for it.
        if (body.name !== request.params.name.trim().toLowerCase()) {
          throw badRequest(
            "invalid_record",
            "The record does not match the name in the path",
          );
        }
        const outcome = await sites.accept(body);
        if (outcome === "rejected") {
          throw badRequest(
            "invalid_record",
            "The site record could not be verified",
          );
        }
        return reply
          .status(outcome === "stored" ? 202 : 200)
          .send({ version: RELAY_API_VERSION, outcome });
      },
    );
  }

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

  /**
   * Pulls site records from the relays this one knows about.
   *
   * Without this, a `.capsule` name would only resolve at the handful of
   * relays its publisher happened to announce to, and a visitor would have to
   * be told which those were — which is a registry with extra steps. Gossip
   * makes the name resolvable anywhere, and the signature makes it safe to
   * accept a record from a relay nobody trusts.
   */
  const siteFetch =
    runtime.fetchImpl ??
    ((input: string, init?: RequestInit) => fetch(input, init));
  const syncSites = async (): Promise<number> => {
    if (!config.sitesEnabled || config.siteGossipLimit === 0) return 0;
    let stored = 0;
    for (const peer of peers.list()) {
      try {
        const response = await siteFetch(
          `${peer.url}/v1/sites?limit=${config.siteGossipLimit}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (!response.ok) continue;
        const body = (await response.json()) as { records?: unknown[] };
        if (!Array.isArray(body.records)) continue;
        for (const record of body.records.slice(0, config.siteGossipLimit)) {
          if ((await sites.accept(record)) === "stored") stored += 1;
        }
      } catch {
        // A peer that will not answer about sites is not an error worth a log
        // line every five minutes.
      }
    }
    return stored;
  };

  let peerSyncInFlight: Promise<void> | undefined;
  const runPeerSync = (): void => {
    if (peerSyncInFlight) return;
    peerSyncInFlight = peers
      .sync()
      .then(async ({ peers: known, added }) => {
        if (added !== 0)
          app.log.info({ known, added }, "Relay directory updated");
        const records = await syncSites();
        if (records !== 0)
          app.log.info({ records, known: sites.size }, "Site records updated");
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
  let bootstrapKnown = -1;
  /**
   * Keeps gossiping until the directory stops growing, not until it is merely
   * non-empty. Knowing one peer is enough to be *in* the network and not
   * enough to be *useful* in it: a mix that has not heard of the node a packet
   * names has no choice but to drop it, so a partial view is a silent failure
   * for everything routed through this relay.
   */
  const bootstrap = (): void => {
    if (!shouldGossip) return;
    if (bootstrapAttempt >= BOOTSTRAP_DELAYS_MS.length) return;
    if (peers.size > 0 && peers.size === bootstrapKnown) return;
    const wait = BOOTSTRAP_DELAYS_MS[bootstrapAttempt] ?? 0;
    bootstrapAttempt += 1;
    const timer = setTimeout(() => {
      bootstrapTimers.delete(timer);
      bootstrapKnown = peers.size;
      void peers
        .sync()
        .then(() => syncSites())
        .catch((error: unknown) =>
          app.log.warn({ err: error }, "Relay bootstrap attempt failed"),
        )
        .finally(bootstrap);
    }, wait);
    timer.unref();
    bootstrapTimers.add(timer);
  };
  bootstrap();

  // --- The mix network -------------------------------------------------------

  const mixPublicKeyBytes = new Uint8Array(
    Buffer.from(identity.mixPublicKey, "base64url"),
  );
  const selfMixNodeId = nodeIdFor(mixPublicKeyBytes);
  // The public URL is often only known once the server is listening, so it is
  // read when a packet needs routing rather than captured here.
  const selfMixNode = (): MixPeer | undefined =>
    config.publicUrl
      ? {
          nodeId: selfMixNodeId,
          url: config.publicUrl,
          publicKey: mixPublicKeyBytes,
        }
      : undefined;

  /**
   * Runs a capsule operation that arrived through the mix. The relay is the
   * destination, not a proxy: it does exactly what it would do for a direct
   * request, having learned nothing about who asked.
   */
  const executeMixRequest = async (
    request: MixRequest,
  ): Promise<MixResponse> => {
    const asJson = (value: unknown): Uint8Array =>
      new Uint8Array(Buffer.from(JSON.stringify(value), "utf8"));
    try {
      switch (request.op) {
        case MixOp.Create: {
          const body: unknown = JSON.parse(
            Buffer.from(request.data ?? new Uint8Array()).toString("utf8"),
          );
          const created = await storage.create(
            createInputFromBody(body, config.defaultTtlSeconds),
          );
          return { ok: true, data: asJson(created) };
        }
        case MixOp.PutChunk: {
          await storage.putChunk(
            request.capsuleId ?? "",
            request.index ?? 0,
            Buffer.from(request.data ?? new Uint8Array()),
            request.token,
          );
          return { ok: true, data: asJson({ stored: true }) };
        }
        case MixOp.Finalize: {
          const status = await storage.finalize(
            request.capsuleId ?? "",
            request.token,
          );
          return { ok: true, data: asJson(status) };
        }
        case MixOp.Status: {
          const record = await storage.readRecord(request.capsuleId ?? "");
          storage.authorizeStatus(record, request.token);
          storage.assertNotExpired(record);
          return { ok: true, data: asJson(await storage.status(record)) };
        }
        case MixOp.Manifest: {
          const record = await storage.readRecord(request.capsuleId ?? "");
          storage.authorize(record, request.token, "read");
          storage.assertNotExpired(record);
          return {
            ok: true,
            data: new Uint8Array(await storage.manifest(record)),
          };
        }
        case MixOp.GetChunk: {
          const record = await storage.readRecord(request.capsuleId ?? "");
          storage.authorize(record, request.token, "read");
          storage.assertNotExpired(record);
          return {
            ok: true,
            data: new Uint8Array(
              await storage.chunk(record, request.index ?? 0),
            ),
          };
        }
        case MixOp.Delete: {
          await storage.delete(request.capsuleId ?? "", request.token);
          return { ok: true, data: asJson({ deleted: true }) };
        }
        default:
          return {
            ok: false,
            data: asJson({ error: "unsupported operation" }),
          };
      }
    } catch (error) {
      // The same shape a direct caller would get, so the mix path is not a
      // different oracle from the plain one.
      const failure =
        error instanceof RelayHttpError
          ? { error: error.code, message: error.message }
          : { error: "internal_error", message: "Internal relay error" };
      return { ok: false, data: asJson(failure) };
    }
  };

  const mix = new MixNode({
    config,
    identity,
    resolve: (nodeId) => {
      const wanted = Buffer.from(nodeId).toString("hex");
      if (Buffer.from(selfMixNodeId).toString("hex") === wanted) {
        return selfMixNode();
      }
      return peers
        .mixNodes()
        .find((node) => Buffer.from(node.nodeId).toString("hex") === wanted);
    },
    peers: () => peers.mixNodes(),
    execute: executeMixRequest,
    ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
    log: (message, details) => app.log.info(details ?? {}, message),
  });

  if (config.mixEnabled) {
    app.addContentTypeParser(
      "application/capsule-mix",
      { parseAs: "buffer", bodyLimit: PACKET_BYTES + 64 },
      (_request, body, done) => done(null, body),
    );

    const mixRateLimit = {
      config: {
        rateLimit: {
          max: config.mixRateLimitMax,
          timeWindow: config.rateLimitWindowMs,
        },
      },
    };

    app.post("/v1/mix", mixRateLimit, async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        throw badRequest(
          "invalid_mix_packet",
          "A mix packet must use application/capsule-mix",
        );
      }
      // Every answer is the same, whatever happened: a mix that reports why it
      // dropped a packet is an oracle for the packet's contents.
      mix.accept(new Uint8Array(request.body));
      return reply.status(202).send();
    });

    app.get<{ Params: { token: string } }>(
      "/v1/mix/mailbox/:token",
      mixRateLimit,
      async (request, reply) => {
        const bodies = mix.collect(request.params.token);
        return reply.type("application/json").send({
          version: RELAY_API_VERSION,
          messages: bodies.map((body) =>
            Buffer.from(body).toString("base64url"),
          ),
        });
      },
    );

    mix.start();
    app.decorate("capsuleMix", mix);
  }

  app.decorate("capsulePeers", peers);
  app.decorate("capsuleIdentity", identity);
  app.decorate("capsuleStorage", storage);

  app.addHook("onClose", async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (peerTimer) clearInterval(peerTimer);
    if (saltTimer) clearInterval(saltTimer);
    for (const timer of bootstrapTimers) clearTimeout(timer);
    bootstrapTimers.clear();
    peers.close();
    mix.stop();
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
    capsuleMix: MixNode;
  }
}
