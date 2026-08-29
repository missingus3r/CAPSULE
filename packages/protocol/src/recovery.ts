import {
  asArrayBuffer,
  fromBase64Url,
  getCrypto,
  randomBytes,
  toBase64Url,
} from "./bytes.js";

/**
 * Passphrase-protected recovery blobs.
 *
 * A capsule without expiry can only be withdrawn with its owner capability, so
 * losing that string loses control of the capsule for good. This wraps a
 * capability under a passphrase so it can be written down, mailed to oneself
 * or stored in a password manager without handing anyone the capability
 * itself.
 *
 * Recovery is always an extra path to the secret. It is opt-in, it never
 * involves the relay, and the relay operator gains nothing from it.
 *
 * The key derivation is PBKDF2-HMAC-SHA-256, chosen because it is the only
 * password KDF available in Web Crypto everywhere CAPSULE runs. It is weaker
 * than Argon2id against an attacker with GPUs: a short passphrase is a short
 * passphrase. The format carries a KDF identifier so a memory-hard function
 * can be added later without breaking existing blobs.
 */

export const RECOVERY_PREFIX = "capsule-recovery:";
export const RECOVERY_FORMAT_VERSION = 1;
/** OWASP's 2023 floor for PBKDF2-HMAC-SHA-256. */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MINIMUM_PBKDF2_ITERATIONS = 100_000;
const MAXIMUM_PBKDF2_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;

export type RecoveryKdf = "pbkdf2-sha256";

export interface RecoveryBlob {
  version: typeof RECOVERY_FORMAT_VERSION;
  kdf: RecoveryKdf;
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
  /** Free-form label so a person can tell two blobs apart. Not secret. */
  label?: string;
}

function additionalData(blob: Omit<RecoveryBlob, "ciphertext">): Uint8Array {
  // Binding the parameters means an attacker cannot quietly downgrade the
  // iteration count of a stored blob and have it still decrypt.
  return new TextEncoder().encode(
    `CAPSULE/recovery/v${blob.version}/${blob.kdf}/${blob.iterations}/${blob.salt}`,
  );
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const crypto = getCrypto();
  const material = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(new TextEncoder().encode(passphrase.normalize("NFKC"))),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: asArrayBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface WrapRecoveryOptions {
  iterations?: number;
  label?: string;
}

/** Wraps a secret string under a passphrase. */
export async function wrapWithPassphrase(
  secret: string,
  passphrase: string,
  options: WrapRecoveryOptions = {},
): Promise<string> {
  if (!secret) throw new Error("There is nothing to protect");
  if (passphrase.trim().length < 8) {
    throw new Error("Use a passphrase of at least 8 characters");
  }
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < MINIMUM_PBKDF2_ITERATIONS ||
    iterations > MAXIMUM_PBKDF2_ITERATIONS
  ) {
    throw new Error(
      `The iteration count must be between ${MINIMUM_PBKDF2_ITERATIONS} and ${MAXIMUM_PBKDF2_ITERATIONS}`,
    );
  }

  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header: Omit<RecoveryBlob, "ciphertext"> = {
    version: RECOVERY_FORMAT_VERSION,
    kdf: "pbkdf2-sha256" as const,
    iterations,
    salt: toBase64Url(salt),
    nonce: toBase64Url(nonce),
    ...(options.label ? { label: options.label.slice(0, 64) } : {}),
  };

  const key = await deriveKey(passphrase, salt, iterations);
  const ciphertext = await getCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(nonce),
      additionalData: asArrayBuffer(additionalData(header)),
      tagLength: 128,
    },
    key,
    asArrayBuffer(new TextEncoder().encode(secret)),
  );

  const blob: RecoveryBlob = {
    ...header,
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
  return `${RECOVERY_PREFIX}${toBase64Url(
    new TextEncoder().encode(JSON.stringify(blob)),
  )}`;
}

export function decodeRecoveryBlob(value: string): RecoveryBlob {
  const trimmed = value.trim();
  if (!trimmed.startsWith(RECOVERY_PREFIX)) {
    throw new Error("Not a CAPSULE recovery blob");
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(
      fromBase64Url(trimmed.slice(RECOVERY_PREFIX.length)),
    ),
  );
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid CAPSULE recovery blob");
  }
  const blob = parsed as Partial<RecoveryBlob>;
  if (
    blob.version !== RECOVERY_FORMAT_VERSION ||
    blob.kdf !== "pbkdf2-sha256" ||
    typeof blob.iterations !== "number" ||
    !Number.isSafeInteger(blob.iterations) ||
    blob.iterations < MINIMUM_PBKDF2_ITERATIONS ||
    blob.iterations > MAXIMUM_PBKDF2_ITERATIONS ||
    typeof blob.salt !== "string" ||
    fromBase64Url(blob.salt).byteLength !== SALT_BYTES ||
    typeof blob.nonce !== "string" ||
    fromBase64Url(blob.nonce).byteLength !== NONCE_BYTES ||
    typeof blob.ciphertext !== "string" ||
    fromBase64Url(blob.ciphertext).byteLength <= 16 ||
    (blob.label !== undefined &&
      (typeof blob.label !== "string" || blob.label.length > 64))
  ) {
    throw new Error("Invalid CAPSULE recovery blob");
  }
  return blob as RecoveryBlob;
}

/** Unwraps a recovery blob. A wrong passphrase fails; it never half-succeeds. */
export async function unwrapWithPassphrase(
  value: string,
  passphrase: string,
): Promise<string> {
  const blob = decodeRecoveryBlob(value);
  const { ciphertext, ...header } = blob;
  const key = await deriveKey(
    passphrase,
    fromBase64Url(blob.salt),
    blob.iterations,
  );
  try {
    const plaintext = await getCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(fromBase64Url(blob.nonce)),
        additionalData: asArrayBuffer(additionalData(header)),
        tagLength: 128,
      },
      key,
      asArrayBuffer(fromBase64Url(ciphertext)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("The passphrase does not open this recovery blob");
  }
}
