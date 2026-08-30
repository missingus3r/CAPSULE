import { lookup } from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyHost,
  classifyRelayOrigin,
  parseIpv4,
} from "@capsule/protocol";
import type { RelayConfig } from "./config.js";
import { nodeIdFor } from "@capsule/mixnet";
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

/**
 * A relay's claim that it exists at an address. Everything else about the
 * relay — its name, its limits — is read from the address itself rather than
 * taken from the claim, so there is nothing in here that is worth forging
 * beyond the address, and the address is verified before it is believed.
 */
export interface RelayAnnouncement {
  url: string;
  relayId: string;
  publicKey: string;
  announcedAt: string;
  /** Proof-of-work nonce; part of the signed message. */
  nonce: string;
  signature: string;
}

export interface PeerRecord {
  url: string;
  relayId: string;
  publicKey: string;
  /** Curve25519 key this relay uses as a mix node, when it runs one. */
  mixPublicKey?: string;
  nickname?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  failures: number;
}

export interface PublicPeer {
  url: string;
  relayId: string;
  publicKey: string;
  mixPublicKey?: string;
  nickname?: string;
  lastSeenAt: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface PeerDirectoryOptions {
  fetchImpl?: FetchLike;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

/**
 * Peer addresses arrive from untrusted relays, so anything that points back
 * into the operator's own infrastructure is refused before it is ever probed.
 * The syntactic half of the check lives in the protocol package, which knows
 * about every way of spelling a loopback address; this adds the half that
 * needs a resolver.
 */
export function isRoutablePeerUrl(
  value: string,
  allowPrivate: boolean,
): boolean {
  if (allowPrivate) {
    // Local networks and the test suite deliberately peer over loopback.
    const url = tryParseOrigin(value);
    return url !== undefined;
  }
  return classifyRelayOrigin(value).routable;
}

function tryParseOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash)
      return undefined;
    if (url.pathname !== "/" && url.pathname !== "") return undefined;
    if (url.origin !== value.replace(/\/$/u, "")) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a peer hostname and refuses it when any address it resolves to is
 * one we would not have dialled directly. A name is the last way left to reach
 * an internal service once the literals are covered.
 *
 * A name could still be re-resolved to a different address between this check
 * and the request. Closing that window needs the connection pinned to the
 * address we checked, which the platform's fetch does not expose; the residual
 * risk is recorded in the threat model rather than hidden here.
 */
async function resolvesToPublicAddress(
  value: string,
  allowPrivate: boolean,
): Promise<boolean> {
  if (allowPrivate) return true;
  const url = tryParseOrigin(value);
  if (!url) return false;
  const verdict = classifyHost(url.hostname);
  if (!verdict.routable) return false;
  if (verdict.kind !== "name") return true;

  try {
    const addresses = await lookup(url.hostname, { all: true });
    if (addresses.length === 0) return false;
    return addresses.every((address) => classifyHost(address.address).routable);
  } catch {
    return false;
  }
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
    const kind = classifyHost(host);
    if (kind.routable && kind.kind !== "name") return host;
    if (!kind.routable && !host.includes(".")) return host;
    if (parseIpv4(host) !== undefined || host.includes(":")) return host;
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
  /** Aborts probes in flight when the relay is shutting down. */
  private readonly shutdown = new AbortController();

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
              ...(peer.mixPublicKey ? { mixPublicKey: peer.mixPublicKey } : {}),
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

  /** Peers that run a mix node, as the mix layer needs to see them. */
  mixNodes(): Array<{
    nodeId: Uint8Array;
    url: string;
    publicKey: Uint8Array;
  }> {
    const nodes: Array<{
      nodeId: Uint8Array;
      url: string;
      publicKey: Uint8Array;
    }> = [];
    for (const peer of this.peers.values()) {
      if (!peer.mixPublicKey) continue;
      const publicKey = new Uint8Array(
        Buffer.from(peer.mixPublicKey, "base64url"),
      );
      if (publicKey.byteLength !== 32) continue;
      nodes.push({ nodeId: nodeIdFor(publicKey), url: peer.url, publicKey });
    }
    return nodes;
  }

  list(limit = this.config.maxPeers): PublicPeer[] {
    return [...this.peers.values()]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, Math.max(0, limit))
      .map((peer) => ({
        url: peer.url,
        relayId: peer.relayId,
        publicKey: peer.publicKey,
        ...(peer.mixPublicKey ? { mixPublicKey: peer.mixPublicKey } : {}),
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
    };
  }

  /**
   * Accepts an announcement pushed by another relay.
   *
   * A valid signature only proves that whoever holds the key wrote the
   * message; it says nothing about whether the address in it belongs to that
   * relay. So the address is asked directly, and the announcement is believed
   * only if that address answers with the same identity. Without this, any
   * relay could fill every directory in the network with addresses it does
   * not control.
   */
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

    const probed = await this.probe(announcement.url);
    if (!probed || probed.relayId !== announcement.relayId) return false;
    if (!this.remember(probed)) return false;

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
      if (peer.mixPublicKey) existing.mixPublicKey = peer.mixPublicKey;
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

  /**
   * A probe gives up on its own timeout, and immediately when the relay is
   * shutting down: waiting out a network timeout is not a reason to keep a
   * process alive.
   */
  private probeSignal(): AbortSignal {
    return AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(PROBE_TIMEOUT_MS),
    ]);
  }

  /** Stops accepting new work and cancels whatever is in flight. */
  close(): void {
    this.shutdown.abort();
  }

  private async probe(url: string): Promise<PeerRecord | undefined> {
    if (this.shutdown.signal.aborted) return undefined;
    if (!isRoutablePeerUrl(url, this.config.allowPrivatePeers)) {
      return undefined;
    }
    if (!(await resolvesToPublicAddress(url, this.config.allowPrivatePeers))) {
      return undefined;
    }
    try {
      const response = await this.request(`${url}/v1/info`, {
        signal: this.probeSignal(),
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
        ...(typeof info.mixPublicKey === "string" &&
        /^[A-Za-z0-9_-]{43}$/u.test(info.mixPublicKey)
          ? { mixPublicKey: info.mixPublicKey }
          : {}),
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
          signal: this.probeSignal(),
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
        signal: this.probeSignal(),
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
