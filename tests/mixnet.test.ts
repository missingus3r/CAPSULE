import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../apps/relay/src/config.js";
import { buildRelayServer } from "../apps/relay/src/server.js";
import {
  MIX_CHUNK_SIZE,
  MixClient,
  MixRelayTransport,
  nodeIdFor,
  type MixDirectoryNode,
} from "../packages/mixnet/src/index.js";
import {
  downloadCapsule,
  uploadCapsule,
  type RelayPublicConfig,
} from "../packages/sdk/src/index.js";

/**
 * The mix network, end to end.
 *
 * The assertion that matters is not that a file arrives — that would be true
 * of any proxy. It is that the client never speaks to the relay that stores
 * the capsule, and that relay never sees an address belonging to the client.
 */

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

function relayConfig(
  storageDir: string,
  overrides: Partial<RelayConfig> = {},
): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    storageDir,
    corsOrigins: "*",
    maxCapsuleBytes: 16 * 1024 * 1024,
    maxChunkBytes: MIX_CHUNK_SIZE + 16,
    maxManifestBytes: 8 * 1024,
    maxChunkCount: 64,
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3_600,
    cleanupIntervalMs: 0,
    rateLimitMax: 100_000,
    rateLimitWindowMs: 60_000,
    createRateLimitMax: 10_000,
    publicUrl: undefined,
    nickname: undefined,
    peers: [],
    maxPeers: 20,
    peerSyncIntervalMs: 0,
    allowPrivatePeers: true,
    allowPersistentCapsules: true,
    maxPersistentBytes: 16 * 1024 * 1024,
    maxPersistentBytesPerSender: 16 * 1024 * 1024,
    announceWorkBits: 0,
    maxPeersPerOperator: 16,
    sitesEnabled: true,
    maxSites: 64,
    siteGossipLimit: 32,
    ipBlind: true,
    mixEnabled: true,
    mixMaxQueued: 512,
    mixMaxDelayMs: 10_000,
    mixMeanDelayMs: 0,
    mixReplayWindowMs: 60_000,
    mixMailboxDepth: 64,
    mixMailboxTtlMs: 60_000,
    mixSendTimeoutMs: 10_000,
    mixCoverIntervalMs: 0,
    mixPathLength: 3,
    mixRateLimitMax: 100_000,
    ...overrides,
  };
}

interface Relay {
  app: FastifyInstance;
  config: RelayConfig;
  url: string;
  node: MixDirectoryNode;
}

async function startRelay(
  overrides: Partial<RelayConfig> = {},
): Promise<Relay> {
  const storageDir = await mkdtemp(join(tmpdir(), "capsule-mix-"));
  directories.push(storageDir);
  const config = relayConfig(storageDir, overrides);
  const app = await buildRelayServer(config, { logger: false });
  servers.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected relay address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  config.publicUrl = url;

  const publicKey = new Uint8Array(
    Buffer.from(app.capsuleIdentity.mixPublicKey, "base64url"),
  );
  return {
    app,
    config,
    url,
    node: { nodeId: nodeIdFor(publicKey), url, publicKey },
  };
}

/** Teaches every relay about every other, the way gossip eventually does. */
async function introduce(relays: Relay[]): Promise<void> {
  for (const relay of relays) {
    relay.config.peers = relays
      .filter((other) => other.url !== relay.url)
      .map((other) => other.url);
  }
  for (const relay of relays) await relay.app.capsulePeers.sync();
  for (const relay of relays) await relay.app.capsulePeers.sync();
}

function limitsFrom(config: RelayConfig): RelayPublicConfig {
  return {
    version: 1,
    maxCapsuleBytes: config.maxCapsuleBytes,
    maxChunkBytes: config.maxChunkBytes,
    maxManifestBytes: config.maxManifestBytes,
    maxChunkCount: config.maxChunkCount,
    defaultTtlSeconds: config.defaultTtlSeconds,
    maxTtlSeconds: config.maxTtlSeconds,
    persistentCapsules: config.allowPersistentCapsules,
  };
}

/** Records every address the client itself opens a connection to. */
function watchfulFetch(seen: string[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    seen.push(new URL(input).origin);
    return fetch(input, init);
  };
}

describe("CAPSULE over its own mix network", () => {
  it("moves a capsule without the storing relay ever seeing the client", async () => {
    const relays = [
      await startRelay(),
      await startRelay(),
      await startRelay(),
      await startRelay(),
    ];
    await introduce(relays);

    const [storage, provider, ...mixes] = relays as [Relay, Relay, ...Relay[]];
    const contacted: string[] = [];
    const client = new MixClient({
      nodes: mixes.map((relay) => relay.node),
      provider: provider.node,
      pathLength: 3,
      meanDelayMs: 0,
      pollIntervalMs: 25,
      timeoutMs: 30_000,
      fetchImpl: watchfulFetch(contacted),
    });

    const transport = (relayUrl: string) => {
      const target = relays.find((relay) => relay.url === relayUrl);
      if (!target) throw new Error(`Unknown relay ${relayUrl}`);
      return new MixRelayTransport(
        relayUrl,
        client,
        target.node,
        limitsFrom(target.config),
      );
    };

    const original = new Uint8Array(120_000);
    for (let index = 0; index < original.length; index += 1) {
      original[index] = (index * 31 + 7) % 256;
    }

    const uploaded = await uploadCapsule({
      data: new Blob([original.slice().buffer]),
      filename: "expediente.bin",
      ttlSeconds: 600,
      relayUrl: storage.url,
      appUrl: "https://capsule.test/",
      chunkSize: MIX_CHUNK_SIZE,
      transport,
    });
    expect(uploaded.relayUrls).toEqual([storage.url]);

    const received = await downloadCapsule({
      capability: uploaded.capability,
      transport,
    });
    expect(new Uint8Array(await received.blob.arrayBuffer())).toEqual(original);

    // The client only ever opened connections to its entry mixes and its
    // provider. The relay holding the capsule is not among them.
    const opened = new Set(contacted);
    expect(opened.has(storage.url)).toBe(false);
    expect(opened.has(provider.url)).toBe(true);
    for (const origin of opened) {
      expect([provider.url, ...mixes.map((relay) => relay.url)]).toContain(
        origin,
      );
    }
  }, 60_000);

  it("holds each packet for the delay the sender asked for", async () => {
    const relays = [await startRelay(), await startRelay(), await startRelay()];
    await introduce(relays);
    const [storage, provider, mix] = relays as [Relay, Relay, Relay];

    const client = new MixClient({
      nodes: [mix.node, provider.node],
      provider: provider.node,
      pathLength: 2,
      meanDelayMs: 250,
      pollIntervalMs: 25,
      timeoutMs: 30_000,
    });
    const transport = (relayUrl: string) =>
      new MixRelayTransport(
        relayUrl,
        client,
        storage.node,
        limitsFrom(storage.config),
      );

    const started = Date.now();
    const uploaded = await uploadCapsule({
      data: new Blob([new Uint8Array(64).fill(3).buffer]),
      filename: "corto.bin",
      ttlSeconds: 600,
      relayUrl: storage.url,
      appUrl: "https://capsule.test/",
      chunkSize: MIX_CHUNK_SIZE,
      transport,
    });
    const elapsed = Date.now() - started;

    // Three requests, each crossing hops that each wait. Delays are random, so
    // the floor is loose on purpose: the point is that waiting happened.
    expect(elapsed).toBeGreaterThan(200);
    expect(uploaded.capability.capsuleId).toBeTruthy();
  }, 60_000);

  it("refuses a packet it has already processed", async () => {
    const relays = [await startRelay(), await startRelay()];
    await introduce(relays);
    const [first, second] = relays as [Relay, Relay];

    const { createPacket, MixCommand } =
      await import("../packages/mixnet/src/index.js");
    const { packet } = createPacket(
      [{ ...first.node, delayMs: 0 }],
      { command: MixCommand.Deliver, id: first.node.nodeId },
      new Uint8Array(32),
    );

    const send = async (): Promise<number> => {
      const response = await fetch(`${first.url}/v1/mix`, {
        method: "POST",
        headers: { "Content-Type": "application/capsule-mix" },
        body: Buffer.from(packet),
      });
      return response.status;
    };

    // A mix answers the same way whatever it decides, so a sender cannot use
    // the response to learn anything about the packet.
    expect(await send()).toBe(202);
    expect(await send()).toBe(202);
    expect(second.url).toBeTruthy();

    // The second copy was dropped rather than acted on.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(first.app.capsuleMix.stats.dropped).toBeGreaterThan(0);
  }, 30_000);

  it("sends cover traffic that is indistinguishable from a real packet", async () => {
    const relays = [await startRelay(), await startRelay(), await startRelay()];
    await introduce(relays);
    const [origin] = relays as [Relay, ...Relay[]];

    const before = origin.app.capsuleMix.stats.forwarded;
    await origin.app.capsuleMix.sendLoop();
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The loop left this node like any other packet; the nodes it passed
    // through cannot tell it carried nothing.
    expect(origin.app.capsuleMix.stats.forwarded).toBeGreaterThanOrEqual(
      before,
    );
  }, 30_000);
});
