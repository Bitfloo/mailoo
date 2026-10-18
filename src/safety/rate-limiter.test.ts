import seededRandom from '../test-support/seeded-random.js';
import RateLimiter from './rate-limiter.js';

/**
 * The same token bucket in exact integers: times are kept multiplied by the
 * limit, so one token costs exactly `windowMs` units and nothing is rounded.
 */
function exactBucket(max: number, windowMs: number, start: number) {
  let tokens = max;
  let scaledLast = start * max;
  const refill = (now: number): void => {
    const earned = Math.floor((now * max - scaledLast) / windowMs);
    if (tokens + earned >= max) {
      tokens = max;
      scaledLast = now * max;
    } else if (earned > 0) {
      tokens += earned;
      scaledLast += earned * windowMs;
    }
  };
  return {
    tryConsume(now: number): boolean {
      refill(now);
      if (tokens === 0) return false;
      tokens -= 1;
      return true;
    },
    remaining(now: number): number {
      refill(now);
      return tokens;
    },
  };
}

/** Each account of each limiter, beside its exact bucket and what it was granted. */
function newLanes(limits: number[], accounts: string[], start: number) {
  return limits.flatMap((max) => {
    const limiter = new RateLimiter(max);
    return accounts.map((account) => ({
      name: `${account}@${max}`,
      max,
      account,
      limiter,
      exact: exactBucket(max, 60_000, start),
      allowed: 0,
      denied: 0,
    }));
  });
}

type Lane = ReturnType<typeof newLanes>[number];

function laneBreach(lane: Lane, start: number): string | undefined {
  const remaining = lane.limiter.remaining(lane.account);
  const exactRemaining = lane.exact.remaining(Date.now());
  const earned = lane.max + (lane.max * (Date.now() - start)) / 60_000;
  if (remaining === exactRemaining && remaining <= lane.max && lane.allowed <= earned) {
    return undefined;
  }
  return `${lane.name} remaining ${remaining} (exact ${exactRemaining}), allowed ${lane.allowed} of ${earned}`;
}

describe('RateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows sends up to the configured limit', () => {
    const limiter = new RateLimiter(3);
    expect(limiter.tryConsume('acct')).toBe(true);
    expect(limiter.tryConsume('acct')).toBe(true);
    expect(limiter.tryConsume('acct')).toBe(true);
  });

  it('rejects sends after limit is exhausted', () => {
    const limiter = new RateLimiter(3);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');
    expect(limiter.tryConsume('acct')).toBe(false);
  });

  it('tracks accounts independently', () => {
    const limiter = new RateLimiter(1);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
    expect(limiter.tryConsume('b')).toBe(true);
  });

  it('remaining() returns max for unknown accounts', () => {
    const limiter = new RateLimiter(5);
    expect(limiter.remaining('unknown')).toBe(5);
  });

  it('remaining() decreases after consumption', () => {
    const limiter = new RateLimiter(5);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');
    expect(limiter.remaining('acct')).toBe(3);
  });

  it('refills tokens after the time window elapses', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');
    expect(limiter.tryConsume('acct')).toBe(false);

    vi.advanceTimersByTime(60_000);

    expect(limiter.tryConsume('acct')).toBe(true);
  });

  // A limit of 2 per minute earns one token every 30 s. Flooring the refill
  // and restarting the clock at "now" dropped the 15 s remainder below.
  it('should keep the partial refill interval when a token is earned mid-interval', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');

    vi.advanceTimersByTime(45_000);
    expect(limiter.tryConsume('acct')).toBe(true);
    vi.advanceTimersByTime(15_000);

    expect(limiter.tryConsume('acct')).toBe(true);
  });

  it('should not count elapsed time twice when tokens are earned in steps', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');

    vi.advanceTimersByTime(30_000);
    limiter.tryConsume('acct');
    vi.advanceTimersByTime(30_000);
    limiter.tryConsume('acct');

    expect(limiter.tryConsume('acct')).toBe(false);
  });

  // A limit of 10 per minute earns one token every 6 s, so 18 s earns 3.
  it('should credit every token earned in one gap when the bucket does not fill', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(10);
    Array.from({ length: 10 }, () => limiter.tryConsume('acct'));

    vi.advanceTimersByTime(18_000);
    const remaining = limiter.remaining('acct');
    const results = Array.from({ length: 4 }, () => limiter.tryConsume('acct'));

    expect({ remaining, results }).toEqual({ remaining: 3, results: [true, true, true, false] });
  });

  it('should allow at most the limit in a burst after a long idle period', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(3);
    limiter.tryConsume('acct');

    vi.advanceTimersByTime(10 * 60_000);
    const results = Array.from({ length: 5 }, () => limiter.tryConsume('acct'));

    expect(results).toEqual([true, true, true, false, false]);
  });

  it('should not bank refill time while the bucket is full', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2);
    limiter.tryConsume('acct');
    vi.advanceTimersByTime(45_000);
    limiter.tryConsume('acct');

    vi.advanceTimersByTime(15_000);
    const results = [limiter.tryConsume('acct'), limiter.tryConsume('acct')];

    expect(results).toEqual([true, false]);
  });

  it('should not refill a token one millisecond before the window and should refill it at the window', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(1);
    limiter.tryConsume('acct');

    vi.advanceTimersByTime(59_999);
    const early = limiter.tryConsume('acct');
    vi.advanceTimersByTime(1);

    expect([early, limiter.tryConsume('acct')]).toEqual([false, true]);
  });

  it('remaining() counts tokens refilled since the last consume', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');

    vi.advanceTimersByTime(30_000);

    expect(limiter.remaining('acct')).toBe(1);
  });

  // The examples above each pin one gap; a long random mix of waits and sends must
  // keep the same bucket.
  it('should match an exact token bucket and stay within the limit over a seeded mix of waits and sends', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const random = seededRandom(20_261_017);
    // One account at one limit could not show a bucket leaking into another, and one
    // visit per outcome passed. This seed waits 2,011 times and allows/denies a@1 31/315,
    // b@1 31/314, a@4 138/177, b@4 137/204, a@7 232/101 and b@7 239/70.
    const lanes = newLanes([1, 4, 7], ['a', 'b'], start);
    const breaches: string[] = [];

    for (let step = 0; step < 4_000; step += 1) {
      if (random() < 0.5) {
        vi.advanceTimersByTime(Math.floor(random() * 2_000));
      } else {
        const lane = lanes[Math.floor(random() * lanes.length)];
        const decision = lane.limiter.tryConsume(lane.account);
        if (decision !== lane.exact.tryConsume(Date.now())) {
          breaches.push(`step ${step}: ${lane.name} allowed ${String(decision)}, exact disagrees`);
        }
        lane[decision ? 'allowed' : 'denied'] += 1;
      }
      for (const lane of lanes) {
        const breach = laneBreach(lane, start);
        if (breach) breaches.push(`step ${step}: ${breach}`);
      }
    }
    const thin = lanes.flatMap((l) => (Math.min(l.allowed, l.denied) < 20 ? [l.name] : []));

    expect({ breaches, thin }).toEqual({ breaches: [], thin: [] });
  });

  it('uses default limit of 10 when no argument provided', () => {
    const limiter = new RateLimiter();
    expect(limiter.remaining('any')).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume('any')).toBe(true);
    }
    expect(limiter.tryConsume('any')).toBe(false);
  });
});
