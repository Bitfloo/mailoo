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
