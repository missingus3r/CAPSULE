import {
  asArrayBuffer,
  fromBase64Url,
  getCrypto,
  toBase64Url,
} from "./bytes.js";
import {
  MAX_ERASURE_SHARDS,
  MIN_ERASURE_DATA_SHARDS,
  shardLengthFor,
} from "./erasure.js";

export * from "./bytes.js";
export * from "./erasure.js";
export * from "./gf256.js";
export * from "./recovery.js";
export * from "./shamir.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type CapsuleProtocolVersion = 1 | 2 | 3;

/**
 * Version written by this implementation. Versions 1 and 2 stay readable.
 *
 * - v1: chunked AES-256-GCM capsule with a mandatory expiry.
 * - v2: optional size-class padding, capsules without expiry, mirror relays.
 * - v3: optional erasure coding, so no single relay holds the whole capsule.
 */
export const CAPSULE_PROTOCOL_VERSION = 3 as const;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly CapsuleProtocolVersion[] = [
  1, 2, 3,
];
/** HTTP surface exposed by a relay; independent from the capsule format. */
export const RELAY_API_VERSION = 1 as const;

export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const CAPSULE_FRAGMENT_PREFIX = "capsule=";
export const CAPSULE_OWNER_PREFIX = "capsule-owner:";
export const MAX_CAPSULE_MIRRORS = 16;
/** Smallest padded size class; below it every capsule looks identical. */
export const MIN_SIZE_CLASS_BYTES = 64 * 1024;
export const MAX_FRAGMENT_LENGTH = 16_384;

export interface CapsuleMetadata {
  version: CapsuleProtocolVersion;
  filename: string;
  mimeType: string;
  byteLength: number;
  chunkSize: number;
  chunkCount: number;
  createdAt: string;
  /** `null` means the sender asked for a capsule without expiry (v2+). */
  expiresAt: string | null;
  /** Padded plaintext length; present only when size-class padding is used. */
  paddedLength?: number;
  note?: string;
}

export interface CapsuleSecrets {
  key: string;
  noncePrefix: string;
  /** Capsule format the AAD is bound to. Defaults to the current version. */
  version?: CapsuleProtocolVersion;
}

export interface CapsuleLocation {
  relayUrl: string;
  capsuleId: string;
  readToken: string;
}

export interface CapsuleOwnerLocation {
  relayUrl: string;
  capsuleId: string;
  deleteToken: string;
}

/**
 * Erasure coding layout of a capsule. When present, each relay listed in the
 * capability holds one shard per chunk instead of a full copy, and `k` of them
 * are needed to reconstruct anything at all.
 */
export interface CapsuleSharding {
  k: number;
  n: number;
  /** Ciphertext bytes of one whole chunk before splitting. */
  blockBytes: number;
  /** Bytes each relay stores per chunk. */
  shardBytes: number;
}

export interface CapsuleShareCapability {
  version: CapsuleProtocolVersion;
  relayUrl: string;
  capsuleId: string;
  readToken: string;
  key: string;
  noncePrefix: string;
  /** Extra relays holding the same ciphertext, or shards of it (v2+). */
  mirrors?: CapsuleLocation[];
  /** Erasure coding layout; the relay list is then ordered by shard index (v3). */
  sharding?: CapsuleSharding;
}

export interface CapsuleOwnerCapability {
  capsuleId: string;
  deleteToken: string;
  relayUrl: string;
  /** Extra relays to delete from (v2+). */
  mirrors?: CapsuleOwnerLocation[];
}

export function createCapsuleSecrets(
  version: CapsuleProtocolVersion = CAPSULE_PROTOCOL_VERSION,
): CapsuleSecrets {
  return {
    key: toBase64Url(randomValues(32)),
    noncePrefix: toBase64Url(randomValues(8)),
    version,
  };
}

function randomValues(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

/**
 * Rounds a plaintext length up to a coarse size class so a relay observing a
 * capsule cannot read the exact file size. Classes grow in quarter-octave
 * steps, so padding never costs more than 25% above the size class floor.
 */
export function sizeClassFor(byteLength: number): number {
  const step = sizeClassStep(byteLength);
  return Math.ceil(Math.max(byteLength, MIN_SIZE_CLASS_BYTES) / step) * step;
}

/**
 * Granularity of the size class ladder for a given length. A capsule padded
 * with chunks of this size lands exactly on its size class instead of
 * overshooting it, which keeps the cost of padding proportional to the file.
 */
export function sizeClassStep(byteLength: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("Invalid capsule length");
  }
  const target = Math.max(byteLength, MIN_SIZE_CLASS_BYTES);
  return 2 ** Math.floor(Math.log2(target)) / 4;
}

/**
 * Padded plaintext length for a capsule: a size class rounded up to a whole
 * number of chunks, so every uploaded chunk has an identical ciphertext size.
 */
export function paddedLengthFor(byteLength: number, chunkSize: number): number {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("Invalid chunk size");
  }
  const padded = Math.ceil(sizeClassFor(byteLength) / chunkSize) * chunkSize;
  if (!Number.isSafeInteger(padded)) {
    throw new Error("Padded capsule length is too large");
  }
  return padded;
}

/** Plaintext bytes actually stored for a capsule, padded or not. */
export function transportLength(metadata: CapsuleMetadata): number {
  return metadata.paddedLength ?? metadata.byteLength;
}

async function importAesKey(encodedKey: string): Promise<CryptoKey> {
  const key = fromBase64Url(encodedKey);
  if (key.byteLength !== 32)
    throw new Error("CAPSULE keys must contain 32 bytes");
  return getCrypto().subtle.importKey(
    "raw",
    asArrayBuffer(key),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

function nonceForIndex(encodedPrefix: string, index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_fffe) {
    throw new Error("Invalid CAPSULE chunk index");
  }

  const prefix = fromBase64Url(encodedPrefix);
  if (prefix.byteLength !== 8)
    throw new Error("CAPSULE nonce prefixes must contain 8 bytes");
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(8, index, false);
  return nonce;
}

function additionalData(
  index: number,
  version: CapsuleProtocolVersion,
): Uint8Array {
  return textEncoder.encode(`CAPSULE/v${version}/chunk/${index}`);
}

function secretsVersion(secrets: CapsuleSecrets): CapsuleProtocolVersion {
  const version = secrets.version ?? CAPSULE_PROTOCOL_VERSION;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new Error("Unsupported CAPSULE protocol version");
  }
  return version;
}

export async function encryptChunk(
  plaintext: Uint8Array,
  index: number,
  secrets: CapsuleSecrets,
): Promise<Uint8Array> {
  const key = await importAesKey(secrets.key);
  const ciphertext = await getCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(nonceForIndex(secrets.noncePrefix, index)),
      additionalData: asArrayBuffer(
        additionalData(index, secretsVersion(secrets)),
      ),
      tagLength: 128,
    },
    key,
    asArrayBuffer(plaintext),
  );
  return new Uint8Array(ciphertext);
}

export async function decryptChunk(
  ciphertext: Uint8Array,
  index: number,
  secrets: CapsuleSecrets,
): Promise<Uint8Array> {
  const key = await importAesKey(secrets.key);
  try {
    const plaintext = await getCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(nonceForIndex(secrets.noncePrefix, index)),
        additionalData: asArrayBuffer(
          additionalData(index, secretsVersion(secrets)),
        ),
        tagLength: 128,
      },
      key,
      asArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("Capsule authentication failed");
  }
}

export async function encryptMetadata(
  metadata: CapsuleMetadata,
  secrets: CapsuleSecrets,
): Promise<Uint8Array> {
  assertCapsuleMetadata(metadata);
  if (metadata.version !== secretsVersion(secrets)) {
    throw new Error("Capsule metadata and secrets declare different versions");
  }
  return encryptChunk(textEncoder.encode(JSON.stringify(metadata)), 0, secrets);
}

export async function decryptMetadata(
  ciphertext: Uint8Array,
  secrets: CapsuleSecrets,
): Promise<CapsuleMetadata> {
  const plaintext = await decryptChunk(ciphertext, 0, secrets);
  const parsed: unknown = JSON.parse(textDecoder.decode(plaintext));
  assertCapsuleMetadata(parsed);
  return parsed;
}

export function assertCapsuleMetadata(
  value: unknown,
): asserts value is CapsuleMetadata {
  if (!value || typeof value !== "object")
    throw new Error("Invalid capsule metadata");
  const candidate = value as Partial<CapsuleMetadata>;
  const version = candidate.version;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new Error("Invalid capsule metadata");
  }
  if (
    typeof candidate.filename !== "string" ||
    candidate.filename.length === 0 ||
    candidate.filename.length > 255 ||
    typeof candidate.mimeType !== "string" ||
    candidate.mimeType.length === 0 ||
    candidate.mimeType.length > 255 ||
    typeof candidate.byteLength !== "number" ||
    !Number.isSafeInteger(candidate.byteLength) ||
    candidate.byteLength < 0 ||
    typeof candidate.chunkSize !== "number" ||
    !Number.isSafeInteger(candidate.chunkSize) ||
    candidate.chunkSize <= 0 ||
    typeof candidate.chunkCount !== "number" ||
    !Number.isSafeInteger(candidate.chunkCount) ||
    candidate.chunkCount < 0 ||
    candidate.chunkCount > 0xffff_fffe ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    (candidate.note !== undefined &&
      (typeof candidate.note !== "string" || candidate.note.length > 4096))
  ) {
    throw new Error("Invalid capsule metadata");
  }

  if (candidate.expiresAt === null) {
    // Capsules without expiry only exist from version 2 onwards.
    if (version === 1) throw new Error("Invalid capsule metadata");
  } else if (
    typeof candidate.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    Date.parse(candidate.expiresAt) <= Date.parse(candidate.createdAt)
  ) {
    throw new Error("Invalid capsule metadata");
  }

  if (candidate.paddedLength === undefined) {
    if (
      candidate.chunkCount !==
      Math.ceil(candidate.byteLength / candidate.chunkSize)
    ) {
      throw new Error("Invalid capsule metadata");
    }
    return;
  }

  if (
    version === 1 ||
    typeof candidate.paddedLength !== "number" ||
    !Number.isSafeInteger(candidate.paddedLength) ||
    candidate.paddedLength < candidate.byteLength ||
    candidate.paddedLength % candidate.chunkSize !== 0 ||
    candidate.chunkCount !== candidate.paddedLength / candidate.chunkSize
  ) {
    throw new Error("Invalid capsule metadata");
  }
}

export function encodeShareCapability(
  capability: CapsuleShareCapability,
): string {
  assertShareCapability(capability);
  return `${CAPSULE_FRAGMENT_PREFIX}${toBase64Url(textEncoder.encode(JSON.stringify(capability)))}`;
}

export function decodeShareCapability(
  fragment: string,
): CapsuleShareCapability {
  const normalized = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!normalized.startsWith(CAPSULE_FRAGMENT_PREFIX))
    throw new Error("Not a CAPSULE share fragment");
  const encoded = normalized.slice(CAPSULE_FRAGMENT_PREFIX.length);
  if (encoded.length > MAX_FRAGMENT_LENGTH)
    throw new Error("CAPSULE share fragment is too large");
  const parsed: unknown = JSON.parse(
    textDecoder.decode(fromBase64Url(encoded)),
  );
  assertShareCapability(parsed);
  return parsed;
}

/** Every relay copy of a capsule, primary first. */
export function shareLocations(
  capability: CapsuleShareCapability,
): CapsuleLocation[] {
  return [
    {
      relayUrl: capability.relayUrl,
      capsuleId: capability.capsuleId,
      readToken: capability.readToken,
    },
    ...(capability.mirrors ?? []),
  ];
}

export function ownerLocations(
  capability: CapsuleOwnerCapability,
): CapsuleOwnerLocation[] {
  return [
    {
      relayUrl: capability.relayUrl,
      capsuleId: capability.capsuleId,
      deleteToken: capability.deleteToken,
    },
    ...(capability.mirrors ?? []),
  ];
}

export function buildShareUrl(
  appUrl: string,
  capability: CapsuleShareCapability,
): string {
  const url = new URL(appUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "The CAPSULE application URL must use HTTP(S) without credentials",
    );
  }
  url.hash = encodeShareCapability(capability);
  return url.toString();
}

export function encodeOwnerCapability(
  capability: CapsuleOwnerCapability,
): string {
  assertOwnerCapability(capability);
  return `${CAPSULE_OWNER_PREFIX}${toBase64Url(textEncoder.encode(JSON.stringify(capability)))}`;
}

export function decodeOwnerCapability(value: string): CapsuleOwnerCapability {
  const trimmed = value.trim();
  if (!trimmed.startsWith(CAPSULE_OWNER_PREFIX))
    throw new Error("Not a CAPSULE owner capability");
  const parsed: unknown = JSON.parse(
    textDecoder.decode(
      fromBase64Url(trimmed.slice(CAPSULE_OWNER_PREFIX.length)),
    ),
  );
  assertOwnerCapability(parsed);
  return parsed;
}

function isCapsuleId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{24,64}$/u.test(value);
}

function isCapabilityToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/u.test(value);
}

function assertMirrorList(
  value: unknown,
  tokenField: "readToken" | "deleteToken",
  message: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_CAPSULE_MIRRORS) {
    throw new Error(message);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new Error(message);
    const mirror = entry as Record<string, unknown>;
    if (
      Object.keys(mirror).length !== 3 ||
      typeof mirror.relayUrl !== "string" ||
      !isHttpOrigin(mirror.relayUrl) ||
      !isCapsuleId(mirror.capsuleId) ||
      !isCapabilityToken(mirror[tokenField])
    ) {
      throw new Error(message);
    }
    const key = `${mirror.relayUrl}/${String(mirror.capsuleId)}`;
    if (seen.has(key)) throw new Error(message);
    seen.add(key);
  }
}

export function assertOwnerCapability(
  value: unknown,
): asserts value is CapsuleOwnerCapability {
  if (!value || typeof value !== "object")
    throw new Error("Invalid owner capability");
  const candidate = value as Partial<CapsuleOwnerCapability>;
  if (
    typeof candidate.relayUrl !== "string" ||
    !isHttpOrigin(candidate.relayUrl) ||
    !isCapsuleId(candidate.capsuleId) ||
    !isCapabilityToken(candidate.deleteToken)
  ) {
    throw new Error("Invalid owner capability");
  }
  assertMirrorList(
    candidate.mirrors,
    "deleteToken",
    "Invalid owner capability",
  );
}

function assertSharding(
  value: unknown,
  mirrorCount: number,
): asserts value is CapsuleSharding {
  const message = "Invalid share capability";
  if (!value || typeof value !== "object") throw new Error(message);
  const sharding = value as Partial<CapsuleSharding>;
  if (
    Object.keys(sharding).length !== 4 ||
    typeof sharding.k !== "number" ||
    typeof sharding.n !== "number" ||
    typeof sharding.blockBytes !== "number" ||
    typeof sharding.shardBytes !== "number" ||
    !Number.isSafeInteger(sharding.k) ||
    !Number.isSafeInteger(sharding.n) ||
    !Number.isSafeInteger(sharding.blockBytes) ||
    !Number.isSafeInteger(sharding.shardBytes) ||
    sharding.k < MIN_ERASURE_DATA_SHARDS ||
    sharding.n <= sharding.k ||
    sharding.n > MAX_ERASURE_SHARDS ||
    sharding.blockBytes <= 0 ||
    sharding.shardBytes !== shardLengthFor(sharding.blockBytes, sharding.k) ||
    // The relay list is the shard list: one relay per shard index, in order.
    sharding.n !== mirrorCount + 1
  ) {
    throw new Error(message);
  }
}

export function assertShareCapability(
  value: unknown,
): asserts value is CapsuleShareCapability {
  if (!value || typeof value !== "object")
    throw new Error("Invalid share capability");
  const candidate = value as Partial<CapsuleShareCapability>;
  if (
    (candidate.version !== 1 &&
      candidate.version !== 2 &&
      candidate.version !== 3) ||
    typeof candidate.relayUrl !== "string" ||
    !isHttpOrigin(candidate.relayUrl) ||
    !isCapsuleId(candidate.capsuleId) ||
    !isCapabilityToken(candidate.readToken) ||
    typeof candidate.key !== "string" ||
    fromBase64Url(candidate.key).byteLength !== 32 ||
    typeof candidate.noncePrefix !== "string" ||
    fromBase64Url(candidate.noncePrefix).byteLength !== 8
  ) {
    throw new Error("Invalid share capability");
  }
  if (candidate.version === 1 && candidate.mirrors !== undefined) {
    throw new Error("Invalid share capability");
  }
  assertMirrorList(candidate.mirrors, "readToken", "Invalid share capability");

  if (candidate.sharding === undefined) return;
  if (candidate.version !== 3) throw new Error("Invalid share capability");
  assertSharding(candidate.sharding, candidate.mirrors?.length ?? 0);
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/" || url.pathname === "") &&
      url.origin === value.replace(/\/$/u, "")
    );
  } catch {
    return false;
  }
}

export { isHttpOrigin as isRelayOrigin };

export async function sha256Base64Url(
  value: string | Uint8Array,
): Promise<string> {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const digest = await getCrypto().subtle.digest(
    "SHA-256",
    asArrayBuffer(bytes),
  );
  return toBase64Url(new Uint8Array(digest));
}
