import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../src/config.js";
import { buildRelayServer } from "../src/server.js";

/**
 * The relay's HTTP surface is reachable by anyone. These runs throw malformed
 * and hostile bodies at it and assert one property: it answers with a status
 * in the 4xx range and a machine-readable code, never a 500 and never a
 * process that stops answering.
 *
 * A 500 here means an unhandled path — the kind of bug that turns a stray
 * request into a denial of service for everyone else using the relay.
 */

let app: FastifyInstance | undefined;
let storageDirectory = "";

function testConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    storageDir: storageDirectory,
    corsOrigins: "*",
    maxCapsuleBytes: 4096,
    maxChunkBytes: 128,
    maxManifestBytes: 256,
    maxChunkCount: 16,
    defaultTtlSeconds: 60,
    maxTtlSeconds: 3_600,
    cleanupIntervalMs: 0,
    rateLimitMax: 100_000,
    rateLimitWindowMs: 60_000,
    createRateLimitMax: 100_000,
    publicUrl: undefined,
    nickname: undefined,
    peers: [],
    maxPeers: 20,
    peerSyncIntervalMs: 0,
    allowPrivatePeers: true,
    allowPersistentCapsules: true,
    maxPersistentBytes: 4096,
    maxPersistentBytesPerSender: 4096,
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

beforeEach(async () => {
  storageDirectory = await mkdtemp(join(tmpdir(), "capsule-fuzz-"));
  app = await buildRelayServer(testConfig(), { logger: false });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(storageDirectory, { recursive: true, force: true });
});

function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const HOSTILE_VALUES: unknown[] = [
  undefined,
  null,
  -1,
  0,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
  "",
  "not-base64!",
  "A".repeat(5000),
  [],
  {},
  { toString: "not a function" },
];

function pick(random: () => number, values: unknown[]): unknown {
  return values[Math.floor(random() * values.length)];
}

describe("relay request fuzzing", () => {
  it("answers every malformed reservation with a client error", async () => {
    const server = app as FastifyInstance;
    for (let seed = 1; seed <= 250; seed += 1) {
      const random = makeRandom(seed * 2654435761);
      const payload: Record<string, unknown> = {
        encryptedManifest: pick(random, [
          ...HOSTILE_VALUES,
          Buffer.from("ok").toString("base64url"),
        ]),
        chunkCount: pick(random, HOSTILE_VALUES),
        totalCiphertextBytes: pick(random, HOSTILE_VALUES),
        expiresInSeconds: pick(random, [...HOSTILE_VALUES, 60]),
      };
      if (random() < 0.2) delete payload.chunkCount;
      if (random() < 0.15) payload[`extra${seed}`] = "unexpected";

      const response = await server.inject({
        method: "POST",
        url: "/v1/capsules",
        payload,
      });
      expect(
        response.statusCode,
        `seed ${seed} produced ${response.statusCode}: ${response.body}`,
      ).toBeLessThan(500);
      expect(typeof response.json().code).toBe("string");
    }
  });

  it("answers every malformed announcement with a client error", async () => {
    const server = app as FastifyInstance;
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = makeRandom(seed * 40_503);
      const response = await server.inject({
        method: "POST",
        url: "/v1/peers/announce",
        payload: {
          url: pick(random, [...HOSTILE_VALUES, "https://relay.example"]),
          relayId: pick(random, HOSTILE_VALUES),
          publicKey: pick(random, HOSTILE_VALUES),
          announcedAt: pick(random, [
            ...HOSTILE_VALUES,
            new Date().toISOString(),
          ]),
          nonce: pick(random, HOSTILE_VALUES),
          signature: pick(random, HOSTILE_VALUES),
        },
      });
      expect(
        response.statusCode,
        `seed ${seed} produced ${response.statusCode}`,
      ).toBeLessThan(500);
      expect(server.capsulePeers.size).toBe(0);
    }
  });

  it("rejects hostile chunk indices and capsule identifiers", async () => {
    const server = app as FastifyInstance;
    const identifiers = [
      "../../etc/passwd",
      "..",
      ".",
      "%2e%2e%2f",
      "a".repeat(500),
      "short",
      "with space",
      "null%00byte",
    ];
    const indices = [
      "-1",
      "1e9",
      "0x10",
      "99999999999999999999",
      "+1",
      "01",
      " 1",
      "NaN",
    ];

    for (const id of identifiers) {
      for (const index of indices) {
        const response = await server.inject({
          method: "GET",
          url: `/v1/capsules/${encodeURIComponent(id)}/chunks/${encodeURIComponent(index)}`,
          headers: { authorization: `Bearer ${"t".repeat(43)}` },
        });
        expect(
          response.statusCode,
          `${id} / ${index} produced ${response.statusCode}`,
        ).toBeLessThan(500);
      }
    }
  });

  it("does not leak whether a capsule exists through error shapes", async () => {
    const server = app as FastifyInstance;
    const created = await server.inject({
      method: "POST",
      url: "/v1/capsules",
      payload: {
        encryptedManifest: Buffer.from("manifest").toString("base64url"),
        chunkCount: 1,
        totalCiphertextBytes: 32,
        expiresInSeconds: 60,
      },
    });
    const capsuleId = created.json().capsuleId as string;

    const wrongToken = await server.inject({
      method: "GET",
      url: `/v1/capsules/${capsuleId}/manifest`,
      headers: { authorization: `Bearer ${"z".repeat(43)}` },
    });
    const missingCapsule = await server.inject({
      method: "GET",
      url: `/v1/capsules/${"y".repeat(32)}/manifest`,
      headers: { authorization: `Bearer ${"z".repeat(43)}` },
    });

    // A wrong capability and a capsule that never existed must be
    // indistinguishable, or the relay becomes an oracle for valid ids.
    expect(wrongToken.statusCode).toBe(missingCapsule.statusCode);
    expect(wrongToken.json()).toEqual(missingCapsule.json());
  });
});
