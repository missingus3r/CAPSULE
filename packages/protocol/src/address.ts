/**
 * Deciding whether an address is safe to connect to.
 *
 * A relay learns addresses from other relays, and a client learns them from
 * relays. Both then connect to them. Without a check, anyone who can announce
 * a peer can point the whole network at `127.0.0.1`, at a cloud metadata
 * service, or at anything else the operator believed was unreachable from
 * outside.
 *
 * The check has to see through every way of writing the same address. It is
 * not enough to reject the string `127.0.0.1`: `[::ffff:7f00:1]` reaches the
 * same socket, and so does any hostname whose A record points there. This
 * module answers the syntactic half of the question, works identically in
 * Node and the browser, and is deliberately conservative: an address it cannot
 * parse is refused.
 *
 * The other half — what a hostname actually resolves to — needs a resolver and
 * lives with the code that has one.
 */

export type AddressVerdict =
  | { routable: true; kind: "ipv4" | "ipv6" | "name"; host: string }
  | { routable: false; reason: string };

/** IPv4 ranges that never belong to a public relay. */
const BLOCKED_IPV4: Array<{ mask: number; bits: number; reason: string }> = [
  { mask: 0x00000000, bits: 8, reason: "this network" },
  { mask: 0x0a000000, bits: 8, reason: "private network" },
  { mask: 0x7f000000, bits: 8, reason: "loopback" },
  {
    mask: 0xa9fe0000,
    bits: 16,
    reason: "link-local, including cloud metadata",
  },
  { mask: 0xac100000, bits: 12, reason: "private network" },
  { mask: 0xc0a80000, bits: 16, reason: "private network" },
  { mask: 0x64400000, bits: 10, reason: "carrier-grade NAT" },
  { mask: 0xc0000000, bits: 24, reason: "IETF protocol assignments" },
  { mask: 0xc0000200, bits: 24, reason: "documentation range" },
  { mask: 0xc6120000, bits: 15, reason: "benchmarking range" },
  { mask: 0xc6336400, bits: 24, reason: "documentation range" },
  { mask: 0xcb007100, bits: 24, reason: "documentation range" },
  { mask: 0xe0000000, bits: 4, reason: "multicast" },
  { mask: 0xf0000000, bits: 4, reason: "reserved" },
];

/** Suffixes that only ever name something on the local network. */
const BLOCKED_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".home.arpa",
  ".arpa",
  ".onion.local",
];

export function parseIpv4(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value * 256 + octet) >>> 0;
  }
  return value >>> 0;
}

/**
 * Parses an IPv6 literal into its eight groups, expanding `::` and accepting
 * the dotted-quad tail used by IPv4-mapped addresses.
 */
export function parseIpv6(host: string): number[] | undefined {
  const value = host.replace(/^\[|\]$/gu, "").split("%")[0] ?? "";
  if (!value.includes(":")) return undefined;

  const [head, tail, ...rest] = value.split("::");
  if (rest.length > 0) return undefined;

  const readGroups = (segment: string): number[] | undefined => {
    if (segment === "") return [];
    const groups: number[] = [];
    const parts = segment.split(":");
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes(".")) {
        const packed = parseIpv4(part);
        if (packed === undefined) return undefined;
        groups.push((packed >>> 16) & 0xffff, packed & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/iu.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const left = readGroups(head ?? "");
  const right = tail === undefined ? [] : readGroups(tail);
  if (!left || !right) return undefined;

  if (tail === undefined) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

/** The IPv4 address an IPv6 address stands for, when it stands for one. */
export function embeddedIpv4(groups: number[]): number | undefined {
  const isZeroPrefix = groups.slice(0, 5).every((group) => group === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated).
  if (isZeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    return (((groups[6] ?? 0) << 16) | (groups[7] ?? 0)) >>> 0;
  }
  // 64:ff9b::/96, the well-known NAT64 prefix.
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return (((groups[6] ?? 0) << 16) | (groups[7] ?? 0)) >>> 0;
  }
  return undefined;
}

function checkIpv4(value: number): AddressVerdict {
  for (const range of BLOCKED_IPV4) {
    const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
    if ((value & mask) >>> 0 === range.mask) {
      return { routable: false, reason: `IPv4 ${range.reason}` };
    }
  }
  return { routable: true, kind: "ipv4", host: String(value) };
}

function checkIpv6(groups: number[]): AddressVerdict {
  const mapped = embeddedIpv4(groups);
  if (mapped !== undefined) {
    const verdict = checkIpv4(mapped);
    return verdict.routable
      ? { routable: true, kind: "ipv6", host: "mapped" }
      : verdict;
  }
  if (groups.every((group) => group === 0)) {
    return { routable: false, reason: "IPv6 unspecified address" };
  }
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return { routable: false, reason: "IPv6 loopback" };
  }
  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) {
    return { routable: false, reason: "IPv6 unique local address" };
  }
  if ((first & 0xffc0) === 0xfe80) {
    return { routable: false, reason: "IPv6 link-local" };
  }
  if ((first & 0xff00) === 0xff00) {
    return { routable: false, reason: "IPv6 multicast" };
  }
  if (first === 0x2001 && groups[1] === 0x0db8) {
    return { routable: false, reason: "IPv6 documentation range" };
  }
  return { routable: true, kind: "ipv6", host: "global" };
}

/**
 * Whether a hostname may be connected to. Names are only checked for the
 * shapes that can never be public; what a name resolves to is the caller's
 * responsibility.
 */
export function classifyHost(hostname: string): AddressVerdict {
  const host = hostname.trim().toLowerCase().replace(/\.$/u, "");
  if (host === "") return { routable: false, reason: "empty host" };

  const ipv4 = parseIpv4(host);
  if (ipv4 !== undefined) return checkIpv4(ipv4);

  const ipv6 = parseIpv6(host);
  if (ipv6 !== undefined) return checkIpv6(ipv6);

  if (host.startsWith("[") || host.includes(":")) {
    return { routable: false, reason: "malformed IPv6 literal" };
  }
  if (host === "localhost") return { routable: false, reason: "localhost" };
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { routable: false, reason: "local network name" };
  }
  if (!host.includes(".")) {
    // A single label is resolved through the local search domain, which is
    // exactly how an intranet name reaches an internal service.
    return { routable: false, reason: "single-label name" };
  }
  if (!/^[a-z0-9.-]+$/u.test(host)) {
    return { routable: false, reason: "unexpected characters in host" };
  }
  return { routable: true, kind: "name", host };
}

/**
 * Whether a URL is an origin a public relay could plausibly live at: an HTTP(S)
 * origin with no credentials, path, query or fragment, whose host is not a
 * local or reserved address.
 */
export function classifyRelayOrigin(value: string): AddressVerdict {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { routable: false, reason: "not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { routable: false, reason: "not an HTTP(S) URL" };
  }
  if (url.username || url.password) {
    return { routable: false, reason: "URL carries credentials" };
  }
  if (url.search || url.hash) {
    return { routable: false, reason: "URL carries a query or fragment" };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return { routable: false, reason: "URL carries a path" };
  }
  if (url.origin !== value.replace(/\/$/u, "")) {
    // Catches decimal, octal and hexadecimal spellings of an address, which
    // the URL parser normalises into a different string than the input.
    return { routable: false, reason: "URL is not a canonical origin" };
  }
  return classifyHost(url.hostname);
}

/** Convenience wrapper: true when the origin is safe to connect to. */
export function isPublicRelayOrigin(value: string): boolean {
  return classifyRelayOrigin(value).routable;
}
