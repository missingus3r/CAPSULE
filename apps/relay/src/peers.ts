import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { RelayConfig } from "./config.js";
import {
  announceMessage,
  relayIdFor,
  solveAnnounceWork,
  verifyAnnouncement,
  type RelayIdentity,
} from "./identity.js";

/**
 * The relay directory.
 *
 * CAPSULE has no registry to join. An operator starts a relay, points it at
 * one or more peers they already know, and the relays exchange addresses.
 * Everything a relay learns is verified against the relay that claims it: an
 * address is only remembered after that address answers `/v1/info` with a
 * public key whose digest matches the relay id it announced. That does not
 * make a peer trustworthy — it only prevents a peer from inventing others.
 */

const ANNOUNCE_SKEW_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 8000;
const MAX_CANDIDATES_PER_ROUND = 16;
const MAX_FAILURES = 5;

export interface RelayAnnouncement {
  url: string;
  relayId: string;
  publicKey: string;
  announcedAt: string;
  /** Proof-of-work nonce; part of the signed message. */
  nonce: string;
  signature: string;
  nickname?: string;
}

export interface PeerRecord {
  url: string;
  relayId: string;
  publicKey: string;
  nickname?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  failures: number;
}

export interface PublicPeer {
  url: string;
  relayId: string;
  publicKey: string;
  nickname?: string;
  lastSeenAt: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface PeerDirectoryOptions {
  fetchImpl?: FetchLike;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

const PRIVATE_IPV4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/u;

/**
 * Peer addresses arrive from untrusted relays, so anything that points back
 * into the operator's own infrastructure is refused before it is ever probed.
 */
export function isRoutablePeerUrl(
  value: string,
  allowPrivate: boolean,
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.origin !== value.replace(/\/$/u, "")) return false;
  if (allowPrivate) return true;

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  ) {
    return false;
  }
  const version = isIP(host.replace(/^\[|\]$/gu, ""));
  if (version === 4) return !PRIVATE_IPV4.test(`${host}.`);
  if (version === 6) {
    const normalized = host.replace(/^\[|\]$/gu, "");
    return !(
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80")
    );
  }
  return true;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A coarse grouping of relays that probably share an operator. Used to stop a
 * single domain from occupying the whole directory; it is a heuristic, not a
 * proof of independence.
 */
export function operatorHint(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (isIP(host.replace(/^\[|\]$/gu, "")) !== 0) return host;
    return host.split(".").slice(-2).join(".");
  } catch {
    return url;
  }
}

export class PeerDirectory {
  private readonly path: string;
  private readonly peers = new Map<string, PeerRecord>();
  private readonly request: FetchLike;
  private readonly log: (
    message: string,
    details?: Record<string, unknown>,
  ) => void;
  private syncing = false;

  constructor(
    private readonly config: RelayConfig,
    private readonly identity: RelayIdentity,
    options: PeerDirectoryOptions = {},
  ) {
    this.path = join(config.storageDir, "peers.json");
    this.request = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.log = options.log ?? (() => undefined);
  }

  async initialize(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const stored = (parsed as { peers?: unknown }).peers;
      if (Array.isArray(stored)) {
        for (const entry of stored) {
          const peer = entry as Partial<PeerRecord>;
          if (
            typeof peer.url === "string" &&
            typeof peer.relayId === "string" &&
            typeof peer.publicKey === "string" &&
            relayIdFor(peer.publicKey) === peer.relayId &&
            peer.relayId !== this.identity.relayId
          ) {
            this.peers.set(peer.relayId, {
              url: peer.url,
              relayId: peer.relayId,
              publicKey: peer.publicKey,
              ...(peer.nickname ? { nickname: peer.nickname } : {}),
              firstSeenAt: peer.firstSeenAt ?? nowIso(),
              lastSeenAt: peer.lastSeenAt ?? nowIso(),
              failures: 0,
            });
          }
        }
      }
    } catch {
      // A missing or unreadable directory simply starts empty.
    }
  }

  get size(): number {
    return this.peers.size;
  }

  list(limit = this.config.maxPeers): PublicPeer[] {
    return [...this.peers.values()]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, Math.max(0, limit))
      .map((peer) => ({
        url: peer.url,
        relayId: peer.relayId,
        publicKey: peer.publicKey,
        ...(peer.nickname ? { nickname: peer.nickname } : {}),
        lastSeenAt: peer.lastSeenAt,
      }));
  }

  /** Signed statement this relay sends to peers; absent without a public URL. */
  selfAnnouncement(): RelayAnnouncement | undefined {
    if (!this.config.publicUrl) return undefined;
    const announcedAt = nowIso();
    // The proof of work is solved once per gossip round and reused for every
    // peer greeted in that round.
    const nonce = solveAnnounceWork(
      this.config.publicUrl,
      this.identity.relayId,
      announcedAt,
      this.config.announceWorkBits,
    );
    return {
      url: this.config.publicUrl,
      relayId: this.identity.relayId,
      publicKey: this.identity.publicKey,
      announcedAt,
      nonce,
      signature: this.identity.sign(
        announceMessage(
          this.config.publicUrl,
          this.identity.relayId,
          announcedAt,
          nonce,
        ),
      ),
      ...(this.config.nickname ? { nickname: this.config.nickname } : {}),
    };
  }

  /** Accepts an announcement pushed by another relay. */
  async accept(announcement: RelayAnnouncement): Promise<boolean> {
    if (announcement.relayId === this.identity.relayId) return false;
    if (!isRoutablePeerUrl(announcement.url, this.config.allowPrivatePeers)) {
      return false;
    }
    const announcedAt = Date.parse(announcement.announcedAt);
    if (
      !Number.isFinite(announcedAt) ||
      Math.abs(Date.now() - announcedAt) > ANNOUNCE_SKEW_MS
    ) {
      return false;
    }
    if (!verifyAnnouncement(announcement, this.config.announceWorkBits)) {
      return false;
    }

    if (
      !this.remember({
        url: announcement.url,
        relayId: announcement.relayId,
        publicKey: announcement.publicKey,
        ...(announcement.nickname ? { nickname: announcement.nickname } : {}),
      })
    ) {
      return false;
    }
    await this.persist();
    return true;
  }

  private remember(
    peer: Omit<PeerRecord, "firstSeenAt" | "lastSeenAt" | "failures">,
  ): boolean {
    const existing = this.peers.get(peer.relayId);
    if (existing) {
      existing.url = peer.url;
      existing.publicKey = peer.publicKey;
      if (peer.nickname) existing.nickname = peer.nickname;
      existing.lastSeenAt = nowIso();
      existing.failures = 0;
      return true;
    }

    // One operator running several relays is normal; one operator filling the
    // whole directory is what a Sybil attack looks like from here.
    const hint = operatorHint(peer.url);
    const sameOperator = [...this.peers.values()].filter(
      (known) => operatorHint(known.url) === hint,
    );
    if (sameOperator.length >= this.config.maxPeersPerOperator) return false;

    if (this.peers.size >= this.config.maxPeers) {
      const oldest = [...this.peers.values()].sort((left, right) =>
        left.lastSeenAt.localeCompare(right.lastSeenAt),
      )[0];
      if (!oldest) return false;
      this.peers.delete(oldest.relayId);
    }
    this.peers.set(peer.relayId, {
      ...peer,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
      failures: 0,
    });
    return true;
  }

  private async persist(): Promise<void> {
    const document = {
      schemaVersion: 1,
      updatedAt: nowIso(),
      peers: [...this.peers.values()],
    };
    await writeFile(this.path, `${JSON.stringify(document)}\n`, {
      mode: 0o600,
    });
  }

  private async probe(url: string): Promise<PeerRecord | undefined> {
    if (!isRoutablePeerUrl(url, this.config.allowPrivatePeers))
      return undefined;
    try {
      const response = await this.request(`${url}/v1/info`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return undefined;
      const info = (await response.json()) as Record<string, unknown>;
      if (
        typeof info.relayId !== "string" ||
        typeof info.publicKey !== "string" ||
        relayIdFor(info.publicKey) !== info.relayId ||
        info.relayId === this.identity.relayId
      ) {
        return undefined;
      }
      return {
        url,
        relayId: info.relayId,
        publicKey: info.publicKey,
        ...(typeof info.nickname === "string" && info.nickname.trim()
          ? { nickname: info.nickname.trim().slice(0, 64) }
          : {}),
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
        failures: 0,
      };
    } catch {
      return undefined;
    }
  }

  private async exchange(url: string): Promise<string[]> {
    const announcement = this.selfAnnouncement();
    const learned: string[] = [];
    try {
      if (announcement) {
        const response = await this.request(`${url}/v1/peers/announce`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(announcement),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (response.ok) {
          const body = (await response.json()) as { peers?: unknown };
          for (const peer of Array.isArray(body.peers) ? body.peers : []) {
            const peerUrl = (peer as { url?: unknown }).url;
            if (typeof peerUrl === "string") learned.push(peerUrl);
          }
          return learned;
        }
      }
      const response = await this.request(`${url}/v1/peers`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return learned;
      const body = (await response.json()) as { peers?: unknown };
      for (const peer of Array.isArray(body.peers) ? body.peers : []) {
        const peerUrl = (peer as { url?: unknown }).url;
        if (typeof peerUrl === "string") learned.push(peerUrl);
      }
    } catch {
      // Unreachable peers are normal in an open network.
    }
    return learned;
  }

  /** One gossip round: greet known relays and learn the ones they know. */
  async sync(): Promise<{ peers: number; added: number }> {
    if (this.syncing) return { peers: this.peers.size, added: 0 };
    this.syncing = true;
    try {
      const known = new Set<string>([
        ...this.config.peers,
        ...[...this.peers.values()].map((peer) => peer.url),
      ]);
      const candidates = [...known].slice(0, MAX_CANDIDATES_PER_ROUND);
      const before = this.peers.size;
      const discovered = new Set<string>();

      for (const candidate of candidates) {
        const record = await this.probe(candidate);
        if (record) {
          this.remember(record);
          for (const peerUrl of await this.exchange(candidate)) {
            discovered.add(peerUrl);
          }
          continue;
        }
        const existing = [...this.peers.values()].find(
          (peer) => peer.url === candidate,
        );
        if (existing) {
          existing.failures += 1;
          if (existing.failures >= MAX_FAILURES) {
            this.peers.delete(existing.relayId);
            this.log("Dropped an unreachable peer", {
              relayId: existing.relayId,
            });
          }
        }
      }

      for (const url of discovered) {
        if (this.peers.size >= this.config.maxPeers) break;
        if ([...this.peers.values()].some((peer) => peer.url === url)) continue;
        const record = await this.probe(url);
        if (record) this.remember(record);
      }

      await this.persist();
      return { peers: this.peers.size, added: this.peers.size - before };
    } finally {
      this.syncing = false;
    }
  }
}
