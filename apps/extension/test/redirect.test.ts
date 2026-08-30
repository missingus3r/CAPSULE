import { describe, expect, it } from "vitest";
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

  it("leaves every other address alone", () => {
    for (const url of [
      "http://example.com/",
      "https://capsule.org/",
      "http://short.capsule/",
      `http://${NAME}.evil.com/`,
      `http://evil.com/?u=${NAME}/`,
      // One character too many, and one too few.
      `http://${"a".repeat(57)}.capsule/`,
      `http://${"a".repeat(55)}.capsule/`,
      // Base32 has no 0, 1, 8 or 9.
      `http://${"0".repeat(56)}.capsule/`,
      "ftp://" + NAME + "/",
    ]) {
      expect(filter.test(url), url).toBe(false);
    }
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
