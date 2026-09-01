import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  announceSiteRecord,
  createSiteIdentity,
  fetchSiteBundle,
  publishSite,
  resolveSite,
} from "../packages/sdk/src/index.js";

/**
 * What it means for a relay to *carry* a site rather than point at one.
 *
 * The property under test is the one the network is for: a `.capsule` name
 * that survives the loss of the machine it was published to. Every test here
 * publishes to one relay only — no mirrors, nothing chosen by the publisher —
 * and then takes that relay away.
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
    siteReplication: true,
    maxReplicaBytes: 4 * 1024 * 1024,
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

interface Relay {
  app: FastifyInstance;
  config: RelayConfig;
  url: string;
  storageDir: string;
}

async function startRelay(
  overrides: (config: RelayConfig) => void = () => undefined,
): Promise<Relay> {
  const storageDir = await mkdtemp(join(tmpdir(), "capsule-replica-e2e-"));
  directories.push(storageDir);
  const config = relayConfig(storageDir);
  overrides(config);
  const app = await buildRelayServer(config, { logger: false });
  servers.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected relay address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  config.publicUrl = url;
  return { app, config, url, storageDir };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function page(path: string, body: string): SiteFile {
  return { path, type: siteContentType(path), bytes: encoder.encode(body) };
}

async function until(
  condition: () => Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Whether a relay will serve the capsule the capability names. */
async function serves(
  relayUrl: string,
  capsuleId: string,
  readToken: string,
): Promise<boolean> {
  const response = await fetch(`${relayUrl}/v1/capsules/${capsuleId}/status`, {
    headers: { Authorization: `Bearer ${readToken}` },
  });
  if (!response.ok) return false;
  const status = (await response.json()) as { state?: string };
  return status.state === "ready";
}

describe("site replication", () => {
  it("carries a site published elsewhere, and keeps it when the origin dies", async () => {
    const origin = await startRelay();
    const carrier = await startRelay();
    const { identity } = await createSiteIdentity();

    const published = await publishSite({
      identity,
      files: [page("index.html", "<h1>still here</h1>")],
      relayUrl: origin.url,
      // No mirrors: the publisher chose one relay and nothing else. Anything
      // that survives past this point was the network's doing.
      ttlSeconds: 600,
      sequence: 1,
    });
    expect(published.relayUrls).toEqual([origin.url]);

    await announceSiteRecord(published.record, [carrier.url]);
    await until(
      () =>
        serves(
          carrier.url,
          published.capability.capsuleId,
          published.capability.readToken,
        ),
      "the carrier to fetch the capsule behind the record it accepted",
    );

    // The copy answers to the identifier the publisher's capability names.
    // Anything else would be bytes nobody can address.
    await origin.app.close();
    servers.splice(servers.indexOf(origin.app), 1);

    const resolved = await resolveSite(identity.name, [carrier.url]);
    expect(resolved?.capability.relayUrl).toBe(origin.url);

    const bundle = await fetchSiteBundle(published.capability, {
      relayUrls: [carrier.url],
    });
    expect(decoder.decode(bundle.files[0]?.bytes)).toContain("still here");
  });

  it("cannot reach a site whose origin is gone without the fallback", async () => {
    const origin = await startRelay();
    const carrier = await startRelay();
    const { identity } = await createSiteIdentity();

    const published = await publishSite({
      identity,
      files: [page("index.html", "<h1>gone</h1>")],
      relayUrl: origin.url,
      ttlSeconds: 600,
      sequence: 1,
    });
    await announceSiteRecord(published.record, [carrier.url]);
    await until(
      () =>
        serves(
          carrier.url,
          published.capability.capsuleId,
          published.capability.readToken,
        ),
      "the carrier to take a copy",
    );
    await origin.app.close();
    servers.splice(servers.indexOf(origin.app), 1);

    // The capability names one relay and that relay is gone. Without being
    // told where else to look, a visitor has nowhere to go — which is what
    // the record on its own has always been worth.
    await expect(fetchSiteBundle(published.capability, {})).rejects.toThrow();
  });

  it("releases the copy when a newer version supersedes it", async () => {
    const origin = await startRelay();
    const carrier = await startRelay();
    const { identity } = await createSiteIdentity();

    const first = await publishSite({
      identity,
      files: [page("index.html", "<h1>one</h1>")],
      relayUrl: origin.url,
      ttlSeconds: 600,
      sequence: 1,
    });
    await announceSiteRecord(first.record, [carrier.url]);
    await until(
      () =>
        serves(
          carrier.url,
          first.capability.capsuleId,
          first.capability.readToken,
        ),
      "the first version to be carried",
    );

    const second = await publishSite({
      identity,
      files: [page("index.html", "<h1>two</h1>")],
      relayUrl: origin.url,
      ttlSeconds: 600,
      sequence: 2,
    });
    await announceSiteRecord(second.record, [carrier.url]);
    await until(
      () =>
        serves(
          carrier.url,
          second.capability.capsuleId,
          second.capability.readToken,
        ),
      "the second version to be carried",
    );

    // A publisher's route to withdrawing something they replicated: publish
    // over it. The copy of the old version is nobody's to keep.
    await until(
      async () =>
        !(await serves(
          carrier.url,
          first.capability.capsuleId,
          first.capability.readToken,
        )),
      "the superseded copy to be released",
    );
  });

  it("stays within the byte budget it was given", async () => {
    const origin = await startRelay();
    const carrier = await startRelay((config) => {
      config.maxReplicaBytes = 1;
    });
    const { identity } = await createSiteIdentity();

    const published = await publishSite({
      identity,
      files: [page("index.html", "<h1>too big for this relay</h1>")],
      relayUrl: origin.url,
      ttlSeconds: 600,
      sequence: 1,
    });
    await announceSiteRecord(published.record, [carrier.url]);

    // The record is still carried and still gossiped: refusing to store a
    // copy is not refusing to know the name.
    const resolved = await resolveSite(identity.name, [carrier.url]);
    expect(resolved?.record.sequence).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      await serves(
        carrier.url,
        published.capability.capsuleId,
        published.capability.readToken,
      ),
    ).toBe(false);
  });

  it("will not fetch from a relay address it would refuse to peer with", async () => {
    const origin = await startRelay();
    // The record is signed by its publisher, so the relay it names is a string
    // an attacker picks. A relay following it blindly is a request to an
    // arbitrary address, made from inside somebody's network, on a schedule
    // the attacker sets.
    const carrier = await startRelay((config) => {
      config.allowPrivatePeers = false;
    });
    const { identity } = await createSiteIdentity();

    const published = await publishSite({
      identity,
      files: [page("index.html", "<h1>internal</h1>")],
      relayUrl: origin.url,
      ttlSeconds: 600,
      sequence: 1,
    });
    await announceSiteRecord(published.record, [carrier.url]);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(
      await serves(
        carrier.url,
        published.capability.capsuleId,
        published.capability.readToken,
      ),
    ).toBe(false);
    // Still resolvable: refusing to dial an address is not refusing the name.
    expect(
      (await resolveSite(identity.name, [carrier.url]))?.record.sequence,
    ).toBe(1);
  });
});

describe("operator denylist", () => {
  it("refuses a name it has been told to refuse, and drops the copy it held", async () => {
    const origin = await startRelay();
    const carrier = await startRelay((config) => {
      config.denylistReloadMs = 50;
    });
    const { identity } = await createSiteIdentity();

    const published = await publishSite({
      identity,
      files: [page("index.html", "<h1>contested</h1>")],
      relayUrl: origin.url,
      ttlSeconds: 600,
      sequence: 1,
    });
    await announceSiteRecord(published.record, [carrier.url]);
    await until(
      () =>
        serves(
          carrier.url,
          published.capability.capsuleId,
          published.capability.readToken,
        ),
      "the carrier to take a copy",
    );

    await writeFile(
      carrier.config.denylistFile,
      JSON.stringify({
        sites: [{ name: identity.name, reason: "a complaint arrived" }],
      }),
    );

    // Both halves matter. The record goes, so the relay stops handing the
    // name to peers; the bytes go, so the relay is no longer holding it.
    await until(
      async () =>
        (await resolveSite(identity.name, [carrier.url])) === undefined,
      "the record to be dropped",
    );
    await until(
      async () =>
        !(await serves(
          carrier.url,
          published.capability.capsuleId,
          published.capability.readToken,
        )),
      "the copy to be removed",
    );

    // And it stays gone: an announcement is refused rather than quietly
    // re-accepted, which is what gossip would otherwise do on every round.
    const { announcedTo } = await announceSiteRecord(published.record, [
      carrier.url,
    ]);
    expect(announcedTo).toEqual([]);
    expect(await resolveSite(identity.name, [carrier.url])).toBeUndefined();

    // The relay that was never asked to refuse anything still serves it.
    expect(
      await serves(
        origin.url,
        published.capability.capsuleId,
        published.capability.readToken,
      ),
    ).toBe(true);
  });

  it("refuses a capsule identifier without touching the rest of the relay", async () => {
    const relay = await startRelay((config) => {
      config.denylistReloadMs = 50;
    });
    const { identity } = await createSiteIdentity();
    const kept = await createSiteIdentity();

    const denied = await publishSite({
      identity,
      files: [page("index.html", "<h1>denied</h1>")],
      relayUrl: relay.url,
      ttlSeconds: 600,
      sequence: 1,
    });
    const survivor = await publishSite({
      identity: kept.identity,
      files: [page("index.html", "<h1>untouched</h1>")],
      relayUrl: relay.url,
      ttlSeconds: 600,
      sequence: 1,
    });

    await writeFile(
      relay.config.denylistFile,
      JSON.stringify({ capsules: [denied.capability.capsuleId] }),
    );

    await until(
      async () =>
        !(await serves(
          relay.url,
          denied.capability.capsuleId,
          denied.capability.readToken,
        )),
      "the denied capsule to stop being served",
    );
    // The answer is the same 404 an unknown identifier gets: an operator's
    // refusal is theirs to publish, not the relay's to announce.
    const response = await fetch(
      `${relay.url}/v1/capsules/${denied.capability.capsuleId}/manifest`,
      { headers: { Authorization: `Bearer ${denied.capability.readToken}` } },
    );
    expect(response.status).toBe(404);

    expect(
      await serves(
        relay.url,
        survivor.capability.capsuleId,
        survivor.capability.readToken,
      ),
    ).toBe(true);
  });
});
