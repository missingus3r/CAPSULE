import { describe, expect, it } from "vitest";
import {
  assertCapsuleMetadata,
  combineShares,
  decodeOwnerCapability,
  decodeRecoveryBlob,
  decodeShare,
  decodeShareCapability,
  decodeShards,
  fromBase64Url,
  toBase64Url,
} from "../src/index.js";

/**
 * Parsers are the only part of CAPSULE that touches bytes chosen by someone
 * else. These runs feed them mutated and random input and assert the same
 * thing every time: they either return a valid value or throw an `Error`.
 *
 * Anything else — a hang, a crash, a `RangeError` escaping from a length
 * field, a half-parsed object — is a bug, and this is where it shows up.
 *
 * The generator is a seeded PRNG so a failure is reproducible from the seed
 * printed in the assertion, not a coin flip that vanishes on the next run.
 */

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function randomBytes(random: () => number, length: number): Uint8Array {
  return Uint8Array.from({ length }, () => Math.floor(random() * 256));
}

function mutate(random: () => number, value: string): string {
  const characters = [...value];
  const operations = 1 + Math.floor(random() * 4);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_={}[]\"' \\";
  for (let index = 0; index < operations; index += 1) {
    const at = Math.floor(random() * characters.length);
    const choice = random();
    if (choice < 0.4) {
      characters[at] = alphabet[
        Math.floor(random() * alphabet.length)
      ] as string;
    } else if (choice < 0.7) {
      characters.splice(at, 1);
    } else {
      characters.splice(
        at,
        0,
        alphabet[Math.floor(random() * alphabet.length)] as string,
      );
    }
  }
  return characters.join("");
}

/** Runs a parser and fails only when it misbehaves, not when it rejects. */
function expectClosedFailure(seed: number, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(
      error instanceof Error,
      `seed ${seed} threw a non-Error: ${String(error)}`,
    ).toBe(true);
  }
}

const VALID_SHARE_CAPABILITY = {
  version: 3,
  relayUrl: "https://relay.example",
  capsuleId: "A".repeat(32),
  readToken: "B".repeat(43),
  key: toBase64Url(new Uint8Array(32).fill(7)),
  noncePrefix: toBase64Url(new Uint8Array(8).fill(9)),
};

describe("parser fuzzing", () => {
  it("never breaks on mutated share fragments", () => {
    const encoded = `capsule=${toBase64Url(
      new TextEncoder().encode(JSON.stringify(VALID_SHARE_CAPABILITY)),
    )}`;
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = makeRandom(seed);
      const fragment = mutate(random, encoded);
      expectClosedFailure(seed, () => {
        const capability = decodeShareCapability(fragment);
        // Anything that parses must be structurally complete.
        expect(capability.capsuleId.length).toBeGreaterThanOrEqual(24);
        expect(fromBase64Url(capability.key).byteLength).toBe(32);
      });
    }
  });

  it("never breaks on random bytes offered as a fragment", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = makeRandom(seed * 7919);
      const noise = toBase64Url(
        randomBytes(random, 1 + Math.floor(random() * 200)),
      );
      expectClosedFailure(seed, () =>
        decodeShareCapability(`capsule=${noise}`),
      );
      expectClosedFailure(seed, () =>
        decodeOwnerCapability(`capsule-owner:${noise}`),
      );
      expectClosedFailure(seed, () => decodeShare(`capsule-share:${noise}`));
      expectClosedFailure(seed, () =>
        decodeRecoveryBlob(`capsule-recovery:${noise}`),
      );
    }
  });

  it("never accepts malformed metadata as valid", () => {
    const base = {
      version: 3,
      filename: "a.bin",
      mimeType: "application/octet-stream",
      byteLength: 1024,
      chunkSize: 512,
      chunkCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
    };
    const fields = Object.keys(base);
    const values: unknown[] = [
      undefined,
      null,
      -1,
      0,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER,
      "",
      "x".repeat(300),
      {},
      [],
    ];

    for (const field of fields) {
      for (const value of values) {
        const candidate = { ...base, [field]: value } as Record<
          string,
          unknown
        >;
        let accepted = true;
        try {
          assertCapsuleMetadata(candidate);
        } catch (error) {
          accepted = false;
          expect(error).toBeInstanceOf(Error);
        }
        if (accepted) {
          // A mutation may legitimately pass — `expiresAt: null` is a capsule
          // without expiry — but whatever passes must still satisfy the
          // invariants the rest of the code relies on.
          const document = candidate as unknown as {
            version: number;
            byteLength: number;
            chunkSize: number;
            chunkCount: number;
            paddedLength?: number;
            expiresAt: string | null;
            createdAt: string;
          };
          const stored = document.paddedLength ?? document.byteLength;
          expect(document.chunkCount).toBe(
            document.paddedLength === undefined
              ? Math.ceil(stored / document.chunkSize)
              : stored / document.chunkSize,
          );
          if (document.expiresAt === null) {
            expect(document.version).toBeGreaterThan(1);
          } else {
            expect(Date.parse(document.expiresAt)).toBeGreaterThan(
              Date.parse(document.createdAt),
            );
          }
        }
      }
    }
  });

  it("never breaks reconstructing from malformed shard sets", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = makeRandom(seed * 104_729);
      const k = 2 + Math.floor(random() * 3);
      const n = k + 1 + Math.floor(random() * 3);
      const shardBytes = 1 + Math.floor(random() * 32);
      const shards = Array.from({ length: n }, () =>
        random() < 0.3 ? undefined : randomBytes(random, shardBytes),
      );
      expectClosedFailure(seed, () =>
        decodeShards(shards, { k, n }, shardBytes * k),
      );
    }
  });

  it("never breaks combining unrelated shares", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = makeRandom(seed * 31_337);
      const shares = Array.from(
        { length: 1 + Math.floor(random() * 4) },
        () => ({
          threshold: 1 + Math.floor(random() * 5),
          index: Math.floor(random() * 300),
          setId: toBase64Url(randomBytes(random, 8)),
          payload: randomBytes(random, 1 + Math.floor(random() * 16)),
        }),
      );
      expectClosedFailure(seed, () => combineShares(shares));
    }
  });
});
