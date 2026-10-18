import seededRandom from '../test-support/seeded-random.js';
import type { SessionTransport } from './http-sessions.js';
import HttpSessionStore from './http-sessions.js';

function fakeTransport() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

const MAX = 3;
const TTL = 1_000;

/** The store under test beside a model of each live session's open requests and idle clock. */
interface Run {
  clock: { now: number };
  store: HttpSessionStore<ReturnType<typeof fakeTransport>>;
  open: Map<string, number>;
  lastUsed: Map<string, number>;
}

interface Step {
  action: 'set' | 'begin' | 'end' | 'wait' | 'sweep';
  added?: string;
  swept: boolean;
  overCap: boolean;
}

function newRun(): Run {
  const clock = { now: 0 };
  const store = new HttpSessionStore<ReturnType<typeof fakeTransport>>(MAX, TTL, () => clock.now);
  return { clock, store, open: new Map(), lastUsed: new Map() };
}

function pickAction(roll: number, present: boolean): Step['action'] {
  if (roll < 0.2 && !present) return 'set';
  if (roll < 0.4 && present) return 'begin';
  if (roll < 0.6) return 'end';
  if (roll < 0.85) return 'wait';
  return 'sweep';
}

const APPLY: Record<Step['action'], (run: Run, id: string, random: () => number) => void> = {
  set: ({ clock, store, open, lastUsed }, id) => {
    store.set(id, fakeTransport());
    open.set(id, 0);
    lastUsed.set(id, clock.now);
  },
  begin: ({ clock, store, open, lastUsed }, id) => {
    store.beginRequest(id);
    open.set(id, (open.get(id) ?? 0) + 1);
    lastUsed.set(id, clock.now);
  },
  end: ({ store, open }, id) => {
    store.endRequest(id);
    if (open.has(id)) open.set(id, Math.max(0, (open.get(id) ?? 0) - 1));
  },
  wait: (run, _id, random) => {
    const { clock } = run;
    clock.now += Math.floor(random() * 800);
  },
  sweep: ({ store }) => {
    store.evict();
  },
};

function applyRandomAction(run: Run, random: () => number): Step {
  const roll = random();
  const id = `s${Math.floor(random() * 8)}`;
  const { size } = run.store;
  const action = pickAction(roll, run.store.get(id) !== undefined);
  APPLY[action](run, id, random);
  if (action === 'set') return { action, added: id, swept: true, overCap: size >= MAX };
  return { action, swept: action === 'sweep', overCap: size > MAX };
}

/** What a session's fate after one step says about the table, if it breaks a promise. */
function sessionBreach(present: boolean, idle: boolean, expired: boolean, step: Step) {
  if (!present && !idle) return 'active, evicted';
  if (!present && !expired && !step.overCap) return 'evicted early';
  if (present && idle && expired && step.swept) return 'expired, kept';
  return undefined;
}

function checkInvariants(run: Run, step: Step, at: number): string[] {
  const { clock, store, open, lastUsed } = run;
  const breaches = Array.from(open.keys()).flatMap((id) => {
    const present = store.get(id) !== undefined;
    const expired = clock.now - (lastUsed.get(id) ?? clock.now) > TTL;
    const breach = sessionBreach(present, open.get(id) === 0, expired, step);
    if (!present) {
      open.delete(id);
      lastUsed.delete(id);
    }
    return breach ? [`step ${at}: ${id} ${breach}`] : [];
  });
  const idleKept = Array.from(open.entries()).filter(([id, n]) => n === 0 && id !== step.added);
  if (step.swept && store.size > MAX && idleKept.length > 0) {
    breaches.push(`step ${at}: ${store.size} sessions over a cap of ${MAX}`);
  }
  return breaches;
}

describe('HttpSessionStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('evicts the oldest idle session when over max', () => {
    let now = 1_000;
    const store = new HttpSessionStore(2, 60_000, () => now);
    const a = fakeTransport();
    const b = fakeTransport();
    const c = fakeTransport();
    store.set('a', a);
    now = 2_000;
    store.set('b', b);
    now = 3_000;
    store.set('c', c);
    expect(store.size).toBe(2);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('c')).toBe(c);
    expect(a.close).toHaveBeenCalled();
  });

  it('does not evict a session with an active request', () => {
    let now = 1_000;
    const store = new HttpSessionStore(1, 60_000, () => now);
    const a = fakeTransport();
    const b = fakeTransport();
    store.set('a', a);
    store.beginRequest('a');
    now = 2_000;
    store.set('b', b);
    expect(store.get('a')).toBe(a);
    expect(store.size).toBe(2);
    store.endRequest('a');
    now = 3_000;
    store.set('c', fakeTransport());
    expect(store.get('a')).toBeUndefined();
  });

  it('expires idle sessions past TTL', () => {
    let now = 0;
    const store = new HttpSessionStore(32, 1_000, () => now);
    const a = fakeTransport();
    store.set('a', a);
    now = 1_001;
    store.evict();
    expect(store.get('a')).toBeUndefined();
    expect(a.close).toHaveBeenCalled();
  });

  it('should keep a session idle for exactly the TTL and evict it one millisecond later', () => {
    let now = 0;
    const store = new HttpSessionStore(32, 1_000, () => now);
    const a = fakeTransport();
    store.set('a', a);

    now = 1_000;
    store.evict();
    const atTtl = store.get('a');
    now = 1_001;
    store.evict();

    expect({ atTtl, afterTtl: store.get('a') }).toEqual({ atTtl: a, afterTtl: undefined });
  });

  it('should hold 32 sessions by default and evict the oldest idle one for the 33rd', () => {
    vi.useFakeTimers({ now: 0 });
    const store = new HttpSessionStore<SessionTransport>();
    Array.from({ length: 33 }).forEach((_, i) => {
      store.set(`s${i}`, fakeTransport());
      vi.advanceTimersByTime(1);
    });

    expect({
      size: store.size,
      oldest: store.get('s0'),
      kept: store.get('s1') !== undefined,
    }).toEqual({ size: 32, oldest: undefined, kept: true });
  });

  it('should keep a session idle for 30 minutes by default and evict it one millisecond later', () => {
    vi.useFakeTimers({ now: 0 });
    const store = new HttpSessionStore<SessionTransport>();
    const a = fakeTransport();
    store.set('a', a);

    vi.advanceTimersByTime(30 * 60_000);
    store.evict();
    const atTtl = store.get('a');
    vi.advanceTimersByTime(1);
    store.evict();

    expect({ atTtl, afterTtl: store.get('a') }).toEqual({ atTtl: a, afterTtl: undefined });
  });

  it('should still expire a session after endRequest is called without a matching beginRequest', () => {
    let now = 0;
    const store = new HttpSessionStore(32, 1_000, () => now);
    const a = fakeTransport();
    store.set('a', a);
    store.endRequest('a');

    now = 1_001;
    store.evict();

    expect(store.get('a')).toBeUndefined();
  });

  it('should restart the idle clock when a request begins', () => {
    let now = 0;
    const store = new HttpSessionStore(32, 1_000, () => now);
    const a = fakeTransport();
    store.set('a', a);
    now = 900;
    store.beginRequest('a');
    store.endRequest('a');

    now = 1_500;
    store.evict();

    expect(store.get('a')).toBe(a);
  });

  // The examples above pin one step each; a long random mix must keep the
  // same promises.
  it('should keep the table invariants over a seeded mix of sessions, requests, waits and sweeps', () => {
    const run = newRun();
    const random = seededRandom(20_261_017);
    // One visit per path let a run reach the cap once and pass. This seed draws 51 sets
    // (47 at the cap), 1,131 begins, 637 ends, 731 waits and 450 sweeps.
    const visits = { set: 0, setAtCap: 0, begin: 0, end: 0, wait: 0, sweep: 0 };

    const breaches = Array.from({ length: 3_000 }).flatMap((_, at) => {
      const step = applyRandomAction(run, random);
      visits[step.action] += 1;
      if (step.action === 'set' && step.overCap) visits.setAtCap += 1;
      return checkInvariants(run, step, at);
    });
    const thin = Object.entries(visits).flatMap(([path, n]) => (n < 40 ? [path] : []));

    expect({ breaches, thin }).toEqual({ breaches: [], thin: [] });
  });

  it('writes stderr when transport.close rejects', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let now = 1_000;
    const store = new HttpSessionStore(1, 60_000, () => now);
    const a = { close: vi.fn().mockRejectedValue(new Error('close failed')) };
    store.set('a', a);
    now = 2_000;
    store.set('b', fakeTransport());
    await vi.waitFor(() => {
      expect(write.mock.calls.some((call) => String(call[0]).includes('close failed'))).toBe(true);
    });
    write.mockRestore();
  });

  it('should write the failure to stderr and keep evicting when transport.close throws synchronously', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let now = 0;
    const store = new HttpSessionStore<SessionTransport>(32, 1_000, () => now);
    store.set('a', {
      close: () => {
        throw new Error('boom');
      },
    });
    store.set('b', fakeTransport());

    now = 1_001;
    store.evict();

    expect({ logged: write.mock.calls.map((call) => call[0]), b: store.get('b') }).toEqual({
      logged: ['[mailoo] HTTP session close failed: boom\n'],
      b: undefined,
    });
  });
});
