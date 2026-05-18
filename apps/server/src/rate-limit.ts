import type { FastifyRequest } from 'fastify';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';

interface RateLimitOptions {
  max: number;
  windowMs: number;
  label: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {}

  hit(key: string, now = Date.now()): void {
    this.pruneExpired(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + this.options.windowMs,
      });
      return;
    }

    if (bucket.count >= this.options.max) {
      throw new SlideStageError(
        ERROR_CODES.ERATELIMIT,
        `${this.options.label} rate limit exceeded; retry later`,
        429,
      );
    }
    bucket.count += 1;
  }

  private pruneExpired(now: number): void {
    if (this.buckets.size < 10_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

export function ipRateLimitKey(req: FastifyRequest): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}
