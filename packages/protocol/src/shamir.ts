import { fromBase64Url, randomBytes, toBase64Url } from "./bytes.js";
import { gfAdd, gfDivide, gfEvaluate, gfMultiply } from "./gf256.js";

/**
 * Shamir secret sharing over GF(256).
 *
 * Used to split a capability among people or devices, so losing one of them
 * does not lose the capsule and holding one of them does not grant access.
 * Fewer than `threshold` shares reveal nothing at all about the secret — that
 * is the property of the construction, not an assumption about the attacker.
 *
 * Shares carry a random set identifier so that mixing shares from two
 * different splits is detected instead of silently producing garbage. They
 * deliberately carry no digest of the secret: a digest would let anyone
 * holding a single share verify guesses offline.
 */

export const SHARE_PREFIX = "capsule-share:";
export const MIN_SHARE_THRESHOLD = 2;
export const MAX_SHARES = 16;
const SHARE_FORMAT_VERSION = 1;
const SET_ID_BYTES = 8;
const HEADER_BYTES = 3 + SET_ID_BYTES;

export interface SecretShare {
  threshold: number;
  index: number;
  setId: string;
  payload: Uint8Array;
}

function assertSplitParameters(threshold: number, shares: number): void {
  if (
    !Number.isSafeInteger(threshold) ||
    !Number.isSafeInteger(shares) ||
    threshold < MIN_SHARE_THRESHOLD ||
    shares < threshold ||
    shares > MAX_SHARES
  ) {
    throw new Error(
      `A split needs a threshold of at least ${MIN_SHARE_THRESHOLD} and at most ${MAX_SHARES} shares`,
    );
  }
}

/** Splits `secret` into `shares` pieces, any `threshold` of which rebuild it. */
export function splitSecret(
  secret: Uint8Array,
  threshold: number,
  shares: number,
): SecretShare[] {
  assertSplitParameters(threshold, shares);
  if (secret.byteLength === 0) throw new Error("The secret cannot be empty");

  const setId = toBase64Url(randomBytes(SET_ID_BYTES));
  const payloads: Uint8Array[] = Array.from(
    { length: shares },
    () => new Uint8Array(secret.byteLength),
  );

  for (let position = 0; position < secret.byteLength; position += 1) {
    // A fresh random polynomial per byte, with the secret byte as its
    // constant term. Coefficients are discarded immediately after use.
    const coefficients = new Uint8Array(threshold);
    coefficients.set(randomBytes(threshold - 1), 1);
    coefficients[0] = secret[position] as number;

    for (let share = 0; share < shares; share += 1) {
      (payloads[share] as Uint8Array)[position] = gfEvaluate(
        coefficients,
        share + 1,
      );
    }
    coefficients.fill(0);
  }

  return payloads.map((payload, index) => ({
    threshold,
    index: index + 1,
    setId,
    payload,
  }));
}

export function encodeShare(share: SecretShare): string {
  const setId = fromBase64Url(share.setId);
  if (setId.byteLength !== SET_ID_BYTES) {
    throw new Error("Invalid share set identifier");
  }
  const bytes = new Uint8Array(HEADER_BYTES + share.payload.byteLength);
  bytes[0] = SHARE_FORMAT_VERSION;
  bytes[1] = share.threshold;
  bytes[2] = share.index;
  bytes.set(setId, 3);
  bytes.set(share.payload, HEADER_BYTES);
  return `${SHARE_PREFIX}${toBase64Url(bytes)}`;
}

export function decodeShare(value: string): SecretShare {
  const trimmed = value.trim();
  if (!trimmed.startsWith(SHARE_PREFIX)) {
    throw new Error("Not a CAPSULE share");
  }
  const bytes = fromBase64Url(trimmed.slice(SHARE_PREFIX.length));
  if (bytes.byteLength <= HEADER_BYTES || bytes[0] !== SHARE_FORMAT_VERSION) {
    throw new Error("Unsupported CAPSULE share format");
  }
  const threshold = bytes[1] as number;
  const index = bytes[2] as number;
  if (
    threshold < MIN_SHARE_THRESHOLD ||
    threshold > MAX_SHARES ||
    index < 1 ||
    index > MAX_SHARES
  ) {
    throw new Error("Invalid CAPSULE share header");
  }
  return {
    threshold,
    index,
    setId: toBase64Url(bytes.subarray(3, HEADER_BYTES)),
    payload: bytes.subarray(HEADER_BYTES),
  };
}

/** Rebuilds a secret from at least `threshold` shares of the same split. */
export function combineShares(shares: SecretShare[]): Uint8Array {
  if (shares.length === 0) throw new Error("No shares were supplied");
  const threshold = (shares[0] as SecretShare).threshold;
  const setId = (shares[0] as SecretShare).setId;
  const length = (shares[0] as SecretShare).payload.byteLength;

  const byIndex = new Map<number, SecretShare>();
  for (const share of shares) {
    if (share.threshold !== threshold || share.setId !== setId) {
      throw new Error("These shares belong to different splits");
    }
    if (share.payload.byteLength !== length) {
      throw new Error("These shares have different lengths");
    }
    byIndex.set(share.index, share);
  }
  if (byIndex.size < threshold) {
    throw new Error(
      `Rebuilding this secret needs ${threshold} different shares`,
    );
  }

  const selected = [...byIndex.values()].slice(0, threshold);
  const secret = new Uint8Array(length);

  for (let position = 0; position < length; position += 1) {
    let value = 0;
    for (const share of selected) {
      // Lagrange basis evaluated at zero.
      let basis = 1;
      for (const other of selected) {
        if (other.index === share.index) continue;
        basis = gfMultiply(
          basis,
          gfDivide(other.index, gfAdd(other.index, share.index)),
        );
      }
      value = gfAdd(
        value,
        gfMultiply(share.payload[position] as number, basis),
      );
    }
    secret[position] = value;
  }

  return secret;
}
