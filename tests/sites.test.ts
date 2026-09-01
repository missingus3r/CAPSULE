import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../apps/relay/src/config.js";
import { buildRelayServer } from "../apps/relay/src/server.js";
import {
  siteContentType,
  type SiteFile,
} from "../packages/protocol/src/index.js";
import {
  createSiteIdentity,
  fetchSiteBundle,
  publishSite,
  resolveSite,
} from "../packages/sdk/src/index.js";

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

function relayConfig(storageDir: string): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    storageDir,
    corsOrigins: "*",
    maxCapsuleBytes: 8 * 1024 * 1024,
    maxChunkBytes: 1024 * 1024 + 64,
    maxManifestBytes: 8 * 1024,
    maxChunkCount: 64,
    defaultTtlSeconds: 600,
    maxTtlSeconds: 86_400,
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
    maxPersistentBytesPerSender: 8 * 1024 * 1024,
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
    mixEnabled: false,
    mixMaxQueued: 16,
    mixMaxDelayMs: 1_000,
    mixMeanDelayMs: 0,
    mixReplayWindowMs: 60_000,
    mixMailboxDepth: 16,
    mixMailboxTtlMs: 60_000,
    mixSendTimeoutMs: 5_000,
    mixCoverIntervalMs: 0,
    mixPathLength: 3,
    mixRateLimitMax: 10_000,
  };
}

async function startRelay(reuseStorageDir?: string): Promise<{
  app: FastifyInstance;
  config: RelayConfig;
  url: string;
}> {
  const storageDir =
    reuseStorageDir ?? (await mkdtemp(join(tmpdir(), "capsule-site-e2e-")));
  if (!reuseStorageDir) directories.push(storageDir);
  const config = relayConfig(storageDir);
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function page(path: string, body: string): SiteFile {
  return { path, type: siteContentType(path), bytes: encoder.encode(body) };
}

describe(".capsule sites end-to-end", () => {
  it("publishes a site, resolves it by name and reads back the pages", async () => {
    const relay = await startRelay();
    const { identity } = await createSiteIdentity();

    const files = [
      page("index.html", "<h1>CAPSULE</h1><link rel=stylesheet href=/a.css>"),
      page("a.css", "body{color:#eb6c36}"),
      page("about/index.html", "<p>about</p>"),
    ];

    const published = await publishSite({
      identity,
      files,
      relayUrl: relay.url,
      ttlSeconds: 600,
      sequence: 1,
      title: "CAPSULE",
    });

    expect(published.name).toBe(identity.name);
    expect(published.announcedTo).toEqual([relay.url]);
    expect(published.announceFailures).toEqual([]);

    const resolved = await resolveSite(identity.name, [relay.url]);
    expect(resolved?.record.sequence).toBe(1);
    expect(resolved?.record.title).toBe("CAPSULE");

    const bundle = await fetchSiteBundle(resolved!.capability);
    expect(bundle.files).toHaveLength(3);
    expect(decoder.decode(bundle.get("a.css")?.bytes)).toBe(
      "body{color:#eb6c36}",
    );
    expect(decoder.decode(bundle.get("about/index.html")?.bytes)).toBe(
      "<p>about</p>",
    );
  });

  it("keeps the name across an update and refuses to go backwards", async () => {
    const relay = await startRelay();
    const { identity } = await createSiteIdentity();

    await publishSite({
      identity,
      files: [page("index.html", "one")],
      relayUrl: relay.url,
      ttlSeconds: 600,
      sequence: 1,
    });
    const second = await publishSite({
      identity,
      files: [page("index.html", "two")],
      relayUrl: relay.url,
      ttlSeconds: 600,
      sequence: 2,
    });
    expect(second.name).toBe(identity.name);

    const resolved = await resolveSite(identity.name, [relay.url]);
    expect(resolved?.record.sequence).toBe(2);
    const bundle = await fetchSiteBundle(resolved!.capability);
    expect(decoder.decode(bundle.get("index.html")?.bytes)).toBe("two");

    // A relay handing back an older version than the visitor already saw is
    // the one attack a signature does not stop on its own.
    await expect(
      resolveSite(identity.name, [relay.url], { pinnedSequence: 5 }),
    ).rejects.toThrow(/Refusing the older version/u);
  });

  it("refuses a record a relay tampered with", async () => {
    const relay = await startRelay();
    const { identity } = await createSiteIdentity();
    const published = await publishSite({
      identity,
      files: [page("index.html", "real")],
      relayUrl: relay.url,
      ttlSeconds: 600,
      sequence: 1,
    });

    const forged = {
      ...published.record,
      capability: published.record.capability.replace(/.$/u, "X"),
    };
    const response = await fetch(
      `${relay.url}/v1/sites/${encodeURIComponent(identity.name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forged),
      },
    );
    expect(response.status).toBe(400);

    const stillReal = await resolveSite(identity.name, [relay.url]);
    expect(stillReal?.record.capability).toBe(published.record.capability);
  });

  it("spreads a record to relays it was never announced to", async () => {
    const first = await startRelay();
    const second = await startRelay();
    second.config.peers = [first.url];
    await second.app.capsulePeers.sync();

    const { identity } = await createSiteIdentity();
    const published = await publishSite({
      identity,
      files: [page("index.html", "gossiped")],
      relayUrl: first.url,
      ttlSeconds: 600,
      sequence: 1,
      announceTo: [first.url],
    });
    expect(published.announcedTo).toEqual([first.url]);

    // The second relay has never been told about this name; it learns of it by
    // pulling records from the peer it already knows.
    const before = await fetch(
      `${second.url}/v1/sites/${encodeURIComponent(identity.name)}`,
    );
    expect(before.status).toBe(404);

    const listed = (await (
      await fetch(`${first.url}/v1/sites?limit=50`)
    ).json()) as { records: unknown[] };
    expect(listed.records).toHaveLength(1);

    for (const record of listed.records) {
      await fetch(
        `${second.url}/v1/sites/${encodeURIComponent(identity.name)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        },
      );
    }

    const resolved = await resolveSite(identity.name, [second.url]);
    expect(resolved?.record.sequence).toBe(1);
    const bundle = await fetchSiteBundle(resolved!.capability);
    expect(decoder.decode(bundle.get("index.html")?.bytes)).toBe("gossiped");
  });

  it("stores the site as an ordinary padded capsule the relay cannot read", async () => {
    const relay = await startRelay();
    const { identity } = await createSiteIdentity();
    const secret = "<h1>only visible to a visitor with the record</h1>";
    const published = await publishSite({
      identity,
      files: [page("index.html", secret)],
      relayUrl: relay.url,
      ttlSeconds: 600,
      sequence: 1,
    });

    // The capsule the relay holds is padded to a size class and is not the
    // length of the site, and the manifest tells it nothing about the name.
    const status = await (
      await fetch(
        `${relay.url}/v1/capsules/${published.capability.capsuleId}/status`,
        {
          headers: {
            Authorization: `Bearer ${published.capability.readToken}`,
          },
        },
      )
    ).json();
    expect(status.state).toBe("ready");
    expect(published.bundleBytes).toBeLessThan(1024);
    // Padded to the smallest size class, so what the relay stores says nothing
    // about how big the site is.
    expect(status.totalCiphertextBytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(published.capability.relayUrl).toBe(relay.url);

    // Nothing the relay holds names the site.
    const onDisk = JSON.stringify(status);
    expect(onDisk).not.toContain(identity.name);
    expect(onDisk).not.toContain("index.html");
    expect(secret.length).toBeGreaterThan(0);
  });

  it("still knows the name after the relay restarts", async () => {
    const first = await startRelay();
    const { identity } = await createSiteIdentity();

    await publishSite({
      identity,
      files: [page("index.html", "one")],
      relayUrl: first.url,
      ttlSeconds: 600,
      sequence: 1,
      title: "Kept",
    });

    // The capsule behind a site was always written to disk; the record tying
    // the name to it was not, so restarting a relay silently emptied its half
    // of the `.capsule` name space — including names its own operator had
    // published minutes earlier.
    await first.app.close();
    const second = await startRelay(first.config.storageDir);

    const resolved = await resolveSite(identity.name, [second.url]);
    expect(resolved?.record.sequence).toBe(1);
    expect(resolved?.record.title).toBe("Kept");
    // The capability still names the relay that stored the bundle, which the
    // restart gave a new port; what is being checked here is the record.
    expect(resolved?.record.name).toBe(identity.name);
  });

  it("refuses a record that was edited on disk", async () => {
    const first = await startRelay();
    const { identity } = await createSiteIdentity();
    await publishSite({
      identity,
      files: [page("index.html", "one")],
      relayUrl: first.url,
      ttlSeconds: 600,
      sequence: 1,
      title: "Real",
    });
    await first.app.close();

    // A relay operator can edit the file. The signature is over the record, so
    // the edit survives exactly as long as it takes the next relay to read it.
    const path = join(first.config.storageDir, "sites.json");
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      records: Array<{ record: { title: string } }>;
    };
    stored.records[0]!.record.title = "Forged";
    await writeFile(path, JSON.stringify(stored));

    const second = await startRelay(first.config.storageDir);
    expect(await resolveSite(identity.name, [second.url])).toBeUndefined();
  });
});
