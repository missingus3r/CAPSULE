import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../apps/relay/src/config.js";
import { buildRelayServer } from "../apps/relay/src/server.js";
import {
  bridgeCookie,
  decodeBridgeLine,
  deriveBridgeSecrets,
  randomBridgeKey,
  toBase64Url,
} from "../packages/protocol/src/index.js";
import {
  CapsuleRelayClient,
  downloadCapsule,
  fetchRelayPeers,
  uploadCapsule,
} from "../packages/sdk/src/index.js";

/**
 * Written from the censor's side of the wire.
 *
 * The question a bridge has to answer is not "can a client use it" — that is
 * the easy half — but "can somebody who suspects this address confirm what it
 * is with one request". Most of the assertions below are about what the bridge
 * does *not* say.
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

async function startRelay(
  overrides: Partial<RelayConfig> = {},
): Promise<{ app: FastifyInstance; config: RelayConfig; url: string }> {
  const storageDir = await mkdtemp(join(tmpdir(), "capsule-bridge-e2e-"));
  directories.push(storageDir);
  const config = relayConfig(storageDir, overrides);
  Object.assign(config, overrides);
  const app = await buildRelayServer(config, { logger: false });
  servers.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected relay address");
  }
  return { app, config, url: `http://127.0.0.1:${address.port}` };
}

async function startBridge(): Promise<{
  app: FastifyInstance;
  url: string;
  line: string;
  prefix: string;
}> {
  const key = randomBridgeKey();
  const bridge = await startRelay({
    bridgeMode: true,
    bridgeKey: toBase64Url(key),
  });
  const port = Number(new URL(bridge.url).port);
  const { pathPrefix } = await deriveBridgeSecrets(key);
  return {
    app: bridge.app,
    url: bridge.url,
    line: bridge.app.capsuleBridge!.line("127.0.0.1", port, false),
    prefix: pathPrefix,
  };
}

describe("what a censor sees when probing a bridge", () => {
  it("answers a probe for the relay API like an ordinary web server", async () => {
    const bridge = await startBridge();

    for (const path of [
      "/v1/info",
      "/v1/peers",
      "/v1/config",
      "/health",
      "/healthz",
      "/v1/capsules",
      "/v1/sites",
    ]) {
      const response = await fetch(`${bridge.url}${path}`);
      const body = await response.text();
      expect(response.status, path).toBe(404);
      expect(body, path).not.toContain("capsule");
      expect(body, path).not.toContain("relayId");
      expect(response.headers.get("content-type")).toContain("text/html");
    }

    // The root is the only thing that answers, and it answers with a page that
    // says nothing.
    const root = await fetch(`${bridge.url}/`);
    expect(root.status).toBe(200);
    const page = await root.text();
    expect(page).toContain("It works");
    expect(page).not.toContain("CAPSULE");
  });

  it("says nothing different when the prefix is right but the token is missing", async () => {
    const bridge = await startBridge();

    const withoutToken = await fetch(`${bridge.url}/${bridge.prefix}/v1/info`);
    expect(withoutToken.status).toBe(404);
    expect(await withoutToken.text()).not.toContain("relayId");

    const withGarbage = await fetch(`${bridge.url}/${bridge.prefix}/v1/info`, {
      headers: { Cookie: "sid=not-a-real-token" },
    });
    expect(withGarbage.status).toBe(404);

    // A well-formed token for a *different* path must not open this one.
    const key = decodeBridgeLine(bridge.line).key;
    const secrets = await deriveBridgeSecrets(key);
    const forOtherPath = await bridgeCookie(secrets, "GET", "/v1/peers");
    const crossed = await fetch(`${bridge.url}/${bridge.prefix}/v1/info`, {
      headers: { Cookie: forOtherPath.header },
    });
    expect(crossed.status).toBe(404);
  });

  it("refuses a token that is replayed, so recorded traffic is not a probe", async () => {
    const bridge = await startBridge();
    const secrets = await deriveBridgeSecrets(
      decodeBridgeLine(bridge.line).key,
    );
    const cookie = await bridgeCookie(secrets, "GET", "/v1/info");

    const first = await fetch(`${bridge.url}/${bridge.prefix}/v1/info`, {
      headers: { Cookie: cookie.header },
    });
    expect(first.status).toBe(200);

    const replayed = await fetch(`${bridge.url}/${bridge.prefix}/v1/info`, {
      headers: { Cookie: cookie.header },
    });
    expect(replayed.status).toBe(404);
    expect(await replayed.text()).not.toContain("relayId");
  });

  it("refuses a token from outside the clock window", async () => {
    const bridge = await startBridge();
    const secrets = await deriveBridgeSecrets(
      decodeBridgeLine(bridge.line).key,
    );
    const old = await bridgeCookie(
      secrets,
      "GET",
      "/v1/info",
      Date.now() - 30 * 60 * 1000,
    );
    const response = await fetch(`${bridge.url}/${bridge.prefix}/v1/info`, {
      headers: { Cookie: old.header },
    });
    expect(response.status).toBe(404);
  });

  it("never appears in the peer list of a relay it talks to", async () => {
    const public1 = await startRelay({ nickname: "public" });
    public1.config.publicUrl = public1.url;

    const bridge = await startBridge();
    // The bridge knows the public relay and syncs with it, which is how it
    // learns the network. It must not end up listed anywhere as a result.
    bridge.app.capsulePeers.config.peers.push(public1.url);
    await bridge.app.capsulePeers.sync();

    const urls = await fetchRelayPeers(public1.url);
    expect(urls).not.toContain(bridge.url);
    expect(urls.some((url) => url.includes(new URL(bridge.url).port))).toBe(
      false,
    );
  });
});

describe("what a client with the bridge line can do", () => {
  it("moves a capsule end to end through the bridge", async () => {
    const bridge = await startBridge();
    const descriptor = decodeBridgeLine(bridge.line);
    const transport = (relayUrl: string): CapsuleRelayClient =>
      new CapsuleRelayClient(relayUrl, { bridge: descriptor });

    const payload = new TextEncoder().encode(
      "readable only by someone who was given the line",
    );
    const uploaded = await uploadCapsule({
      data: new Blob([payload.slice().buffer], { type: "text/plain" }),
      filename: "note.txt",
      mimeType: "text/plain",
      ttlSeconds: 600,
      relayUrl: bridge.url,
      appUrl: "https://capsule.test/",
      transport,
    });

    const downloaded = await downloadCapsule({
      capability: uploaded.capability,
      transport,
    });
    expect(new TextDecoder().decode(await downloaded.blob.arrayBuffer())).toBe(
      "readable only by someone who was given the line",
    );
  });

  it("cannot be reached by a client that does not have the line", async () => {
    const bridge = await startBridge();
    const plain = new CapsuleRelayClient(bridge.url);
    await expect(plain.config()).rejects.toThrow();
  });

  it("round-trips a bridge line, including an IPv6 host", () => {
    const key = randomBridgeKey();
    for (const host of ["203.0.113.9", "bridge.example.org", "2001:db8::1"]) {
      const line = `capsule-bridge:1:${toBase64Url(new TextEncoder().encode(host))}:8443:1:${toBase64Url(key)}`;
      const decoded = decodeBridgeLine(line);
      expect(decoded.host).toBe(host);
      expect(decoded.port).toBe(8443);
      expect(decoded.tls).toBe(true);
      expect([...decoded.key]).toEqual([...key]);
    }
    expect(() => decodeBridgeLine("capsule-bridge:1:x:y")).toThrow();
    expect(() => decodeBridgeLine("https://example.org")).toThrow();
  });
});
