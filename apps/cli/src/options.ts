export function parseTtl(value: string): number {
  const match = /^(\d+)(m|h|d)$/iu.exec(value.trim());
  if (!match) throw new Error("Use a TTL such as 30m, 1h, 24h or 7d");
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
