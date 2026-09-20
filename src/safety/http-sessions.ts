/**
 * Bounded Streamable HTTP session table.
 * Idle sessions expire; excess inactive sessions are evicted LRU-first.
 * Sessions with in-flight requests are never evicted.
 */

export const DEFAULT_HTTP_SESSION_TTL_MS = 30 * 60 * 1000;
// Session cap bounds the MCP HTTP table only; it is not a process-wide heap-leak fix (#55).
export const DEFAULT_HTTP_MAX_SESSIONS = 32;

export interface SessionTransport {
  close: () => Promise<void> | void;
}

interface TrackedSession<T extends SessionTransport> {
  id: string;
  transport: T;
  lastUsed: number;
  activeRequests: number;
}

export default class HttpSessionStore<T extends SessionTransport> {
  private readonly sessions = new Map<string, TrackedSession<T>>();

  constructor(
    private readonly maxSessions = DEFAULT_HTTP_MAX_SESSIONS,
    private readonly ttlMs = DEFAULT_HTTP_SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  get(id: string): T | undefined {
    return this.sessions.get(id)?.transport;
  }

  set(id: string, transport: T): void {
    this.evict();
    this.sessions.set(id, {
      id,
      transport,
      lastUsed: this.now(),
      activeRequests: 0,
    });
    this.evict(id);
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastUsed = this.now();
  }

  beginRequest(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.activeRequests += 1;
    session.lastUsed = this.now();
  }

  endRequest(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.activeRequests === 0) return;
    session.activeRequests -= 1;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  values(): T[] {
    return Array.from(this.sessions.values(), (s) => s.transport);
  }

  evict(keepId?: string): void {
    const now = this.now();
    Array.from(this.sessions.entries()).forEach(([id, session]) => {
      if (session.activeRequests === 0 && now - session.lastUsed > this.ttlMs) {
        this.closeAndDelete(id, session);
      }
    });

    while (this.sessions.size > this.maxSessions) {
      const idle = Array.from(this.sessions.values())
        .filter((s) => s.activeRequests === 0 && s.id !== keepId)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      if (idle.length === 0) break;
      this.closeAndDelete(idle[0].id, idle[0]);
    }
  }

  private closeAndDelete(id: string, session: TrackedSession<T>): void {
    this.sessions.delete(id);
    try {
      Promise.resolve(session.transport.close()).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[mailoo] HTTP session close failed: ${message}\n`);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mailoo] HTTP session close failed: ${message}\n`);
    }
  }
}
