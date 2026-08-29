import { describe, expect, it } from "vitest";
import { encodeShareCapability } from "@capsule/protocol";
import {
  extractCapability,
  formatBytes,
  normalizeProgress,
  sanitizeFilename,
} from "./ui";

describe("CAPSULE UI helpers", () => {
  it("extracts and validates a capability from a complete share URL", () => {
    const fragment = encodeShareCapability({
      version: 1,
      relayUrl: "https://relay.example",
      capsuleId: "a".repeat(32),
      readToken: "b".repeat(43),
      key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      noncePrefix: "AAAAAAAAAAA",
    });
    expect(extractCapability(`https://capsule.example/#${fragment}`)).toBe(
      fragment,
    );
  });

  it("rejects incomplete or unrelated links", () => {
    expect(extractCapability("https://capsule.example/")).toBeNull();
    expect(extractCapability("#capsule=broken")).toBeNull();
  });

  it("formats useful byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });

  it("accepts numeric and structured progress callbacks", () => {
    expect(normalizeProgress(50)).toBe(0.5);
    expect(normalizeProgress({ loaded: 25, total: 100 })).toBe(0.25);
    expect(
      normalizeProgress({
        phase: "uploading",
        completedBytes: 75,
        totalBytes: 100,
      }),
    ).toBe(0.75);
    expect(
      normalizeProgress({
        phase: "downloading",
        completedChunks: 3,
        totalChunks: 4,
      }),
    ).toBe(0.75);
    expect(normalizeProgress({ ratio: 2 })).toBe(0.02);
  });

  it("sanitizes untrusted filenames before saving", () => {
    expect(sanitizeFilename("../../factura?.pdf")).toBe(".._.._factura_.pdf");
    expect(sanitizeFilename("..", "archivo")).toBe("archivo");
  });
});
