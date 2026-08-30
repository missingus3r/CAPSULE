import { fromBase64Url, type CapsuleSiteRecord } from "@capsule/protocol";
import type { RelayInfo, RelayPublicConfig } from "@capsule/sdk";
import {
  MixClient,
  MixRelayTransport,
  type MixDirectoryNode,
} from "./client.js";
import { nodeIdFor } from "./sphinx.js";

/**
 * Turning a directory of relays into a usable mix network.
 *
 * Two honest constraints shape this:
 *
 * - **A path needs relays that are not the destination.** Every hop that is
 *   also the destination is a hop that learns nothing new. With too few relays
 *   the path gets shorter, and the caller is told the real length rather than
 *   the one it asked for.
 * - **Fewer relays means less protection, and no amount of code fixes it.**
 *   Anonymity comes from the crowd a message hides in. `MixNetwork.strength`
 *   exists so an interface can say what that crowd currently is, instead of
 *   implying a guarantee that a three-node network cannot give.
 */

export interface MixNetworkOptions {
  relays: RelayInfo[];
  /** Relay that will hold this client's mailbox. Defaults to a random one. */
  providerUrl?: string;
  pathLength?: number;
  meanDelayMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface MixNetwork {
  client: MixClient;
  provider: MixDirectoryNode;
  /** Relays that can act as mixes, by URL. */
  nodes: Map<string, MixDirectoryNode>;
  /** Hops per direction actually available, which may be fewer than asked. */
  pathLength: number;
  /** Builds the transport a transfer uses to reach one relay. */
  transportFor: (relayUrl: string) => MixRelayTransport;
  /**
   * Asks one relay for a `.capsule` record without revealing who is asking.
   *
   * Shaped to drop straight into `resolveSite`, and quiet about every kind of
   * no — a relay outside this network, one that does not hold the name, one
   * too old to know the operation. A resolver asks several and keeps the
   * newest record that verifies, so one relay saying nothing is not an error
   * and not information.
   */
  recordFor: (
    relayUrl: string,
    name: string,
  ) => Promise<CapsuleSiteRecord | undefined>;
  /** An honest summary of what this network can and cannot offer. */
  strength: MixNetworkStrength;
}

export interface MixNetworkStrength {
  mixCount: number;
  operatorCount: number;
  pathLength: number;
  /**
   * Plain-language verdict. A network this small protects against a curious
   * relay, not against someone who can watch the whole network.
   */
  verdict: "single-node" | "minimal" | "small" | "usable";
}

function toDirectoryNode(relay: RelayInfo): MixDirectoryNode | undefined {
  if (!relay.mixPublicKey) return undefined;
  const publicKey = fromBase64Url(relay.mixPublicKey);
  if (publicKey.byteLength !== 32) return undefined;
  return { nodeId: nodeIdFor(publicKey), url: relay.url, publicKey };
}

function operatorOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/^[\d.]+$/u.test(host) || host.includes(":")) return host;
    return host.split(".").slice(-2).join(".");
  } catch {
    return url;
  }
}

export function limitsOf(relay: RelayInfo): RelayPublicConfig {
  return {
    version: 1,
    maxCapsuleBytes: relay.limits.maxCapsuleBytes,
    maxChunkBytes: relay.limits.maxChunkBytes,
    maxManifestBytes: relay.limits.maxManifestBytes,
    maxChunkCount: relay.limits.maxChunkCount,
    defaultTtlSeconds: relay.defaultTtlSeconds,
    maxTtlSeconds: relay.maxTtlSeconds,
    persistentCapsules: relay.persistentCapsules,
  };
}

function verdictFor(
  mixCount: number,
  operatorCount: number,
): MixNetworkStrength["verdict"] {
  if (mixCount <= 1) return "single-node";
  if (mixCount < 3 || operatorCount < 2) return "minimal";
  if (mixCount < 10 || operatorCount < 4) return "small";
  return "usable";
}

export function buildMixNetwork(options: MixNetworkOptions): MixNetwork {
  const byUrl = new Map<string, MixDirectoryNode>();
  const limits = new Map<string, RelayPublicConfig>();
  for (const relay of options.relays) {
    const node = toDirectoryNode(relay);
    if (!node) continue;
    byUrl.set(relay.url, node);
    limits.set(relay.url, limitsOf(relay));
  }
  if (byUrl.size === 0) {
    throw new Error("No relay in the directory runs a mix node");
  }

  const provider = options.providerUrl
    ? byUrl.get(options.providerUrl)
    : [...byUrl.values()][Math.floor(Math.random() * byUrl.size)];
  if (!provider) {
    throw new Error("The chosen provider does not run a mix node");
  }

  // A path is built from relays other than the destination, so the usable
  // length is bounded by how many the directory actually holds.
  const requested = options.pathLength ?? 3;
  const pathLength = Math.max(1, Math.min(requested, byUrl.size));

  const clientOptions = {
    nodes: [...byUrl.values()],
    provider,
    pathLength,
    ...(options.meanDelayMs !== undefined
      ? { meanDelayMs: options.meanDelayMs }
      : {}),
    ...(options.pollIntervalMs !== undefined
      ? { pollIntervalMs: options.pollIntervalMs }
      : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
  const client = new MixClient(clientOptions);

  const operators = new Set([...byUrl.keys()].map(operatorOf));

  /**
   * The client to use when talking to one particular relay.
   *
   * Normally the shared one. The exception matters: a client polls its mailbox
   * provider directly, so the provider sees an address and the reply token it
   * is polling for — and the destination learns that same token when it
   * answers. If those are the same relay it can put the two together and read
   * the address behind a request that was supposed to arrive with none. So
   * when the destination is also the provider, and there is anywhere else to
   * put the mailbox, the mailbox moves.
   */
  const byProvider = new Map<string, MixClient>();
  const clientFor = (destinationUrl: string): MixClient => {
    if (destinationUrl !== provider.url) return client;
    const alternative = [...byUrl.values()].find(
      (node) => node.url !== destinationUrl,
    );
    if (!alternative) return client;
    const existing = byProvider.get(alternative.url);
    if (existing) return existing;
    const replacement = new MixClient({
      ...clientOptions,
      provider: alternative,
    });
    byProvider.set(alternative.url, replacement);
    return replacement;
  };

  return {
    client,
    provider,
    nodes: byUrl,
    pathLength,
    transportFor: (relayUrl: string) => {
      const destination = byUrl.get(relayUrl);
      const config = limits.get(relayUrl);
      if (!destination || !config) {
        throw new Error(
          `Relay ${relayUrl} does not run a mix node, so it cannot be reached through the network`,
        );
      }
      return new MixRelayTransport(
        relayUrl,
        clientFor(relayUrl),
        destination,
        config,
      );
    },
    recordFor: async (relayUrl: string, name: string) => {
      const destination = byUrl.get(relayUrl);
      const config = limits.get(relayUrl);
      if (!destination || !config) return undefined;
      const record = await new MixRelayTransport(
        relayUrl,
        clientFor(relayUrl),
        destination,
        config,
      ).siteRecord(name);
      return record as CapsuleSiteRecord | undefined;
    },
    strength: {
      mixCount: byUrl.size,
      operatorCount: operators.size,
      pathLength,
      verdict: verdictFor(byUrl.size, operators.size),
    },
  };
}

/** One sentence a person can act on, given how small the network really is. */
export function describeStrength(strength: MixNetworkStrength): string {
  const base = `${strength.mixCount} mixes across ${strength.operatorCount} apparent operators, ${strength.pathLength} hops each way`;
  switch (strength.verdict) {
    case "single-node":
      return `${base}. This is not anonymity: with one node, that node sees both ends.`;
    case "minimal":
      return `${base}. Enough to keep the storing relay from seeing you, and not enough for anything more.`;
    case "small":
      return `${base}. A curious relay learns little; anyone who can watch several of these relays learns a lot.`;
    default:
      return `${base}. Still far short of a large network: judge it by who runs these relays, not by the count.`;
  }
}
