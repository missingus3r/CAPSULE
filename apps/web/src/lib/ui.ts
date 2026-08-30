import { decodeShareCapability } from "@capsule/protocol";
import type { Locale, MessageKey } from "../i18n";

export interface DisplayMetadata {
  filename: string;
  mimeType: string;
  byteLength: number;
  createdAt?: string;
  expiresAt?: string;
  /** True when the capsule was stored without an expiry date. */
  persistent?: boolean;
  note?: string;
}

/**
 * Byte sizes and dates are formatted by the platform rather than by hand, so
 * a Portuguese reader gets a comma where they expect one.
 */
export function formatBytes(bytes: number, locale: Locale = "en"): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: value >= 10 ? 1 : 2,
  }).format(value);
  return `${formatted} ${unit}`;
}

export function formatDate(
  value?: string,
  locale: Locale = "en",
): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * A mime type reduced to something worth reading, as a message key where one
 * exists. Anything unrecognised keeps its own name: inventing a label for it
 * would say less than the type already does.
 */
export function mimeTypeKey(mimeType: string): MessageKey | undefined {
  if (!mimeType || mimeType === "application/octet-stream") {
    return "mime.generic";
  }
  const detail = mimeType.split("/")[1];
  const known: Record<string, MessageKey> = {
    pdf: "mime.pdf",
    jpeg: "mime.jpeg",
    jpg: "mime.jpeg",
    png: "mime.png",
    gif: "mime.gif",
    webp: "mime.webp",
    mp4: "mime.mp4",
    zip: "mime.zip",
    plain: "mime.plain",
  };
  return detail ? known[detail] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function sanitizeFilename(value: string, fallback = "capsule"): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 180);
  return sanitized && sanitized !== "." && sanitized !== ".."
    ? sanitized
    : fallback;
}

export function normalizeMetadata(
  metadata: unknown,
  blob?: Blob,
  fallbackName = "capsule",
): DisplayMetadata {
  const value = asRecord(metadata);
  const rawFilename =
    typeof value.filename === "string" && value.filename.trim()
      ? value.filename
      : fallbackName;
  const filename = sanitizeFilename(
    rawFilename,
    sanitizeFilename(fallbackName),
  );
  const mimeType =
    typeof value.mimeType === "string" && value.mimeType.trim()
      ? value.mimeType
      : blob?.type || "application/octet-stream";
  const byteLength =
    typeof value.byteLength === "number" && Number.isFinite(value.byteLength)
      ? value.byteLength
      : typeof value.size === "number" && Number.isFinite(value.size)
        ? value.size
        : (blob?.size ?? 0);

  return {
    filename,
    mimeType,
    byteLength,
    ...(typeof value.createdAt === "string"
      ? { createdAt: value.createdAt }
      : {}),
    ...(typeof value.expiresAt === "string"
      ? { expiresAt: value.expiresAt }
      : {}),
    ...(value.expiresAt === null ? { persistent: true } : {}),
    ...(typeof value.note === "string" && value.note.trim()
      ? { note: value.note }
      : {}),
  };
}

export function normalizeProgress(value: unknown): number {
  if (typeof value === "number") {
    const normalized = value > 1 ? value / 100 : value;
    return Math.max(0, Math.min(1, normalized));
  }

  const progress = asRecord(value);
  for (const key of ["progress", "ratio", "percent"] as const) {
    if (typeof progress[key] === "number") {
      const normalized =
        progress[key] > 1 ? progress[key] / 100 : progress[key];
      return Math.max(0, Math.min(1, normalized));
    }
  }

  if (
    typeof progress.loaded === "number" &&
    typeof progress.total === "number" &&
    progress.total > 0
  ) {
    return Math.max(0, Math.min(1, progress.loaded / progress.total));
  }

  if (
    typeof progress.completedBytes === "number" &&
    typeof progress.totalBytes === "number" &&
    progress.totalBytes > 0
  ) {
    return Math.max(
      0,
      Math.min(1, progress.completedBytes / progress.totalBytes),
    );
  }

  if (
    typeof progress.completedChunks === "number" &&
    typeof progress.totalChunks === "number" &&
    progress.totalChunks > 0
  ) {
    return Math.max(
      0,
      Math.min(1, progress.completedChunks / progress.totalChunks),
    );
  }

  if (progress.phase === "complete") return 1;

  return 0;
}

export function extractCapability(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    candidate = url.hash;
  } catch {
    // The input can also be the fragment itself.
  }

  const normalized = candidate.startsWith("#") ? candidate.slice(1) : candidate;
  if (!normalized.startsWith("capsule=")) return null;

  try {
    decodeShareCapability(normalized);
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Maps a failure onto a message key.
 *
 * The key rather than the sentence, so the caller renders it in the reader's
 * language. The matching is on the SDK's own English messages, which is why it
 * stays here and not in a dictionary.
 */
export function errorKey(
  error: unknown,
  action: "upload" | "download",
): MessageKey {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("expired") || message.includes("410")) {
    return "error.expired";
  }
  if (message.includes("not found") || message.includes("404")) {
    return "error.notFound";
  }
  if (
    message.includes("limit") ||
    message.includes("exceed") ||
    message.includes("too large") ||
    message.includes("payload") ||
    message.includes("413")
  ) {
    return "error.tooLarge";
  }
  if (
    message.includes("authentication") ||
    message.includes("decrypt") ||
    message.includes("capability") ||
    message.includes("fragment") ||
    message.includes("invalid")
  ) {
    return "error.authentication";
  }
  if (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("offline")
  ) {
    // A browser hides the difference between "the relay is down" and "the
    // relay refused this origin", so the message names both. The second is the
    // likelier one on a machine where the relay is plainly running.
    return "error.network";
  }

  return action === "upload" ? "error.uploadGeneric" : "error.downloadGeneric";
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  }
}
