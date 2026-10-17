import seededRandom from '../test-support/seeded-random.js';
import HttpSessionStore from './http-sessions.js';

function fakeTransport() {
  return { close: vi.fn().mockResolvedValue(undefined) };
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

  // The examples above pin one step each. Over a long random mix of new
  // sessions, requests, waits and sweeps the table must still never drop an
  // active session, never keep an expired idle one after a sweep, never stay
  // over the cap while an idle session could go, and never drop one early.
  it('should keep the table invariants over a seeded mix of sessions, requests, waits and sweeps', () => {
    let now = 0;
    const max = 3;
    const ttl = 1_000;
    const store = new HttpSessionStore(max, ttl, () => now);
    const random = seededRandom(20_261_017);
    const open = new Map<string, number>();
    const lastUsed = new Map<string, number>();
    const breaches: string[] = [];

    Array.from({ length: 3_000 }).forEach((_, step) => {
      const roll = random();
      const id = `s${Math.floor(random() * 8)}`;
      const sizeBefore = store.size;
      let added: string | undefined;
      if (roll < 0.2 && !store.get(id)) {
        store.set(id, fakeTransport());
        open.set(id, 0);
        lastUsed.set(id, now);
        added = id;
      } else if (roll < 0.4 && store.get(id)) {
        store.beginRequest(id);
        open.set(id, (open.get(id) ?? 0) + 1);
        lastUsed.set(id, now);
      } else if (roll < 0.6) {
        store.endRequest(id);
        if (open.has(id)) open.set(id, Math.max(0, (open.get(id) ?? 0) - 1));
      } else if (roll < 0.7 && store.get(id)) {
        store.touch(id);
        lastUsed.set(id, now);
      } else if (roll < 0.85) {
        now += Math.floor(random() * 800);
      } else {
        store.evict();
      }
      const swept = added !== undefined || roll >= 0.85;
      const overCap = sizeBefore + (added ? 1 : 0) > max;

      Array.from(open.keys()).forEach((sid) => {
        const idle = open.get(sid) === 0;
        const expired = now - (lastUsed.get(sid) ?? now) > ttl;
        const present = store.get(sid) !== undefined;
        if (!present && !idle) breaches.push(`step ${step}: active ${sid} evicted`);
        if (!present && idle && !expired && !overCap) breaches.push(`step ${step}: ${sid} early`);
        if (present && idle && expired && swept) breaches.push(`step ${step}: ${sid} expired`);
        if (!present) {
          open.delete(sid);
          lastUsed.delete(sid);
        }
      });
      const idleKept = Array.from(open.entries()).filter(([sid, n]) => n === 0 && sid !== added);
      if (swept && store.size > max && idleKept.length > 0) {
        breaches.push(`step ${step}: ${store.size} sessions over a cap of ${max}`);
      }
    });

    expect(breaches).toEqual([]);
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
