/** Byte, base64url and Web Crypto helpers shared by every protocol module. */

export function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required by the CAPSULE protocol");
  }
  return globalThis.crypto;
}

export function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url value");
  }

  if (typeof Buffer !== "undefined") {
    const decoded = new Uint8Array(Buffer.from(value, "base64url"));
    if (toBase64Url(decoded) !== value)
      throw new Error("Invalid base64url value");
    return decoded;
  }

  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const decoded = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (toBase64Url(decoded) !== value)
    throw new Error("Invalid base64url value");
  return decoded;
}

export function randomBase64Url(byteLength = 32): string {
  return toBase64Url(randomBytes(byteLength));
}

/** Compares two byte strings without leaking their contents through timing. */
export function timingSafeEquals(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}
