/**
 * A capsule with no network anywhere in it.
 *
 * Everything else in CAPSULE assumes there is a relay to reach. Sometimes
 * there is not — the connection is cut, the network is hostile, or the file
 * simply must not touch one. An offline capsule is the same encrypted content
 * in a single file that travels on a memory stick, an SD card, or a laptop
 * carried across a room.
 *
 * The default is **sealed**: the file holds ciphertext and nothing that opens
 * it. The key travels separately, the way the key in a share link travels
 * separately from the bytes on the relay. It is the same idea applied to a
 * different courier, and it means a lost memory stick is a lost memory stick
 * rather than a disclosure.
 *
 * Putting the key inside is supported, because sometimes the point is to hand
 * somebody one object and be done. That choice is theirs to make and the tool
 * says what it costs.
 *
 * Layout:
 *
 *     "CAPSOFF1"        8 bytes
 *     header length     uint32, big-endian
 *     header            UTF-8 JSON
 *     chunks            uint32 length prefix, then ciphertext, repeated
 */

import { fromBase64Url, toBase64Url } from "./bytes.js";
import type { CapsuleSecrets } from "./index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const OFFLINE_MAGIC = "CAPSOFF1";
export const OFFLINE_VERSION = 1 as const;
export const MAX_OFFLINE_HEADER_BYTES = 1024 * 1024;
export const MAX_OFFLINE_CHUNKS = 100_000;

export interface OfflineCapsuleHeader {
  v: typeof OFFLINE_VERSION;
  /** Encrypted manifest, base64url. Opens with the same key as the chunks. */
  manifest: string;
  chunkCount: number;
  createdAt: string;
  /** Present only when the author chose to seal the key in with the content. */
  secrets?: CapsuleSecrets;
}

export interface OfflineCapsule {
  header: OfflineCapsuleHeader;
  chunks: Uint8Array[];
}

export interface PackOfflineInput {
  encryptedManifest: Uint8Array;
  chunks: Uint8Array[];
  /** Include to make the file self-opening. Omit to keep it sealed. */
  secrets?: CapsuleSecrets;
  createdAt?: string;
}

export function packOfflineCapsule(input: PackOfflineInput): Uint8Array {
  if (input.chunks.length === 0) {
    throw new Error("An offline capsule needs at least one chunk");
  }
  if (input.chunks.length > MAX_OFFLINE_CHUNKS) {
    throw new Error("Too many chunks for one offline capsule");
  }

  const header: OfflineCapsuleHeader = {
    v: OFFLINE_VERSION,
    manifest: toBase64Url(input.encryptedManifest),
    chunkCount: input.chunks.length,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.secrets ? { secrets: input.secrets } : {}),
  };
  const encodedHeader = textEncoder.encode(JSON.stringify(header));
  if (encodedHeader.byteLength > MAX_OFFLINE_HEADER_BYTES) {
    throw new Error("The offline capsule header is too large");
  }

  const magic = textEncoder.encode(OFFLINE_MAGIC);
  const body = input.chunks.reduce(
    (total, chunk) => total + 4 + chunk.byteLength,
    0,
  );
  const output = new Uint8Array(
    magic.byteLength + 4 + encodedHeader.byteLength + body,
  );
  const view = new DataView(output.buffer);

  output.set(magic, 0);
  view.setUint32(magic.byteLength, encodedHeader.byteLength, false);
  output.set(encodedHeader, magic.byteLength + 4);

  let cursor = magic.byteLength + 4 + encodedHeader.byteLength;
  for (const chunk of input.chunks) {
    view.setUint32(cursor, chunk.byteLength, false);
    cursor += 4;
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return output;
}

export function unpackOfflineCapsule(bytes: Uint8Array): OfflineCapsule {
  const magic = textEncoder.encode(OFFLINE_MAGIC);
  if (bytes.byteLength < magic.byteLength + 4) {
    throw new Error("Not an offline CAPSULE file");
  }
  for (let index = 0; index < magic.byteLength; index += 1) {
    if (bytes[index] !== magic[index]) {
      throw new Error("Not an offline CAPSULE file");
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(magic.byteLength, false);
  if (headerLength > MAX_OFFLINE_HEADER_BYTES) {
    throw new Error("The offline capsule header is too large");
  }
  const bodyStart = magic.byteLength + 4 + headerLength;
  if (bodyStart > bytes.byteLength) {
    throw new Error("The offline capsule is truncated");
  }

  let header: OfflineCapsuleHeader;
  try {
    header = JSON.parse(
      textDecoder.decode(bytes.subarray(magic.byteLength + 4, bodyStart)),
    ) as OfflineCapsuleHeader;
  } catch {
    throw new Error("The offline capsule header is not valid JSON");
  }
  if (header?.v !== OFFLINE_VERSION) {
    throw new Error("Unsupported offline capsule version");
  }
  if (
    !Number.isSafeInteger(header.chunkCount) ||
    header.chunkCount <= 0 ||
    header.chunkCount > MAX_OFFLINE_CHUNKS
  ) {
    throw new Error("The offline capsule declares an implausible chunk count");
  }
  if (typeof header.manifest !== "string") {
    throw new Error("The offline capsule has no manifest");
  }
  // Parsed here so a malformed one fails now rather than during decryption.
  fromBase64Url(header.manifest);

  const chunks: Uint8Array[] = [];
  let cursor = bodyStart;
  for (let index = 0; index < header.chunkCount; index += 1) {
    if (cursor + 4 > bytes.byteLength) {
      throw new Error("The offline capsule is truncated");
    }
    const length = view.getUint32(cursor, false);
    cursor += 4;
    if (cursor + length > bytes.byteLength) {
      throw new Error("The offline capsule is truncated");
    }
    chunks.push(bytes.subarray(cursor, cursor + length));
    cursor += length;
  }
  return { header, chunks };
}

/** The encrypted manifest, ready to decrypt with the capsule's own key. */
export function offlineManifest(capsule: OfflineCapsule): Uint8Array {
  return fromBase64Url(capsule.header.manifest);
}

/** Whether the file can be opened on its own, or needs a key from elsewhere. */
export function offlineCapsuleIsSealed(capsule: OfflineCapsule): boolean {
  return capsule.header.secrets === undefined;
}
