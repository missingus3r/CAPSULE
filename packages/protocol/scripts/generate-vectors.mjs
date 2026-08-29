#!/usr/bin/env node
/**
 * Regenerates the official CAPSULE test vectors.
 *
 * The vectors let a second implementation prove it is compatible without
 * reading this one. Everything here is deterministic: keys and nonce prefixes
 * are fixed constants, never random, so the file only changes when the
 * protocol changes — which is exactly when a reviewer should look at the diff.
 *
 * Run with: node packages/protocol/scripts/generate-vectors.mjs
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  encodeOwnerCapability,
  encodeShards,
  encodeShareCapability,
  encryptChunk,
  encryptMetadata,
  paddedLengthFor,
  sizeClassFor,
  toBase64Url,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = toBase64Url(
  Uint8Array.from({ length: 32 }, (_unused, index) => index),
);
const NONCE_PREFIX = toBase64Url(
  Uint8Array.from({ length: 8 }, (_unused, index) => 0xa0 + index),
);
const text = (value) => new TextEncoder().encode(value);

const chunkVectors = [];
for (const version of [1, 2, 3]) {
  for (const [index, plaintext] of [
    [0, text("")],
    [1, text("hola cápsula")],
    [2, Uint8Array.from({ length: 64 }, (_unused, i) => (i * 7) % 256)],
  ]) {
    const secrets = { key: KEY, noncePrefix: NONCE_PREFIX, version };
    chunkVectors.push({
      protocolVersion: version,
      index,
      plaintext: toBase64Url(plaintext),
      ciphertext: toBase64Url(await encryptChunk(plaintext, index, secrets)),
    });
  }
}

const manifestVectors = [];
for (const metadata of [
  {
    version: 1,
    filename: "informe.pdf",
    mimeType: "application/pdf",
    byteLength: 2048,
    chunkSize: 1024,
    chunkCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
  },
  {
    version: 2,
    filename: "capsule.bin",
    mimeType: "application/octet-stream",
    byteLength: 10,
    chunkSize: 65536,
    chunkCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    paddedLength: 65536,
  },
  {
    version: 3,
    filename: "video.mp4",
    mimeType: "video/mp4",
    byteLength: 300000,
    chunkSize: 32768,
    chunkCount: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-08T00:00:00.000Z",
    paddedLength: 327680,
    note: "una nota privada",
  },
]) {
  manifestVectors.push({
    metadata,
    encryptedManifest: toBase64Url(
      await encryptMetadata(metadata, {
        key: KEY,
        noncePrefix: NONCE_PREFIX,
        version: metadata.version,
      }),
    ),
  });
}

const shareCapability = {
  version: 3,
  relayUrl: "https://relay-one.example",
  capsuleId: "A".repeat(32),
  readToken: "B".repeat(43),
  key: KEY,
  noncePrefix: NONCE_PREFIX,
  mirrors: [
    {
      relayUrl: "https://relay-two.example",
      capsuleId: "C".repeat(32),
      readToken: "D".repeat(43),
    },
    {
      relayUrl: "https://relay-three.example",
      capsuleId: "E".repeat(32),
      readToken: "F".repeat(43),
    },
  ],
  sharding: { k: 2, n: 3, blockBytes: 32784, shardBytes: 16392 },
};

const ownerCapability = {
  capsuleId: "A".repeat(32),
  deleteToken: "G".repeat(43),
  relayUrl: "https://relay-one.example",
};

const erasureBlock = Uint8Array.from(
  { length: 100 },
  (_unused, index) => (index * 13 + 5) % 256,
);
const erasureVectors = [
  { k: 2, n: 3 },
  { k: 3, n: 5 },
].map((layout) => ({
  layout,
  block: toBase64Url(erasureBlock),
  shards: encodeShards(erasureBlock, layout).map(toBase64Url),
}));

const document = {
  format: 1,
  generatedBy: "packages/protocol/scripts/generate-vectors.mjs",
  key: KEY,
  noncePrefix: NONCE_PREFIX,
  chunks: chunkVectors,
  manifests: manifestVectors,
  capabilities: {
    share: {
      capability: shareCapability,
      encoded: encodeShareCapability(shareCapability),
    },
    owner: {
      capability: ownerCapability,
      encoded: encodeOwnerCapability(ownerCapability),
    },
  },
  sizeClasses: [0, 1, 100, 65536, 200000, 1_500_000, 10_485_760].map(
    (byteLength) => ({
      byteLength,
      sizeClass: sizeClassFor(byteLength),
      paddedWithMiBChunks: paddedLengthFor(byteLength, 1024 * 1024),
    }),
  ),
  erasure: erasureVectors,
};

await writeFile(
  join(here, "..", "vectors", "capsule-test-vectors.json"),
  `${JSON.stringify(document, null, 2)}\n`,
);
console.log("wrote packages/protocol/vectors/capsule-test-vectors.json");
