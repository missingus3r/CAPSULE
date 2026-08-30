import { ctr } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { derive } from "./group.js";

/**
 * LIONESS, the wide-block cipher used for a packet's body.
 *
 * A mix must not be able to mark a packet it forwards in a way another mix, or
 * the destination, can recognise later — that is the tagging attack, and it
 * breaks a mix network completely: mark on the way in, spot on the way out,
 * and the two ends are linked.
 *
 * Ordinary modes do not help. With a stream cipher, flipping a bit in the
 * ciphertext flips exactly that bit in the plaintext, so a mark survives every
 * remaining layer. LIONESS is a *pseudo-random permutation over the whole
 * block*: changing one bit anywhere randomises all 64 KiB. A marked packet
 * therefore arrives as noise, the destination's plaintext check fails, and the
 * mark carries no information because every tampered packet looks the same.
 *
 * The construction is Anderson and Biham's, unchanged: four rounds alternating
 * a stream cipher and a keyed hash. The only choices made here are the
 * primitives — AES-256-CTR and HMAC-SHA-256 — and the key derivation.
 */

const KEY_BYTES = 32;

/**
 * CTR from a zero counter. Every invocation uses a key derived once for this
 * packet and this round, so the counter never has to vary.
 */
const ZERO_IV = new Uint8Array(16);

export const LIONESS_MINIMUM_BYTES = KEY_BYTES + 1;

function streamXor(key: Uint8Array, target: Uint8Array): void {
  const keystream = ctr(key, ZERO_IV).encrypt(
    new Uint8Array(target.byteLength),
  );
  for (let index = 0; index < target.byteLength; index += 1) {
    target[index] = (target[index] as number) ^ (keystream[index] as number);
  }
}

function hashXor(
  key: Uint8Array,
  source: Uint8Array,
  target: Uint8Array,
): void {
  const digest = hmac(sha256, key, source);
  for (let index = 0; index < KEY_BYTES; index += 1) {
    target[index] = (target[index] as number) ^ (digest[index] as number);
  }
}

/** The four round keys, derived once from the per-hop payload key. */
function roundKeys(key: Uint8Array): Uint8Array[] {
  const material = derive(key, "lioness", KEY_BYTES * 4);
  return [0, 1, 2, 3].map((round) =>
    material.subarray(round * KEY_BYTES, (round + 1) * KEY_BYTES),
  );
}

/** Mixes the left half into the stream key without leaking it. */
function streamKeyFor(left: Uint8Array, roundKey: Uint8Array): Uint8Array {
  const mixed = new Uint8Array(KEY_BYTES);
  for (let index = 0; index < KEY_BYTES; index += 1) {
    mixed[index] = (left[index] as number) ^ (roundKey[index] as number);
  }
  return derive(mixed, "lioness-stream", KEY_BYTES);
}

function assertBlock(block: Uint8Array): void {
  if (block.byteLength < LIONESS_MINIMUM_BYTES) {
    throw new Error(`A LIONESS block needs more than ${KEY_BYTES} bytes`);
  }
}

/** Encrypts in place and returns the same buffer, for chaining. */
export function lionessEncrypt(key: Uint8Array, block: Uint8Array): Uint8Array {
  assertBlock(block);
  const [k1, k2, k3, k4] = roundKeys(key) as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  const left = block.subarray(0, KEY_BYTES);
  const right = block.subarray(KEY_BYTES);

  streamXor(streamKeyFor(left, k1), right);
  hashXor(k2, right, left);
  streamXor(streamKeyFor(left, k3), right);
  hashXor(k4, right, left);
  return block;
}

/** Decrypts in place and returns the same buffer, for chaining. */
export function lionessDecrypt(key: Uint8Array, block: Uint8Array): Uint8Array {
  assertBlock(block);
  const [k1, k2, k3, k4] = roundKeys(key) as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  const left = block.subarray(0, KEY_BYTES);
  const right = block.subarray(KEY_BYTES);

  hashXor(k4, right, left);
  streamXor(streamKeyFor(left, k3), right);
  hashXor(k2, right, left);
  streamXor(streamKeyFor(left, k1), right);
  return block;
}
