import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/**
 * The group operations the packet format needs, on Curve25519.
 *
 * Sphinx needs one thing a plain key exchange does not expose: multiplying an
 * arbitrary point by an arbitrary scalar, so a header can be blinded at each
 * hop. X25519 *is* that operation — `diffieHellman(scalar, point)` is scalar
 * multiplication — it is simply spelled as a key exchange. Wrapping raw bytes
 * in the DER envelopes Node expects gives us the primitive without writing a
 * single line of field arithmetic, which is the point: nothing here invents
 * cryptography.
 *
 * Multiplication commutes, which is what makes the blinding chain work: the
 * sender arrives at each hop's shared secret by multiplying that hop's public
 * key by every blinding factor in turn, and the hop arrives at the same value
 * by multiplying the header's ephemeral point by its own private key.
 */

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export const SCALAR_BYTES = 32;
export const POINT_BYTES = 32;

export interface MixKeyPair {
  /** Raw 32-byte scalar. Never leaves the node that generated it. */
  privateKey: Uint8Array;
  /** Raw 32-byte Curve25519 point. */
  publicKey: Uint8Array;
}

function privateKeyObject(scalar: Uint8Array): KeyObject {
  if (scalar.byteLength !== SCALAR_BYTES) {
    throw new Error("A Curve25519 scalar has 32 bytes");
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(scalar)]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyObject(point: Uint8Array): KeyObject {
  if (point.byteLength !== POINT_BYTES) {
    throw new Error("A Curve25519 point has 32 bytes");
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(point)]),
    format: "der",
    type: "spki",
  });
}

export function generateMixKeyPair(): MixKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    privateKey: new Uint8Array(
      privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32),
    ),
    publicKey: new Uint8Array(
      publicKey.export({ type: "spki", format: "der" }).subarray(-32),
    ),
  };
}

export function mixKeyPairFromScalar(scalar: Uint8Array): MixKeyPair {
  const publicKey = new Uint8Array(
    createPublicKey(privateKeyObject(scalar))
      .export({ type: "spki", format: "der" })
      .subarray(-32),
  );
  return { privateKey: Uint8Array.from(scalar), publicKey };
}

export function randomScalar(): Uint8Array {
  return new Uint8Array(randomBytes(SCALAR_BYTES));
}

/** `scalar · G`, the public point for a scalar. */
export function basePoint(scalar: Uint8Array): Uint8Array {
  return mixKeyPairFromScalar(scalar).publicKey;
}

/**
 * `scalar · point`. Throws when the result is the identity, which is what
 * X25519 does for the small-order points an attacker might send.
 */
export function multiply(scalar: Uint8Array, point: Uint8Array): Uint8Array {
  return new Uint8Array(
    diffieHellman({
      privateKey: privateKeyObject(scalar),
      publicKey: publicKeyObject(point),
    }),
  );
}

/** HKDF-SHA-256 with a domain-separating label. */
export function derive(
  secret: Uint8Array,
  label: string,
  byteLength: number,
): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      "sha256",
      secret,
      Buffer.alloc(0),
      Buffer.from(`capsule/mix/v1/${label}`, "utf8"),
      byteLength,
    ),
  );
}
