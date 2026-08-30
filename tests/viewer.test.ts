import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../apps/relay/src/config.js";
import { buildRelayServer } from "../apps/relay/src/server.js";
import { renderSitePage, sandboxFor } from "../apps/extension/src/render.js";
import {
  siteContentType,
  unpackSite,
  type SiteFile,
} from "../packages/protocol/src/index.js";
import {
  createSiteIdentity,
  fetchSiteBytes,
  publishSite,
  resolveSite,
} from "../packages/sdk/src/index.js";

/**
 * The whole path a visitor takes, with a real relay at one end and the
 * extension's renderer at the other. Everything between the address bar and
 * the pixels is exercised here except Chrome's own enforcement of the sandbox
 * and the redirect rule, which only a browser can prove.
 */

const directories: string[] = [];
const servers: FastifyInstance[] = [];
const VIEWER = "chrome-extension://capsule/viewer.html";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function startRelay(): Promise<string> {
  const storageDir = await mkdtemp(join(tmpdir(), "capsule-viewer-e2e-"));
  directories.push(storageDir);
  const config: RelayConfig = {
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
    sitesEnabled: true,
    maxSites: 64,
    siteGossipLimit: 32,
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
  const app = await buildRelayServer(config, { logger: false });
  servers.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected relay address");
  }
  return `http://127.0.0.1:${address.port}`;
}

const encoder = new TextEncoder();

function page(path: string, body: string): SiteFile {
  return { path, type: siteContentType(path), bytes: encoder.encode(body) };
}

const dom = new JSDOM("<!doctype html><html></html>");
const parse = (html: string): Document =>
  new dom.window.DOMParser().parseFromString(html, "text/html") as Document;

describe("what the extension actually shows", () => {
  it("resolves, downloads and rebuilds a site with nothing left pointing outside", async () => {
    const relay = await startRelay();
    const { identity } = await createSiteIdentity();

    await publishSite({
      identity,
      files: [
        page(
          "index.html",
          [
            '<html><head><title>Demo</title><link rel="stylesheet" href="/style.css"></head>',
            "<body><h1>No server</h1>",
            '<img src="mark.svg" alt="">',
            '<a href="/about/">about</a>',
            '<a href="https://example.test/">outside</a>',
            '<script src="https://cdn.test/t.js"></script>',
            '<img src="https://tracker.test/p.gif" alt="">',
            "</body></html>",
          ].join(""),
        ),
        page("style.css", "body{background:url(mark.svg)}"),
        page("mark.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>"),
        page(
          "about/index.html",
          '<html><body><a href="../">back</a></body></html>',
        ),
      ],
      relayUrl: relay,
      ttlSeconds: 600,
      sequence: 1,
      title: "Demo",
    });

    const resolved = await resolveSite(identity.name, [relay]);
    expect(resolved).toBeDefined();

    const bundle = unpackSite(await fetchSiteBytes(resolved!.capability));
    const rendered = renderSitePage({
      bundle,
      path: "index.html",
      name: identity.name,
      viewerUrl: VIEWER,
      parse,
    });

    // Nothing in the finished document can reach the network.
    expect(rendered.html).not.toMatch(/(?:src|href)="https?:/iu);
    expect(rendered.html).not.toContain("cdn.test");
    expect(rendered.html).not.toContain("tracker.test");
    expect(rendered.html).not.toContain("<script");
    expect(rendered.blockedExternals).toContain("https://tracker.test/p.gif");

    // What it needs, it carries with it.
    expect(rendered.html).toContain("data:text/css;base64,");
    expect(rendered.html).toContain("data:image/svg+xml;base64,");

    // The policy is the first thing the parser sees.
    expect(rendered.html.indexOf("Content-Security-Policy")).toBeLessThan(
      rendered.html.indexOf("<title"),
    );
    expect(rendered.html).toContain("connect-src 'none'");

    // Internal navigation goes back through the viewer; leaving is a choice.
    expect(rendered.html).toContain(
      `${VIEWER}#http://${identity.name}/about/index.html`,
    );
    expect(rendered.html).toContain(
      `${VIEWER}#external:${encodeURIComponent("https://example.test/")}`,
    );
    expect(rendered.externalLinks).toEqual(["https://example.test/"]);
    expect(sandboxFor(false)).not.toContain("allow-scripts");

    const second = renderSitePage({
      bundle,
      path: "about/index.html",
      name: identity.name,
      viewerUrl: VIEWER,
      parse,
    });
    expect(second.html).toContain(
      `${VIEWER}#http://${identity.name}/index.html`,
    );
  });
});
