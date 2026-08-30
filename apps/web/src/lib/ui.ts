import { decodeShareCapability } from "@capsule/protocol";

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

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Tamaño desconocido";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  const digits = value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$/u, "")} ${unit}`;
}

export function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("es-UY", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatMimeType(mimeType: string): string {
  if (!mimeType || mimeType === "application/octet-stream") return "Archivo";
  const [family, detail] = mimeType.split("/");
  if (!detail) return mimeType;
  const friendly: Record<string, string> = {
    pdf: "Documento PDF",
    jpeg: "Imagen JPEG",
    jpg: "Imagen JPG",
    png: "Imagen PNG",
    webp: "Imagen WebP",
    mp4: "Video MP4",
    mpeg: "Audio MPEG",
    zip: "Archivo ZIP",
    plain: "Texto",
  };
  return friendly[detail] ?? `${family} · ${detail.toUpperCase()}`;
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

export function friendlyError(
  error: unknown,
  action: "upload" | "download",
): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("expired") || message.includes("410")) {
    return "Esta cápsula ya venció y dejó de estar disponible.";
  }
  if (message.includes("not found") || message.includes("404")) {
    return "No encontramos esta cápsula. Puede haber vencido o haber sido retirada.";
  }
  if (
    message.includes("limit") ||
    message.includes("exceed") ||
    message.includes("too large") ||
    message.includes("payload") ||
    message.includes("413")
  ) {
    return "El archivo o el vencimiento supera el límite de este relay.";
  }
  if (
    message.includes("authentication") ||
    message.includes("decrypt") ||
    message.includes("capability") ||
    message.includes("fragment") ||
    message.includes("invalid")
  ) {
    return "El enlace está incompleto o el archivo no pudo verificarse. Pedí un enlace nuevo.";
  }
  if (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("offline")
  ) {
    // A browser hides the difference between "the relay is down" and "the relay
    // refused this origin", so the message has to name both. The second is the
    // likelier one on a machine where the relay is clearly running.
    return "No pudimos conectar con el relay. Si está corriendo, suele ser que no acepta el origen desde el que abriste esta página: probá con la misma dirección que anuncia (localhost y 127.0.0.1 son orígenes distintos), o poné CAPSULE_CORS_ORIGIN en el relay.";
  }

  return action === "upload"
    ? "No pudimos preparar la cápsula. El archivo sigue en tu dispositivo; podés intentar otra vez."
    : "No pudimos abrir la cápsula. Probá nuevamente o pedí un enlace nuevo.";
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
