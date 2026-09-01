import { decodeShareCapability } from "@capsule/protocol";
import type {
  CapsuleLocation,
  CapsuleShareCapability,
  CapsuleSiteRecord,
} from "@capsule/protocol";
import type { RelayConfig } from "./config.js";
import { isFetchableRelayOrigin } from "./peers.js";
import type { CapsuleStorage } from "./storage.js";

/**
 * Carrying a site, rather than just pointing at one.
 *
 * Gossip spreads the record: a signed line saying "version N of this name is
 * that capability". What it does not spread is the site. Without this, every
 * relay in the network knows the name of a page whose bytes sit on the one
 * machine its publisher happened to upload to, so the pointer is the part
 * that is impossible to withdraw and the content is the part one power cut
 * removes. For a network whose claim is that publishing does not depend on a
 * host, that is exactly backwards.
 *
 * A relay holding a site record already holds everything needed to fetch the
 * capsule — the identifier and the read token are inside the record, because
 * a `.capsule` site is public by construction and every visitor gets them the
 * same way. So the relay fetches it, stores it under the *same* identifier,
 * and from then on answers for that content as well as the origin does. A
 * visitor who cannot reach the relay named in the capability tries the relays
 * it knows instead, and the site is still there.
 *
 * What this deliberately does not do:
 *
 * - **Private capsules.** A capsule shared as a link is never replicated: its
 *   key and read token live in a URL fragment that no relay ever sees. Only
 *   content whose publisher signed a record saying "this is public" is
 *   carried, and that is the only distinction the relay can make.
 * - **Sharded capsules.** Where a capability declares erasure coding, each
 *   relay holds a shard rather than a copy, and there is no single stream of
 *   ciphertext to take on. Those are skipped, and the trade is worth saying
 *   out loud: splitting a site across relays buys confidentiality from any
 *   one operator and gives up this.
 * - **Anything the operator refuses.** The denylist is consulted for the name
 *   and for the identifier, before a byte is fetched.
 *
 * And one thing it has to be careful about. The relay a record names is a
 * string its publisher chose, so this is the one place where a relay makes
 * requests to an address an untrusted party picked — the same shape as the
 * peer directory, and guarded the same way: `isFetchableRelayOrigin` before
 * every request, every response body capped, and nothing believed until the
 * bytes are counted.
 */

export interface SiteReplicatorOptions {
  config: RelayConfig;
  storage: CapsuleStorage;
  /** The records this relay currently holds. */
  records: () => CapsuleSiteRecord[];
  deniesSite: (name: string) => boolean;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  log?: (message: string, details?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface ReplicationRound {
  /** Copies fetched for the first time. */
  adopted: number;
  /** Copies whose lease was pushed out because the name is still gossiped. */
  renewed: number;
  /** Copies dropped: superseded, denied, or no longer named by any record. */
  released: number;
  /** Sites that could not be fetched from any relay that had them. */
  failed: number;
  /** Sites left unfetched because the byte budget is full. */
  deferred: number;
}

const STATUS_TIMEOUT_MS = 10_000;
const TRANSFER_TIMEOUT_MS = 60_000;
const MAX_STATUS_BYTES = 64 * 1024;

async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error("The relay offered a larger body than it should have");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw new Error("The relay sent a larger body than it should have");
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts, total);
}

interface RemoteStatus {
  state?: string;
  chunkCount?: number;
  totalCiphertextBytes?: number;
}

export class SiteReplicator {
  private readonly request: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>;
  private readonly now: () => number;
  private running = false;

  constructor(private readonly options: SiteReplicatorOptions) {
    this.request =
      options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * One pass: renew what is still named, fetch what is missing, release the
   * rest.
   *
   * Sequential on purpose. Replication is the least urgent thing a relay
   * does — nobody is waiting on it — and a relay that answered a gossip round
   * by opening thirty simultaneous downloads would be a worse neighbour than
   * one that never replicated at all.
   */
  async run(): Promise<ReplicationRound> {
    const round: ReplicationRound = {
      adopted: 0,
      renewed: 0,
      released: 0,
      failed: 0,
      deferred: 0,
    };
    if (this.running || !this.options.config.siteReplication) return round;
    this.running = true;
    try {
      const wanted = new Map<string, CapsuleSiteRecord>();
      for (const record of this.options.records()) {
        if (this.options.deniesSite(record.name)) continue;
        const capability = this.capabilityOf(record);
        if (!capability || capability.sharding) continue;
        wanted.set(capability.capsuleId, record);
      }

      // Released first, so a superseded version gives its bytes back to the
      // budget before the version replacing it asks for them.
      for (const replica of await this.options.storage.listReplicas()) {
        if (wanted.has(replica.capsuleId)) continue;
        if (await this.options.storage.removeAsOperator(replica.capsuleId)) {
          round.released += 1;
        }
      }

      const expiresAt = new Date(
        this.now() + this.options.config.replicaTtlSeconds * 1000,
      ).toISOString();

      for (const [capsuleId, record] of wanted) {
        const capability = this.capabilityOf(record);
        if (!capability) continue;
        if (await this.options.storage.extendReplica(capsuleId, expiresAt)) {
          round.renewed += 1;
          continue;
        }
        // Held as the origin rather than as a copy: this relay is where the
        // site was published, and there is nothing to fetch from itself.
        if (await this.options.storage.holds(capsuleId)) continue;
        if (round.deferred > 0) {
          // The budget filled on an earlier site this round; the rest are
          // reported rather than each one repeating the same failed check.
          round.deferred += 1;
          continue;
        }
        const outcome = await this.adopt(record, capability, expiresAt);
        if (outcome === "stored") round.adopted += 1;
        else if (outcome === "no_space") round.deferred += 1;
        else if (outcome === "failed") round.failed += 1;
      }
    } finally {
      this.running = false;
    }
    return round;
  }

  private capabilityOf(
    record: CapsuleSiteRecord,
  ): CapsuleShareCapability | undefined {
    try {
      return decodeShareCapability(record.capability);
    } catch {
      // A record that verified but carries an unreadable capability is a
      // publisher's problem, not something to log every five minutes.
      return undefined;
    }
  }

  private async adopt(
    record: CapsuleSiteRecord,
    capability: CapsuleShareCapability,
    expiresAt: string,
  ): Promise<"stored" | "held" | "no_space" | "failed"> {
    const locations: CapsuleLocation[] = [
      {
        relayUrl: capability.relayUrl,
        capsuleId: capability.capsuleId,
        readToken: capability.readToken,
      },
      ...(capability.mirrors ?? []),
    ];

    for (const location of locations) {
      if (
        !(await isFetchableRelayOrigin(
          location.relayUrl,
          this.options.config.allowPrivatePeers,
        ))
      ) {
        continue;
      }
      let status: RemoteStatus;
      try {
        status = await this.json(location, "status");
      } catch {
        continue;
      }
      if (
        status.state !== "ready" ||
        !Number.isSafeInteger(status.chunkCount) ||
        !Number.isSafeInteger(status.totalCiphertextBytes)
      ) {
        continue;
      }

      try {
        const manifest = (
          await this.bytes(
            location,
            "manifest",
            this.options.config.maxManifestBytes,
          )
        ).toString("base64url");
        const outcome = await this.options.storage.adopt(
          {
            capsuleId: capability.capsuleId,
            readToken: capability.readToken,
            siteName: record.name,
            encryptedManifest: manifest,
            chunkCount: status.chunkCount as number,
            totalCiphertextBytes: status.totalCiphertextBytes as number,
            expiresAt,
          },
          async (index) =>
            this.bytes(
              location,
              `chunks/${index}`,
              this.options.config.maxChunkBytes,
            ),
        );
        if (outcome === "refused") return "failed";
        if (outcome === "no_space") return "no_space";
        if (outcome === "stored") {
          this.options.log?.("Carrying a site", {
            name: record.name,
            bytes: status.totalCiphertextBytes,
            from: location.relayUrl,
          });
        }
        return outcome;
      } catch {
        // A relay that dies halfway through is the ordinary case; the copy is
        // discarded whole and another relay holding it may still answer.
        continue;
      }
    }
    return "failed";
  }

  private async json<T>(location: CapsuleLocation, path: string): Promise<T> {
    const response = await this.fetchFrom(location, path, STATUS_TIMEOUT_MS);
    return JSON.parse(
      (await readCapped(response, MAX_STATUS_BYTES)).toString("utf8"),
    ) as T;
  }

  /**
   * Reads a body, refusing one larger than it should be.
   *
   * The limit is not politeness. The other end is a relay this one has no
   * reason to trust, `Content-Length` is a claim rather than a fact, and a
   * chunked response has no declared size at all — so the count that matters
   * is the one taken while reading, and the read stops the moment it is
   * exceeded rather than after the memory is already gone.
   */
  private async bytes(
    location: CapsuleLocation,
    path: string,
    limit: number,
  ): Promise<Buffer> {
    const response = await this.fetchFrom(location, path, TRANSFER_TIMEOUT_MS);
    return readCapped(response, limit);
  }

  private async fetchFrom(
    location: CapsuleLocation,
    path: string,
    timeoutMs: number,
  ): Promise<Response> {
    const base = location.relayUrl.replace(/\/+$/u, "");
    const response = await this.request(
      `${base}/v1/capsules/${encodeURIComponent(location.capsuleId)}/${path}`,
      {
        headers: { Authorization: `Bearer ${location.readToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`${base} answered ${response.status} for ${path}`);
    }
    return response;
  }
}
