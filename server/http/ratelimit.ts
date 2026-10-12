import { HttpError } from './router.ts';

/**
 * In-memory token-bucket rate limiter. Suitable for a single instance; for a
 * multi-instance deployment back this with Redis (see docs/DEPLOYMENT.md).
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(public readonly capacity: number, public readonly perSeconds: number) {
    const t = setInterval(() => this.sweep(), 60_000);
    t.unref();
  }
  /** Returns seconds to wait if limited, or 0 when allowed. */
  take(key: string, cost = 1): number {
    const now = Date.now();
    const rate = this.capacity / (this.perSeconds * 1000);
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.updated) * rate);
    b.updated = now;
    if (b.tokens < cost) {
      this.buckets.set(key, b);
      return Math.ceil((cost - b.tokens) / rate / 1000);
    }
    b.tokens -= cost;
    this.buckets.set(key, b);
    return 0;
  }
  check(key: string, cost = 1) {
    if (process.env.DISABLE_RATE_LIMITS === '1') return;
    const wait = this.take(key, cost);
    if (wait > 0) throw new HttpError(429, 'rate_limited', `You're doing that too fast. Try again in ${wait}s.`, { retryAfter: wait });
  }
  reset() { this.buckets.clear(); }
  private sweep() {
    const cutoff = Date.now() - this.perSeconds * 2000;
    for (const [k, b] of this.buckets) if (b.updated < cutoff) this.buckets.delete(k);
  }
}

export const limits = {
  global: new RateLimiter(300, 60),         // per IP: 300 req / minute
  auth: new RateLimiter(10, 60),            // per IP: login/register attempts
  authEmail: new RateLimiter(5, 300),       // per email: verification/reset mails
  messages: new RateLimiter(10, 8),         // per user: ~5 messages / 4s burst
  uploads: new RateLimiter(20, 60),
  writes: new RateLimiter(60, 60),          // per user: other mutations
  typing: new RateLimiter(10, 10),
  search: new RateLimiter(30, 60),
};
