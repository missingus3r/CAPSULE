/**
 * `.capsule` names and site records.
 *
 * A `.capsule` name is not registered anywhere. It *is* an Ed25519 public key,
 * written in base32, so the name and the key allowed to speak for it are the
 * same object. Nobody can hand out a name they do not hold the key for, and no
 * registry can be pressured into pointing a name somewhere else. This is the
 * same trade Tor made for onion addresses: names become long and unmemorable,
 * and in exchange they stop needing to be trusted.
 *
 * What a name points at is a **site record**: a small signed statement saying
 * "the current version of this site is the capsule behind this capability".
 * Relays store and hand out these records. They cannot forge one, because they
 * do not have the key, and they cannot silently roll a site back to an older
 * version, because clients remember the highest sequence number they have seen.
 *
 * The site itself is an ordinary capsule. Everything capsules already do —
 * end-to-end encryption, size-class padding, mirrors, k-of-n sharding, mix
 * routing — applies to a site with no extra machinery.
 */

import { concatBytes, fromBase64Url, getCrypto, toBase64Url } from "./bytes.js";

const textEncoder = new TextEncoder();

export const CAPSULE_SITE_TLD = "capsule";
export const CAPSULE_SITE_SUFFIX = ".capsule";
/** Name format. Bumped only if the key type or the encoding changes. */
export const CAPSULE_SITE_NAME_VERSION = 1 as const;
export const CAPSULE_SITE_RECORD_VERSION = 1 as const;

/** 32-byte key, 2-byte checksum, 1-byte version, base32 with no padding. */
export const CAPSULE_SITE_NAME_LENGTH = 56;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const NAME_CHECKSUM_CONTEXT = "CAPSULE/site-name/v1";
const RECORD_CONTEXT = "CAPSULE/site-record/v1";

/** Records older than this are refused, so a stale record cannot be served forever. */
export const MAX_SITE_RECORD_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** A record dated further ahead than this is refused. */
export const MAX_SITE_RECORD_SKEW_MS = 10 * 60 * 1000;
export const MAX_SITE_TITLE_LENGTH = 120;
export const MAX_SITE_CAPABILITY_LENGTH = 16_384;

export function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function base32Decode(value: string): Uint8Array {
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 value");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
    }
  }
  // Leftover bits must be zero. Otherwise the same bytes have two spellings,
  // and two spellings of one name is one name too many.
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Error("Invalid base32 value");
  }
  return Uint8Array.from(output);
}

async function nameChecksum(publicKey: Uint8Array): Promise<Uint8Array> {
  const digest = await getCrypto().subtle.digest(
    "SHA-256",
    concatBytes([
      textEncoder.encode(NAME_CHECKSUM_CONTEXT),
      publicKey,
      Uint8Array.of(CAPSULE_SITE_NAME_VERSION),
    ]) as unknown as BufferSource,
  );
  return new Uint8Array(digest).slice(0, 2);
}

/** Builds the `<base32>.capsule` name a public key answers to. */
export async function siteNameFor(publicKey: Uint8Array): Promise<string> {
  if (publicKey.byteLength !== 32) {
    throw new Error("A .capsule name is built from a 32-byte Ed25519 key");
  }
  const checksum = await nameChecksum(publicKey);
  const label = base32Encode(
    concatBytes([
      publicKey,
      checksum,
      Uint8Array.of(CAPSULE_SITE_NAME_VERSION),
    ]),
  );
  return `${label}${CAPSULE_SITE_SUFFIX}`;
}

export interface ParsedSiteName {
  name: string;
  label: string;
  publicKey: Uint8Array;
  version: number;
}

/**
 * Reads a `.capsule` name back into the key it encodes. Returns `undefined`
 * for anything that is not one, including a name whose checksum does not
 * match — a mistyped name must fail here rather than resolve to nothing.
 */
export async function parseSiteName(
  value: string,
): Promise<ParsedSiteName | undefined> {
  const trimmed = value.trim().toLowerCase().replace(/\.$/u, "");
  const host = trimmed.includes("://")
    ? safeHost(trimmed)
    : (trimmed.split("/")[0] ?? "");
  if (!host || !host.endsWith(CAPSULE_SITE_SUFFIX)) return undefined;

  const label = host.slice(0, -CAPSULE_SITE_SUFFIX.length);
  if (label.length !== CAPSULE_SITE_NAME_LENGTH) return undefined;
  if (!/^[a-z2-7]+$/u.test(label)) return undefined;

  let decoded: Uint8Array;
  try {
    decoded = base32Decode(label);
  } catch {
    return undefined;
  }
  if (decoded.byteLength !== 35) return undefined;

  const publicKey = decoded.slice(0, 32);
  const checksum = decoded.slice(32, 34);
  const version = decoded[34] as number;
  if (version !== CAPSULE_SITE_NAME_VERSION) return undefined;

  const expected = await nameChecksum(publicKey);
  if (expected[0] !== checksum[0] || expected[1] !== checksum[1]) {
    return undefined;
  }
  return { name: `${label}${CAPSULE_SITE_SUFFIX}`, label, publicKey, version };
}

function safeHost(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

export interface CapsuleSiteRecord {
  version: typeof CAPSULE_SITE_RECORD_VERSION;
  /** Full `<label>.capsule` name. */
  name: string;
  /** Monotonic. A client keeps the highest it has seen for a name. */
  sequence: number;
  publishedAt: string;
  /** Fragment payload of the capsule holding the bundle: `capsule=...`. */
  capability: string;
  title?: string;
  /** base64url Ed25519 signature over the canonical statement below. */
  signature: string;
}

export type UnsignedSiteRecord = Omit<CapsuleSiteRecord, "signature">;

/**
 * The exact bytes that get signed. Fields are newline-separated and none of
 * them may contain a newline, so no two different records can produce the same
 * statement.
 */
export function siteRecordStatement(record: UnsignedSiteRecord): Uint8Array {
  return textEncoder.encode(
    [
      RECORD_CONTEXT,
      String(record.version),
      record.name,
      String(record.sequence),
      record.publishedAt,
      record.capability,
      record.title ?? "",
    ].join("\n"),
  );
}

function wellFormed(record: UnsignedSiteRecord): boolean {
  if (!record || typeof record !== "object") return false;
  if (record.version !== CAPSULE_SITE_RECORD_VERSION) return false;
  if (typeof record.name !== "string") return false;
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 0) {
    return false;
  }
  if (typeof record.capability !== "string") return false;
  if (record.capability.length === 0) return false;
  if (record.capability.length > MAX_SITE_CAPABILITY_LENGTH) return false;
  if (/[\r\n]/u.test(record.capability)) return false;
  if (record.title !== undefined) {
    if (typeof record.title !== "string") return false;
    if (record.title.length > MAX_SITE_TITLE_LENGTH) return false;
    if (/[\r\n]/u.test(record.title)) return false;
  }
  if (typeof record.publishedAt !== "string") return false;
  if (/[\r\n]/u.test(record.publishedAt)) return false;
  return Number.isFinite(Date.parse(record.publishedAt));
}

async function importVerifyKey(publicKey: Uint8Array): Promise<CryptoKey> {
  return getCrypto().subtle.importKey(
    "raw",
    publicKey.slice() as unknown as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

/** Signs a record. `privateKey` must be an Ed25519 key with `sign` usage. */
export async function signSiteRecord(
  record: UnsignedSiteRecord,
  privateKey: CryptoKey,
): Promise<CapsuleSiteRecord> {
  if (!wellFormed(record)) throw new Error("The site record is malformed");
  const signature = await getCrypto().subtle.sign(
    { name: "Ed25519" },
    privateKey,
    siteRecordStatement(record) as unknown as BufferSource,
  );
  return { ...record, signature: toBase64Url(new Uint8Array(signature)) };
}

export interface SiteRecordCheck {
  now?: number;
  /** Skips the freshness window. Only for reading an archived record. */
  allowStale?: boolean;
}

/**
 * Verifies that a record was signed by the key its own name encodes.
 *
 * This is the whole trust model of a `.capsule` site: whoever handed you the
 * record — a relay, a peer, a cache, an attacker — does not matter, because a
 * record that does not verify against the name is discarded, and one that does
 * could only have been made by the holder of the site's key.
 */
export async function verifySiteRecord(
  record: CapsuleSiteRecord,
  options: SiteRecordCheck = {},
): Promise<boolean> {
  if (!wellFormed(record)) return false;
  if (typeof record.signature !== "string") return false;

  const parsed = await parseSiteName(record.name);
  if (!parsed || parsed.name !== record.name) return false;

  if (!options.allowStale) {
    const now = options.now ?? Date.now();
    const published = Date.parse(record.publishedAt);
    if (published - now > MAX_SITE_RECORD_SKEW_MS) return false;
    if (now - published > MAX_SITE_RECORD_AGE_MS) return false;
  }

  let signature: Uint8Array;
  try {
    signature = fromBase64Url(record.signature);
  } catch {
    return false;
  }
  if (signature.byteLength !== 64) return false;

  const { signature: _signature, ...unsigned } = record;
  try {
    return await getCrypto().subtle.verify(
      { name: "Ed25519" },
      await importVerifyKey(parsed.publicKey),
      signature.slice() as unknown as BufferSource,
      siteRecordStatement(unsigned) as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

/** Picks the record a client should believe out of what several relays returned. */
export async function bestSiteRecord(
  records: readonly CapsuleSiteRecord[],
  options: SiteRecordCheck = {},
): Promise<CapsuleSiteRecord | undefined> {
  let best: CapsuleSiteRecord | undefined;
  for (const record of records) {
    if (!(await verifySiteRecord(record, options))) continue;
    if (!best || record.sequence > best.sequence) best = record;
  }
  return best;
}
