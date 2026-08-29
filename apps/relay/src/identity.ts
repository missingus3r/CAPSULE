import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Every relay owns an Ed25519 keypair generated the first time it starts.
 * There is no registration and no central authority: the key is only used so
 * a relay announcing itself can prove it is the same relay that answered
 * before, and so a poisoned peer list cannot silently rename an operator.
 */

export const ANNOUNCE_CONTEXT = "CAPSULE/relay-announce/v2";
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface RelayIdentity {
  relayId: string;
  publicKey: string;
  sign(message: string): string;
}

interface StoredIdentity {
  schemaVersion: 1;
  createdAt: string;
  relayId: string;
  publicKey: string;
  privateKey: string;
}

function rawPublicKeyOf(key: KeyObject): Buffer {
  const spki = key.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - 32));
}

export function relayIdFor(publicKeyBase64Url: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKeyBase64Url, "base64url"))
    .digest("base64url");
}

export function publicKeyFromBase64Url(value: string): KeyObject {
  const raw = Buffer.from(value, "base64url");
  if (raw.length !== 32) throw new Error("Ed25519 public keys have 32 bytes");
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function announceMessage(
  url: string,
  relayId: string,
  announcedAt: string,
  nonce: string,
): string {
  return `${ANNOUNCE_CONTEXT}\n${url}\n${relayId}\n${announcedAt}\n${nonce}`;
}

/** Leading zero bits of the digest of an announcement. */
export function announceWork(message: string): number {
  const digest = createHash("sha256").update(message, "utf8").digest();
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Finds a nonce whose announcement digest has at least `bits` leading zeros.
 *
 * Announcing costs the newcomer a measurable amount of work, so filling a
 * directory with invented relays costs that work per invented relay. It does
 * not make Sybil attacks impossible; it makes them expensive enough that a
 * bored attacker is not the threat, and it costs an honest relay a fraction of
 * a second every gossip round.
 */
export function solveAnnounceWork(
  url: string,
  relayId: string,
  announcedAt: string,
  bits: number,
  maximumAttempts = 50_000_000,
): string {
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const nonce = attempt.toString(36);
    if (
      announceWork(announceMessage(url, relayId, announcedAt, nonce)) >= bits
    ) {
      return nonce;
    }
  }
  throw new Error("Could not solve the announcement proof of work");
}

export function verifyAnnouncement(
  announcement: {
    url: string;
    relayId: string;
    publicKey: string;
    announcedAt: string;
    nonce: string;
    signature: string;
  },
  requiredWorkBits = 0,
): boolean {
  try {
    if (relayIdFor(announcement.publicKey) !== announcement.relayId) {
      return false;
    }
    const message = announceMessage(
      announcement.url,
      announcement.relayId,
      announcement.announcedAt,
      announcement.nonce,
    );
    if (requiredWorkBits > 0 && announceWork(message) < requiredWorkBits) {
      return false;
    }
    return verify(
      null,
      Buffer.from(message, "utf8"),
      publicKeyFromBase64Url(announcement.publicKey),
      Buffer.from(announcement.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function isStoredIdentity(value: unknown): value is StoredIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredIdentity>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.relayId === "string" &&
    typeof candidate.publicKey === "string" &&
    typeof candidate.privateKey === "string"
  );
}

/** Loads the relay identity, generating and persisting one when absent. */
export async function loadRelayIdentity(
  storageDir: string,
): Promise<RelayIdentity> {
  const path = join(storageDir, "identity.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isStoredIdentity(parsed)) {
      const privateKey = privateKeyFrom(parsed.privateKey);
      return {
        relayId: parsed.relayId,
        publicKey: parsed.publicKey,
        sign: (message) =>
          sign(null, Buffer.from(message, "utf8"), privateKey).toString(
            "base64url",
          ),
      };
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw new Error(
        `The relay identity at ${path} is unreadable. Move it aside to generate a new one.`,
      );
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const encodedPublicKey = rawPublicKeyOf(publicKey).toString("base64url");
  const stored: StoredIdentity = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    relayId: relayIdFor(encodedPublicKey),
    publicKey: encodedPublicKey,
    privateKey: privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });

  return {
    relayId: stored.relayId,
    publicKey: stored.publicKey,
    sign: (message) =>
      sign(null, Buffer.from(message, "utf8"), privateKey).toString(
        "base64url",
      ),
  };
}

function privateKeyFrom(privateKeyBase64: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
}
