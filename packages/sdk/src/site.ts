/**
 * Publishing and resolving `.capsule` sites.
 *
 * A site is a capsule with a name attached. Publishing packs a directory into
 * a bundle, uploads it like any other capsule, and then signs a one-line
 * statement — "sequence 7 of this name is that capability" — which relays
 * store and hand out. Resolving does the reverse: ask several relays, keep
 * only records that verify against the name itself, take the newest.
 *
 * Two consequences worth stating plainly, because they are the reason to do it
 * this way rather than with a registry:
 *
 * - **A relay cannot lie about a site**, only refuse to answer. It has no key,
 *   so a forged record fails verification at the visitor.
 * - **A relay cannot read a site**, because the capability lives in the record
 *   and the record is what it stores. That is a real trade: anyone who can
 *   fetch the record can read the site. A `.capsule` site is public by
 *   construction. Publishing something private means not publishing a record.
 */

import {
  bestSiteRecord,
  decodeShareCapability,
  encodeShareCapability,
  packSite,
  parseSiteName,
  siteNameFor,
  signSiteRecord,
  toBase64Url,
  fromBase64Url,
  unpackSite,
  verifySiteRecord,
  CAPSULE_SITE_RECORD_VERSION,
  type CapsuleShareCapability,
  type CapsuleSiteRecord,
  type SiteBundle,
  type SiteFile,
  type UnsignedSiteRecord,
} from "@capsule/protocol";
import type { RelayTransportFactory } from "./client.js";
import type { FetchLike } from "./network.js";
import {
  downloadCapsule,
  uploadCapsule,
  type CapsuleAnonymityOptions,
  type CapsuleReplication,
  type TransferProgress,
} from "./transfer.js";

/** Filename a site key is written to by the CLI. Holds the private key. */
export const SITE_IDENTITY_VERSION = 1 as const;

export interface SiteIdentityFile {
  version: typeof SITE_IDENTITY_VERSION;
  name: string;
  /** base64url, raw 32 bytes. */
  publicKey: string;
  /** base64url PKCS#8. Whoever holds this owns the name. */
  privateKey: string;
  createdAt: string;
}

export interface SiteIdentity {
  name: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to work with .capsule sites");
  }
  return globalThis.crypto.subtle;
}

async function assertEd25519(): Promise<void> {
  try {
    await subtle().generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  } catch {
    throw new Error(
      "This runtime has no Ed25519 in Web Crypto, which .capsule names are built on. " +
        "Node 20+, Chrome 137+, Firefox 129+ and Safari 17+ have it.",
    );
  }
}

/** Creates a new name. The name is the key; there is nothing to register. */
export async function createSiteIdentity(): Promise<{
  identity: SiteIdentity;
  file: SiteIdentityFile;
}> {
  await assertEd25519();
  const pair = (await subtle().generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await subtle().exportKey("raw", pair.publicKey),
  );
  const pkcs8 = new Uint8Array(
    await subtle().exportKey("pkcs8", pair.privateKey),
  );
  const name = await siteNameFor(publicKey);
  return {
    identity: { name, publicKey, privateKey: pair.privateKey },
    file: {
      version: SITE_IDENTITY_VERSION,
      name,
      publicKey: toBase64Url(publicKey),
      privateKey: toBase64Url(pkcs8),
      createdAt: new Date().toISOString(),
    },
  };
}

export async function loadSiteIdentity(
  file: SiteIdentityFile,
): Promise<SiteIdentity> {
  if (file?.version !== SITE_IDENTITY_VERSION) {
    throw new Error("Unsupported site key file");
  }
  const publicKey = fromBase64Url(file.publicKey);
  if (publicKey.byteLength !== 32) throw new Error("Malformed site key file");

  const name = await siteNameFor(publicKey);
  if (name !== file.name) {
    throw new Error("The site key file does not match the name it claims");
  }

  const privateKey = await subtle().importKey(
    "pkcs8",
    fromBase64Url(file.privateKey).slice() as unknown as BufferSource,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { name, publicKey, privateKey };
}

export interface PublishSiteOptions {
  identity: SiteIdentity;
  files: SiteFile[];
  relayUrl: string;
  /** Where the record is announced. Defaults to `[relayUrl]` plus mirrors. */
  announceTo?: string[];
  mirrorRelayUrls?: string[];
  replication?: CapsuleReplication;
  /** `null` keeps the site up until it is deleted. Requires a willing relay. */
  ttlSeconds: number | null;
  title?: string;
  /** Next sequence number. Must exceed the one already published. */
  sequence: number;
  anonymity?: CapsuleAnonymityOptions;
  transport?: RelayTransportFactory;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

export interface PublishedSite {
  name: string;
  record: CapsuleSiteRecord;
  capability: CapsuleShareCapability;
  ownerCapability: string;
  bundleBytes: number;
  relayUrls: string[];
  /** Relays that accepted the record. */
  announcedTo: string[];
  announceFailures: Array<{ relayUrl: string; reason: string }>;
}

export async function publishSite(
  options: PublishSiteOptions,
): Promise<PublishedSite> {
  const bundle = packSite(options.files);
  const uploaded = await uploadCapsule({
    data: new Blob([bundle as unknown as BlobPart], {
      type: "application/capsule-site",
    }),
    // The bundle is padded and encrypted like any capsule; the name is neutral
    // because a relay has no business knowing which site it is holding.
    filename: "site.capsite",
    mimeType: "application/capsule-site",
    ttlSeconds: options.ttlSeconds,
    relayUrl: options.relayUrl,
    appUrl: "https://capsule.invalid/",
    ...(options.mirrorRelayUrls
      ? { mirrorRelayUrls: options.mirrorRelayUrls }
      : {}),
    ...(options.replication ? { replication: options.replication } : {}),
    // A site is public content held by a relay that has no business knowing
    // how big it is or what it was called on disk. Padding and a neutral name
    // are the default here rather than an option the publisher must remember.
    anonymity: {
      padding: true,
      scrubMetadata: true,
      hideFilename: true,
      ...(options.anonymity ?? {}),
    },
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const unsigned: UnsignedSiteRecord = {
    version: CAPSULE_SITE_RECORD_VERSION,
    name: options.identity.name,
    sequence: options.sequence,
    publishedAt: new Date().toISOString(),
    capability: encodeShareCapability(uploaded.capability),
    ...(options.title ? { title: options.title } : {}),
  };
  const record = await signSiteRecord(unsigned, options.identity.privateKey);

  const targets = options.announceTo ?? uploaded.relayUrls;
  const { announcedTo, failures } = await announceSiteRecord(record, targets, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  return {
    name: options.identity.name,
    record,
    capability: uploaded.capability,
    ownerCapability: JSON.stringify(uploaded.ownerCapability),
    bundleBytes: bundle.byteLength,
    relayUrls: uploaded.relayUrls,
    announcedTo,
    announceFailures: failures,
  };
}

export interface AnnounceOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

export async function announceSiteRecord(
  record: CapsuleSiteRecord,
  relayUrls: readonly string[],
  options: AnnounceOptions = {},
): Promise<{
  announcedTo: string[];
  failures: Array<{ relayUrl: string; reason: string }>;
}> {
  const request = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const announcedTo: string[] = [];
  const failures: Array<{ relayUrl: string; reason: string }> = [];

  await Promise.all(
    [...new Set(relayUrls)].map(async (relayUrl) => {
      try {
        const response = await request(
          `${trimSlash(relayUrl)}/v1/sites/${encodeURIComponent(record.name)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(record),
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        if (!response.ok) {
          failures.push({
            relayUrl,
            reason: `The relay refused the record (${response.status})`,
          });
          return;
        }
        announcedTo.push(relayUrl);
      } catch (error) {
        failures.push({ relayUrl, reason: describe(error) });
      }
    }),
  );
  return { announcedTo, failures };
}

export interface ResolveSiteOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  /** Highest sequence already seen for this name; anything lower is refused. */
  pinnedSequence?: number;
  now?: number;
  /**
   * Fetches one relay's record for a name by some route other than a direct
   * request. Supplied when the caller has a path that does not reveal who is
   * asking — the mix network — and left out for an ordinary request.
   *
   * It changes how the record arrives and nothing about whether it is
   * believed: every answer is verified against the key inside the name the
   * same way, because a route that hides the asker says nothing about the
   * honesty of whoever answers.
   */
  recordFor?: (
    relayUrl: string,
    name: string,
  ) => Promise<CapsuleSiteRecord | undefined>;
}

export interface ResolvedSite {
  record: CapsuleSiteRecord;
  capability: CapsuleShareCapability;
  /** Relays that returned a record that verified. */
  seenAt: string[];
}

/**
 * Asks every relay given and keeps the newest record that verifies.
 *
 * Querying more than one relay is not redundancy for its own sake: a single
 * relay can withhold an update and keep serving an old version of a site it
 * cannot forge. Disagreement between relays is the only signal a visitor has,
 * and taking the highest sequence is what makes withholding useless as long as
 * one honest relay answers.
 */
export async function resolveSite(
  name: string,
  relayUrls: readonly string[],
  options: ResolveSiteOptions = {},
): Promise<ResolvedSite | undefined> {
  const parsed = await parseSiteName(name);
  if (!parsed) throw new Error("Not a .capsule name");

  const request = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const found: CapsuleSiteRecord[] = [];
  const seenAt: string[] = [];

  await Promise.all(
    [...new Set(relayUrls)].map(async (relayUrl) => {
      try {
        let record: CapsuleSiteRecord | undefined;
        if (options.recordFor) {
          record = await options.recordFor(relayUrl, parsed.name);
        } else {
          const response = await request(
            `${trimSlash(relayUrl)}/v1/sites/${encodeURIComponent(parsed.name)}`,
            { ...(options.signal ? { signal: options.signal } : {}) },
          );
          if (!response.ok) return;
          const body = (await response.json()) as {
            record?: CapsuleSiteRecord;
          };
          record = body?.record;
        }
        if (!record) return;
        // Verified here as well as in bestSiteRecord, so a relay that answers
        // for a different name never gets counted as having seen this one.
        if (record.name !== parsed.name) return;
        if (
          !(await verifySiteRecord(record, {
            ...(options.now !== undefined ? { now: options.now } : {}),
          }))
        ) {
          return;
        }
        found.push(record);
        seenAt.push(relayUrl);
      } catch {
        // A relay that cannot answer is not evidence about the site.
      }
    }),
  );

  const record = await bestSiteRecord(found, {
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  if (!record) return undefined;
  if (
    options.pinnedSequence !== undefined &&
    record.sequence < options.pinnedSequence
  ) {
    throw new Error(
      `This name previously published sequence ${options.pinnedSequence} and the relays are now offering ${record.sequence}. Refusing the older version.`,
    );
  }

  return {
    record,
    capability: decodeShareCapability(record.capability),
    seenAt,
  };
}

export interface FetchSiteOptions {
  fetchImpl?: FetchLike;
  transport?: RelayTransportFactory;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

/** Downloads the bundle bytes a record points at, without unpacking them. */
export async function fetchSiteBytes(
  capability: CapsuleShareCapability,
  options: FetchSiteOptions = {},
): Promise<Uint8Array> {
  const downloaded = await downloadCapsule({
    capability,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  return new Uint8Array(await downloaded.blob.arrayBuffer());
}

/** Downloads and unpacks the bundle a record points at. */
export async function fetchSiteBundle(
  capability: CapsuleShareCapability,
  options: FetchSiteOptions = {},
): Promise<SiteBundle> {
  // Padding is part of the capsule, not of the bundle: the index says where
  // the files end, and everything after that is the padding to a size class.
  return unpackSite(await fetchSiteBytes(capability, options));
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
