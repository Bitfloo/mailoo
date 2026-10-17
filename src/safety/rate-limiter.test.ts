import RateLimiter from './rate-limiter.js';

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

  it('remaining() counts tokens refilled since the last consume', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');

    vi.advanceTimersByTime(30_000);

    expect(limiter.remaining('acct')).toBe(1);
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
