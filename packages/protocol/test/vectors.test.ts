import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeOwnerCapability,
  decodeShareCapability,
  decryptChunk,
  decryptMetadata,
  encodeOwnerCapability,
  encodeShardsFor,
  encodeShareCapability,
  encryptChunk,
  encryptMetadata,
  fromBase64Url,
  paddedLengthFor,
  sizeClassFor,
  toBase64Url,
  type CapsuleMetadata,
  type CapsuleProtocolVersion,
} from "./helpers.js";

/**
 * Conformance against the published vectors.
 *
 * These are the bytes another implementation has to reproduce to interoperate.
 * If a change here forces the vectors to be regenerated, the protocol changed:
 * it needs a version bump, a note in PROTOCOL.md and a reviewer's eyes. That
 * is the whole point of freezing them.
 */

interface Vectors {
  format: number;
  key: string;
  noncePrefix: string;
  chunks: Array<{
    protocolVersion: CapsuleProtocolVersion;
    index: number;
    plaintext: string;
    ciphertext: string;
  }>;
  manifests: Array<{ metadata: CapsuleMetadata; encryptedManifest: string }>;
  capabilities: {
    share: { capability: unknown; encoded: string };
    owner: { capability: unknown; encoded: string };
  };
  sizeClasses: Array<{
    byteLength: number;
    sizeClass: number;
    paddedWithMiBChunks: number;
  }>;
  erasure: Array<{
    layout: { k: number; n: number };
    block: string;
    shards: string[];
  }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  await readFile(
    join(here, "..", "vectors", "capsule-test-vectors.json"),
    "utf8",
  ),
) as Vectors;

/** base64url of an empty byte string is the empty string, which never decodes. */
function decodeMaybeEmpty(value: string): Uint8Array {
  return value === "" ? new Uint8Array(0) : fromBase64Url(value);
}

describe("CAPSULE conformance vectors", () => {
  it("uses a vectors file this implementation understands", () => {
    expect(vectors.format).toBe(1);
    expect(vectors.chunks.length).toBeGreaterThan(0);
    expect(vectors.manifests.length).toBeGreaterThan(0);
  });

  it("reproduces every chunk ciphertext byte for byte", async () => {
    for (const vector of vectors.chunks) {
      const secrets = {
        key: vectors.key,
        noncePrefix: vectors.noncePrefix,
        version: vector.protocolVersion,
      };
      const plaintext = decodeMaybeEmpty(vector.plaintext);
      const ciphertext = await encryptChunk(plaintext, vector.index, secrets);
      expect(toBase64Url(ciphertext)).toBe(vector.ciphertext);
      await expect(
        decryptChunk(fromBase64Url(vector.ciphertext), vector.index, secrets),
      ).resolves.toEqual(plaintext);
    }
  });

  it("reproduces every encrypted manifest and reads it back", async () => {
    for (const vector of vectors.manifests) {
      const secrets = {
        key: vectors.key,
        noncePrefix: vectors.noncePrefix,
        version: vector.metadata.version,
      };
      const encrypted = await encryptMetadata(vector.metadata, secrets);
      expect(toBase64Url(encrypted)).toBe(vector.encryptedManifest);
      await expect(
        decryptMetadata(fromBase64Url(vector.encryptedManifest), secrets),
      ).resolves.toEqual(vector.metadata);
    }
  });

  it("encodes capabilities exactly as published", () => {
    const share = vectors.capabilities.share;
    expect(encodeShareCapability(share.capability as never)).toBe(
      share.encoded,
    );
    expect(decodeShareCapability(share.encoded)).toEqual(share.capability);

    const owner = vectors.capabilities.owner;
    expect(encodeOwnerCapability(owner.capability as never)).toBe(
      owner.encoded,
    );
    expect(decodeOwnerCapability(owner.encoded)).toEqual(owner.capability);
  });

  it("computes the published size classes", () => {
    for (const vector of vectors.sizeClasses) {
      expect(sizeClassFor(vector.byteLength)).toBe(vector.sizeClass);
      expect(paddedLengthFor(vector.byteLength, 1024 * 1024)).toBe(
        vector.paddedWithMiBChunks,
      );
    }
  });

  it("produces the published erasure shards", () => {
    for (const vector of vectors.erasure) {
      const block = fromBase64Url(vector.block);
      const shards = encodeShardsFor(block, vector.layout).map(toBase64Url);
      expect(shards).toEqual(vector.shards);
    }
  });
});
