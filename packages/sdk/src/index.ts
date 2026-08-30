import { fromBase64Url } from "@capsule/protocol";

export * from "./anonymize.js";
export * from "./bridge.js";
export * from "./client.js";
export * from "./network.js";
export * from "./offline.js";
export * from "./site.js";
export * from "./transfer.js";

export function isEncodedManifestWithinLimit(
  encoded: string,
  maxBytes: number,
): boolean {
  return fromBase64Url(encoded).byteLength <= maxBytes;
}
