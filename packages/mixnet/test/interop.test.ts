import { describe, expect, it } from "vitest";
import {
  basePoint,
  derive,
  lionessEncrypt,
  multiply,
  nodeIdFor,
} from "../src/index.js";

/**
 * Known-answer vectors for the packet format's primitives.
 *
 * Every value here was produced by the `node:crypto` implementation the mix
 * network shipped with before it was ported to run in a browser. Nothing about
 * the format changed in that port, and this file is what keeps that true: a
 * relay on an older version and one on a newer version have to agree on these
 * bytes or they cannot forward each other's packets at all.
 *
 * A failure here is not a broken test. It means the wire format moved, which
 * needs a version, not a fix to the expectations.
 */

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const filled = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

describe("wire format vectors", () => {
  it("derives the same key material as node:crypto did", () => {
    expect(hex(derive(filled(0x11), "payload", 64))).toBe(
      "b20ec2808d645034c25405762dfcbd426341fab0ca85d603adbb9797882cff90" +
        "a2b3b8c74a1a03c87b82105b639e1578e1d982fbe641632f40698f7c72e58934",
    );
  });

  it("puts a scalar on the curve at the same point", () => {
    expect(hex(basePoint(filled(0x44)))).toBe(
      "ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b",
    );
  });

  it("multiplies to the same shared secret", () => {
    expect(hex(multiply(filled(0x44), basePoint(filled(0x55))))).toBe(
      "1eafcf380080d1f4d8a308284691b84a06aa5ca32c723c9a327b7a28c504ad1d",
    );
  });

  it("gives a node the same identifier", () => {
    // A directory keyed on a different digest would silently stop routing.
    expect(hex(nodeIdFor(basePoint(filled(0x55))))).toBe(
      "89d8b7e10db9bdb08d5ce167ccd2f512",
    );
  });

  it("permutes a body block the same way", () => {
    const block = new Uint8Array(96);
    for (let index = 0; index < block.byteLength; index += 1) {
      block[index] = index;
    }
    expect(hex(lionessEncrypt(filled(0x77), block))).toBe(
      "045180ded743771007769d0c67e8cc4f760c6f0c6765f88c905829e185dc35f9" +
        "f0b9ede95a3182d11b0d30193743bd132dcf0ce15c21e892de5577efbf3c7b0e" +
        "8afc78d4ba28f261d8dc14b5e04cbd5f5b5573ab2ca06bea0caa52eb3232065d",
    );
  });

  it("rejects a small-order point rather than returning the identity", () => {
    // X25519 does this for us; losing it would hand an attacker a shared
    // secret they can predict.
    expect(() => multiply(filled(0x44), new Uint8Array(32))).toThrow();
  });
});
