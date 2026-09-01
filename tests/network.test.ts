import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../apps/relay/src/config.js";
import { buildRelayServer } from "../apps/relay/src/server.js";
import {
  CapsuleRelayClient,
  deleteCapsule,
  discoverRelays,
  downloadCapsule,
  fetchRelayPeers,
  resumeUpload,
  selectRelays,
  uploadCapsule,
  type UploadTicket,
} from "../packages/sdk/src/index.js";

const CHUNK_BYTES = 64 * 1024;

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
    maxCapsuleBytes: 8 * 1024 * 1024,
    maxChunkBytes: CHUNK_BYTES + 16,
    maxManifestBytes: 8 * 1024,
    maxChunkCount: 64,
    defaultTtlSeconds: 60,
    maxTtlSeconds: 3_600,
    cleanupIntervalMs: 0,
    rateLimitMax: 10_000,
    rateLimitWindowMs: 60_000,
    createRateLimitMax: 1_000,
    publicUrl: undefined,
    nickname: undefined,
    peers: [],
    maxPeers: 20,
    peerSyncIntervalMs: 0,
    allowPrivatePeers: true,
    allowPersistentCapsules: true,
    maxPersistentBytes: 8 * 1024 * 1024,
    maxPersistentBytesPerSender: 1024 * 1024 * 1024,
    announceWorkBits: 0,
    maxPeersPerOperator: 8,
    lanBeacon: false,
    bridgeMode: false,
    bridgeKey: undefined,
    bridgeDecoyFile: undefined,
    sitesEnabled: true,
    maxSites: 64,
    siteGossipLimit: 32,
    // Replication reaches across relays, so the tests that want it say so.
    siteReplication: false,
    maxReplicaBytes: 1024 * 1024,
    replicaTtlSeconds: 3_600,
    denylistFile: join(storageDir, "denylist.json"),
    denylistReloadMs: 0,
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
  const storageDir = await mkdtemp(join(tmpdir(), "capsule-net-e2e-"));
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
  return { app, config, url };
}

function jpegWithExif(): Uint8Array {
  const encoder = new TextEncoder();
  const exif = encoder.encode("Exif  GPS -34.9011,-56.1645 Camera SN 42");
  const scan = encoder.encode("scan data that must survive anonymisation");
  const parts: number[] = [0xff, 0xd8];
  parts.push(0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff);
  parts.push(...exif);
  parts.push(0xff, 0xda);
  parts.push(...scan);
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

describe("CAPSULE network end-to-end", () => {
  it("mirrors an anonymous capsule without expiry and reads it from a surviving relay", async () => {
    const primary = await startRelay({ nickname: "primary" });
    const mirror = await startRelay({ nickname: "mirror" });
    mirror.config.peers = [primary.url];
    await mirror.app.capsulePeers.sync();

    const network = await discoverRelays({
      seeds: [primary.url],
      allowPrivateRelays: true,
    });
    expect(network).toHaveLength(2);
    const [chosen] = selectRelays(network, {
      count: 1,
      ciphertextBytes: 1024 * 1024,
      chunkCount: 4,
      persistent: true,
      exclude: [primary.url],
    });
    expect(chosen?.url).toBe(mirror.url);

    const original = jpegWithExif();
    const uploaded = await uploadCapsule({
      data: new Blob([original.slice().buffer], { type: "image/jpeg" }),
      filename: "Ana Pereira - pasaporte.jpg",
      mimeType: "image/jpeg",
      ttlSeconds: null,
      relayUrl: primary.url,
      mirrorRelayUrls: [chosen!.url],
      appUrl: "https://capsule.test/",
      anonymity: { padding: true, scrubMetadata: true, hideFilename: true },
    });

    expect(uploaded.relayUrls).toEqual([primary.url, mirror.url]);
    expect(uploaded.mirrorFailures).toEqual([]);
    expect(uploaded.capability.mirrors).toHaveLength(1);
    expect(uploaded.metadata.expiresAt).toBeNull();
    expect(uploaded.metadata.filename).toBe("capsule.jpg");
    expect(uploaded.metadata.paddedLength).toBe(CHUNK_BYTES);
    expect(uploaded.anonymity.removedMetadata.length).toBeGreaterThan(0);

    // What the relay stores is a whole size class, not the real file size.
    const primaryClient = new CapsuleRelayClient(primary.url);
    const status = await primaryClient.status(
      uploaded.capability.capsuleId,
      uploaded.capability.readToken,
    );
    expect(status.expiresAt).toBeNull();
    expect(status.totalCiphertextBytes).toBe(
      CHUNK_BYTES + uploaded.metadata.chunkCount * 16,
    );
    expect(status.totalCiphertextBytes).toBeGreaterThan(original.length * 10);
    // Every chunk is identical in size, so the relay cannot tell where the
    // real bytes end and the padding begins.
    expect(status.totalCiphertextBytes % uploaded.metadata.chunkCount).toBe(0);

    const received = await downloadCapsule({ capability: uploaded.capability });
    const receivedBytes = new Uint8Array(await received.blob.arrayBuffer());
    const receivedText = new TextDecoder().decode(receivedBytes);
    expect(receivedText).toContain("scan data that must survive");
    expect(receivedText).not.toContain("GPS -34.9011");
    expect(receivedBytes.length).toBe(uploaded.metadata.byteLength);

    // Losing the primary relay must not lose the capsule.
    await primaryClient.delete(
      uploaded.capability.capsuleId,
      uploaded.ownerCapability.deleteToken,
    );
    const fromMirror = await downloadCapsule({
      capability: uploaded.capability,
    });
    expect(fromMirror.relayUrls).toEqual([mirror.url]);
    expect(new Uint8Array(await fromMirror.blob.arrayBuffer())).toEqual(
      receivedBytes,
    );

    const deletion = await deleteCapsule(uploaded.ownerCapability);
    expect(deletion.deleted).toEqual([primary.url, mirror.url]);
    expect(deletion.failed).toEqual([]);
    await expect(
      downloadCapsule({ capability: uploaded.capability }),
    ).rejects.toThrow();
  });

  it("reports a mirror that refuses the capsule instead of failing the send", async () => {
    const primary = await startRelay();
    const strict = await startRelay({ allowPersistentCapsules: false });

    const uploaded = await uploadCapsule({
      data: new Blob([new Uint8Array(64)]),
      filename: "nota.bin",
      ttlSeconds: null,
      relayUrl: primary.url,
      mirrorRelayUrls: [strict.url],
      appUrl: "https://capsule.test/",
    });

    expect(uploaded.relayUrls).toEqual([primary.url]);
    expect(uploaded.capability.mirrors).toBeUndefined();
    expect(uploaded.mirrorFailures).toHaveLength(1);
    expect(uploaded.mirrorFailures[0]?.relayUrl).toBe(strict.url);
  });

  it("splits a capsule so no single relay holds enough to rebuild it", async () => {
    const relays = [await startRelay(), await startRelay(), await startRelay()];
    const original = new Uint8Array(200_000);
    for (let index = 0; index < original.length; index += 1) {
      original[index] = (index * 37 + 11) % 256;
    }

    const uploaded = await uploadCapsule({
      data: new Blob([original.slice().buffer]),
      filename: "expediente.bin",
      ttlSeconds: null,
      relayUrl: relays[0]!.url,
      mirrorRelayUrls: [relays[1]!.url, relays[2]!.url],
      replication: { mode: "shards", dataShards: 2 },
      appUrl: "https://capsule.test/",
    });

    expect(uploaded.sharding).toEqual({
      k: 2,
      n: 3,
      blockBytes: expect.any(Number),
      shardBytes: expect.any(Number),
    });
    const sharding = uploaded.sharding!;
    expect(uploaded.capability.sharding).toEqual(sharding);
    // Each relay stores roughly half the capsule, not a whole copy.
    expect(sharding.shardBytes * 2).toBeGreaterThanOrEqual(sharding.blockBytes);
    expect(sharding.shardBytes).toBeLessThan(sharding.blockBytes);

    const status = await new CapsuleRelayClient(relays[0]!.url).status(
      uploaded.capability.capsuleId,
      uploaded.capability.readToken,
    );
    expect(status.totalCiphertextBytes).toBe(
      uploaded.metadata.chunkCount * sharding.shardBytes,
    );

    const received = await downloadCapsule({ capability: uploaded.capability });
    expect(new Uint8Array(await received.blob.arrayBuffer())).toEqual(original);

    // Any one relay may disappear and the capsule survives.
    await relays[1]!.app.close();
    servers.splice(servers.indexOf(relays[1]!.app), 1);
    const withoutOne = await downloadCapsule({
      capability: uploaded.capability,
      retry: { attempts: 0 },
    });
    expect(new Uint8Array(await withoutOne.blob.arrayBuffer())).toEqual(
      original,
    );

    // Two of three gone is below the threshold, and the client says so.
    await relays[2]!.app.close();
    servers.splice(servers.indexOf(relays[2]!.app), 1);
    await expect(
      downloadCapsule({
        capability: uploaded.capability,
        retry: { attempts: 0 },
      }),
    ).rejects.toThrow(/needs 2 of its 3 relays|relays hold a consistent copy/u);
  });

  it("rebuilds a shard set even when one relay serves corrupted shards", async () => {
    const relays = [await startRelay(), await startRelay(), await startRelay()];
    const original = new TextEncoder().encode("contenido que debe sobrevivir");

    const uploaded = await uploadCapsule({
      data: new Blob([original.slice().buffer]),
      filename: "nota.txt",
      ttlSeconds: 600,
      relayUrl: relays[0]!.url,
      mirrorRelayUrls: [relays[1]!.url, relays[2]!.url],
      replication: { mode: "shards", dataShards: 2 },
      appUrl: "https://capsule.test/",
    });

    // A relay that flips bytes in the shards it serves cannot corrupt the
    // capsule: reconstruction from another pair authenticates instead.
    const mirror = uploaded.capability.mirrors![0]!;
    const chunkDirectory = join(
      relays[1]!.config.storageDir,
      "capsules",
      mirror.capsuleId,
      "chunks",
    );
    for (const name of await readdir(chunkDirectory)) {
      const path = join(chunkDirectory, name);
      const bytes = await readFile(path);
      bytes[0] ^= 0xff;
      await writeFile(path, bytes);
    }

    const received = await downloadCapsule({ capability: uploaded.capability });
    expect(new Uint8Array(await received.blob.arrayBuffer())).toEqual(original);
  });

  it("resumes an interrupted upload without re-sending what arrived", async () => {
    const relay = await startRelay();
    const original = new Uint8Array(300_000).fill(9);
    const data = new Blob([original.slice().buffer]);

    let ticket: UploadTicket | undefined;
    const failing = new AbortController();
    await expect(
      uploadCapsule({
        data,
        filename: "grande.bin",
        ttlSeconds: 600,
        relayUrl: relay.url,
        appUrl: "https://capsule.test/",
        chunkSize: 64 * 1024,
        signal: failing.signal,
        onTicket: (issued) => {
          ticket = issued;
        },
        onProgress: (progress) => {
          // Cut the connection halfway through, the way a real one dies.
          if (progress.completedChunks === 2) failing.abort();
        },
      }),
    ).rejects.toThrow();

    expect(ticket).toBeDefined();
    const client = new CapsuleRelayClient(relay.url);
    const partial = await client.status(
      ticket!.targets[0]!.capsuleId,
      ticket!.targets[0]!.writeToken,
    );
    expect(partial.uploadedChunks).toBeGreaterThan(0);
    expect(partial.uploadedChunks).toBeLessThan(ticket!.chunkCount);

    const finished = await resumeUpload(ticket!, data, {
      appUrl: "https://capsule.test/",
    });
    expect(finished.capability.capsuleId).toBe(ticket!.targets[0]!.capsuleId);

    const received = await downloadCapsule({ capability: finished.capability });
    expect(new Uint8Array(await received.blob.arrayBuffer())).toEqual(original);
  });

  it("does not follow a relay that points clients at their own network", async () => {
    const honest = await startRelay();
    // A relay's peer list is written by that relay. This one answers with
    // loopback addresses, which is how a hostile relay would turn a visitor's
    // browser into a scanner of the visitor's own machine.
    const hostile = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/v1/info") {
        response.end(
          JSON.stringify({
            version: 1,
            relayId: "h".repeat(43),
            publicKey: "k".repeat(43),
            limits: {
              maxCapsuleBytes: 1024,
              maxChunkBytes: 1024,
              maxManifestBytes: 1024,
              maxChunkCount: 8,
            },
            defaultTtlSeconds: 60,
            maxTtlSeconds: 3600,
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          version: 1,
          peers: [
            { url: "http://127.0.0.1:9200" },
            { url: "http://[::ffff:7f00:1]:9201" },
            { url: "http://169.254.169.254" },
            { url: honest.url },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      hostile.listen(0, "127.0.0.1", resolve),
    );
    const address = hostile.address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected address");
    }
    const hostileUrl = `http://127.0.0.1:${address.port}`;

    try {
      const followed = await fetchRelayPeers(hostileUrl);
      expect(followed).toEqual([]);

      // With the local-network opt-in the same list is followed, because the
      // operator said they are working inside one.
      const local = await fetchRelayPeers(hostileUrl, {
        allowPrivateRelays: true,
      });
      expect(local.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => hostile.close(() => resolve()));
    }
  });

  it("refuses to resume with a different file of the same size", async () => {
    const relay = await startRelay();
    const original = new Uint8Array(200_000).fill(1);
    const impostor = new Uint8Array(200_000).fill(2);

    let ticket: UploadTicket | undefined;
    const controller = new AbortController();
    await expect(
      uploadCapsule({
        data: new Blob([original.slice().buffer]),
        filename: "original.bin",
        ttlSeconds: 600,
        relayUrl: relay.url,
        appUrl: "https://capsule.test/",
        chunkSize: 32 * 1024,
        signal: controller.signal,
        onTicket: (issued) => {
          ticket = issued;
        },
        onProgress: (progress) => {
          if (progress.completedChunks === 2) controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(ticket?.contentDigest).toBeTruthy();

    // Resuming with different bytes would encrypt new plaintext under a nonce
    // the original already used. The ticket commits to the contents, so this
    // is refused before a single byte is sent.
    await expect(
      resumeUpload(ticket!, new Blob([impostor.slice().buffer]), {
        appUrl: "https://capsule.test/",
      }),
    ).rejects.toThrow("does not match");

    // The original still resumes.
    const finished = await resumeUpload(
      ticket!,
      new Blob([original.slice().buffer]),
      { appUrl: "https://capsule.test/" },
    );
    const received = await downloadCapsule({ capability: finished.capability });
    expect(new Uint8Array(await received.blob.arrayBuffer())).toEqual(original);
  });
});
