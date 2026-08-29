/**
 * Re-exports for the test suite, so a test file names what it uses rather than
 * pulling the whole module surface into scope.
 */
export {
  decodeOwnerCapability,
  decodeShareCapability,
  decryptChunk,
  decryptMetadata,
  encodeOwnerCapability,
  encodeShards as encodeShardsFor,
  encodeShareCapability,
  encryptChunk,
  encryptMetadata,
  fromBase64Url,
  paddedLengthFor,
  sizeClassFor,
  toBase64Url,
  type CapsuleMetadata,
  type CapsuleProtocolVersion,
} from "../src/index.js";
