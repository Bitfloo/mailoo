/**
 * Token-bucket rate limiter.
 *
 * Limits the number of send operations per account within a time window.
 * Defaults to 10 sends per 60-second window.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export default class RateLimiter {
  private buckets = new Map<string, Bucket>();

  private readonly maxTokens: number;

  private readonly windowMs: number;

  constructor(maxPerMinute = 10) {
    this.maxTokens = maxPerMinute;
    this.windowMs = 60_000;
  }

  /**
   * Try to consume a token for the given account.
   * @returns `true` if allowed, `false` if rate-limited.
   */
  tryConsume(accountName: string): boolean {
    const bucket = this.refill(accountName, Date.now());

    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Get remaining tokens for an account.
   */
  remaining(accountName: string): number {
    if (!this.buckets.has(accountName)) return this.maxTokens;
    return this.refill(accountName, Date.now()).tokens;
  }

  /**
   * Credit whole tokens earned since `lastRefill`. The clock advances only by
   * the time those tokens cost, so a partial interval carries over; a full
   * bucket earns nothing, so its clock restarts at `now`.
   */
  private refill(accountName: string, now: number): Bucket {
    const bucket = this.buckets.get(accountName) ?? { tokens: this.maxTokens, lastRefill: now };
    const earned = Math.floor(((now - bucket.lastRefill) * this.maxTokens) / this.windowMs);
    let next = bucket;
    if (bucket.tokens + earned >= this.maxTokens) {
      next = { tokens: this.maxTokens, lastRefill: now };
    } else if (earned > 0) {
      next = {
        tokens: bucket.tokens + earned,
        lastRefill: bucket.lastRefill + (earned * this.windowMs) / this.maxTokens,
      };
    }
    this.buckets.set(accountName, next);
    return next;
  }
}
