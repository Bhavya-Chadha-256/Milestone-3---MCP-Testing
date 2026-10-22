export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Sliding-window log limiter: at most `limit` events in any `windowMs` period, per server instance. */
export class SlidingWindowRateLimiter {
  private events: number[] = [];

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an event if allowed. */
  tryAcquire(): RateDecision {
    const t = this.now();
    this.prune(t);
    if (this.events.length >= this.limit) {
      const oldest = this.events[0] ?? t;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - t) / 1000)) };
    }
    this.events.push(t);
    return { allowed: true };
  }

  private prune(t: number) {
    const cutoff = t - this.windowMs;
    while (this.events.length > 0 && (this.events[0] ?? 0) <= cutoff) this.events.shift();
  }
}
