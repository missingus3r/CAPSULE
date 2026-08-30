import {
  CAPSULE_PROTOCOL_VERSION,
  DEFAULT_CHUNK_SIZE,
  createCapsuleSecrets,
  decryptChunk,
  decryptMetadata,
  encryptChunk,
  encryptMetadata,
  offlineManifest,
  packOfflineCapsule,
  paddedLengthFor,
  sizeClassStep,
  transportLength,
  unpackOfflineCapsule,
  type CapsuleMetadata,
  type CapsuleSecrets,
} from "@capsule/protocol";
import {
  coarseMimeType,
  neutralFilename,
  scrubFileMetadata,
} from "./anonymize.js";
import type {
  AnonymityReport,
  CapsuleAnonymityOptions,
  TransferProgress,
} from "./transfer.js";

/**
 * Making and opening a capsule with no relay involved at any point.
 *
 * This is the same encryption, the same padding and the same metadata
 * scrubbing as an upload; only the courier changes. It is the answer to the
 * case CAPSULE otherwise has no answer for: there is no network, or there is
 * one and it must not be used.
 */

export const OFFLINE_CAPABILITY_PREFIX = "capsule-offline:";

export interface PackOfflineOptions {
  data: Blob;
  filename: string;
  mimeType?: string;
  note?: string;
  chunkSize?: number;
  anonymity?: CapsuleAnonymityOptions;
  /**
   * Puts the key inside the file, so it opens on its own.
   *
   * Off by default. A sealed file is ciphertext and nothing else: losing the
   * memory stick loses the memory stick. Sealing the key in makes it one
   * object to hand over, and makes losing it a disclosure.
   */
  includeKey?: boolean;
  onProgress?: (progress: TransferProgress) => void;
}

export interface PackedOfflineCapsule {
  bytes: Uint8Array;
  metadata: CapsuleMetadata;
  anonymity: AnonymityReport;
  /** The key, for a sealed file. Send it by a different route than the file. */
  capability?: string;
  sealed: boolean;
}

export function encodeOfflineCapability(secrets: CapsuleSecrets): string {
  return `${OFFLINE_CAPABILITY_PREFIX}${btoa(JSON.stringify(secrets))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}

export function decodeOfflineCapability(value: string): CapsuleSecrets {
  const trimmed = value.trim();
  if (!trimmed.startsWith(OFFLINE_CAPABILITY_PREFIX)) {
    throw new Error("Not an offline capsule capability");
  }
  const encoded = trimmed.slice(OFFLINE_CAPABILITY_PREFIX.length);
  const padded = encoded
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const parsed = JSON.parse(atob(padded)) as CapsuleSecrets;
  if (
    typeof parsed?.key !== "string" ||
    typeof parsed?.noncePrefix !== "string"
  ) {
    throw new Error("Malformed offline capsule capability");
  }
  return parsed;
}

export async function packOfflineCapsuleFile(
  options: PackOfflineOptions,
): Promise<PackedOfflineCapsule> {
  if (!options.filename.trim()) throw new Error("A filename is required");
  const anonymity = { ...(options.anonymity ?? {}) };

  let payload = options.data;
  let removedMetadata: string[] = [];
  let remainingMetadata: string[] = [];
  let metadataScrubbed = false;
  if (anonymity.scrubMetadata) {
    const scrubbed = scrubFileMetadata(
      new Uint8Array(await payload.arrayBuffer()),
    );
    payload = new Blob([scrubbed.bytes as unknown as BlobPart], {
      type: payload.type,
    });
    removedMetadata = scrubbed.removed;
    remainingMetadata = scrubbed.remaining;
    metadataScrubbed = scrubbed.supported;
  }

  const declaredMimeType =
    options.mimeType?.trim() || payload.type || "application/octet-stream";
  const filename = anonymity.hideFilename
    ? neutralFilename(declaredMimeType)
    : options.filename;
  const mimeType = anonymity.hideFilename
    ? coarseMimeType(declaredMimeType)
    : declaredMimeType;

  const chunkSize =
    options.chunkSize ??
    (anonymity.padding
      ? Math.min(DEFAULT_CHUNK_SIZE, sizeClassStep(payload.size))
      : DEFAULT_CHUNK_SIZE);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("Invalid chunk size");
  }

  const paddedLength = anonymity.padding
    ? paddedLengthFor(payload.size, chunkSize)
    : undefined;
  const storedLength = paddedLength ?? payload.size;
  const chunkCount = Math.max(1, Math.ceil(storedLength / chunkSize));

  const secrets = createCapsuleSecrets(CAPSULE_PROTOCOL_VERSION);
  const metadata: CapsuleMetadata = {
    version: CAPSULE_PROTOCOL_VERSION,
    filename,
    mimeType,
    byteLength: payload.size,
    chunkSize,
    chunkCount,
    createdAt: new Date().toISOString(),
    // An offline capsule has nobody to expire it: there is no relay running a
    // clock. Saying `null` is the truthful answer rather than a promise that
    // no software will keep.
    expiresAt: null,
    ...(paddedLength !== undefined ? { paddedLength } : {}),
    ...(options.note ? { note: options.note } : {}),
  };

  const source = new Uint8Array(await payload.arrayBuffer());
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkSize;
    const plaintext = new Uint8Array(Math.min(chunkSize, storedLength - start));
    // Everything past the real bytes is left as zeroes and then encrypted, so
    // padding is indistinguishable from content in the file.
    plaintext.set(
      source.subarray(start, Math.min(start + chunkSize, source.length)),
    );
    chunks.push(await encryptChunk(plaintext, index, secrets));
    options.onProgress?.({
      phase: "encrypting",
      completedBytes: Math.min(start + chunkSize, storedLength),
      totalBytes: storedLength,
      completedChunks: index + 1,
      totalChunks: chunkCount,
    });
  }

  const bytes = packOfflineCapsule({
    encryptedManifest: await encryptMetadata(metadata, secrets),
    chunks,
    ...(options.includeKey ? { secrets } : {}),
  });
  options.onProgress?.({
    phase: "complete",
    completedBytes: storedLength,
    totalBytes: storedLength,
    completedChunks: chunkCount,
    totalChunks: chunkCount,
  });

  return {
    bytes,
    metadata,
    sealed: options.includeKey !== true,
    ...(options.includeKey
      ? {}
      : { capability: encodeOfflineCapability(secrets) }),
    anonymity: {
      padded: paddedLength !== undefined,
      paddingBytes: (paddedLength ?? payload.size) - payload.size,
      metadataScrubbed,
      removedMetadata,
      remainingMetadata,
      filenameHidden: anonymity.hideFilename === true,
    },
  };
}

export interface OpenedOfflineCapsule {
  metadata: CapsuleMetadata;
  blob: Blob;
}

export async function openOfflineCapsuleFile(
  bytes: Uint8Array,
  capability?: string,
  onProgress?: (progress: TransferProgress) => void,
): Promise<OpenedOfflineCapsule> {
  const capsule = unpackOfflineCapsule(bytes);
  const secrets = capability
    ? decodeOfflineCapability(capability)
    : capsule.header.secrets;
  if (!secrets) {
    throw new Error(
      "This offline capsule is sealed: it needs the capsule-offline: capability that was printed when it was made.",
    );
  }

  const metadata = await decryptMetadata(offlineManifest(capsule), secrets);
  if (capsule.chunks.length !== metadata.chunkCount) {
    throw new Error("The offline capsule is missing chunks");
  }

  const stored = transportLength(metadata);
  const plaintext = new Uint8Array(stored);
  let offset = 0;
  for (let index = 0; index < capsule.chunks.length; index += 1) {
    const decrypted = await decryptChunk(
      capsule.chunks[index] as Uint8Array,
      index,
      secrets,
    );
    plaintext.set(decrypted, offset);
    offset += decrypted.byteLength;
    onProgress?.({
      phase: "decrypting",
      completedBytes: offset,
      totalBytes: stored,
      completedChunks: index + 1,
      totalChunks: capsule.chunks.length,
    });
  }
  if (offset !== stored) {
    throw new Error("The offline capsule does not match its manifest");
  }

  // Padding is dropped here, exactly as a download does.
  const body = plaintext.subarray(0, metadata.byteLength);
  onProgress?.({
    phase: "complete",
    completedBytes: metadata.byteLength,
    totalBytes: metadata.byteLength,
    completedChunks: capsule.chunks.length,
    totalChunks: capsule.chunks.length,
  });
  return {
    metadata,
    blob: new Blob([body.slice() as unknown as BlobPart], {
      type: metadata.mimeType,
    }),
  };
}
