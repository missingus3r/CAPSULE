import { describe, expect, it } from "vitest";
import {
  classifyHost,
  classifyRelayOrigin,
  embeddedIpv4,
  isPublicRelayOrigin,
  parseIpv4,
  parseIpv6,
} from "../src/index.js";

/**
 * A relay learns addresses from other relays and a client learns them from
 * relays; both then connect to them. The whole value of this check is that it
 * sees through every spelling of the same address, so the interesting cases
 * are the ones that do not look like `127.0.0.1`.
 */

describe("address parsing", () => {
  it("parses dotted IPv4 and refuses everything else", () => {
    expect(parseIpv4("127.0.0.1")).toBe(0x7f000001);
    expect(parseIpv4("255.255.255.255")).toBe(0xffffffff);
    expect(parseIpv4("256.0.0.1")).toBeUndefined();
    expect(parseIpv4("1.2.3")).toBeUndefined();
    expect(parseIpv4("0x7f.0.0.1")).toBeUndefined();
  });

  it("expands IPv6, including the dotted tail", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x7f00, 1,
    ]);
    expect(parseIpv6("[2606:4700::1111]")).toEqual([
      0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111,
    ]);
    expect(parseIpv6("1::2::3")).toBeUndefined();
    expect(parseIpv6("gggg::1")).toBeUndefined();
  });

  it("sees the IPv4 address hidden inside an IPv6 one", () => {
    expect(embeddedIpv4(parseIpv6("::ffff:7f00:1") as number[])).toBe(
      0x7f000001,
    );
    expect(embeddedIpv4(parseIpv6("::ffff:127.0.0.1") as number[])).toBe(
      0x7f000001,
    );
    expect(embeddedIpv4(parseIpv6("64:ff9b::a9fe:a9fe") as number[])).toBe(
      0xa9fea9fe,
    );
    expect(
      embeddedIpv4(parseIpv6("2606:4700::1111") as number[]),
    ).toBeUndefined();
  });
});

describe("relay origin routability", () => {
  const blocked = [
    "http://127.0.0.1",
    "http://127.0.0.1:8787",
    "http://10.0.0.5",
    "http://192.168.1.1",
    "http://172.16.0.1",
    "http://169.254.169.254",
    "http://100.64.0.1",
    "http://0.0.0.0",
    "http://255.255.255.255",
    "http://224.0.0.1",
    "http://localhost",
    "http://localhost:8787",
    "http://relay.local",
    "http://metadata.google.internal",
    "http://intranet",
    // The same loopback address written as IPv6.
    "http://[::1]",
    "http://[::ffff:7f00:1]",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:a00:1]",
    "http://[::ffff:c0a8:1]",
    "http://[::]",
    "http://[fd00::1]",
    "http://[fe80::1]",
    "http://[64:ff9b::7f00:1]",
    // Not canonical origins: the URL parser rewrites these.
    "http://2130706433",
    "http://0177.0.0.1",
    "http://user:pass@relay.example.org",
    "http://relay.example.org/path",
    "http://relay.example.org?query=1",
    "ftp://relay.example.org",
  ];

  const allowed = [
    "https://relay.example.org",
    "http://relay.example.org:8787",
    "https://sub.domain.relay.example.org",
    "http://[2606:4700::1111]",
    "http://8.8.8.8",
  ];

  it("refuses every address that points back into a local network", () => {
    for (const origin of blocked) {
      const verdict = classifyRelayOrigin(origin);
      expect(verdict.routable, `${origin} should be refused`).toBe(false);
    }
  });

  it("accepts ordinary public relay addresses", () => {
    for (const origin of allowed) {
      const verdict = classifyRelayOrigin(origin);
      expect(verdict.routable, `${origin} should be accepted`).toBe(true);
    }
  });

  it("says why it refused, so an operator can tell a bug from a policy", () => {
    const verdict = classifyRelayOrigin("http://[::ffff:7f00:1]");
    expect(verdict.routable).toBe(false);
    if (!verdict.routable) expect(verdict.reason).toContain("loopback");
  });

  it("still resolves names to the caller, which is where DNS lives", () => {
    // A name that resolves to a private address cannot be caught here; that is
    // the resolver's job, and the relay does it before connecting.
    expect(isPublicRelayOrigin("http://127.0.0.1.nip.io")).toBe(true);
    expect(classifyHost("127.0.0.1.nip.io")).toEqual({
      routable: true,
      kind: "name",
      host: "127.0.0.1.nip.io",
    });
  });
});
