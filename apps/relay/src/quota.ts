import { createHash, randomBytes } from "node:crypto";

/**
 * Per-sender ceiling for storage without expiry.
 *
 * The global cap stops the disk from filling; this stops one sender from
 * taking all of it before anyone else arrives. It has to tell senders apart
 * without keeping a list of who they are, so addresses are only ever seen as a
 * salted digest, and the salt is thrown away and regenerated every window.
 * When the salt rotates the counters reset with it: the relay forgets, which
 * is the point.
 */
export class SenderQuota {
  private salt = randomBytes(16);
  private counters = new Map<string, number>();
  private windowStart = Date.now();

  constructor(
    private readonly limitBytes: number,
    private readonly windowMs: number = 24 * 60 * 60_000,
  ) {}

  private rotate(): void {
    if (Date.now() - this.windowStart < this.windowMs) return;
    this.salt = randomBytes(16);
    this.counters.clear();
    this.windowStart = Date.now();
  }

  private keyFor(address: string): string {
    return createHash("sha256")
      .update(this.salt)
      .update(address)
      .digest("base64url");
  }

  /** Records `bytes` against a sender, or refuses when it would exceed the cap. */
  reserve(address: string, bytes: number): boolean {
    if (this.limitBytes <= 0) return false;
    this.rotate();
    const key = this.keyFor(address);
    const used = this.counters.get(key) ?? 0;
    if (used + bytes > this.limitBytes) return false;
    this.counters.set(key, used + bytes);
    return true;
  }

  /** Gives back a reservation that did not become a stored capsule. */
  release(address: string, bytes: number): void {
    const key = this.keyFor(address);
    const used = this.counters.get(key);
    if (used === undefined) return;
    const remaining = used - bytes;
    if (remaining <= 0) this.counters.delete(key);
    else this.counters.set(key, remaining);
  }

  get trackedSenders(): number {
    return this.counters.size;
  }
}
