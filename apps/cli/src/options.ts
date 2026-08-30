import { defaultSeedOrigins } from "@capsule/protocol";

const PERSISTENT_ALIASES = new Set([
  "never",
  "persist",
  "persistent",
  "forever",
  "siempre",
  "sin-vencimiento",
]);

/**
 * Parses a TTL such as `30m`, `24h` or `7d`. `never` returns `null`, which
 * asks the relay for a capsule without expiry; relays only accept that when
 * their operator has enabled it.
 */
export function parseTtl(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (PERSISTENT_ALIASES.has(normalized)) return null;

  const match = /^(\d+)(m|h|d)$/iu.exec(normalized);
  if (!match) throw new Error("Use a TTL such as 30m, 1h, 24h, 7d or never");
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("TTL must be greater than zero");
  const multiplier = unit === "m" ? 60 : unit === "h" ? 3600 : 86_400;
  return amount * multiplier;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * The relay a command talks to when nobody said which.
 *
 * `CAPSULE_RELAY_URL` first, because somebody who set it meant it. Then the
 * seed that ships, so a fresh install reaches the network without also running
 * a relay. Then this machine, for somebody who is running one.
 */
export function defaultRelayUrl(): string {
  const configured = process.env.CAPSULE_RELAY_URL?.trim();
  if (configured) return configured;
  return defaultSeedOrigins()[0] ?? "http://localhost:8787";
}
