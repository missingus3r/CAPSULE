import {
  CAPSULE_PROTOCOL_VERSION,
  DEFAULT_CHUNK_SIZE,
  MAX_CAPSULE_MIRRORS,
  buildShareUrl,
  createCapsuleSecrets,
  decodeShards,
  decryptChunk,
  decryptMetadata,
  encodeShards,
  encryptChunk,
  encryptMetadata,
  fromBase64Url,
  ownerLocations,
  paddedLengthFor,
  shardCombinations,
  shardLengthFor,
  shareLocations,
  sha256Base64Url,
  sizeClassStep,
  toBase64Url,
  transportLength,
  type CapsuleLocation,
  type CapsuleMetadata,
  type CapsuleOwnerCapability,
  type CapsuleOwnerLocation,
  type CapsuleSecrets,
  type CapsuleShareCapability,
  type CapsuleSharding,
} from "@capsule/protocol";
import {
  coarseMimeType,
  neutralFilename,
  scrubBlobMetadata,
} from "./anonymize.js";
import {
  CapsuleRelayClient,
  normalizeRelayUrl,
  type RelayCreateRequest,
  type RelayCreateResponse,
  type RelayPublicConfig,
  type RelayTransport,
  type RelayTransportFactory,
  type RetryPolicy,
} from "./client.js";
import type { FetchLike } from "./network.js";

export type TransferPhase =
  | "creating"
  | "encrypting"
  | "uploading"
  | "finalizing"
  | "downloading"
  | "decrypting"
  | "complete";

export interface TransferProgress {
  phase: TransferPhase;
  completedBytes: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
}

/**
 * Client-side anonymisation. Every option costs something — bandwidth, time or
 * convenience — so each one is opt-in and named after what it actually hides.
 */
export interface CapsuleAnonymityOptions {
  /** Pads the capsule to a size class so the relay cannot read the exact size. */
  padding?: boolean;
  /** Strips embedded metadata from the file before encrypting it. */
  scrubMetadata?: boolean;
  /** Replaces the filename and mime type with neutral values in the manifest. */
  hideFilename?: boolean;
  /** Upper bound of a random delay inserted between chunk uploads. */
  jitterMs?: number;
}

export interface AnonymityReport {
  padded: boolean;
  paddingBytes: number;
  /** True when the file format was understood well enough to clean it. */
  metadataScrubbed: boolean;
  removedMetadata: string[];
  /** Metadata that was detected but could not be removed safely. */
  remainingMetadata: string[];
  filenameHidden: boolean;
}

/**
 * How copies are spread across relays.
 *
 * - `mirror` stores the whole capsule on every relay. Simple, and any single
 *   relay can serve it — including to whoever compels that relay.
 * - `shards` splits every chunk with `k of n` erasure coding. No single relay
 *   holds enough to reconstruct a byte, and any `k` of them can serve the
 *   capsule. It costs `n/k` of the capsule instead of `n`.
 */
export interface CapsuleReplication {
  mode: "mirror" | "shards";
  /** Shards required to reconstruct, for `shards` mode. Defaults to n - 1. */
  dataShards?: number;
}

export interface UploadCapsuleOptions {
  data: Blob;
  filename: string;
  mimeType?: string;
  note?: string;
  /** Seconds until expiry, or `null` for a capsule the relay keeps until deleted. */
  ttlSeconds: number | null;
  relayUrl: string;
  appUrl: string;
  /** Extra relays that should store a copy, or a shard, of the capsule. */
  mirrorRelayUrls?: string[];
  replication?: CapsuleReplication;
  chunkSize?: number;
  anonymity?: CapsuleAnonymityOptions;
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  /**
   * Replaces the direct connection to a relay. The mix network supplies one of
   * these so an upload travels through other relays instead of straight to the
   * one that stores it.
   */
  transport?: RelayTransportFactory;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
  /**
   * Receives the resume ticket as soon as storage is reserved. Persisting it
   * lets an interrupted upload continue instead of starting over. The ticket
   * contains the capsule key: treat it exactly like the share link.
   */
  onTicket?: (ticket: UploadTicket) => void | Promise<void>;
}

export interface MirrorFailure {
  relayUrl: string;
  reason: string;
}

export interface UploadedCapsule {
  shareUrl: string;
  capability: CapsuleShareCapability;
  ownerCapability: CapsuleOwnerCapability;
  metadata: CapsuleMetadata;
  /** Relays that hold the capsule, primary first. */
  relayUrls: string[];
  /** Mirrors that were requested but did not store the capsule. */
  mirrorFailures: MirrorFailure[];
  anonymity: AnonymityReport;
  sharding?: CapsuleSharding;
}

/** Everything needed to continue an interrupted upload. Contains the key. */
export interface UploadTicket {
  version: 1;
  createdAt: string;
  /**
   * Commitment to the exact bytes this ticket was issued for.
   *
   * Resuming with a different file would encrypt different plaintext under a
   * nonce already used for the original — and with several relays at
   * different points in the upload, both ciphertexts would exist. Reusing a
   * nonce breaks AES-GCM outright, so the file is checked rather than trusted.
   */
  contentDigest: string;
  secrets: CapsuleSecrets;
  metadata: CapsuleMetadata;
  encryptedManifest: string;
  expiresInSeconds: number | null;
  chunkCount: number;
  totalCiphertextBytes: number;
  sharding?: CapsuleSharding;
  targets: Array<{
    relayUrl: string;
    capsuleId: string;
    readToken: string;
    writeToken: string;
    deleteToken: string;
  }>;
}

export interface DownloadCapsuleOptions {
  capability: CapsuleShareCapability;
  /**
   * Relays to try after the ones the capability names, using the same
   * identifier and read token.
   *
   * A capability is signed, or embedded in a link, at the moment of
   * publishing: it can only ever name the relays that existed for the
   * publisher then. Relays that took a copy afterwards answer for the same
   * `capsuleId` — that is the point of storing a copy under the identifier it
   * came with — but nothing in the capability can say so. This is how a
   * caller who knows the network offers those relays as a fallback, and it is
   * what makes losing the origin survivable rather than final.
   *
   * Ignored for sharded capsules, where each relay holds a shard rather than
   * a copy and the relay list is ordered by shard index.
   */
  extraRelayUrls?: readonly string[];
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  transport?: RelayTransportFactory;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

export interface DownloadedCapsule {
  metadata: CapsuleMetadata;
  blob: Blob;
  /** Relays the capsule was actually read from. */
  relayUrls: string[];
}

function report(
  callback:
    UploadCapsuleOptions["onProgress"] | DownloadCapsuleOptions["onProgress"],
  progress: TransferProgress,
): void {
  callback?.(progress);
}

/** Builds the transport for a relay: direct unless the caller supplied one. */
function transportFor(
  relayUrl: string,
  options: {
    transport?: RelayTransportFactory;
    fetchImpl?: FetchLike;
    retry?: Partial<RetryPolicy>;
  },
): RelayTransport {
  if (options.transport) return options.transport(relayUrl);
  return new CapsuleRelayClient(relayUrl, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function jitter(maximumMs: number | undefined): Promise<void> {
  if (!maximumMs || maximumMs <= 0) return;
  const wait = Math.floor(Math.random() * maximumMs);
  if (wait === 0) return;
  await new Promise((resolve) => setTimeout(resolve, wait));
}

interface UploadTarget {
  client: RelayTransport;
  config: RelayPublicConfig;
  created?: RelayCreateResponse;
  /** Chunk indices the relay already holds, when resuming. */
  present?: Set<number>;
}

function minimumLimits(targets: UploadTarget[]): RelayPublicConfig {
  const first = targets[0]?.config;
  if (!first) throw new Error("No relay is available for this capsule");
  return targets.reduce<RelayPublicConfig>(
    (limits, target) => ({
      version: limits.version,
      maxCapsuleBytes: Math.min(
        limits.maxCapsuleBytes,
        target.config.maxCapsuleBytes,
      ),
      maxChunkBytes: Math.min(
        limits.maxChunkBytes,
        target.config.maxChunkBytes,
      ),
      maxManifestBytes: Math.min(
        limits.maxManifestBytes,
        target.config.maxManifestBytes,
      ),
      maxChunkCount: Math.min(
        limits.maxChunkCount,
        target.config.maxChunkCount,
      ),
      defaultTtlSeconds: Math.min(
        limits.defaultTtlSeconds,
        target.config.defaultTtlSeconds,
      ),
      maxTtlSeconds: Math.min(
        limits.maxTtlSeconds,
        target.config.maxTtlSeconds,
      ),
      persistentCapsules:
        limits.persistentCapsules && target.config.persistentCapsules,
    }),
    { ...first },
  );
}

/**
 * A commitment to the contents of a blob, computed one chunk at a time so a
 * large file never has to be held in memory: the digest of the concatenated
 * per-chunk digests.
 */
async function contentDigestOf(
  payload: Blob,
  chunkSize: number,
): Promise<string> {
  const digests: Uint8Array[] = [];
  for (let offset = 0; offset < payload.size; offset += chunkSize) {
    const slice = new Uint8Array(
      await payload
        .slice(offset, Math.min(offset + chunkSize, payload.size))
        .arrayBuffer(),
    );
    digests.push(fromBase64Url(await sha256Base64Url(slice)));
  }
  const combined = new Uint8Array(digests.length * 32);
  digests.forEach((digest, index) => combined.set(digest, index * 32));
  return sha256Base64Url(combined);
}

/** Reads one padded chunk of plaintext, zero-filling past the end of the file. */
async function readChunk(
  payload: Blob,
  index: number,
  chunkSize: number,
  storedLength: number,
): Promise<Uint8Array> {
  const start = index * chunkSize;
  const end = Math.min(start + chunkSize, storedLength);
  const readEnd = Math.min(end, payload.size);
  const plaintext = new Uint8Array(end - start);
  if (readEnd > start) {
    plaintext.set(
      new Uint8Array(await payload.slice(start, readEnd).arrayBuffer()),
    );
  }
  return plaintext;
}

export async function uploadCapsule(
  options: UploadCapsuleOptions,
): Promise<UploadedCapsule> {
  const persistent = options.ttlSeconds === null;
  if (
    !persistent &&
    (!Number.isFinite(options.ttlSeconds) || (options.ttlSeconds ?? 0) <= 0)
  ) {
    throw new Error("Capsule TTL must be greater than zero");
  }
  if (!options.filename.trim()) throw new Error("A filename is required");

  const replication = options.replication ?? { mode: "mirror" };
  const anonymity = { ...(options.anonymity ?? {}) };
  if (replication.mode === "shards") {
    // Erasure coding needs every chunk to be the same size, which is exactly
    // what size-class padding produces.
    anonymity.padding = true;
  }
  const clientOptions = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
  };

  const primaryUrl = normalizeRelayUrl(options.relayUrl);
  const requestedMirrors = [...new Set(options.mirrorRelayUrls ?? [])]
    .map((url) => normalizeRelayUrl(url))
    .filter((url) => url !== primaryUrl)
    .slice(0, MAX_CAPSULE_MIRRORS);

  report(options.onProgress, {
    phase: "creating",
    completedBytes: 0,
    totalBytes: options.data.size,
    completedChunks: 0,
    totalChunks: 0,
  });

  const primary = transportFor(primaryUrl, options);
  const primaryConfig = await primary.config(options.signal);
  if (persistent && !primaryConfig.persistentCapsules) {
    throw new Error(
      "This relay does not store capsules without expiry. Choose a TTL or another relay.",
    );
  }
  if (!persistent && (options.ttlSeconds ?? 0) > primaryConfig.maxTtlSeconds) {
    throw new Error(
      `Capsule TTL exceeds the relay limit of ${primaryConfig.maxTtlSeconds} seconds`,
    );
  }

  const mirrorFailures: MirrorFailure[] = [];
  const targets: UploadTarget[] = [{ client: primary, config: primaryConfig }];
  for (const mirrorUrl of requestedMirrors) {
    try {
      const client = transportFor(mirrorUrl, options);
      const config = await client.config(options.signal);
      if (persistent && !config.persistentCapsules) {
        throw new Error("Relay does not accept capsules without expiry");
      }
      if (!persistent && (options.ttlSeconds ?? 0) > config.maxTtlSeconds) {
        throw new Error("Relay TTL limit is below the requested expiry");
      }
      targets.push({ client, config });
    } catch (error) {
      mirrorFailures.push({ relayUrl: mirrorUrl, reason: reasonOf(error) });
    }
  }

  // Anonymisation happens before anything is measured: padding and manifest
  // limits must be computed over the bytes that actually leave the device.
  let payload = options.data;
  let removedMetadata: string[] = [];
  let remainingMetadata: string[] = [];
  let metadataScrubbed = false;
  if (anonymity.scrubMetadata) {
    const scrubbed = await scrubBlobMetadata(payload);
    payload = scrubbed.blob;
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

  const limits = minimumLimits(targets);
  const maximumPlaintextChunkBytes = limits.maxChunkBytes - 16;
  // Padding rounds up to whole chunks, so a padded capsule uses chunks no
  // larger than the size class granularity. Otherwise a 60 byte file would be
  // padded to a full default chunk instead of to its 64 KiB class.
  const defaultChunkSize = anonymity.padding
    ? Math.min(
        DEFAULT_CHUNK_SIZE,
        maximumPlaintextChunkBytes,
        sizeClassStep(payload.size),
      )
    : Math.min(DEFAULT_CHUNK_SIZE, maximumPlaintextChunkBytes);
  const chunkSize = options.chunkSize ?? defaultChunkSize;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)
    throw new Error("Invalid chunk size");
  if (chunkSize > maximumPlaintextChunkBytes) {
    throw new Error(
      `Chunk size exceeds the relay limit of ${maximumPlaintextChunkBytes} plaintext bytes`,
    );
  }

  const paddedLength = anonymity.padding
    ? paddedLengthFor(payload.size, chunkSize)
    : undefined;
  const storedLength = paddedLength ?? payload.size;
  const chunkCount = Math.ceil(storedLength / chunkSize);
  if (chunkCount > limits.maxChunkCount) {
    throw new Error(
      `Capsule requires ${chunkCount} chunks, above the relay limit of ${limits.maxChunkCount}`,
    );
  }

  let sharding: CapsuleSharding | undefined;
  if (replication.mode === "shards") {
    const n = targets.length;
    if (n < 3) {
      throw new Error(
        "Splitting a capsule needs at least three relays; use mirroring instead",
      );
    }
    const k = replication.dataShards ?? n - 1;
    if (!Number.isSafeInteger(k) || k < 2 || k >= n) {
      throw new Error(
        `With ${n} relays the number of shards needed to rebuild must be between 2 and ${n - 1}`,
      );
    }
    const blockBytes = chunkSize + 16;
    const shardBytes = shardLengthFor(blockBytes, k);
    if (shardBytes < 16) {
      throw new Error("The chunk size is too small to split across relays");
    }
    if (shardBytes > limits.maxChunkBytes) {
      throw new Error(
        `Each shard would be ${shardBytes} bytes, above the relay limit`,
      );
    }
    sharding = { k, n, blockBytes, shardBytes };
  }

  const storedPerRelay = sharding
    ? chunkCount * sharding.shardBytes
    : storedLength + chunkCount * 16;
  if (
    !Number.isSafeInteger(storedPerRelay) ||
    storedPerRelay > limits.maxCapsuleBytes
  ) {
    throw new Error(
      `Capsule exceeds the relay limit of ${limits.maxCapsuleBytes} encrypted bytes`,
    );
  }

  const secrets = createCapsuleSecrets(CAPSULE_PROTOCOL_VERSION);
  const now = new Date();
  const metadata: CapsuleMetadata = {
    version: CAPSULE_PROTOCOL_VERSION,
    filename,
    mimeType,
    byteLength: payload.size,
    chunkSize,
    chunkCount,
    createdAt: now.toISOString(),
    expiresAt: persistent
      ? null
      : new Date(
          now.getTime() + (options.ttlSeconds ?? 0) * 1000,
        ).toISOString(),
    ...(paddedLength !== undefined ? { paddedLength } : {}),
    ...(options.note?.trim() ? { note: options.note.trim() } : {}),
  };

  const encryptedManifest = await encryptMetadata(metadata, secrets);
  if (encryptedManifest.byteLength > limits.maxManifestBytes) {
    throw new Error(
      `Encrypted metadata exceeds the relay limit of ${limits.maxManifestBytes} bytes`,
    );
  }

  const createRequest: RelayCreateRequest = {
    encryptedManifest: toBase64Url(encryptedManifest),
    chunkCount,
    totalCiphertextBytes: storedPerRelay,
    expiresInSeconds: persistent ? null : (options.ttlSeconds ?? 0),
  };

  const reserved: UploadTarget[] = [];
  for (const target of targets) {
    try {
      target.created = await target.client.create(
        createRequest,
        options.signal,
      );
      reserved.push(target);
    } catch (error) {
      if (target.client.relayUrl === primary.relayUrl) throw error;
      if (sharding) {
        // Dropping a relay would change k-of-n into something the sender did
        // not ask for, so the whole upload stops instead.
        throw new Error(
          `Relay ${target.client.relayUrl} could not store a shard: ${reasonOf(error)}`,
        );
      }
      mirrorFailures.push({
        relayUrl: target.client.relayUrl,
        reason: reasonOf(error),
      });
    }
  }

  const ticket: UploadTicket = {
    version: 1,
    createdAt: now.toISOString(),
    contentDigest: options.onTicket
      ? await contentDigestOf(payload, chunkSize)
      : "",
    secrets,
    metadata,
    encryptedManifest: createRequest.encryptedManifest,
    expiresInSeconds: createRequest.expiresInSeconds,
    chunkCount,
    totalCiphertextBytes: storedPerRelay,
    ...(sharding ? { sharding } : {}),
    targets: reserved.map((target) => ({
      relayUrl: target.client.relayUrl,
      capsuleId: (target.created as RelayCreateResponse).capsuleId,
      readToken: (target.created as RelayCreateResponse).readToken,
      writeToken: (target.created as RelayCreateResponse).writeToken,
      deleteToken: (target.created as RelayCreateResponse).deleteToken,
    })),
  };
  await options.onTicket?.(ticket);

  return transferChunks({
    payload,
    storedLength,
    chunkSize,
    chunkCount,
    secrets,
    metadata,
    targets: reserved,
    ...(sharding ? { sharding } : {}),
    anonymity,
    mirrorFailures,
    appUrl: options.appUrl,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    report: {
      padded: paddedLength !== undefined,
      paddingBytes: storedLength - payload.size,
      metadataScrubbed,
      removedMetadata,
      remainingMetadata,
      filenameHidden: anonymity.hideFilename === true,
    },
  });
}

/**
 * Continues an upload that was interrupted, using the ticket the first attempt
 * produced. Chunks the relays already hold are skipped: a repeated chunk with
 * different bytes is rejected by the relay, so a mismatched file is caught
 * rather than silently stitched together.
 */
export async function resumeUpload(
  ticket: UploadTicket,
  data: Blob,
  options: Omit<
    UploadCapsuleOptions,
    | "data"
    | "ttlSeconds"
    | "relayUrl"
    | "mirrorRelayUrls"
    | "replication"
    | "filename"
    | "note"
    | "mimeType"
    | "anonymity"
    | "chunkSize"
    | "onTicket"
  > & { anonymity?: CapsuleAnonymityOptions },
): Promise<UploadedCapsule> {
  if (ticket.version !== 1 || ticket.targets.length === 0) {
    throw new Error("This resume ticket is not usable");
  }
  const clientOptions = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
  };

  let payload = data;
  const anonymity = options.anonymity ?? {};
  if (anonymity.scrubMetadata) {
    payload = (await scrubBlobMetadata(payload)).blob;
  }
  if (payload.size !== ticket.metadata.byteLength) {
    throw new Error(
      "This file does not match the one the ticket was created for",
    );
  }
  if (!ticket.contentDigest) {
    throw new Error("This ticket predates content checking and cannot be used");
  }
  if (
    (await contentDigestOf(payload, ticket.metadata.chunkSize)) !==
    ticket.contentDigest
  ) {
    throw new Error(
      "This file does not match the one the ticket was created for",
    );
  }

  const targets: UploadTarget[] = [];
  for (const stored of ticket.targets) {
    const client = transportFor(stored.relayUrl, options);
    const config = await client.config(options.signal);
    const status = await client.status(
      stored.capsuleId,
      stored.writeToken,
      options.signal,
    );
    targets.push({
      client,
      config,
      created: {
        capsuleId: stored.capsuleId,
        readToken: stored.readToken,
        writeToken: stored.writeToken,
        deleteToken: stored.deleteToken,
        expiresAt: status.expiresAt,
      },
      present: new Set(status.receivedChunks ?? []),
    });
  }

  const storedLength = transportLength(ticket.metadata);
  return transferChunks({
    payload,
    storedLength,
    chunkSize: ticket.metadata.chunkSize,
    chunkCount: ticket.chunkCount,
    secrets: ticket.secrets,
    metadata: ticket.metadata,
    targets,
    ...(ticket.sharding ? { sharding: ticket.sharding } : {}),
    anonymity,
    mirrorFailures: [],
    appUrl: options.appUrl,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    report: {
      padded: ticket.metadata.paddedLength !== undefined,
      paddingBytes: storedLength - ticket.metadata.byteLength,
      metadataScrubbed: anonymity.scrubMetadata === true,
      removedMetadata: [],
      remainingMetadata: [],
      filenameHidden: anonymity.hideFilename === true,
    },
  });
}

interface TransferChunksInput {
  payload: Blob;
  storedLength: number;
  chunkSize: number;
  chunkCount: number;
  secrets: CapsuleSecrets;
  metadata: CapsuleMetadata;
  targets: UploadTarget[];
  sharding?: CapsuleSharding;
  anonymity: CapsuleAnonymityOptions;
  mirrorFailures: MirrorFailure[];
  appUrl: string;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
  report: AnonymityReport;
}

async function transferChunks(
  input: TransferChunksInput,
): Promise<UploadedCapsule> {
  const {
    payload,
    storedLength,
    chunkSize,
    chunkCount,
    secrets,
    metadata,
    sharding,
    anonymity,
    mirrorFailures,
  } = input;
  const surviving = [...input.targets];
  const primaryUrl = surviving[0]?.client.relayUrl;
  let completedBytes = 0;

  for (let index = 0; index < chunkCount; index += 1) {
    report(input.onProgress, {
      phase: "encrypting",
      completedBytes,
      totalBytes: storedLength,
      completedChunks: index,
      totalChunks: chunkCount,
    });

    // A chunk is re-sent to every target as soon as one of them is missing it,
    // not only to the ones missing it. A relay that already holds the chunk
    // then verifies the bytes are identical, which turns a mismatched resume
    // into a refusal instead of a capsule stitched from two different files.
    const pending = surviving.some((target) => !target.present?.has(index))
      ? [...surviving]
      : [];
    if (pending.length > 0) {
      const plaintext = await readChunk(
        payload,
        index,
        chunkSize,
        storedLength,
      );
      const ciphertext = await encryptChunk(plaintext, index + 1, secrets);
      const shards = sharding
        ? encodeShards(ciphertext, { k: sharding.k, n: sharding.n })
        : undefined;

      for (const target of [...pending]) {
        const created = target.created;
        if (!created) continue;
        const position = surviving.indexOf(target);
        const body = shards ? (shards[position] as Uint8Array) : ciphertext;
        try {
          await target.client.uploadChunk(
            created.capsuleId,
            index,
            body,
            created.writeToken,
            input.signal,
          );
        } catch (error) {
          if (target.client.relayUrl === primaryUrl || sharding) throw error;
          surviving.splice(surviving.indexOf(target), 1);
          mirrorFailures.push({
            relayUrl: target.client.relayUrl,
            reason: reasonOf(error),
          });
        }
      }
    }

    completedBytes += Math.min(chunkSize, storedLength - index * chunkSize);
    report(input.onProgress, {
      phase: "uploading",
      completedBytes,
      totalBytes: storedLength,
      completedChunks: index + 1,
      totalChunks: chunkCount,
    });
    await jitter(anonymity.jitterMs);
  }

  report(input.onProgress, {
    phase: "finalizing",
    completedBytes,
    totalBytes: storedLength,
    completedChunks: chunkCount,
    totalChunks: chunkCount,
  });

  for (const target of [...surviving]) {
    const created = target.created;
    if (!created) continue;
    try {
      await target.client.finalize(
        created.capsuleId,
        created.writeToken,
        input.signal,
      );
    } catch (error) {
      if (target.client.relayUrl === primaryUrl || sharding) throw error;
      surviving.splice(surviving.indexOf(target), 1);
      mirrorFailures.push({
        relayUrl: target.client.relayUrl,
        reason: reasonOf(error),
      });
    }
  }

  const [primaryTarget, ...mirrorTargets] = surviving;
  if (!primaryTarget?.created) {
    throw new Error("The primary relay did not store the capsule");
  }

  const mirrors: CapsuleLocation[] = mirrorTargets.flatMap((target) =>
    target.created
      ? [
          {
            relayUrl: target.client.relayUrl,
            capsuleId: target.created.capsuleId,
            readToken: target.created.readToken,
          },
        ]
      : [],
  );
  const ownerMirrors: CapsuleOwnerLocation[] = mirrorTargets.flatMap(
    (target) =>
      target.created
        ? [
            {
              relayUrl: target.client.relayUrl,
              capsuleId: target.created.capsuleId,
              deleteToken: target.created.deleteToken,
            },
          ]
        : [],
  );

  const capability: CapsuleShareCapability = {
    version: CAPSULE_PROTOCOL_VERSION,
    relayUrl: primaryTarget.client.relayUrl,
    capsuleId: primaryTarget.created.capsuleId,
    readToken: primaryTarget.created.readToken,
    key: secrets.key,
    noncePrefix: secrets.noncePrefix,
    ...(mirrors.length > 0 ? { mirrors } : {}),
    ...(sharding ? { sharding } : {}),
  };
  const ownerCapability: CapsuleOwnerCapability = {
    capsuleId: primaryTarget.created.capsuleId,
    deleteToken: primaryTarget.created.deleteToken,
    relayUrl: primaryTarget.client.relayUrl,
    ...(ownerMirrors.length > 0 ? { mirrors: ownerMirrors } : {}),
  };
  const shareUrl = buildShareUrl(input.appUrl, capability);

  report(input.onProgress, {
    phase: "complete",
    completedBytes,
    totalBytes: storedLength,
    completedChunks: chunkCount,
    totalChunks: chunkCount,
  });

  return {
    shareUrl,
    capability,
    ownerCapability,
    metadata,
    relayUrls: surviving.map((target) => target.client.relayUrl),
    mirrorFailures,
    anonymity: input.report,
    ...(sharding ? { sharding } : {}),
  };
}

interface ReadSource {
  client: RelayTransport;
  location: CapsuleLocation;
  index: number;
}

async function openSources(
  capability: CapsuleShareCapability,
  options: DownloadCapsuleOptions,
): Promise<{ sources: ReadSource[]; failures: MirrorFailure[] }> {
  // Probing which relays are alive is discovery, not transfer: an unreachable
  // relay here is an ordinary state, so it is not worth a long backoff. Once a
  // relay is known to answer, the full retry policy applies to the transfer.
  const clientOptions = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    retry: options.retry ?? { attempts: 1, baseDelayMs: 250, maxDelayMs: 1000 },
  };
  const sources: ReadSource[] = [];
  const failures: MirrorFailure[] = [];

  const locations = [...shareLocations(capability)];
  if (!capability.sharding && options.extraRelayUrls) {
    const known = new Set(
      locations.map((location) => trimSlash(location.relayUrl)),
    );
    for (const relayUrl of options.extraRelayUrls) {
      const url = trimSlash(relayUrl);
      if (!url || known.has(url)) continue;
      known.add(url);
      locations.push({
        relayUrl: url,
        capsuleId: capability.capsuleId,
        readToken: capability.readToken,
      });
    }
  }
  for (const [index, location] of locations.entries()) {
    try {
      const client = options.transport
        ? options.transport(location.relayUrl)
        : new CapsuleRelayClient(location.relayUrl, clientOptions);
      const status = await client.status(
        location.capsuleId,
        location.readToken,
        options.signal,
      );
      if (status.state !== "ready") {
        throw new Error("Capsule is not ready for download");
      }
      sources.push({ client, location, index });
    } catch (error) {
      failures.push({ relayUrl: location.relayUrl, reason: reasonOf(error) });
    }
  }
  return { sources, failures };
}

async function downloadMirrored(
  source: ReadSource,
  secrets: CapsuleSecrets,
  options: DownloadCapsuleOptions,
): Promise<DownloadedCapsule> {
  const { client, location } = source;
  const status = await client.status(
    location.capsuleId,
    location.readToken,
    options.signal,
  );
  const encryptedManifest = await client.manifest(
    location.capsuleId,
    location.readToken,
    options.signal,
  );
  const metadata = await decryptMetadata(encryptedManifest, secrets);
  const storedLength = transportLength(metadata);
  const expectedChunkCount = Math.ceil(storedLength / metadata.chunkSize);
  const expectedCiphertextBytes = storedLength + metadata.chunkCount * 16;
  if (
    metadata.chunkCount !== expectedChunkCount ||
    metadata.chunkCount !== status.chunkCount ||
    status.uploadedChunks !== status.chunkCount ||
    expectedCiphertextBytes !== status.totalCiphertextBytes ||
    status.uploadedCiphertextBytes !== status.totalCiphertextBytes
  ) {
    throw new Error(
      "Capsule metadata does not match the authenticated relay inventory",
    );
  }

  const parts: Uint8Array[] = [];
  let completedBytes = 0;

  for (let index = 0; index < metadata.chunkCount; index += 1) {
    report(options.onProgress, {
      phase: "downloading",
      completedBytes,
      totalBytes: storedLength,
      completedChunks: index,
      totalChunks: metadata.chunkCount,
    });
    const ciphertext = await client.chunk(
      location.capsuleId,
      index,
      location.readToken,
      options.signal,
    );
    const plaintext = await decryptChunk(ciphertext, index + 1, secrets);
    const expectedPlaintextBytes = Math.min(
      metadata.chunkSize,
      storedLength - index * metadata.chunkSize,
    );
    if (
      ciphertext.byteLength !== expectedPlaintextBytes + 16 ||
      plaintext.byteLength !== expectedPlaintextBytes
    ) {
      throw new Error(
        `Capsule chunk ${index} has an invalid authenticated size`,
      );
    }
    keepRealBytes(parts, plaintext, index, metadata);
    completedBytes += plaintext.byteLength;
    report(options.onProgress, {
      phase: "decrypting",
      completedBytes,
      totalBytes: storedLength,
      completedChunks: index + 1,
      totalChunks: metadata.chunkCount,
    });
  }

  return finishDownload(parts, metadata, storedLength, options, [
    client.relayUrl,
  ]);
}

/**
 * Padding chunks are downloaded so the access pattern does not reveal the real
 * size, but only authenticated file bytes are kept.
 */
function keepRealBytes(
  parts: Uint8Array[],
  plaintext: Uint8Array,
  index: number,
  metadata: CapsuleMetadata,
): void {
  const keep = Math.min(
    Math.max(metadata.byteLength - index * metadata.chunkSize, 0),
    plaintext.byteLength,
  );
  if (keep > 0) parts.push(plaintext.subarray(0, keep));
}

function finishDownload(
  parts: Uint8Array[],
  metadata: CapsuleMetadata,
  storedLength: number,
  options: DownloadCapsuleOptions,
  relayUrls: string[],
): DownloadedCapsule {
  const recoveredBytes = parts.reduce((total, part) => total + part.length, 0);
  if (recoveredBytes !== metadata.byteLength) {
    throw new Error(
      "The capsule size does not match its authenticated metadata",
    );
  }
  report(options.onProgress, {
    phase: "complete",
    completedBytes: storedLength,
    totalBytes: storedLength,
    completedChunks: metadata.chunkCount,
    totalChunks: metadata.chunkCount,
  });
  return {
    metadata,
    blob: new Blob(parts.map(asArrayBuffer), { type: metadata.mimeType }),
    relayUrls,
  };
}

async function downloadSharded(
  capability: CapsuleShareCapability,
  sharding: CapsuleSharding,
  sources: ReadSource[],
  secrets: CapsuleSecrets,
  options: DownloadCapsuleOptions,
): Promise<DownloadedCapsule> {
  if (sources.length < sharding.k) {
    throw new Error(
      `This capsule needs ${sharding.k} of its ${sharding.n} relays; only ${sources.length} answered`,
    );
  }

  let metadata: CapsuleMetadata | undefined;
  for (const source of sources) {
    try {
      const encryptedManifest = await source.client.manifest(
        source.location.capsuleId,
        source.location.readToken,
        options.signal,
      );
      metadata = await decryptMetadata(encryptedManifest, secrets);
      break;
    } catch (error) {
      if (error instanceof Error && error.message.includes("authentication")) {
        // A relay serving a manifest that does not authenticate is lying;
        // another relay may still hold the real one.
        continue;
      }
      throw error;
    }
  }
  if (!metadata) {
    throw new Error("No relay served a manifest that could be authenticated");
  }

  const storedLength = transportLength(metadata);
  if (
    metadata.chunkSize + 16 !== sharding.blockBytes ||
    metadata.chunkCount !== Math.ceil(storedLength / metadata.chunkSize)
  ) {
    throw new Error(
      "Capsule metadata does not match the erasure coding in the link",
    );
  }

  const usable: ReadSource[] = [];
  for (const source of sources) {
    const status = await source.client.status(
      source.location.capsuleId,
      source.location.readToken,
      options.signal,
    );
    if (
      status.chunkCount === metadata.chunkCount &&
      status.uploadedChunks === status.chunkCount &&
      status.totalCiphertextBytes === metadata.chunkCount * sharding.shardBytes
    ) {
      usable.push(source);
    }
  }
  if (usable.length < sharding.k) {
    throw new Error(
      `Only ${usable.length} relays hold a consistent copy; ${sharding.k} are needed`,
    );
  }

  const parts: Uint8Array[] = [];
  let completedBytes = 0;

  for (let index = 0; index < metadata.chunkCount; index += 1) {
    report(options.onProgress, {
      phase: "downloading",
      completedBytes,
      totalBytes: storedLength,
      completedChunks: index,
      totalChunks: metadata.chunkCount,
    });

    const fetched = new Map<number, Uint8Array>();
    let plaintext: Uint8Array | undefined;

    for (const source of usable) {
      if (plaintext) break;
      try {
        const shard = await source.client.chunk(
          source.location.capsuleId,
          index,
          source.location.readToken,
          options.signal,
        );
        if (shard.byteLength !== sharding.shardBytes) continue;
        fetched.set(source.index, shard);
      } catch {
        continue;
      }
      if (fetched.size < sharding.k) continue;

      // With one bad shard among the ones we hold, reconstruction produces
      // noise that AES-GCM rejects. Trying other combinations isolates the
      // relay that is lying instead of failing the whole download.
      for (const combination of shardCombinations(
        [...fetched.keys()],
        sharding.k,
        24,
      )) {
        const layout = new Array<Uint8Array | undefined>(sharding.n).fill(
          undefined,
        );
        for (const shardIndex of combination) {
          layout[shardIndex] = fetched.get(shardIndex);
        }
        try {
          const block = decodeShards(
            layout,
            { k: sharding.k, n: sharding.n },
            sharding.blockBytes,
          );
          plaintext = await decryptChunk(block, index + 1, secrets);
          break;
        } catch {
          continue;
        }
      }
    }

    if (!plaintext) {
      throw new Error(
        `Chunk ${index} could not be rebuilt from the available relays`,
      );
    }
    const expectedPlaintextBytes = Math.min(
      metadata.chunkSize,
      storedLength - index * metadata.chunkSize,
    );
    if (plaintext.byteLength !== expectedPlaintextBytes) {
      throw new Error(
        `Capsule chunk ${index} has an invalid authenticated size`,
      );
    }
    keepRealBytes(parts, plaintext, index, metadata);
    completedBytes += plaintext.byteLength;
    report(options.onProgress, {
      phase: "decrypting",
      completedBytes,
      totalBytes: storedLength,
      completedChunks: index + 1,
      totalChunks: metadata.chunkCount,
    });
  }

  return finishDownload(
    parts,
    metadata,
    storedLength,
    options,
    usable.map((source) => source.client.relayUrl),
  );
}

export async function downloadCapsule(
  options: DownloadCapsuleOptions,
): Promise<DownloadedCapsule> {
  const secrets: CapsuleSecrets = {
    key: options.capability.key,
    noncePrefix: options.capability.noncePrefix,
    version: options.capability.version,
  };
  const { sources, failures } = await openSources(options.capability, options);
  if (sources.length === 0) {
    throw new Error(failures[0]?.reason ?? "No relay could serve this capsule");
  }

  const sharding = options.capability.sharding;
  if (sharding) {
    return downloadSharded(
      options.capability,
      sharding,
      sources,
      secrets,
      options,
    );
  }

  let lastError: unknown;
  for (const source of sources) {
    try {
      return await downloadMirrored(source, secrets, options);
    } catch (error) {
      // A capsule that fails to authenticate is never retried elsewhere: the
      // ciphertext is wrong, not the relay.
      if (
        error instanceof Error &&
        (error.message.includes("authentication failed") ||
          error.message.includes("authenticated"))
      ) {
        throw error;
      }
      if (options.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No relay could serve this capsule");
}

export interface DeleteCapsuleResult {
  deleted: string[];
  failed: MirrorFailure[];
}

export async function deleteCapsule(
  capability: CapsuleOwnerCapability,
  options:
    | {
        signal?: AbortSignal;
        fetchImpl?: FetchLike;
        retry?: Partial<RetryPolicy>;
      }
    | AbortSignal = {},
): Promise<DeleteCapsuleResult> {
  const normalized =
    options instanceof AbortSignal ? { signal: options } : options;
  const deleted: string[] = [];
  const failed: MirrorFailure[] = [];

  for (const location of ownerLocations(capability)) {
    try {
      const relay = transportFor(location.relayUrl, normalized);
      await relay.delete(
        location.capsuleId,
        location.deleteToken,
        normalized.signal,
      );
      deleted.push(location.relayUrl);
    } catch (error) {
      failed.push({ relayUrl: location.relayUrl, reason: reasonOf(error) });
    }
  }

  if (deleted.length === 0 && failed.length > 0) {
    throw new Error(
      `No relay confirmed deletion: ${failed.map((entry) => entry.reason).join("; ")}`,
    );
  }
  return { deleted, failed };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}
