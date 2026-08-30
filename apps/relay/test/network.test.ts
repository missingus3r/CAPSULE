import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../src/config.js";
import { announceMessage, solveAnnounceWork } from "../src/identity.js";
import { operatorHint } from "../src/peers.js";
import { buildRelayServer } from "../src/server.js";

const directories: string[] = [];
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function testConfig(
  storageDir: string,
  overrides: Partial<RelayConfig> = {},
): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    storageDir,
    corsOrigins: "*",
    maxCapsuleBytes: 4096,
    maxChunkBytes: 64,
    maxManifestBytes: 128,
    maxChunkCount: 8,
    defaultTtlSeconds: 60,
    maxTtlSeconds: 3_600,
    cleanupIntervalMs: 0,
    rateLimitMax: 1_000,
    rateLimitWindowMs: 60_000,
    createRateLimitMax: 500,
    publicUrl: undefined,
    nickname: undefined,
    peers: [],
    maxPeers: 20,
    peerSyncIntervalMs: 0,
    allowPrivatePeers: true,
    allowPersistentCapsules: false,
    maxPersistentBytes: 4096,
    maxPersistentBytesPerSender: 1024 * 1024 * 1024,
    announceWorkBits: 0,
    maxPeersPerOperator: 8,
    sitesEnabled: true,
    maxSites: 64,
    siteGossipLimit: 32,
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

async function startRelay(
  overrides: Partial<RelayConfig> = {},
): Promise<{ app: FastifyInstance; config: RelayConfig; url: string }> {
  const storageDir = await mkdtemp(join(tmpdir(), "capsule-network-"));
  directories.push(storageDir);
  const config = testConfig(storageDir, overrides);
  const app = await buildRelayServer(config, { logger: false });
  servers.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected relay address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  // A relay only announces itself once it knows its own reachable address.
  config.publicUrl = url;
  return { app, config, url };
}

async function createCapsule(
  app: FastifyInstance,
  expiresInSeconds: number | null,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/capsules",
    payload: {
      encryptedManifest: Buffer.from("sealed metadata").toString("base64url"),
      chunkCount: 1,
      totalCiphertextBytes: 32,
      expiresInSeconds,
    },
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

describe("capsules without expiry", () => {
  it("stores, serves and deletes a capsule the operator allowed to persist", async () => {
    const { app } = await startRelay({ allowPersistentCapsules: true });
    const created = await createCapsule(app, null);
    expect(created.statusCode).toBe(201);
    expect(created.body.expiresAt).toBeNull();

    const ciphertext = Buffer.alloc(32, 7);
    const upload = await app.inject({
      method: "PUT",
      url: `/v1/capsules/${String(created.body.capsuleId)}/chunks/0`,
      headers: {
        authorization: `Bearer ${String(created.body.writeToken)}`,
        "content-type": "application/octet-stream",
      },
      payload: ciphertext,
    });
    expect(upload.statusCode).toBe(204);

    const finalized = await app.inject({
      method: "POST",
      url: `/v1/capsules/${String(created.body.capsuleId)}/finalize`,
      headers: { authorization: `Bearer ${String(created.body.writeToken)}` },
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json().expiresAt).toBeNull();

    // Expiry cleanup must never touch a capsule that has no expiry.
    await expect(app.capsuleStorage.cleanupExpired()).resolves.toEqual({
      removed: 0,
      errors: 0,
    });
    const stillThere = await app.inject({
      method: "GET",
      url: `/v1/capsules/${String(created.body.capsuleId)}/manifest`,
      headers: { authorization: `Bearer ${String(created.body.readToken)}` },
    });
    expect(stillThere.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/capsules/${String(created.body.capsuleId)}`,
      headers: { authorization: `Bearer ${String(created.body.deleteToken)}` },
    });
    expect(deleted.statusCode).toBe(204);
    expect(app.capsuleStorage.persistentBytesUsed).toBe(0);
  });

  it("refuses capsules without expiry unless the operator enabled them", async () => {
    const { app } = await startRelay();
    const created = await createCapsule(app, null);
    expect(created.statusCode).toBe(400);
    expect(created.body.code).toBe("persistent_capsules_disabled");
  });

  it("stops accepting capsules without expiry once the quota is used", async () => {
    const { app } = await startRelay({
      allowPersistentCapsules: true,
      maxPersistentBytes: 40,
    });
    expect((await createCapsule(app, null)).statusCode).toBe(201);
    const second = await createCapsule(app, null);
    expect(second.statusCode).toBe(507);
    expect(second.body.code).toBe("insufficient_storage");
    // A capsule with a TTL is unaffected by the persistent quota.
    expect((await createCapsule(app, 60)).statusCode).toBe(201);
  });
});

describe("relay network", () => {
  it("lets a new relay join by announcing itself to a peer it already knows", async () => {
    const first = await startRelay({ nickname: "primero" });
    const second = await startRelay({ nickname: "segundo" });
    second.config.peers = [first.url];

    const result = await second.app.capsulePeers.sync();
    expect(result.peers).toBe(1);

    // The joining relay knows the seed...
    const secondView = await second.app.inject({
      method: "GET",
      url: "/v1/peers",
    });
    expect(secondView.json().peers[0].url).toBe(first.url);

    // ...and the seed learned about the newcomer from its signed announcement.
    const firstView = await first.app.inject({
      method: "GET",
      url: "/v1/peers",
    });
    const learned = firstView.json().peers as Array<Record<string, string>>;
    expect(learned).toHaveLength(1);
    expect(learned[0]?.url).toBe(second.url);
    expect(learned[0]?.relayId).toBe(second.app.capsuleIdentity.relayId);
    expect(learned[0]?.nickname).toBe("segundo");
  });

  it("propagates a third relay through one gossip hop", async () => {
    const first = await startRelay();
    const second = await startRelay({ peers: [] });
    const third = await startRelay({ peers: [] });
    second.config.peers = [first.url];
    third.config.peers = [first.url];

    await second.app.capsulePeers.sync();
    await third.app.capsulePeers.sync();
    // The seed now knows both newcomers, so the first one learns about the
    // second the next time it talks to the seed.
    await second.app.capsulePeers.sync();

    const knownBySecond = second.app.capsulePeers
      .list()
      .map((peer) => peer.url);
    expect(knownBySecond).toContain(first.url);
    expect(knownBySecond).toContain(third.url);
  });

  it("rejects an announcement whose signature does not match the relay id", async () => {
    const { app } = await startRelay();
    const response = await app.inject({
      method: "POST",
      url: "/v1/peers/announce",
      payload: {
        url: "http://127.0.0.1:9999",
        relayId: "x".repeat(43),
        publicKey: "y".repeat(43),
        announcedAt: new Date().toISOString(),
        signature: "z".repeat(86),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_announcement");
    expect(app.capsulePeers.size).toBe(0);
  });

  it("publishes an identity other relays and clients can verify", async () => {
    const { app, url } = await startRelay({
      nickname: "relay de prueba",
      allowPersistentCapsules: true,
    });
    const info = (
      await app.inject({ method: "GET", url: "/v1/info" })
    ).json() as Record<string, unknown>;

    expect(info.version).toBe(1);
    expect(info.relayId).toBe(app.capsuleIdentity.relayId);
    expect(info.url).toBe(url);
    expect(info.nickname).toBe("relay de prueba");
    expect(info.persistentCapsules).toBe(true);
    expect(info.protocolVersions).toEqual([1, 2, 3]);
  });

  it("requires proof of work on announcements when the operator asks for it", async () => {
    const relay = await startRelay({ announceWorkBits: 12 });
    const other = await startRelay({ announceWorkBits: 12 });
    const announcement = other.app.capsulePeers.selfAnnouncement();
    expect(announcement).toBeDefined();

    // The same announcement with a nonce that does no work is refused, even
    // though its signature is valid for that nonce.
    const lazyNonce = "0";
    const lazy = {
      ...announcement,
      nonce: lazyNonce,
      signature: other.app.capsuleIdentity.sign(
        announceMessage(
          announcement!.url,
          announcement!.relayId,
          announcement!.announcedAt,
          lazyNonce,
        ),
      ),
    };
    const refused = await relay.app.inject({
      method: "POST",
      url: "/v1/peers/announce",
      payload: lazy,
    });
    expect(refused.statusCode).toBe(400);
    expect(relay.app.capsulePeers.size).toBe(0);

    const accepted = await relay.app.inject({
      method: "POST",
      url: "/v1/peers/announce",
      payload: { ...announcement },
    });
    expect(accepted.statusCode).toBe(202);
    expect(relay.app.capsulePeers.size).toBe(1);
  });

  it("solves its own proof of work at the configured difficulty", () => {
    const nonce = solveAnnounceWork(
      "https://relay.example",
      "r".repeat(43),
      "2026-08-29T00:00:00.000Z",
      10,
    );
    expect(typeof nonce).toBe("string");
  });

  it("stops one operator from filling the directory", async () => {
    const relay = await startRelay({ maxPeersPerOperator: 1 });
    const first = await startRelay();
    const second = await startRelay();
    // Both newcomers live on the same address, so they read as one operator.
    expect(operatorHint(first.url)).toBe(operatorHint(second.url));

    for (const newcomer of [first, second]) {
      const payload = newcomer.app.capsulePeers.selfAnnouncement();
      expect(payload).toBeDefined();
      await relay.app.inject({
        method: "POST",
        url: "/v1/peers/announce",
        payload: { ...payload },
      });
    }
    expect(relay.app.capsulePeers.size).toBe(1);
  });

  it("meters storage without expiry per sender, not only in total", async () => {
    const { app } = await startRelay({
      allowPersistentCapsules: true,
      maxPersistentBytes: 1024 * 1024,
      maxPersistentBytesPerSender: 40,
    });
    expect((await createCapsule(app, null)).statusCode).toBe(201);
    const second = await createCapsule(app, null);
    expect(second.statusCode).toBe(507);
    expect(String(second.body.message)).toContain("one sender");
    // The global budget is untouched, so capsules with a TTL still work.
    expect((await createCapsule(app, 60)).statusCode).toBe(201);
  });

  it("keeps trying to join when its seed is not listening yet", async () => {
    // Reserve a port, let it go, and point a relay at it before anything is
    // there — exactly what happens when a fleet starts at once.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected probe address");
    }
    const seedPort = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const seedUrl = `http://127.0.0.1:${seedPort}`;

    const latecomer = await startRelay({
      peers: [seedUrl],
      // Long enough that only the bootstrap retries can save this.
      peerSyncIntervalMs: 10 * 60_000,
    });
    expect(latecomer.app.capsulePeers.size).toBe(0);

    const seedStorage = await mkdtemp(join(tmpdir(), "capsule-network-seed-"));
    directories.push(seedStorage);
    const seedConfig = testConfig(seedStorage, {
      publicUrl: seedUrl,
      nickname: "seed",
    });
    const seed = await buildRelayServer(seedConfig, { logger: false });
    servers.push(seed);
    await seed.listen({ host: "127.0.0.1", port: seedPort });

    const deadline = Date.now() + 8000;
    while (latecomer.app.capsulePeers.size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(latecomer.app.capsulePeers.list()[0]?.url).toBe(seedUrl);
  }, 15_000);

  it("refuses an announcement for an address that does not host that relay", async () => {
    const relay = await startRelay();
    const other = await startRelay();
    const announcement = other.app.capsulePeers.selfAnnouncement();
    expect(announcement).toBeDefined();

    // A valid signature proves who wrote the message, not who owns the
    // address in it. Announcing an address that answers as somebody else — or
    // does not answer at all — must not put it in the directory.
    const elsewhere = {
      ...announcement,
      url: "http://127.0.0.1:1",
      signature: other.app.capsuleIdentity.sign(
        announceMessage(
          "http://127.0.0.1:1",
          announcement!.relayId,
          announcement!.announcedAt,
          announcement!.nonce,
        ),
      ),
    };
    const refused = await relay.app.inject({
      method: "POST",
      url: "/v1/peers/announce",
      payload: elsewhere,
    });
    expect(refused.statusCode).toBe(400);
    expect(relay.app.capsulePeers.size).toBe(0);

    // The relay's real address is accepted, because it answers as itself.
    const accepted = await relay.app.inject({
      method: "POST",
      url: "/v1/peers/announce",
      payload: { ...announcement },
    });
    expect(accepted.statusCode).toBe(202);
    expect(relay.app.capsulePeers.list()[0]?.url).toBe(other.url);
  });

  it("refuses peer addresses that point back into the operator's network", async () => {
    // With the local-network escape hatch closed, loopback is refused even
    // when the announcement itself is perfectly valid.
    const relay = await startRelay({ allowPrivatePeers: false });
    const other = await startRelay({ allowPrivatePeers: false });
    const response = await relay.app.inject({
      method: "POST",
      url: "/v1/peers/announce",
      payload: { ...other.app.capsulePeers.selfAnnouncement() },
    });
    expect(response.statusCode).toBe(400);
    expect(relay.app.capsulePeers.size).toBe(0);
  });
});
