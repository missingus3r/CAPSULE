export class RelayHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "RelayHttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function badRequest(code: string, message: string): RelayHttpError {
  return new RelayHttpError(400, code, message);
}

export function unauthorized(): RelayHttpError {
  return new RelayHttpError(
    401,
    "unauthorized",
    "A valid bearer capability is required",
  );
}

export function notFound(): RelayHttpError {
  return new RelayHttpError(404, "capsule_not_found", "Capsule not found");
}

export function conflict(code: string, message: string): RelayHttpError {
  return new RelayHttpError(409, code, message);
}

export function gone(): RelayHttpError {
  return new RelayHttpError(410, "capsule_expired", "Capsule has expired");
}

export function payloadTooLarge(message: string): RelayHttpError {
  return new RelayHttpError(413, "payload_too_large", message);
}

export function storageCorrupt(
  message = "Stored capsule data is invalid",
): RelayHttpError {
  return new RelayHttpError(500, "storage_corrupt", message);
}

export function insufficientStorage(message: string): RelayHttpError {
  return new RelayHttpError(507, "insufficient_storage", message);
}
