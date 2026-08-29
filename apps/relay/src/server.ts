import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { RelayConfig } from "./config.js";
import { RelayHttpError, badRequest, payloadTooLarge } from "./errors.js";
import {
  CapsuleStorage,
  parseBearerToken,
  parseChunkIndex,
  type CreateCapsuleInput,
} from "./storage.js";

interface CapsuleParameters {
  id: string;
}

interface ChunkParameters extends CapsuleParameters {
  index: string;
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
    typeof candidate.expiresInSeconds !== "number"
  ) {
    throw badRequest("invalid_expiry", "expiresInSeconds must be a number");
  }
  return {
    encryptedManifest: candidate.encryptedManifest,
    chunkCount: candidate.chunkCount,
    totalCiphertextBytes: candidate.totalCiphertextBytes,
    expiresInSeconds: candidate.expiresInSeconds ?? defaultTtlSeconds,
  };
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
): Promise<FastifyInstance> {
  const storage = new CapsuleStorage(config);
  await storage.initialize();

  const app = Fastify({
    ...fastifyOptions,
    bodyLimit: Math.max(config.maxManifestBytes * 2, 64 * 1024),
    trustProxy: false,
  });

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

  await app.register(rateLimit, {
    global: true,
    hook: "onRequest",
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    enableDraftSpec: true,
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

  app.get("/v1/config", async () => ({
    version: 1,
    maxCapsuleBytes: config.maxCapsuleBytes,
    maxChunkBytes: config.maxChunkBytes,
    maxManifestBytes: config.maxManifestBytes,
    maxChunkCount: config.maxChunkCount,
    defaultTtlSeconds: config.defaultTtlSeconds,
    maxTtlSeconds: config.maxTtlSeconds,
    limits: {
      maxCapsuleBytes: config.maxCapsuleBytes,
      maxChunkBytes: config.maxChunkBytes,
      maxManifestBytes: config.maxManifestBytes,
      maxChunkCount: config.maxChunkCount,
    },
    ttl: {
      defaultSeconds: config.defaultTtlSeconds,
      maxSeconds: config.maxTtlSeconds,
    },
    rateLimit: {
      max: config.rateLimitMax,
      windowMs: config.rateLimitWindowMs,
      createMax: config.createRateLimitMax,
    },
  }));

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
      const created = await storage.create(input);
      return reply.status(201).send(created);
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

  app.addHook("onClose", async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    await cleanupInFlight;
  });

  return app;
}
