import seededRandom from '../test-support/seeded-random.js';
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
  action: 'set' | 'begin' | 'end' | 'touch' | 'wait' | 'sweep';
  added?: string;
  swept: boolean;
  overCap: boolean;
}

function newRun(): Run {
  const clock = { now: 0 };
  const store = new HttpSessionStore<ReturnType<typeof fakeTransport>>(MAX, TTL, () => clock.now);
  return { clock, store, open: new Map(), lastUsed: new Map() };
}

function applyRandomAction(run: Run, random: () => number): Step {
  const roll = random();
  const id = `s${Math.floor(random() * 8)}`;
  const { clock, store, open, lastUsed } = run;
  const overCap = store.size > MAX;
  if (roll < 0.2 && !store.get(id)) {
    const full = store.size >= MAX;
    store.set(id, fakeTransport());
    open.set(id, 0);
    lastUsed.set(id, clock.now);
    return { action: 'set', added: id, swept: true, overCap: full };
  }
  let action: Step['action'] = 'wait';
  if (roll < 0.4 && store.get(id)) {
    store.beginRequest(id);
    open.set(id, (open.get(id) ?? 0) + 1);
    lastUsed.set(id, clock.now);
    action = 'begin';
  } else if (roll < 0.6) {
    store.endRequest(id);
    if (open.has(id)) open.set(id, Math.max(0, (open.get(id) ?? 0) - 1));
    action = 'end';
  } else if (roll < 0.7 && store.get(id)) {
    store.touch(id);
    lastUsed.set(id, clock.now);
    action = 'touch';
  } else if (roll < 0.85) {
    clock.now += Math.floor(random() * 800);
  } else {
    store.evict();
    return { action: 'sweep', swept: true, overCap };
  }
  return { action, swept: false, overCap };
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
    const unvisited = new Set<Step['action']>(['set', 'begin', 'end', 'touch', 'wait', 'sweep']);

    const breaches = Array.from({ length: 3_000 }).flatMap((_, at) => {
      const step = applyRandomAction(run, random);
      unvisited.delete(step.action);
      return checkInvariants(run, step, at);
    });

    expect({ breaches, unvisited: [...unvisited] }).toEqual({ breaches: [], unvisited: [] });
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
});
