import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../apps/relay/src/config.js";
import { buildRelayServer } from "../apps/relay/src/server.js";
import {
  CapsuleRelayClient,
  deleteCapsule,
  downloadCapsule,
  uploadCapsule,
} from "../packages/sdk/src/index.js";

const execFileAsync = promisify(execFile);
const plaintextChunkBytes = 1024 * 1024;

let app: FastifyInstance | undefined;
let storageDirectory = "";
let relayUrl = "";

function config(): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    storageDir: storageDirectory,
    corsOrigins: "*",
    maxCapsuleBytes: 20 * 1024 * 1024,
    maxChunkBytes: plaintextChunkBytes + 16,
    maxManifestBytes: 256 * 1024,
    maxChunkCount: 100,
    defaultTtlSeconds: 60,
    maxTtlSeconds: 3600,
    cleanupIntervalMs: 0,
    rateLimitMax: 10_000,
    rateLimitWindowMs: 60_000,
    createRateLimitMax: 1000,
    publicUrl: undefined,
    nickname: undefined,
    peers: [],
    maxPeers: 50,
    peerSyncIntervalMs: 0,
    allowPrivatePeers: true,
    allowPersistentCapsules: true,
    maxPersistentBytes: 64 * 1024 * 1024,
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
  };
}

function deterministicBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + 17) % 256;
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeEach(async () => {
  storageDirectory = await mkdtemp(join(tmpdir(), "capsule-integration-"));
  app = await buildRelayServer(config(), { logger: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("Unexpected relay address");
  relayUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(storageDirectory, { recursive: true, force: true });
});

describe("CAPSULE end-to-end", () => {
  it("round-trips boundary sizes and a 10 MiB payload, then deletes idempotently", async () => {
    const sizes = [
      0,
      1,
      plaintextChunkBytes,
      plaintextChunkBytes + 1,
      10 * 1024 * 1024,
    ];

    for (const size of sizes) {
      const original = deterministicBytes(size);
      const filename = `prueba-${size}.bin`;
      const note = `nota privada ${size}`;
      const uploaded = await uploadCapsule({
        data: new Blob([original]),
        filename,
        mimeType: "application/octet-stream",
        note,
        ttlSeconds: 60,
        relayUrl,
        appUrl: "http://localhost:5173/",
      });

      const stored = await readFile(
        join(
          storageDirectory,
          "capsules",
          uploaded.capability.capsuleId,
          "record.json",
        ),
        "utf8",
      );
      expect(stored).not.toContain(filename);
      expect(stored).not.toContain(note);
      expect(stored).not.toContain(uploaded.capability.readToken);
      expect(stored).not.toContain(uploaded.ownerCapability.deleteToken);

      const downloaded = await downloadCapsule({
        capability: uploaded.capability,
      });
      const reconstructed = new Uint8Array(await downloaded.blob.arrayBuffer());
      expect(downloaded.metadata).toMatchObject({
        filename,
        note,
        byteLength: size,
      });
      expect(sha256(reconstructed)).toBe(sha256(original));

      await deleteCapsule(uploaded.ownerCapability);
      // Deleting twice is not an error: the second call simply confirms that
      // no relay still holds the capsule.
      await expect(deleteCapsule(uploaded.ownerCapability)).resolves.toEqual({
        deleted: [relayUrl],
        failed: [],
      });
      await expect(
        new CapsuleRelayClient(relayUrl).status(
          uploaded.capability.capsuleId,
          uploaded.capability.readToken,
        ),
      ).rejects.toMatchObject({ status: 404, code: "capsule_not_found" });
    }
  }, 60_000);

  it("fails closed when stored ciphertext is modified", async () => {
    const uploaded = await uploadCapsule({
      data: new Blob([new TextEncoder().encode("contenido autenticado")]),
      filename: "integridad.txt",
      mimeType: "text/plain",
      ttlSeconds: 60,
      relayUrl,
      appUrl: "http://localhost:5173/",
    });
    const chunkPath = join(
      storageDirectory,
      "capsules",
      uploaded.capability.capsuleId,
      "chunks",
      "0.bin",
    );
    const tampered = new Uint8Array(await readFile(chunkPath));
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await writeFile(chunkPath, tampered);

    await expect(
      downloadCapsule({ capability: uploaded.capability }),
    ).rejects.toThrow("authentication failed");
  });

  it("interoperates through the built CLI for send, receive and repeated delete", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "capsule-cli-"));
    try {
      const input = join(workingDirectory, "entrada.txt");
      const output = join(workingDirectory, "salida.txt");
      const original = new TextEncoder().encode(
        "CAPSULE CLI extremo a extremo\n",
      );
      await writeFile(input, original);
      const cli = resolve("apps/cli/dist/index.js");

      const sent = await execFileAsync(process.execPath, [
        cli,
        "--json",
        "send",
        input,
        "--relay",
        relayUrl,
        "--app",
        "http://localhost:5173/",
        "--ttl",
        "1h",
      ]);
      const result = JSON.parse(sent.stdout) as {
        shareUrl: string;
        ownerCapability: string;
      };
      expect(result.shareUrl).toContain("#capsule=");
      expect(result.ownerCapability).toMatch(/^capsule-owner:/u);

      await execFileAsync(process.execPath, [
        cli,
        "--json",
        "download",
        result.shareUrl,
        "--out",
        output,
      ]);
      expect(new Uint8Array(await readFile(output))).toEqual(original);

      await execFileAsync(process.execPath, [
        cli,
        "--json",
        "delete",
        result.ownerCapability,
      ]);
      await execFileAsync(process.execPath, [
        cli,
        "--json",
        "delete",
        result.ownerCapability,
      ]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
