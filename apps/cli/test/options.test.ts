import { describe, expect, it } from "vitest";
import { humanBytes, parseTtl } from "../src/options.js";

describe("CLI options", () => {
  it("parses human TTL values", () => {
    expect(parseTtl("30m")).toBe(1800);
    expect(parseTtl("24h")).toBe(86_400);
    expect(parseTtl("7d")).toBe(604_800);
  });

  it("rejects ambiguous TTL values", () => {
    expect(() => parseTtl("24")).toThrow("Use a TTL");
    expect(() => parseTtl("0h")).toThrow("greater than zero");
  });

  it("formats byte counts", () => {
    expect(humanBytes(1024)).toBe("1.0 KiB");
    expect(humanBytes(1024 ** 2)).toBe("1.0 MiB");
  });
});
