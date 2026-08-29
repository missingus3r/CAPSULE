const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const CAPSULE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const CAPSULE_FRAGMENT_PREFIX = "capsule=";
export const CAPSULE_OWNER_PREFIX = "capsule-owner:";

export interface CapsuleMetadata {
  version: typeof CAPSULE_PROTOCOL_VERSION;
  filename: string;
  mimeType: string;
  byteLength: number;
  chunkSize: number;
  chunkCount: number;
  createdAt: string;
  expiresAt: string;
  note?: string;
}

export interface CapsuleSecrets {
  key: string;
  noncePrefix: string;
}

export interface CapsuleShareCapability {
  version: typeof CAPSULE_PROTOCOL_VERSION;
  relayUrl: string;
  capsuleId: string;
  readToken: string;
  key: string;
  noncePrefix: string;
}

export interface CapsuleOwnerCapability {
  capsuleId: string;
  deleteToken: string;
  relayUrl: string;
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required by the CAPSULE protocol");
  }
  return globalThis.crypto;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function toBase64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url value");
  }

  if (typeof Buffer !== "undefined") {
    const decoded = new Uint8Array(Buffer.from(value, "base64url"));
    if (toBase64Url(decoded) !== value)
      throw new Error("Invalid base64url value");
    return decoded;
  }

  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const decoded = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (toBase64Url(decoded) !== value)
    throw new Error("Invalid base64url value");
  return decoded;
}

export function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function createCapsuleSecrets(): CapsuleSecrets {
  return {
    key: randomBase64Url(32),
    noncePrefix: randomBase64Url(8),
  };
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

function additionalData(index: number): Uint8Array {
  return textEncoder.encode(
    `CAPSULE/v${CAPSULE_PROTOCOL_VERSION}/chunk/${index}`,
  );
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
      additionalData: asArrayBuffer(additionalData(index)),
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
        additionalData: asArrayBuffer(additionalData(index)),
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
  if (
    candidate.version !== CAPSULE_PROTOCOL_VERSION ||
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
    typeof candidate.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    Date.parse(candidate.expiresAt) <= Date.parse(candidate.createdAt) ||
    (candidate.note !== undefined &&
      (typeof candidate.note !== "string" || candidate.note.length > 4096)) ||
    candidate.chunkCount !==
      Math.ceil(candidate.byteLength / candidate.chunkSize)
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
  if (encoded.length > 4096)
    throw new Error("CAPSULE share fragment is too large");
  const parsed: unknown = JSON.parse(
    textDecoder.decode(fromBase64Url(encoded)),
  );
  assertShareCapability(parsed);
  return parsed;
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
  if (!value.startsWith(CAPSULE_OWNER_PREFIX))
    throw new Error("Not a CAPSULE owner capability");
  const parsed: unknown = JSON.parse(
    textDecoder.decode(fromBase64Url(value.slice(CAPSULE_OWNER_PREFIX.length))),
  );
  assertOwnerCapability(parsed);
  return parsed;
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
    typeof candidate.capsuleId !== "string" ||
    !/^[A-Za-z0-9_-]{24,64}$/u.test(candidate.capsuleId) ||
    typeof candidate.deleteToken !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(candidate.deleteToken)
  ) {
    throw new Error("Invalid owner capability");
  }
}

export function assertShareCapability(
  value: unknown,
): asserts value is CapsuleShareCapability {
  if (!value || typeof value !== "object")
    throw new Error("Invalid share capability");
  const candidate = value as Partial<CapsuleShareCapability>;
  if (
    candidate.version !== CAPSULE_PROTOCOL_VERSION ||
    typeof candidate.relayUrl !== "string" ||
    !isHttpOrigin(candidate.relayUrl) ||
    typeof candidate.capsuleId !== "string" ||
    !/^[A-Za-z0-9_-]{24,64}$/u.test(candidate.capsuleId) ||
    typeof candidate.readToken !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(candidate.readToken) ||
    typeof candidate.key !== "string" ||
    fromBase64Url(candidate.key).byteLength !== 32 ||
    typeof candidate.noncePrefix !== "string" ||
    fromBase64Url(candidate.noncePrefix).byteLength !== 8
  ) {
    throw new Error("Invalid share capability");
  }
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
