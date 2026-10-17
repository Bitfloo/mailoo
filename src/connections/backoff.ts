/**
 * Reconnect delays shared by the connection manager and the IDLE watcher: 1 s doubling to
 * 60 s, each shortened by up to a quarter so clients that dropped together do not all
 * reconnect in the same instant.
 */

export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;
const JITTER_RATIO = 0.25;

export function nextBackoff(delayMs: number): number {
  return Math.min(delayMs * 2, MAX_BACKOFF_MS);
}

export function withJitter(delayMs: number): number {
  return delayMs - Math.floor(Math.random() * delayMs * JITTER_RATIO);
}

interface FailureState {
  delayMs: number;
  retryAt: number;
  error: Error;
}

/**
 * Refuses a new connect for a protocol and account until the window opened by its last
 * failure has passed, so a broken account is not hammered on every tool call.
 */
export class ConnectBackoff {
  private failures = new Map<string, FailureState>();

  assertReady(protocol: string, accountName: string): void {
    const failure = this.failures.get(`${protocol}:${accountName}`);
    if (!failure) return;
    const waitMs = failure.retryAt - Date.now();
    if (waitMs <= 0) return;
    throw new Error(
      `Last ${protocol} connect for "${accountName}" failed: ${failure.error.message} (next attempt in ${Math.ceil(waitMs / 1000)}s)`,
    );
  }

  recordFailure(protocol: string, accountName: string, error: Error): void {
    const key = `${protocol}:${accountName}`;
    const previous = this.failures.get(key);
    const delayMs = previous ? nextBackoff(previous.delayMs) : INITIAL_BACKOFF_MS;
    this.failures.set(key, { delayMs, retryAt: Date.now() + withJitter(delayMs), error });
  }

  recordSuccess(protocol: string, accountName: string): void {
    this.failures.delete(`${protocol}:${accountName}`);
  }
}
