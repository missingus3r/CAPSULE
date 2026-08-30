import { asArrayBuffer, fromBase64Url, randomBytes } from "@capsule/protocol";
import type {
  RelayCreateRequest,
  RelayCreateResponse,
  RelayPublicConfig,
  RelayStatus,
  RelayTransport,
} from "@capsule/sdk";
import {
  MIX_CHUNK_SIZE,
  MixOp,
  decodeResponse,
  encodeRequest,
  type MixOpValue,
} from "./message.js";
import {
  MixCommand,
  NODE_ID_BYTES,
  createPacket,
  createReplyBlock,
  openReply,
  type MixHop,
} from "./sphinx.js";

/**
 * Sending through the mix network instead of straight at a relay.
 *
 * The shape of an anonymous request is: pick a path of relays that have
 * nothing to do with the one storing the capsule, wrap the request so that
 * each of them can peel exactly one layer, hand it to the first, and wait.
 * The reply comes back along a second path the client chose and the relay
 * cannot see, landing in a mailbox the client polls.
 *
 * Two things are worth being precise about, because they are the difference
 * between this and a proxy:
 *
 * - **The client waits on purpose.** Each hop holds the packet for a random
 *   time. That is what breaks the timing correlation an observer would
 *   otherwise use to pair the packet entering the network with the one leaving
 *   it. It is also why this is not a replacement for browsing.
 * - **The provider knows the client exists.** Whoever holds the mailbox sees
 *   an address polling it. It does not see what was asked or of whom, but it
 *   knows someone is using the network. That is inherent to a client that
 *   cannot be dialled, and it is a cost, not an oversight.
 */

export interface MixDirectoryNode {
  nodeId: Uint8Array;
  /** Where a packet for this node is posted. */
  url: string;
  publicKey: Uint8Array;
}

export interface MixClientOptions {
  /** Mixes available for building paths. */
  nodes: MixDirectoryNode[];
  /** The relay that holds this client's mailbox. */
  provider: MixDirectoryNode;
  /** Hops per direction, including the destination. */
  pathLength?: number;
  /** Mean of the exponential delay asked of each hop. */
  meanDelayMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface MixSendResult {
  ok: boolean;
  data: Uint8Array;
}

const DEFAULTS = {
  pathLength: 3,
  meanDelayMs: 2_000,
  pollIntervalMs: 500,
  timeoutMs: 120_000,
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class MixClient {
  private readonly options: Required<
    Omit<MixClientOptions, "fetchImpl" | "nodes" | "provider">
  > &
    MixClientOptions;
  private readonly request: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>;

  constructor(options: MixClientOptions) {
    this.options = {
      pathLength: DEFAULTS.pathLength,
      meanDelayMs: DEFAULTS.meanDelayMs,
      pollIntervalMs: DEFAULTS.pollIntervalMs,
      timeoutMs: DEFAULTS.timeoutMs,
      ...options,
    };
    this.request = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** How many distinct mixes the client can currently choose from. */
  get nodeCount(): number {
    return this.options.nodes.length;
  }

  private delay(): number {
    const mean = this.options.meanDelayMs;
    if (mean <= 0) return 0;
    return Math.round(-mean * Math.log(1 - Math.random()));
  }

  /**
   * Picks intermediate hops, preferring different hosts. Repeating a host in
   * one path would hand the same operator two views of the same packet, which
   * is most of what a path is meant to prevent.
   */
  private intermediates(exclude: MixDirectoryNode[]): MixHop[] {
    const wanted = Math.max(0, this.options.pathLength - 1);
    const usedNodes = new Set(exclude.map((node) => hex(node.nodeId)));
    const usedHosts = new Set(exclude.map((node) => hostOf(node.url)));
    const pool = [...this.options.nodes];

    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      const current = pool[index] as MixDirectoryNode;
      pool[index] = pool[swap] as MixDirectoryNode;
      pool[swap] = current;
    }

    const chosen: MixHop[] = [];
    for (const node of pool) {
      if (chosen.length >= wanted) break;
      if (usedNodes.has(hex(node.nodeId))) continue;
      if (usedHosts.has(hostOf(node.url))) continue;
      usedNodes.add(hex(node.nodeId));
      usedHosts.add(hostOf(node.url));
      chosen.push({
        id: node.nodeId,
        publicKey: node.publicKey,
        delayMs: this.delay(),
      });
    }
    return chosen;
  }

  private nodeByHop(hop: MixHop): MixDirectoryNode | undefined {
    const wanted = hex(hop.id);
    if (hex(this.options.provider.nodeId) === wanted) {
      return this.options.provider;
    }
    return this.options.nodes.find((node) => hex(node.nodeId) === wanted);
  }

  /**
   * Sends one request to a relay through the network and waits for its answer.
   *
   * The path and the reply path are chosen fresh every time, so two requests
   * from the same client take different routes and no single mix sees a
   * pattern to follow.
   */
  async send(
    destination: MixDirectoryNode,
    operation: {
      op: MixOpValue;
      capsuleId?: string;
      token?: string;
      index?: number;
      data?: Uint8Array;
    },
    signal?: AbortSignal,
  ): Promise<MixSendResult> {
    const forwardIntermediates = this.intermediates([destination]);
    const forwardPath: MixHop[] = [
      ...forwardIntermediates,
      {
        id: destination.nodeId,
        publicKey: destination.publicKey,
        delayMs: 0,
      },
    ];

    const replyIntermediates = this.intermediates([
      destination,
      this.options.provider,
    ]);
    const replyPath: MixHop[] = [
      ...replyIntermediates,
      {
        id: this.options.provider.nodeId,
        publicKey: this.options.provider.publicKey,
        delayMs: 0,
      },
    ];

    const mailboxToken = randomBytes(NODE_ID_BYTES);
    const { block, secrets } = createReplyBlock(replyPath, mailboxToken);

    const message = encodeRequest({
      op: operation.op,
      replyBlock: block,
      ...(operation.capsuleId ? { capsuleId: operation.capsuleId } : {}),
      ...(operation.token ? { token: operation.token } : {}),
      ...(operation.index !== undefined ? { index: operation.index } : {}),
      ...(operation.data ? { data: operation.data } : {}),
    });

    const { packet } = createPacket(
      forwardPath,
      { command: MixCommand.Deliver, id: destination.nodeId },
      message,
    );

    const entry = this.nodeByHop(forwardPath[0] as MixHop);
    if (!entry) throw new Error("No entry mix is reachable");
    await this.post(`${entry.url}/v1/mix`, packet, signal);

    const body = await this.collect(hex(mailboxToken), signal);
    const opened = openReply(secrets, body);
    if (!opened) throw new Error("The reply did not authenticate");
    const response = decodeResponse(opened);
    return { ok: response.ok, data: response.data };
  }

  private async post(
    url: string,
    packet: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/capsule-mix" },
      body: asArrayBuffer(packet),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`The entry mix refused the packet (${response.status})`);
    }
  }

  private async collect(
    token: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const deadline = Date.now() + this.options.timeoutMs;
    // Polling backs off as the wait grows: a reply that has not arrived in a
    // second is waiting on a hop's delay, and asking faster will not help.
    let interval = this.options.pollIntervalMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("The request was cancelled");
      const response = await this.request(
        `${this.options.provider.url}/v1/mix/mailbox/${token}`,
        { ...(signal ? { signal } : {}) },
      );
      if (response.ok) {
        const body = (await response.json()) as { messages?: string[] };
        const first = body.messages?.[0];
        if (first) return fromBase64Url(first);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 1.5, 3_000);
    }
    throw new Error(
      "No reply arrived through the mix network before the timeout",
    );
  }
}

function asJson<T>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data)) as T;
}

function failure(data: Uint8Array): Error {
  try {
    const body = asJson<{ error?: string; message?: string }>(data);
    return new Error(body.message ?? body.error ?? "The relay refused");
  } catch {
    return new Error("The relay refused");
  }
}

/**
 * A relay transport that speaks through the mix network. The SDK cannot tell
 * the difference; the relay cannot tell who is on the other end.
 */
export class MixRelayTransport implements RelayTransport {
  readonly relayUrl: string;

  constructor(
    relayUrl: string,
    private readonly client: MixClient,
    private readonly destination: MixDirectoryNode,
    /** Limits taken from the directory, so the relay is never asked directly. */
    private readonly limits: RelayPublicConfig,
  ) {
    this.relayUrl = relayUrl;
  }

  async config(): Promise<RelayPublicConfig> {
    // Asking the relay for its configuration over a direct connection would
    // undo the point of the mix, and the directory already carries it.
    return this.limits;
  }

  private async run(
    op: MixOpValue,
    operation: {
      capsuleId?: string;
      token?: string;
      index?: number;
      data?: Uint8Array;
    },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const result = await this.client.send(
      this.destination,
      { op, ...operation },
      signal,
    );
    if (!result.ok) throw failure(result.data);
    return result.data;
  }

  async create(
    request: RelayCreateRequest,
    signal?: AbortSignal,
  ): Promise<RelayCreateResponse> {
    const data = await this.run(
      MixOp.Create,
      { data: new TextEncoder().encode(JSON.stringify(request)) },
      signal,
    );
    return asJson<RelayCreateResponse>(data);
  }

  async uploadChunk(
    capsuleId: string,
    index: number,
    ciphertext: Uint8Array,
    writeToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.run(
      MixOp.PutChunk,
      { capsuleId, token: writeToken, index, data: ciphertext },
      signal,
    );
  }

  async finalize(
    capsuleId: string,
    writeToken: string,
    signal?: AbortSignal,
  ): Promise<RelayStatus> {
    return asJson<RelayStatus>(
      await this.run(MixOp.Finalize, { capsuleId, token: writeToken }, signal),
    );
  }

  async status(
    capsuleId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<RelayStatus> {
    return asJson<RelayStatus>(
      await this.run(MixOp.Status, { capsuleId, token }, signal),
    );
  }

  async manifest(
    capsuleId: string,
    readToken: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.run(MixOp.Manifest, { capsuleId, token: readToken }, signal);
  }

  async chunk(
    capsuleId: string,
    index: number,
    readToken: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.run(
      MixOp.GetChunk,
      { capsuleId, token: readToken, index },
      signal,
    );
  }

  async delete(
    capsuleId: string,
    deleteToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.run(MixOp.Delete, { capsuleId, token: deleteToken }, signal);
  }
}

export { MIX_CHUNK_SIZE };
