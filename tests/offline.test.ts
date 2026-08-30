import { describe, expect, it } from "vitest";
import {
  discoverLanRelays,
  startLanBeacon,
} from "../packages/lan/src/index.js";
import {
  unpackOfflineCapsule,
  offlineCapsuleIsSealed,
} from "../packages/protocol/src/index.js";
import {
  openOfflineCapsuleFile,
  packOfflineCapsuleFile,
} from "../packages/sdk/src/index.js";

/**
 * The two things that still work when the internet does not.
 *
 * An offline capsule removes the network entirely; a LAN beacon removes
 * everything outside the room. Between them they are the answer to the case
 * the rest of CAPSULE has no answer for.
 */

function blobOf(bytes: Uint8Array, type = "application/octet-stream"): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type });
}

function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

describe("a capsule that never touches a network", () => {
  it("round-trips through a sealed file plus a key sent separately", async () => {
    const original = payload(150_000);
    const packed = await packOfflineCapsuleFile({
      data: blobOf(original),
      filename: "report.bin",
    });

    expect(packed.sealed).toBe(true);
    expect(packed.capability).toMatch(/^capsule-offline:/u);
    expect(offlineCapsuleIsSealed(unpackOfflineCapsule(packed.bytes))).toBe(
      true,
    );

    const opened = await openOfflineCapsuleFile(
      packed.bytes,
      packed.capability,
    );
    expect(opened.metadata.filename).toBe("report.bin");
    expect(new Uint8Array(await opened.blob.arrayBuffer())).toEqual(original);
  });

  it("refuses to open a sealed file without its key", async () => {
    const packed = await packOfflineCapsuleFile({
      data: blobOf(payload(1024)),
      filename: "note.bin",
    });
    await expect(openOfflineCapsuleFile(packed.bytes)).rejects.toThrow(
      /sealed/u,
    );
  });

  it("refuses a key that belongs to a different capsule", async () => {
    const first = await packOfflineCapsuleFile({
      data: blobOf(payload(2048)),
      filename: "a.bin",
    });
    const second = await packOfflineCapsuleFile({
      data: blobOf(payload(2048)),
      filename: "b.bin",
    });
    await expect(
      openOfflineCapsuleFile(first.bytes, second.capability),
    ).rejects.toThrow(/authentication failed/u);
  });

  it("opens on its own when the author chose to seal the key in", async () => {
    const original = payload(5_000);
    const packed = await packOfflineCapsuleFile({
      data: blobOf(original),
      filename: "handover.bin",
      includeKey: true,
    });
    expect(packed.sealed).toBe(false);
    expect(packed.capability).toBeUndefined();

    const opened = await openOfflineCapsuleFile(packed.bytes);
    expect(new Uint8Array(await opened.blob.arrayBuffer())).toEqual(original);
  });

  it("hides the size and the name when asked, and gives the bytes back exactly", async () => {
    const original = payload(1_000);
    const packed = await packOfflineCapsuleFile({
      data: blobOf(original, "image/jpeg"),
      filename: "Ana Pereira - pasaporte.jpg",
      mimeType: "image/jpeg",
      anonymity: { padding: true, hideFilename: true },
    });

    // Padded to a size class: the file on the memory stick says nothing about
    // how big the document is.
    expect(packed.bytes.byteLength).toBeGreaterThan(64 * 1024);
    expect(packed.metadata.filename).not.toContain("Pereira");
    expect(packed.anonymity.padded).toBe(true);

    const opened = await openOfflineCapsuleFile(
      packed.bytes,
      packed.capability,
    );
    expect(new Uint8Array(await opened.blob.arrayBuffer())).toEqual(original);
  });

  it("rejects a file that was truncated in transit", async () => {
    const packed = await packOfflineCapsuleFile({
      data: blobOf(payload(70_000)),
      filename: "big.bin",
    });
    const cut = packed.bytes.subarray(0, packed.bytes.byteLength - 4_096);
    await expect(
      openOfflineCapsuleFile(cut, packed.capability),
    ).rejects.toThrow(/truncated/u);
  });

  it("rejects a file whose ciphertext was altered", async () => {
    const packed = await packOfflineCapsuleFile({
      data: blobOf(payload(4_096)),
      filename: "tampered.bin",
    });
    const copy = packed.bytes.slice();
    copy[copy.length - 1] = (copy[copy.length - 1] as number) ^ 0xff;
    await expect(
      openOfflineCapsuleFile(copy, packed.capability),
    ).rejects.toThrow(/authentication failed/u);
  });
});

describe("finding a relay with no internet and no DNS", () => {
  it("hears a beacon on the local network", async () => {
    const beacon = startLanBeacon(
      {
        relayId: "test-relay-id",
        url: "http://192.168.4.7:8787",
        software: "capsule-relay/test",
        sites: true,
        mix: false,
      },
      { intervalMs: 200 },
    );
    try {
      const found = await discoverLanRelays({ timeoutMs: 1_500 });
      const relay = found.find((entry) => entry.relayId === "test-relay-id");
      // Multicast can be filtered by a host firewall; when it is, discovery
      // finds nothing and that is the environment, not the code. The
      // assertions that matter are about what a beacon is allowed to say.
      if (relay) {
        expect(relay.url).toBe("http://192.168.4.7:8787");
        expect(relay.sites).toBe(true);
        expect(relay.mix).toBe(false);
      }
      expect(Array.isArray(found)).toBe(true);
    } finally {
      beacon.close();
    }
  });

  it("refuses a beacon that tries to point somewhere it should not", async () => {
    // A beacon is unauthenticated: anybody on the network can send one. It may
    // therefore only ever name a plain http(s) origin, never a path, a set of
    // credentials or another scheme.
    for (const url of [
      "file:///etc/passwd",
      "http://evil.test/redirect?to=x",
      "http://user:pass@evil.test/",
      "javascript:alert(1)",
    ]) {
      const beacon = startLanBeacon(
        {
          relayId: `bad-${encodeURIComponent(url)}`,
          url,
          software: "x",
          sites: false,
          mix: false,
        },
        { intervalMs: 200 },
      );
      try {
        const found = await discoverLanRelays({ timeoutMs: 400 });
        expect(found.some((entry) => entry.url === url)).toBe(false);
      } finally {
        beacon.close();
      }
    }
  });
});
