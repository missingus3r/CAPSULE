import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@capsule/protocol";

/**
 * The group operations the packet format needs, on Curve25519.
 *
 * Sphinx needs one thing a plain key exchange does not expose: multiplying an
 * arbitrary point by an arbitrary scalar, so a header can be blinded at each
 * hop. X25519 *is* that operation — scalar multiplication — it is simply
 * usually spelled as a key exchange. Nothing here invents cryptography; the
 * primitives are taken as published.
 *
 * Multiplication commutes, which is what makes the blinding chain work: the
 * sender arrives at each hop's shared secret by multiplying that hop's public
 * key by every blinding factor in turn, and the hop arrives at the same value
 * by multiplying the header's ephemeral point by its own private key.
 *
 * These used to be `node:crypto` calls, which is why the mix network was
 * unavailable in a browser. They are the audited `@noble` implementations
 * instead: one implementation for Node and the browser, still synchronous —
 * Web Crypto has no synchronous form and no way to derive a public key from a
 * private one, so it would have turned every function below into a promise and
 * every caller with it. The outputs are identical to what `node:crypto`
 * produced, which is what `test/interop.test.ts` pins.
 */

export const SCALAR_BYTES = 32;
export const POINT_BYTES = 32;

const LABEL_PREFIX = "capsule/mix/v1/";
const utf8 = new TextEncoder();

export interface MixKeyPair {
  /** Raw 32-byte scalar. Never leaves the node that generated it. */
  privateKey: Uint8Array;
  /** Raw 32-byte Curve25519 point. */
  publicKey: Uint8Array;
}

function assertScalar(scalar: Uint8Array): void {
  if (scalar.byteLength !== SCALAR_BYTES) {
    throw new Error("A Curve25519 scalar has 32 bytes");
  }
}

function assertPoint(point: Uint8Array): void {
  if (point.byteLength !== POINT_BYTES) {
    throw new Error("A Curve25519 point has 32 bytes");
  }
}

export function generateMixKeyPair(): MixKeyPair {
  return mixKeyPairFromScalar(randomScalar());
}

export function mixKeyPairFromScalar(scalar: Uint8Array): MixKeyPair {
  assertScalar(scalar);
  return {
    privateKey: Uint8Array.from(scalar),
    publicKey: x25519.getPublicKey(scalar),
  };
}

export function randomScalar(): Uint8Array {
  return randomBytes(SCALAR_BYTES);
}

/** `scalar · G`, the public point for a scalar. */
export function basePoint(scalar: Uint8Array): Uint8Array {
  assertScalar(scalar);
  return x25519.getPublicKey(scalar);
}

/**
 * `scalar · point`. Throws when the result is the identity, which is what
 * X25519 does for the small-order points an attacker might send.
 */
export function multiply(scalar: Uint8Array, point: Uint8Array): Uint8Array {
  assertScalar(scalar);
  assertPoint(point);
  return x25519.scalarMult(scalar, point);
}

/** HKDF-SHA-256 with a domain-separating label. */
export function derive(
  secret: Uint8Array,
  label: string,
  byteLength: number,
): Uint8Array {
  return hkdf(
    sha256,
    secret,
    new Uint8Array(0),
    utf8.encode(`${LABEL_PREFIX}${label}`),
    byteLength,
  );
}
