import { describe, expect, it } from "vitest";
import {
  MINIMUM_PBKDF2_ITERATIONS,
  combineShares,
  decodeRecoveryBlob,
  decodeShare,
  decodeShards,
  encodeShare,
  encodeShards,
  gfDivide,
  gfInverse,
  gfMultiply,
  shardCombinations,
  shardLengthFor,
  splitSecret,
  unwrapWithPassphrase,
  wrapWithPassphrase,
} from "../src/index.js";

function pseudoRandom(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = (state >>> 16) & 0xff;
  }
  return bytes;
}

describe("GF(256) arithmetic", () => {
  it("behaves like a field", () => {
    for (let value = 1; value < 256; value += 1) {
      expect(gfMultiply(value, gfInverse(value))).toBe(1);
      expect(gfDivide(value, value)).toBe(1);
    }
    expect(gfMultiply(0, 123)).toBe(0);
    expect(() => gfInverse(0)).toThrow("no inverse");
    expect(() => gfDivide(1, 0)).toThrow("Division by zero");
  });
});

describe("Reed-Solomon erasure coding", () => {
  it("reconstructs a block from every possible set of k shards", () => {
    const block = pseudoRandom(1000);
    const layout = { k: 2, n: 4 };
    const shards = encodeShards(block, layout);
    expect(shards).toHaveLength(4);
    expect(shards[0]?.byteLength).toBe(shardLengthFor(block.length, 2));

    for (const combination of shardCombinations([0, 1, 2, 3], 2, 100)) {
      const available = shards.map((shard, index) =>
        combination.includes(index) ? shard : undefined,
      );
      expect(decodeShards(available, layout, block.length)).toEqual(block);
    }
  });

  it("survives the loss of n - k shards with a larger layout", () => {
    const block = pseudoRandom(4096, 19);
    const layout = { k: 3, n: 5 };
    const shards = encodeShards(block, layout);
    const available = shards.map((shard, index) =>
      index === 0 || index === 4 ? undefined : shard,
    );
    expect(decodeShards(available, layout, block.length)).toEqual(block);
  });

  it("refuses to reconstruct with fewer than k shards", () => {
    const block = pseudoRandom(64);
    const layout = { k: 3, n: 5 };
    const shards = encodeShards(block, layout);
    const available = shards.map((shard, index) =>
      index < 2 ? shard : undefined,
    );
    expect(() => decodeShards(available, layout, block.length)).toThrow(
      "needs 3 shards",
    );
  });

  it("produces a different block when a shard is tampered with", () => {
    const block = pseudoRandom(256, 3);
    const layout = { k: 2, n: 3 };
    const shards = encodeShards(block, layout);
    const tampered = shards.map((shard) => Uint8Array.from(shard));
    const target = tampered[1] as Uint8Array;
    target[0] = (target[0] as number) ^ 0xff;
    // Reconstruction cannot detect this on its own; the capsule's AES-GCM tag
    // is what fails afterwards. What matters here is that it does not silently
    // return the original block.
    expect(decodeShards(tampered, layout, block.length)).not.toEqual(block);
  });

  it("rejects impossible layouts", () => {
    expect(() => encodeShards(pseudoRandom(16), { k: 1, n: 3 })).toThrow(
      "Invalid erasure layout",
    );
    expect(() => encodeShards(pseudoRandom(16), { k: 3, n: 3 })).toThrow(
      "Invalid erasure layout",
    );
    expect(() => encodeShards(pseudoRandom(16), { k: 2, n: 99 })).toThrow(
      "Invalid erasure layout",
    );
  });
});

describe("Shamir secret sharing", () => {
  const secret = new TextEncoder().encode(
    "capsule-owner:eyJjYXBzdWxlSWQiOiJleGFtcGxlIn0",
  );

  it("rebuilds the secret from any threshold subset", () => {
    const shares = splitSecret(secret, 2, 4);
    expect(shares).toHaveLength(4);
    expect(combineShares([shares[0]!, shares[3]!])).toEqual(secret);
    expect(combineShares([shares[1]!, shares[2]!])).toEqual(secret);
    expect(combineShares(shares)).toEqual(secret);
  });

  it("refuses to rebuild with fewer shares than the threshold", () => {
    const shares = splitSecret(secret, 3, 5);
    expect(() => combineShares([shares[0]!, shares[1]!])).toThrow(
      "needs 3 different shares",
    );
    // A repeated share is not a second share.
    expect(() => combineShares([shares[0]!, shares[0]!, shares[0]!])).toThrow(
      "needs 3 different shares",
    );
  });

  it("detects shares that belong to different splits", () => {
    const first = splitSecret(secret, 2, 3);
    const second = splitSecret(secret, 2, 3);
    expect(() => combineShares([first[0]!, second[1]!])).toThrow(
      "different splits",
    );
  });

  it("round-trips the printable share encoding", () => {
    const shares = splitSecret(secret, 2, 3);
    const encoded = shares.map(encodeShare);
    expect(encoded[0]).toMatch(/^capsule-share:/u);
    const decoded = encoded.slice(0, 2).map(decodeShare);
    expect(combineShares(decoded)).toEqual(secret);
    expect(() => decodeShare("capsule-share:not-base64!")).toThrow();
    expect(() => decodeShare("nope")).toThrow("Not a CAPSULE share");
  });

  it("rejects splits that could not protect anything", () => {
    expect(() => splitSecret(secret, 1, 3)).toThrow("threshold of at least 2");
    expect(() => splitSecret(secret, 3, 2)).toThrow("threshold of at least 2");
    expect(() => splitSecret(new Uint8Array(0), 2, 3)).toThrow(
      "cannot be empty",
    );
  });
});

describe("passphrase recovery", () => {
  const iterations = MINIMUM_PBKDF2_ITERATIONS;
  const capability = "capsule-owner:eyJjYXBzdWxlSWQiOiJleGFtcGxlIn0";

  it("wraps and unwraps a capability", async () => {
    const blob = await wrapWithPassphrase(capability, "correcta caballo", {
      iterations,
      label: "cápsula del martes",
    });
    expect(blob).toMatch(/^capsule-recovery:/u);
    expect(blob).not.toContain(capability);
    expect(decodeRecoveryBlob(blob).label).toBe("cápsula del martes");
    await expect(unwrapWithPassphrase(blob, "correcta caballo")).resolves.toBe(
      capability,
    );
  });

  it("fails closed on a wrong passphrase", async () => {
    const blob = await wrapWithPassphrase(capability, "correcta caballo", {
      iterations,
    });
    await expect(unwrapWithPassphrase(blob, "incorrecta")).rejects.toThrow(
      "does not open",
    );
  });

  it("refuses a downgraded iteration count", async () => {
    const blob = await wrapWithPassphrase(capability, "correcta caballo", {
      iterations: iterations * 2,
    });
    const decoded = decodeRecoveryBlob(blob);
    const tampered = `capsule-recovery:${Buffer.from(
      JSON.stringify({ ...decoded, iterations }),
      "utf8",
    ).toString("base64url")}`;
    await expect(
      unwrapWithPassphrase(tampered, "correcta caballo"),
    ).rejects.toThrow("does not open");
  });

  it("rejects passphrases that are not worth deriving from", async () => {
    await expect(wrapWithPassphrase(capability, "corta")).rejects.toThrow(
      "at least 8 characters",
    );
  });
});
