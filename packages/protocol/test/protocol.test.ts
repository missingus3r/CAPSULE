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
  encodeShareCapability,
  paddedLengthFor,
  shareLocations,
  sizeClassFor,
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

  it("accepts capsules without expiry from version 2 and rejects them in v1", async () => {
    const secrets = createCapsuleSecrets(2);
    const persistent: CapsuleMetadata = {
      version: 2,
      filename: "archivo.bin",
      mimeType: "application/octet-stream",
      byteLength: 10,
      chunkSize: 1024,
      chunkCount: 1,
      createdAt: "2026-08-29T00:00:00.000Z",
      expiresAt: null,
    };

    const encrypted = await encryptMetadata(persistent, secrets);
    await expect(decryptMetadata(encrypted, secrets)).resolves.toEqual(
      persistent,
    );
    await expect(
      encryptMetadata(
        { ...persistent, version: 1 },
        { ...secrets, version: 1 },
      ),
    ).rejects.toThrow("Invalid capsule metadata");
  });

  it("keeps version 1 capsules readable after later version bumps", async () => {
    const secrets = createCapsuleSecrets(1);
    const legacy: CapsuleMetadata = {
      version: 1,
      filename: "viejo.txt",
      mimeType: "text/plain",
      byteLength: 5,
      chunkSize: 1024,
      chunkCount: 1,
      createdAt: "2026-08-29T00:00:00.000Z",
      expiresAt: "2026-08-30T00:00:00.000Z",
    };

    const encrypted = await encryptMetadata(legacy, secrets);
    await expect(decryptMetadata(encrypted, secrets)).resolves.toEqual(legacy);
    // A later reader must not silently accept version 1 additional data.
    await expect(
      decryptMetadata(encrypted, { ...secrets, version: 2 }),
    ).rejects.toThrow("authentication failed");
    await expect(
      decryptMetadata(encrypted, { ...secrets, version: 3 }),
    ).rejects.toThrow("authentication failed");
  });

  it("pads capsules to whole chunks inside a coarse size class", () => {
    expect(sizeClassFor(1)).toBe(64 * 1024);
    expect(sizeClassFor(1_000_000)).toBe(1_048_576);
    expect(paddedLengthFor(3, 1024)).toBe(64 * 1024);
    expect(paddedLengthFor(1_500_000, 1024 * 1024) % (1024 * 1024)).toBe(0);
    expect(paddedLengthFor(1_500_000, 1024 * 1024)).toBeGreaterThanOrEqual(
      1_500_000,
    );
  });

  it("rejects padded metadata whose chunk count does not match the padding", async () => {
    const secrets = createCapsuleSecrets();
    await expect(
      encryptMetadata(
        {
          version: CAPSULE_PROTOCOL_VERSION,
          filename: "padded.bin",
          mimeType: "application/octet-stream",
          byteLength: 10,
          chunkSize: 1024,
          chunkCount: 1,
          createdAt: "2026-08-29T00:00:00.000Z",
          expiresAt: "2026-08-30T00:00:00.000Z",
          paddedLength: 2048,
        },
        secrets,
      ),
    ).rejects.toThrow("Invalid capsule metadata");
  });

  it("carries mirror relays inside the share capability", () => {
    const secrets = createCapsuleSecrets();
    const capability = {
      version: CAPSULE_PROTOCOL_VERSION,
      relayUrl: "https://relay-one.example",
      capsuleId: "a".repeat(32),
      readToken: "b".repeat(43),
      key: secrets.key,
      noncePrefix: secrets.noncePrefix,
      mirrors: [
        {
          relayUrl: "https://relay-two.example",
          capsuleId: "c".repeat(32),
          readToken: "d".repeat(43),
        },
      ],
    };

    const decoded = decodeShareCapability(encodeShareCapability(capability));
    expect(shareLocations(decoded)).toHaveLength(2);
    expect(shareLocations(decoded)[1]?.relayUrl).toBe(
      "https://relay-two.example",
    );
  });
});

describe("manifest padding", () => {
  const base = (filename: string, note?: string): CapsuleMetadata => ({
    version: CAPSULE_PROTOCOL_VERSION,
    filename,
    mimeType: "application/octet-stream",
    byteLength: 1000,
    chunkSize: 1000,
    chunkCount: 1,
    createdAt: "2026-08-30T00:00:00.000Z",
    expiresAt: null,
    ...(note ? { note } : {}),
  });

  it("gives every manifest the same length, whatever the file is called", async () => {
    const lengths = new Set<number>();
    for (const [filename, note] of [
      ["x.txt", undefined],
      ["Ana Pereira - passport scan 2019.jpg", undefined],
      ["y.bin", "a".repeat(300)],
    ] as Array<[string, string | undefined]>) {
      const secrets = createCapsuleSecrets();
      const ciphertext = await encryptMetadata(base(filename, note), secrets);
      lengths.add(ciphertext.byteLength);
    }
    // AES-GCM does not hide length, so without padding the ciphertext would
    // measure the filename and the note.
    expect(lengths.size).toBe(1);
  });

  it("does not let the padding reach whoever opens the capsule", async () => {
    const secrets = createCapsuleSecrets();
    const metadata = base("report.pdf", "for review");
    const decrypted = await decryptMetadata(
      await encryptMetadata(metadata, secrets),
      secrets,
    );
    expect(decrypted).toEqual(metadata);
    expect(Object.keys(decrypted)).not.toContain("p");
  });

  it("still round-trips a manifest large enough to need a bigger class", async () => {
    const secrets = createCapsuleSecrets();
    const metadata = base("big-note.bin", "n".repeat(4000));
    const ciphertext = await encryptMetadata(metadata, secrets);
    expect(ciphertext.byteLength).toBeGreaterThan(4096);
    expect(await decryptMetadata(ciphertext, secrets)).toEqual(metadata);
  });
});
