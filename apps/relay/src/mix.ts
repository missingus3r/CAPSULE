import { randomBytes } from "node:crypto";
import {
  MixCommand,
  NODE_ID_BYTES,
  PACKET_BYTES,
  createPacket,
  decodeRequest,
  encodeResponse,
  nodeIdFor,
  processPacket,
  sealReply,
  readMessage,
  type MixHop,
  type MixRequest,
  type MixResponse,
} from "@capsule/mixnet";
import type { RelayConfig } from "./config.js";
import type { RelayIdentity } from "./identity.js";

/**
 * The relay acting as a node in the mix network.
 *
 * Three jobs, and the order matters:
 *
 * 1. **Hold, then forward.** A packet waits for the delay its sender chose
 *    before moving on. That wait is the whole point: it is what stops an
 *    observer watching both ends of this node from pairing an incoming packet
 *    with an outgoing one by timing. Tor cannot do this, because a person
 *    waiting for a web page will not wait; a file transfer will.
 * 2. **Refuse repeats.** A packet processed twice would leave twice, and the
 *    pair would be trivially linkable. Each packet has a tag derived from the
 *    shared secret, and a tag is honoured once.
 * 3. **Answer, without knowing whom.** When a packet is addressed to this
 *    relay, it carries a reply block. The relay can send an answer through it
 *    and cannot tell where it goes.
 *
 * The node also sends packets to itself through random paths, so that a link
 * carrying nothing real still carries something.
 */

export const MIX_PACKET_BYTES = PACKET_BYTES;

export interface MixPeer {
  nodeId: Uint8Array;
  url: string;
  publicKey: Uint8Array;
}

export interface MixCapsuleExecutor {
  (request: MixRequest): Promise<MixResponse>;
}

export interface MixNodeOptions {
  config: RelayConfig;
  identity: RelayIdentity;
  /** Resolves a node identifier to somewhere a packet can be sent. */
  resolve: (nodeId: Uint8Array) => MixPeer | undefined;
  /** Every mix this relay knows about, for cover traffic paths. */
  peers: () => MixPeer[];
  /** Runs a capsule operation addressed to this relay. */
  execute: MixCapsuleExecutor;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

interface MailboxEntry {
  body: Uint8Array;
  storedAt: number;
}

const TAG_HEX_LENGTH = 32;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export class MixNode {
  readonly nodeId: Uint8Array;
  private readonly options: MixNodeOptions;
  private readonly request: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>;
  private readonly seen = new Map<string, number>();
  private readonly mailboxes = new Map<string, MailboxEntry[]>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private coverTimer: NodeJS.Timeout | undefined;
  private queued = 0;
  private forwarded = 0;
  private delivered = 0;
  private dropped = 0;

  constructor(options: MixNodeOptions) {
    this.options = options;
    this.nodeId = nodeIdFor(
      new Uint8Array(Buffer.from(options.identity.mixPublicKey, "base64url")),
    );
    this.request = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get stats(): Record<string, number> {
    return {
      queued: this.queued,
      forwarded: this.forwarded,
      delivered: this.delivered,
      dropped: this.dropped,
      mailboxes: this.mailboxes.size,
    };
  }

  /**
   * Takes a packet off the wire. Returns as soon as the packet is accepted:
   * the caller must not learn how long it will be held, or where it goes.
   */
  accept(packet: Uint8Array): "accepted" | "rejected" {
    if (packet.byteLength !== PACKET_BYTES) return "rejected";
    if (this.queued >= this.options.config.mixMaxQueued) {
      this.dropped += 1;
      return "rejected";
    }

    let processed;
    try {
      processed = processPacket(this.options.identity.mixPrivateKey, packet);
    } catch {
      this.dropped += 1;
      return "rejected";
    }

    const tag = hex(processed.tag);
    this.prune();
    if (this.seen.has(tag)) {
      this.dropped += 1;
      return "rejected";
    }
    this.seen.set(tag, Date.now() + this.options.config.mixReplayWindowMs);

    // The sender's delay is honoured up to the node's own ceiling, so one
    // sender cannot pin a node's queue open for an arbitrary time.
    const delay = Math.min(
      processed.delayMs,
      this.options.config.mixMaxDelayMs,
    );
    this.queued += 1;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.queued -= 1;
      void this.dispatch(processed).catch((error: unknown) =>
        this.options.log?.("Mix dispatch failed", { err: String(error) }),
      );
    }, delay);
    timer.unref();
    this.timers.add(timer);
    return "accepted";
  }

  private async dispatch(
    processed: ReturnType<typeof processPacket>,
  ): Promise<void> {
    if (processed.command === MixCommand.Discard) {
      // A loop that came home. Its only job was to exist.
      this.dropped += 1;
      return;
    }

    if (processed.command === MixCommand.Forward) {
      const peer = this.options.resolve(processed.id);
      if (!peer || !processed.packet) {
        this.dropped += 1;
        return;
      }
      await this.send(peer.url, processed.packet);
      this.forwarded += 1;
      return;
    }

    if (processed.command === MixCommand.Mailbox) {
      if (!processed.body) return;
      this.deposit(processed.id, processed.body);
      this.delivered += 1;
      return;
    }

    // Deliver: the packet was addressed to this relay.
    if (!processed.body) return;
    if (hex(processed.id) !== hex(this.nodeId)) {
      this.dropped += 1;
      return;
    }
    const message = readMessage(processed.body);
    if (!message) {
      // Tampered on the way: the body is noise and there is nothing to answer.
      this.dropped += 1;
      return;
    }

    let request: MixRequest;
    try {
      request = decodeRequest(message);
    } catch {
      this.dropped += 1;
      return;
    }

    let response: MixResponse;
    try {
      response = await this.options.execute(request);
    } catch (error) {
      response = {
        ok: false,
        data: Buffer.from(
          JSON.stringify({
            error: error instanceof Error ? error.message : "relay error",
          }),
        ),
      };
    }
    this.delivered += 1;

    const firstHop = this.options.resolve(request.replyBlock.firstHopId);
    if (!firstHop) {
      this.dropped += 1;
      return;
    }
    await this.send(
      firstHop.url,
      sealReply(request.replyBlock, encodeResponse(response)),
    );
  }

  private async send(url: string, packet: Uint8Array): Promise<void> {
    try {
      await this.request(`${url}/v1/mix`, {
        method: "POST",
        headers: { "Content-Type": "application/capsule-mix" },
        body: Buffer.from(packet),
        signal: AbortSignal.timeout(this.options.config.mixSendTimeoutMs),
      });
    } catch (error) {
      this.dropped += 1;
      this.options.log?.("Mix forward failed", { err: String(error) });
    }
  }

  private deposit(token: Uint8Array, body: Uint8Array): void {
    const key = hex(token);
    const entries = this.mailboxes.get(key) ?? [];
    if (entries.length >= this.options.config.mixMailboxDepth) entries.shift();
    entries.push({ body, storedAt: Date.now() });
    this.mailboxes.set(key, entries);
  }

  /** Empties a mailbox. A body is handed over once and then forgotten. */
  collect(token: string): Uint8Array[] {
    if (!/^[0-9a-f]{32}$/u.test(token)) return [];
    this.pruneMailboxes();
    const entries = this.mailboxes.get(token) ?? [];
    this.mailboxes.delete(token);
    return entries.map((entry) => entry.body);
  }

  private prune(): void {
    const now = Date.now();
    if (this.seen.size < this.options.config.mixMaxQueued * 8) {
      // Cheap path: only sweep when the table has grown enough to matter.
      if (this.seen.size < 1024) return;
    }
    for (const [tag, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(tag);
    }
  }

  private pruneMailboxes(): void {
    const cutoff = Date.now() - this.options.config.mixMailboxTtlMs;
    for (const [key, entries] of this.mailboxes) {
      const kept = entries.filter((entry) => entry.storedAt > cutoff);
      if (kept.length === 0) this.mailboxes.delete(key);
      else this.mailboxes.set(key, kept);
    }
  }

  /**
   * Sends a packet to itself through a random path. A link that carries only
   * real traffic tells an observer when there is real traffic; a link that
   * always carries something tells them nothing.
   */
  async sendLoop(): Promise<void> {
    const peers = this.options.peers();
    if (peers.length === 0) return;

    const hops: MixHop[] = [];
    const chosen = new Set<string>();
    const length = Math.min(
      this.options.config.mixPathLength,
      peers.length + 1,
    );
    for (let index = 0; index < length - 1; index += 1) {
      const peer = peers[Math.floor(Math.random() * peers.length)] as MixPeer;
      if (chosen.has(hex(peer.nodeId))) continue;
      chosen.add(hex(peer.nodeId));
      hops.push({
        id: peer.nodeId,
        publicKey: peer.publicKey,
        delayMs: this.randomDelay(),
      });
    }
    hops.push({
      id: this.nodeId,
      publicKey: new Uint8Array(
        Buffer.from(this.options.identity.mixPublicKey, "base64url"),
      ),
      delayMs: 0,
    });

    const { packet } = createPacket(
      hops,
      { command: MixCommand.Discard, id: new Uint8Array(NODE_ID_BYTES) },
      randomBytes(64),
    );
    const first = this.options.resolve((hops[0] as MixHop).id);
    if (first) await this.send(first.url, packet);
  }

  private randomDelay(): number {
    // Exponentially distributed, so the number of packets a node is holding at
    // any moment does not depend on when they arrived.
    const mean = this.options.config.mixMeanDelayMs;
    if (mean <= 0) return 0;
    return Math.min(
      this.options.config.mixMaxDelayMs,
      Math.round(-mean * Math.log(1 - Math.random())),
    );
  }

  start(): void {
    if (this.options.config.mixCoverIntervalMs <= 0) return;
    this.coverTimer = setInterval(() => {
      void this.sendLoop().catch(() => undefined);
    }, this.options.config.mixCoverIntervalMs);
    this.coverTimer.unref();
  }

  stop(): void {
    if (this.coverTimer) clearInterval(this.coverTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.queued = 0;
  }
}

export { TAG_HEX_LENGTH };
