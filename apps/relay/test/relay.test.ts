import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../src/config.js";
import { buildRelayServer } from "../src/server.js";

interface CreatedCapsule {
  capsuleId: string;
  readToken: string;
  writeToken: string;
  deleteToken: string;
  expiresAt: string | null;
}

let app: FastifyInstance | undefined;
let storageDirectory = "";

beforeEach(async () => {
  storageDirectory = await mkdtemp(join(tmpdir(), "capsule-relay-test-"));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(storageDirectory, { recursive: true, force: true });
});

function testConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    storageDir: storageDirectory,
    corsOrigins: ["https://capsule.test"],
    maxCapsuleBytes: 128,
    maxChunkBytes: 32,
    maxManifestBytes: 64,
    maxChunkCount: 8,
    defaultTtlSeconds: 60,
    maxTtlSeconds: 3_600,
    cleanupIntervalMs: 0,
    rateLimitMax: 1_000,
    rateLimitWindowMs: 60_000,
    createRateLimitMax: 100,
    publicUrl: undefined,
    nickname: undefined,
    peers: [],
    maxPeers: 50,
    peerSyncIntervalMs: 0,
    allowPrivatePeers: true,
    allowPersistentCapsules: false,
    maxPersistentBytes: 1024,
    maxPersistentBytesPerSender: 1024 * 1024 * 1024,
    announceWorkBits: 0,
    maxPeersPerOperator: 8,
    ipBlind: true,
    mixEnabled: true,
    mixMaxQueued: 256,
    mixMaxDelayMs: 5_000,
    mixMeanDelayMs: 0,
    mixReplayWindowMs: 60_000,
    mixMailboxDepth: 64,
    mixMailboxTtlMs: 60_000,
    mixSendTimeoutMs: 5_000,
    mixCoverIntervalMs: 0,
    mixPathLength: 3,
    mixRateLimitMax: 100_000,
    ...overrides,
  };
}

async function createCapsule(
  server: FastifyInstance,
  overrides: Record<string, unknown> = {},
): Promise<CreatedCapsule> {
  const response = await server.inject({
    method: "POST",
    url: "/v1/capsules",
    payload: {
      encryptedManifest: Buffer.from("sealed metadata").toString("base64url"),
      chunkCount: 2,
      totalCiphertextBytes: 33,
      expiresInSeconds: 60,
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<CreatedCapsule>();
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("CAPSULE relay API", () => {
  it("stores capabilities as hashes and completes the full lifecycle", async () => {
    app = await buildRelayServer(testConfig());
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", version: 1 });

    const created = await createCapsule(app);
    expect(created.capsuleId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(created.readToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.writeToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.deleteToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const storedRecord = await readFile(
      join(storageDirectory, "capsules", created.capsuleId, "record.json"),
      "utf8",
    );
    expect(storedRecord).not.toContain(created.readToken);
    expect(storedRecord).not.toContain(created.writeToken);
    expect(storedRecord).not.toContain(created.deleteToken);
    const parsedRecord = JSON.parse(storedRecord) as {
      tokenHashes: Record<string, string>;
    };
    expect(Object.values(parsedRecord.tokenHashes)).toHaveLength(3);
    for (const hash of Object.values(parsedRecord.tokenHashes)) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    }

    const unauthorizedStatus = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/status`,
      headers: bearer("not-the-token"),
    });
    expect(unauthorizedStatus.statusCode).toBe(404);
    expect(unauthorizedStatus.json()).toMatchObject({
      code: "capsule_not_found",
    });

    const status = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/status`,
      headers: bearer(created.readToken),
    });
    expect(status.json()).toMatchObject({
      capsuleId: created.capsuleId,
      state: "uploading",
      chunkCount: 2,
      uploadedChunks: 0,
      totalCiphertextBytes: 33,
      uploadedCiphertextBytes: 0,
      finalized: false,
      receivedChunks: [],
    });

    const earlyManifest = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/manifest`,
      headers: bearer(created.readToken),
    });
    expect(earlyManifest.statusCode).toBe(409);
    expect(earlyManifest.json()).toMatchObject({
      code: "capsule_not_finalized",
    });

    const firstChunk = Buffer.alloc(16, 1);
    const firstUpload = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/0`,
      headers: {
        ...bearer(created.writeToken),
        "content-type": "application/octet-stream",
      },
      payload: firstChunk,
    });
    expect(firstUpload.statusCode).toBe(204);

    const duplicate = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/0`,
      headers: {
        ...bearer(created.writeToken),
        "content-type": "application/octet-stream",
      },
      payload: firstChunk,
    });
    expect(duplicate.statusCode).toBe(204);

    const conflictingDuplicate = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/0`,
      headers: {
        ...bearer(created.writeToken),
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(16, 9),
    });
    expect(conflictingDuplicate.statusCode).toBe(409);
    expect(conflictingDuplicate.json()).toMatchObject({
      code: "chunk_mismatch",
    });

    const incomplete = await app.inject({
      method: "POST",
      url: `/v1/capsules/${created.capsuleId}/finalize`,
      headers: bearer(created.writeToken),
    });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json()).toMatchObject({ code: "capsule_incomplete" });

    const secondChunk = Buffer.alloc(17, 5);
    const secondUpload = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/1`,
      headers: {
        ...bearer(created.writeToken),
        "content-type": "application/octet-stream",
      },
      payload: secondChunk,
    });
    expect(secondUpload.statusCode).toBe(204);

    const finalized = await app.inject({
      method: "POST",
      url: `/v1/capsules/${created.capsuleId}/finalize`,
      headers: bearer(created.writeToken),
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json()).toMatchObject({
      state: "ready",
      uploadedChunks: 2,
      uploadedCiphertextBytes: 33,
      finalized: true,
      receivedChunks: [0, 1],
    });

    const finalizedAgain = await app.inject({
      method: "POST",
      url: `/v1/capsules/${created.capsuleId}/finalize`,
      headers: bearer(created.writeToken),
    });
    expect(finalizedAgain.statusCode).toBe(200);
    expect(finalizedAgain.json()).toMatchObject({
      state: "ready",
      uploadedChunks: 2,
    });

    const manifest = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/manifest`,
      headers: bearer(created.readToken),
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["content-type"]).toContain(
      "application/octet-stream",
    );
    expect(manifest.rawPayload).toEqual(Buffer.from("sealed metadata"));

    const downloadedChunk = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/chunks/1`,
      headers: bearer(created.readToken),
    });
    expect(downloadedChunk.rawPayload).toEqual(secondChunk);

    const uploadAfterFinalize = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/1`,
      headers: {
        ...bearer(created.writeToken),
        "content-type": "application/octet-stream",
      },
      payload: secondChunk,
    });
    expect(uploadAfterFinalize.statusCode).toBe(409);
    expect(uploadAfterFinalize.json()).toMatchObject({
      code: "capsule_finalized",
    });

    const invalidDelete = await app.inject({
      method: "DELETE",
      url: `/v1/capsules/${created.capsuleId}`,
      headers: bearer(created.readToken),
    });
    expect(invalidDelete.statusCode).toBe(204);

    const stillPresent = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/status`,
      headers: bearer(created.readToken),
    });
    expect(stillPresent.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/capsules/${created.capsuleId}`,
      headers: bearer(created.deleteToken),
    });
    expect(deleted.statusCode).toBe(204);

    const deletedAgain = await app.inject({
      method: "DELETE",
      url: `/v1/capsules/${created.capsuleId}`,
      headers: bearer(created.deleteToken),
    });
    expect(deletedAgain.statusCode).toBe(204);

    const missing = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/status`,
      headers: bearer(created.readToken),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects invalid declarations, indices, media types and oversized chunks", async () => {
    app = await buildRelayServer(testConfig({ maxChunkBytes: 16 }));

    const invalidManifest = await app.inject({
      method: "POST",
      url: "/v1/capsules",
      payload: {
        encryptedManifest: "not+base64url",
        chunkCount: 1,
        totalCiphertextBytes: 16,
        expiresInSeconds: 60,
      },
    });
    expect(invalidManifest.statusCode).toBe(400);

    const inconsistent = await app.inject({
      method: "POST",
      url: "/v1/capsules",
      payload: {
        encryptedManifest: Buffer.from("m").toString("base64url"),
        chunkCount: 0,
        totalCiphertextBytes: 1,
        expiresInSeconds: 60,
      },
    });
    expect(inconsistent.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: "POST",
      url: "/v1/capsules",
      payload: {
        encryptedManifest: Buffer.from("m").toString("base64url"),
        chunkCount: 1,
        totalCiphertextBytes: 1,
        expiresInSeconds: 3_601,
      },
    });
    expect(tooLong.statusCode).toBe(400);

    const created = await createCapsule(app, {
      chunkCount: 1,
      totalCiphertextBytes: 16,
    });
    const badIndex = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/01`,
      headers: {
        ...bearer(created.writeToken),
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from([1]),
    });
    expect(badIndex.statusCode).toBe(400);

    const wrongMediaType = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/0`,
      headers: { ...bearer(created.writeToken), "content-type": "text/plain" },
      payload: "0123456789abcdef",
    });
    expect(wrongMediaType.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/0`,
      headers: {
        ...bearer(created.writeToken),
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(17, 1),
    });
    expect(oversized.statusCode).toBe(413);

    const undersized = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/0`,
      headers: {
        ...bearer(created.writeToken),
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(15, 1),
    });
    expect(undersized.statusCode).toBe(400);
    expect(undersized.json()).toMatchObject({ code: "invalid_chunk_size" });
  });

  it("makes concurrent byte-identical duplicate uploads idempotent", async () => {
    app = await buildRelayServer(testConfig());
    const created = await createCapsule(app, {
      chunkCount: 1,
      totalCiphertextBytes: 16,
    });
    const request = () =>
      app!.inject({
        method: "PUT",
        url: `/v1/capsules/${created.capsuleId}/chunks/0`,
        headers: {
          ...bearer(created.writeToken),
          "content-type": "application/octet-stream",
        },
        payload: Buffer.alloc(16, 1),
      });

    const results = await Promise.all([request(), request()]);
    expect(results.map((result) => result.statusCode)).toEqual([204, 204]);
  });

  it("persists uploads across a relay restart", async () => {
    app = await buildRelayServer(testConfig());
    const created = await createCapsule(app, {
      chunkCount: 1,
      totalCiphertextBytes: 16,
    });
    await app.inject({
      method: "PUT",
      url: `/v1/capsules/${created.capsuleId}/chunks/0`,
      headers: {
        ...bearer(created.writeToken),
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(16, 1),
    });
    await app.close();

    app = await buildRelayServer(testConfig());
    const status = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/status`,
      headers: bearer(created.writeToken),
    });
    expect(status.json()).toMatchObject({
      state: "uploading",
      uploadedChunks: 1,
      uploadedCiphertextBytes: 16,
    });
  });

  it("rejects expired capsules and removes them during startup cleanup", async () => {
    app = await buildRelayServer(testConfig());
    const created = await createCapsule(app, { expiresInSeconds: 1 });
    const expiredForDelete = await createCapsule(app, { expiresInSeconds: 1 });

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const expired = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/status`,
      headers: bearer(created.readToken),
    });
    expect(expired.statusCode).toBe(404);
    expect(expired.json()).toMatchObject({ code: "capsule_not_found" });

    const expiredDelete = await app.inject({
      method: "DELETE",
      url: `/v1/capsules/${expiredForDelete.capsuleId}`,
      headers: bearer(expiredForDelete.readToken),
    });
    expect(expiredDelete.statusCode).toBe(204);

    const expiredDeleteAgain = await app.inject({
      method: "DELETE",
      url: `/v1/capsules/${expiredForDelete.capsuleId}`,
      headers: bearer(expiredForDelete.deleteToken),
    });
    expect(expiredDeleteAgain.statusCode).toBe(204);

    await app.close();
    app = await buildRelayServer(testConfig());
    const cleaned = await app.inject({
      method: "GET",
      url: `/v1/capsules/${created.capsuleId}/status`,
      headers: bearer(created.readToken),
    });
    expect(cleaned.statusCode).toBe(404);
  });

  it("supports empty finalized capsules and applies CORS only to configured origins", async () => {
    app = await buildRelayServer(testConfig());
    const publicConfig = await app.inject({ method: "GET", url: "/v1/config" });
    expect(publicConfig.statusCode).toBe(200);
    expect(publicConfig.json()).toMatchObject({
      version: 1,
      maxCapsuleBytes: 128,
      maxChunkBytes: 32,
      defaultTtlSeconds: 60,
      maxTtlSeconds: 3_600,
      limits: { maxChunkCount: 8 },
      ttl: { defaultSeconds: 60, maxSeconds: 3_600 },
      rateLimit: { max: 1_000, windowMs: 60_000, createMax: 100 },
    });
    const created = await createCapsule(app, {
      chunkCount: 0,
      totalCiphertextBytes: 0,
    });
    const finalized = await app.inject({
      method: "POST",
      url: `/v1/capsules/${created.capsuleId}/finalize`,
      headers: bearer(created.writeToken),
    });
    expect(finalized.json()).toMatchObject({
      state: "ready",
      uploadedChunks: 0,
    });

    const allowed = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://capsule.test" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://capsule.test",
    );

    const denied = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.test" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate-limits capsule creation before accepting more payloads", async () => {
    app = await buildRelayServer(
      testConfig({
        rateLimitMax: 10,
        createRateLimitMax: 1,
        rateLimitWindowMs: 60_000,
      }),
    );
    await createCapsule(app);

    const limited = await app.inject({
      method: "POST",
      url: "/v1/capsules",
      payload: {
        encryptedManifest:
          Buffer.from("another manifest").toString("base64url"),
        chunkCount: 0,
        totalCiphertextBytes: 0,
        expiresInSeconds: 60,
      },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "rate_limit_exceeded" });
  });
});
