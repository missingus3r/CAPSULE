import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";

/**
 * Finding a relay when there is no internet.
 *
 * Every other way CAPSULE finds a relay assumes something outside the room:
 * DNS to resolve a name, a seed list somebody published, a peer that is already
 * reachable. On a laptop hotspot in a building with the uplink cut, none of
 * those exist, and the two machines that need to exchange a file are four
 * metres apart.
 *
 * So: a relay may shout on the local network, and a client may listen. No
 * names, no bootstrap, no server anywhere. This is UDP multicast, which is the
 * same mechanism a printer uses to announce itself.
 *
 * **It is off by default and it should be.** A beacon tells everyone on the
 * network that this machine is running CAPSULE. On a café's wifi that is a
 * disclosure, and it is exactly the disclosure the rest of this project spends
 * its effort avoiding. It is worth turning on when the local network is the
 * only network there is, and not otherwise.
 */

/** Administratively scoped multicast: never routed off the local network. */
export const LAN_GROUP = "239.255.42.99";
export const LAN_PORT = 8799;
export const LAN_MAGIC = "CAPSULELAN1";
export const DEFAULT_BEACON_INTERVAL_MS = 5_000;
export const DEFAULT_DISCOVERY_MS = 3_000;
const MAX_BEACON_BYTES = 1024;

export interface LanBeacon {
  /** Relay identity, so a client can tell two beacons apart. */
  relayId: string;
  /** Where to reach it, e.g. `http://192.168.1.24:8787`. */
  url: string;
  software: string;
  sites: boolean;
  mix: boolean;
}

export interface LanRelay extends LanBeacon {
  /** The address the beacon actually came from. */
  address: string;
}

function encode(beacon: LanBeacon): Buffer {
  return Buffer.from(`${LAN_MAGIC}${JSON.stringify(beacon)}`, "utf8");
}

function decode(payload: Buffer): LanBeacon | undefined {
  if (payload.byteLength > MAX_BEACON_BYTES) return undefined;
  const text = payload.toString("utf8");
  if (!text.startsWith(LAN_MAGIC)) return undefined;
  try {
    const parsed = JSON.parse(text.slice(LAN_MAGIC.length)) as LanBeacon;
    if (typeof parsed?.relayId !== "string" || parsed.relayId.length > 128) {
      return undefined;
    }
    if (typeof parsed.url !== "string") return undefined;
    // Only a plain origin, and only on the local network: a beacon is an
    // unauthenticated message from anyone on the wire, so it must not be able
    // to point a client at an arbitrary address.
    const url = new URL(parsed.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash)
      return undefined;
    if (url.pathname !== "/" && url.pathname !== "") return undefined;
    return {
      relayId: parsed.relayId,
      url: url.origin,
      software: typeof parsed.software === "string" ? parsed.software : "",
      sites: parsed.sites === true,
      mix: parsed.mix === true,
    };
  } catch {
    return undefined;
  }
}

/** The IPv4 addresses this machine has on real interfaces. */
export function localAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      found.push(entry.address);
    }
  }
  return found;
}

export interface BeaconHandle {
  close(): void;
}

/**
 * Announces a relay on the local network until closed.
 *
 * Failures are swallowed on purpose: a machine with no network, or one where
 * multicast is filtered, should not take the relay down with it. The beacon is
 * a convenience, not a dependency.
 */
export function startLanBeacon(
  beacon: LanBeacon,
  options: { intervalMs?: number; port?: number; group?: string } = {},
): BeaconHandle {
  const port = options.port ?? LAN_PORT;
  const group = options.group ?? LAN_GROUP;
  const payload = encode(beacon);
  if (payload.byteLength > MAX_BEACON_BYTES) {
    throw new Error("The LAN beacon is too large");
  }

  const socket = createSocket({ type: "udp4", reuseAddr: true });
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  socket.on("error", () => {
    // Nothing to do: multicast may simply be unavailable here.
  });
  socket.bind(() => {
    if (closed) return;
    try {
      socket.setBroadcast(true);
      socket.setMulticastTTL(1);
    } catch {
      // Some platforms refuse these; the send below may still work.
    }
    const send = (): void => {
      socket.send(payload, port, group, () => undefined);
    };
    send();
    timer = setInterval(send, options.intervalMs ?? DEFAULT_BEACON_INTERVAL_MS);
    timer.unref();
  });

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Listens for beacons and returns what answered.
 *
 * Nothing here is authenticated, and it cannot be: the point is to find a relay
 * you have never heard of, on a network with no infrastructure. What protects
 * the content is that the content was already encrypted before it went
 * anywhere — a hostile relay on the local network sees ciphertext, the same as
 * a hostile relay on the internet.
 */
export async function discoverLanRelays(
  options: {
    timeoutMs?: number;
    port?: number;
    group?: string;
    signal?: AbortSignal;
  } = {},
): Promise<LanRelay[]> {
  const port = options.port ?? LAN_PORT;
  const group = options.group ?? LAN_GROUP;
  const found = new Map<string, LanRelay>();

  return new Promise((resolve) => {
    const socket: Socket = createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, options.timeoutMs ?? DEFAULT_DISCOVERY_MS);
    timer.unref();
    options.signal?.addEventListener("abort", finish, { once: true });

    socket.on("error", finish);
    socket.on("message", (payload, remote) => {
      const beacon = decode(payload);
      if (!beacon) return;
      found.set(beacon.relayId, { ...beacon, address: remote.address });
    });
    socket.bind(port, () => {
      try {
        socket.addMembership(group);
      } catch {
        // Without membership only broadcasts arrive, which is still something.
      }
    });
  });
}
