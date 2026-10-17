import {
  ConnectBackoff,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  nextBackoff,
  withJitter,
} from './backoff.js';

describe('nextBackoff', () => {
  it('should double the delay', () => {
    expect(nextBackoff(INITIAL_BACKOFF_MS)).toBe(2_000);
  });

  it('should cap a doubling that would pass 60 s', () => {
    expect(nextBackoff(40_000)).toBe(60_000);
  });

  it('should stay at 60 s once the cap is reached', () => {
    expect(nextBackoff(60_000)).toBe(60_000);
  });
});

describe('withJitter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return the full delay when the random draw is 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(withJitter(4_000)).toBe(4_000);
  });

  it('should shorten the delay by at most a quarter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999_999);
    expect(withJitter(4_000)).toBe(3_001);
  });
});

describe('ConnectBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should allow the first attempt', () => {
    const backoff = new ConnectBackoff();
    expect(() => backoff.assertReady('IMAP', 'work')).not.toThrow();
  });

  it('should refuse an attempt inside the window and name the last error', () => {
    const backoff = new ConnectBackoff();
    backoff.recordFailure('IMAP', 'work', new Error('Invalid credentials'));
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS - 1);
    expect(() => backoff.assertReady('IMAP', 'work')).toThrow(
      'Last IMAP connect for "work" failed: Invalid credentials (next attempt in 1s)',
    );
  });

  it('should allow an attempt once the window has passed', () => {
    const backoff = new ConnectBackoff();
    backoff.recordFailure('IMAP', 'work', new Error('Invalid credentials'));
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(() => backoff.assertReady('IMAP', 'work')).not.toThrow();
  });

  it('should open the window up to a quarter early', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999_999);
    const backoff = new ConnectBackoff();
    backoff.recordFailure('IMAP', 'work', new Error('timeout'));
    vi.advanceTimersByTime(751);
    expect(() => backoff.assertReady('IMAP', 'work')).not.toThrow();
  });

  it('should double the window after a second consecutive failure', () => {
    const backoff = new ConnectBackoff();
    backoff.recordFailure('IMAP', 'work', new Error('timeout'));
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    backoff.recordFailure('IMAP', 'work', new Error('timeout'));
    vi.advanceTimersByTime(2_000 - 1);
    expect(() => backoff.assertReady('IMAP', 'work')).toThrow(/next attempt in 1s/);
    vi.advanceTimersByTime(1);
    expect(() => backoff.assertReady('IMAP', 'work')).not.toThrow();
  });

  it('should keep the window at 60 s after many failures', () => {
    const backoff = new ConnectBackoff();
    for (let i = 0; i < 12; i++) {
      backoff.recordFailure('IMAP', 'work', new Error('timeout'));
    }
    vi.advanceTimersByTime(MAX_BACKOFF_MS - 1);
    expect(() => backoff.assertReady('IMAP', 'work')).toThrow();
    vi.advanceTimersByTime(1);
    expect(() => backoff.assertReady('IMAP', 'work')).not.toThrow();
  });

  it('should start over at 1 s after a success', () => {
    const backoff = new ConnectBackoff();
    backoff.recordFailure('IMAP', 'work', new Error('timeout'));
    backoff.recordFailure('IMAP', 'work', new Error('timeout'));
    backoff.recordSuccess('IMAP', 'work');
    backoff.recordFailure('IMAP', 'work', new Error('timeout'));
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(() => backoff.assertReady('IMAP', 'work')).not.toThrow();
  });

  it('should keep separate windows per protocol and account', () => {
    const backoff = new ConnectBackoff();
    backoff.recordFailure('IMAP', 'work', new Error('timeout'));
    expect(() => backoff.assertReady('SMTP', 'work')).not.toThrow();
    expect(() => backoff.assertReady('IMAP', 'personal')).not.toThrow();
  });
});
