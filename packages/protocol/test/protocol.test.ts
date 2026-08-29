import { describe, expect, it } from "vitest";
import {
  CAPSULE_PROTOCOL_VERSION,
  buildShareUrl,
  createCapsuleSecrets,
  decodeOwnerCapability,
  decodeShareCapability,
  decryptChunk,
  decryptMetadata,
  encryptChunk,
  encryptMetadata,
  encodeOwnerCapability,
  type CapsuleMetadata,
} from "../src/index.js";

describe("CAPSULE protocol", () => {
  it("encrypts and authenticates independent chunks", async () => {
    const secrets = createCapsuleSecrets();
    const plaintext = new TextEncoder().encode("hola cápsula");
    const encrypted = await encryptChunk(plaintext, 3, secrets);

    expect(encrypted).not.toEqual(plaintext);
    await expect(decryptChunk(encrypted, 3, secrets)).resolves.toEqual(
      plaintext,
    );
    await expect(decryptChunk(encrypted, 4, secrets)).rejects.toThrow(
      "authentication failed",
    );
  });

  it("round-trips encrypted metadata", async () => {
    const secrets = createCapsuleSecrets();
    const metadata: CapsuleMetadata = {
      version: CAPSULE_PROTOCOL_VERSION,
      filename: "foto.jpg",
      mimeType: "image/jpeg",
      byteLength: 1234,
      chunkSize: 1024,
      chunkCount: 2,
      createdAt: "2026-08-29T00:00:00.000Z",
      expiresAt: "2026-08-30T00:00:00.000Z",
    };

    const encrypted = await encryptMetadata(metadata, secrets);
    await expect(decryptMetadata(encrypted, secrets)).resolves.toEqual(
      metadata,
    );
  });

  it("rejects inconsistent metadata before encryption", async () => {
    const secrets = createCapsuleSecrets();
    await expect(
      encryptMetadata(
        {
          version: CAPSULE_PROTOCOL_VERSION,
          filename: "invalido.bin",
          mimeType: "application/octet-stream",
          byteLength: 1,
          chunkSize: 1024,
          chunkCount: 0,
          createdAt: "2026-08-29T00:00:00.000Z",
          expiresAt: "2026-08-30T00:00:00.000Z",
        },
        secrets,
      ),
    ).rejects.toThrow("Invalid capsule metadata");
  });

  it("keeps all secrets inside the URL fragment", () => {
    const secrets = createCapsuleSecrets();
    const capsuleId = "a".repeat(32);
    const url = buildShareUrl("https://capsule.example/", {
      version: CAPSULE_PROTOCOL_VERSION,
      relayUrl: "https://relay.example",
      capsuleId,
      readToken: "b".repeat(43),
      ...secrets,
    });

    const parsed = new URL(url);
    expect(parsed.search).toBe("");
    expect(parsed.pathname).toBe("/");
    expect(decodeShareCapability(parsed.hash).capsuleId).toBe(capsuleId);
  });

  it("round-trips owner capabilities separately from share links", () => {
    const deleteToken = "c".repeat(43);
    const encoded = encodeOwnerCapability({
      relayUrl: "https://relay.example",
      capsuleId: "a".repeat(32),
      deleteToken,
    });

    expect(encoded).toMatch(/^capsule-owner:/u);
    expect(decodeOwnerCapability(encoded).deleteToken).toBe(deleteToken);
  });
});
