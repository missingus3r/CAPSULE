import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CAPSULE_URL_FILTER } from "../src/redirect.js";

/**
 * The redirect rule is the only reason a `.capsule` address reaches anything.
 * When it is wrong the browser says "this site can't be reached" and nothing
 * points at the extension, so it is worth pinning down here rather than
 * discovering it by hand.
 *
 * Chrome compiles the filter with RE2; JavaScript's engine is a superset for
 * the constructs used, so matching behaviour can be checked without a browser.
 */

const NAME = "6dijvuvwrd5jqp4efjbb4hwcsmtsf6sgi3at4jeto63k7x5fkbwat2yb.capsule";
const filter = new RegExp(CAPSULE_URL_FILTER);

describe("the .capsule redirect filter", () => {
  it("matches the addresses a visitor would type", () => {
    for (const url of [
      `http://${NAME}/`,
      `http://${NAME}`,
      `https://${NAME}/`,
      `http://${NAME}/about/`,
      `http://${NAME}/assets/app.css`,
      `http://${NAME}:8080/x?y=1`,
      `http://${NAME}/page#section`,
    ]) {
      expect(filter.test(url), url).toBe(true);
    }
  });

  it("leaves every address that is not under .capsule alone", () => {
    for (const url of [
      "http://example.com/",
      "https://capsule.org/",
      `http://${NAME}.evil.com/`,
      `http://evil.com/?u=${NAME}/`,
      // Base32 has no 0, 1, 8 or 9.
      `http://${"0".repeat(56)}.capsule/`,
      "ftp://" + NAME + "/",
    ]) {
      expect(filter.test(url), url).toBe(false);
    }
  });

  it("still catches a name of the wrong length, so the viewer can explain", () => {
    // The filter cannot check the length: a counted repetition compiles past
    // the 2 KB budget Chrome allows and the rule gets skipped entirely. The
    // check lives in parseSiteName instead, and reaching the viewer with a bad
    // name produces an explanation rather than a DNS error.
    for (const url of [
      "http://short.capsule/",
      `http://${"a".repeat(57)}.capsule/`,
      `http://${"a".repeat(55)}.capsule/`,
    ]) {
      expect(filter.test(url), url).toBe(true);
    }
  });

  it("compiles to something small enough for Chrome to accept", () => {
    // A rough stand-in for RE2's budget: what blew it was `{56}` over a 32-way
    // character class, so what matters is that no counted repetition survives.
    expect(CAPSULE_URL_FILTER).not.toMatch(/\{\d+\}/u);
    expect(CAPSULE_URL_FILTER.length).toBeLessThan(80);
  });

  it("is anchored, so the whole address is what gets substituted", () => {
    // `\0` in a regexSubstitution is the matched text. Anchoring is what makes
    // that the entire URL rather than a fragment of one.
    expect(CAPSULE_URL_FILTER.startsWith("^")).toBe(true);
    expect(CAPSULE_URL_FILTER.endsWith("$")).toBe(true);
    const matched = `http://${NAME}/about/`.match(filter);
    expect(matched?.[0]).toBe(`http://${NAME}/about/`);
  });
});

describe("the frame a site with scripts runs in", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
  ) as {
    sandbox?: { pages?: string[] };
    content_security_policy?: Record<string, string>;
  };

  it("declares a sandboxed page, because srcdoc inherits this page's policy", () => {
    // A `srcdoc` document takes the Content-Security-Policy of the page
    // embedding it, and an extension page's is `script-src 'self'`. A meta
    // policy inside can only add restrictions, so through srcdoc a site's own
    // scripts can never run — verified in Chrome, and the reason this page
    // exists at all.
    expect(manifest.sandbox?.pages).toContain("sandboxed.html");
  });

  it("keeps the network shut in the sandbox policy too", () => {
    const policy = manifest.content_security_policy?.sandbox ?? "";
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("child-src 'none'");
    // Everything a site may load has to come from the bundle it arrived in.
    expect(policy).not.toMatch(/https?:/u);
  });

  it("is the only place unsafe-inline appears", () => {
    const pages = manifest.content_security_policy?.extension_pages ?? "";
    expect(pages).toContain("script-src 'self'");
    expect(pages).not.toContain("unsafe-inline");
  });
});
