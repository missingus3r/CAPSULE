import {
  bridgeCookie,
  bridgeOrigin,
  deriveBridgeSecrets,
  type BridgeDescriptor,
  type BridgeSecrets,
} from "@capsule/protocol";
import type { FetchLike } from "./network.js";

/**
 * A `fetch` that knows how to talk to a bridge.
 *
 * Doing it at this level rather than inside the relay client is deliberate:
 * everything in the SDK that reaches a relay already takes a `fetchImpl`, so
 * one wrapper gives bridge support to transfers, relay discovery, site
 * resolution and record announcements at once — and nothing can be forgotten,
 * because there is only one place to forget it.
 *
 * Requests to anywhere other than the bridge pass through untouched. A client
 * configured with a bridge is usually still talking to the wider network
 * through it, and rewriting somebody else's URL would break that.
 */
export function createBridgeFetch(
  bridge: BridgeDescriptor,
  fetchImpl?: FetchLike,
): FetchLike {
  const origin = bridgeOrigin(bridge);
  const request: FetchLike =
    fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  let secrets: Promise<BridgeSecrets> | undefined;

  return async (url, init = {}) => {
    if (!url.startsWith(`${origin}/`) && url !== origin) {
      return request(url, init);
    }

    secrets ??= deriveBridgeSecrets(bridge.key);
    const resolved = await secrets;
    const path = url.slice(origin.length) || "/";
    const method = init.method ?? "GET";
    const cookie = await bridgeCookie(resolved, method, path);

    return request(`${origin}/${resolved.pathPrefix}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Cookie: cookie.header },
    });
  };
}

/** The origin a bridge is reached at, for commands that need a relay URL. */
export { bridgeOrigin };
