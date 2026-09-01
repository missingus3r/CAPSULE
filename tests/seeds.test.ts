import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../apps/relay/src/config.js";
import { buildRelayServer } from "../apps/relay/src/server.js";
import {
  DEFAULT_SEEDS,
  defaultSeedOrigins,
  parseSeedRef,
  parseSeedRefs,
  relayIdForPublicKey,
} from "../packages/protocol/src/index.js";
import { discoverRelays, fetchRelayInfo } from "../packages/sdk/src/index.js";

/**
 * What a pinned seed is worth.
 *
 * A default seed is believed first by every fresh install, so the question is
 * not whether the check passes for the real relay — it is whether it fails for
 * somebody who read the real relay's `/v1/info` and repeated it back. Both
 * `relayId` and `publicKey` are public, so a check that compares only those
 * strings protects nothing at all. These tests are written from the impostor's
 * side.
 */

const directories: string[] = [];
const servers: FastifyInstance[] = [];
const impostors: Server[] = [];

/**
 * An impostor is a plain HTTP server, not a relay.
 *
 * That is what the attack looks like: whoever wants to be believed at a seed
 * address serves a document, and everything in it was readable by anyone who
 * fetched the real relay once. It has no key, which is the entire point.
 */
async function startImpostor(document: unknown): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(document));
  });
  impostors.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    impostors
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function relayConfig(storageDir: string): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    storageDir,
    corsOrigins: "*",
    maxCapsuleBytes: 4 * 1024 * 1024,
    maxChunkBytes: 1024 * 1024,
    maxManifestBytes: 8 * 1024,
    maxChunkCount: 16,
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3_600,
    cleanupIntervalMs: 0,
    rateLimitMax: 100_000,
    rateLimitWindowMs: 60_000,
    createRateLimitMax: 10_000,
    publicUrl: undefined,
    nickname: undefined,
    peers: [],
    allowPrivatePeers: true,
    maxPeers: 50,
    maxPeersPerOperator: 50,
    peerSyncIntervalMs: 0,
    announceWorkBits: 0,
    allowPersistentCapsules: true,
    maxPersistentBytes: 1024 * 1024,
    maxPersistentBytesPerSender: 1024 * 1024,
    ipBlind: true,
    mixEnabled: true,
    mixCoverIntervalMs: 0,
    mixMaxDelayMs: 1_000,
    mixMeanDelayMs: 0,
    mixMaxQueued: 64,
    mixReplayWindowMs: 60_000,
    mixMailboxDepth: 32,
    mixMailboxTtlMs: 60_000,
    mixSendTimeoutMs: 5_000,
    mixPathLength: 3,
    mixRateLimitMax: 100_000,
    sitesEnabled: true,
    maxSites: 100,
    siteGossipLimit: 100,
    // Replication reaches across relays, so the tests that want it say so.
    siteReplication: false,
    maxReplicaBytes: 1024 * 1024,
    replicaTtlSeconds: 3_600,
    denylistFile: join(storageDir, "denylist.json"),
    denylistReloadMs: 0,
    bridgeMode: false,
    bridgeHost: undefined,
    bridgeKey: undefined,
    bridgeDecoyFile: undefined,
    lanEnabled: false,
  } as RelayConfig;
}

async function startRelay(): Promise<{ url: string; app: FastifyInstance }> {
  const storageDir = await mkdtemp(join(tmpdir(), "capsule-seed-"));
  directories.push(storageDir);
  const app = await buildRelayServer(relayConfig(storageDir), {
    logger: false,
  });
  servers.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}`, app };
}

describe("seed references", () => {
  it("ships no seed that cannot be checked", () => {
    // A seed that arrives with the software is believed before anything else a
    // fresh install sees, so one without an identifier to hold it to would
    // hand whoever controls that address the opening view of the network for
    // everybody. Shipping none is fine; shipping an unpinned one is not.
    for (const seed of DEFAULT_SEEDS) {
      const parsed = parseSeedRef(seed);
      expect(parsed, `${seed} does not parse`).toBeDefined();
      expect(parsed?.relayId, `${seed} is not pinned`).toBeTruthy();
    }
  });

  it("exposes seed origins with no fragment, for anything building a URL", () => {
    // `url#relayId` is a seed reference, not an address: appending a path to
    // one puts it after the fragment, where a server never sees it.
    for (const origin of defaultSeedOrigins()) {
      expect(origin).not.toContain("#");
      expect(new URL(`${origin}/v1/info`).pathname).toBe("/v1/info");
    }
  });

  it("reads url#relayId, and refuses what it cannot make sense of", () => {
    expect(parseSeedRef("https://relay.example#abcdefghijklmnop")).toEqual({
      url: "https://relay.example",
      relayId: "abcdefghijklmnop",
    });
    expect(parseSeedRef("https://relay.example")).toEqual({
      url: "https://relay.example",
    });
    expect(parseSeedRef("ftp://relay.example")).toBeUndefined();
    expect(parseSeedRef("https://user:pw@relay.example")).toBeUndefined();
    expect(parseSeedRef("https://relay.example#short")).toBeUndefined();
    expect(parseSeedRef("not a url")).toBeUndefined();
  });

  it("keeps the first of a repeated origin and drops what does not parse", () => {
    expect(
      parseSeedRefs([
        "https://a.example#abcdefghijklmnop",
        "https://a.example#qrstuvwxyz012345",
        "nonsense",
      ]),
    ).toEqual([{ url: "https://a.example", relayId: "abcdefghijklmnop" }]);
  });
});

describe("a pinned seed", () => {
  it("accepts the relay that actually holds the key", async () => {
    const relay = await startRelay();
    const announced = await fetchRelayInfo(relay.url);

    // The identifier is the digest of the key, not a name the relay chose.
    expect(await relayIdForPublicKey(announced.publicKey)).toBe(
      announced.relayId,
    );

    const pinned = await fetchRelayInfo(relay.url, {
      expectRelayId: announced.relayId,
    });
    expect(pinned.relayId).toBe(announced.relayId);
  });

  it("refuses an impostor that repeats the public identity back", async () => {
    const real = await startRelay();
    const genuine = await fetchRelayInfo(real.url);

    // Everything this impostor serves was readable by anyone: it fetched the
    // real relay's /v1/info once and is replaying it. This is the whole attack
    // a hardcoded seed has to survive.
    const impostor = await startImpostor({
      version: 1,
      software: "capsule-relay/1.3.0",
      protocolVersions: [1, 2, 3],
      relayId: genuine.relayId,
      publicKey: genuine.publicKey,
      limits: genuine.limits,
      defaultTtlSeconds: genuine.defaultTtlSeconds,
      maxTtlSeconds: genuine.maxTtlSeconds,
      peerCount: 0,
      acceptsAnnouncements: true,
      mixEnabled: false,
      sitesEnabled: false,
      siteCount: 0,
    });

    await expect(
      fetchRelayInfo(impostor, { expectRelayId: genuine.relayId }),
    ).rejects.toThrow(/could not prove/u);
  });

  it("refuses a relay whose identifier does not follow from its key", async () => {
    const relay = await startRelay();
    const genuine = await fetchRelayInfo(relay.url);
    const other = await startRelay();
    const otherInfo = await fetchRelayInfo(other.url);

    // Claiming one relay's identifier while presenting another's key is caught
    // by arithmetic, before any signature is looked at.
    const liar = await startImpostor({
      version: 1,
      software: "capsule-relay/1.3.0",
      protocolVersions: [1, 2, 3],
      relayId: genuine.relayId,
      publicKey: otherInfo.publicKey,
      limits: otherInfo.limits,
      defaultTtlSeconds: otherInfo.defaultTtlSeconds,
      maxTtlSeconds: otherInfo.maxTtlSeconds,
      peerCount: 0,
      acceptsAnnouncements: true,
      mixEnabled: false,
      sitesEnabled: false,
      siteCount: 0,
    });

    await expect(
      fetchRelayInfo(liar, { expectRelayId: genuine.relayId }),
    ).rejects.toThrow(/identifier-does-not-match-key|could not prove/u);
  });

  it("does not follow a pinned seed that turns out to be somebody else", async () => {
    const real = await startRelay();
    const genuine = await fetchRelayInfo(real.url);
    const impostor = await startRelay();

    // Discovery starting from a pinned seed that fails the check finds
    // nothing, rather than quietly falling back to trusting it.
    const found = await discoverRelays({
      seeds: [{ url: impostor.url, relayId: genuine.relayId }],
      allowPrivateRelays: true,
    });
    expect(found).toEqual([]);
  });
});
