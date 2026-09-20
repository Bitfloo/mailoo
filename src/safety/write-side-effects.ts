/**
 * Gate for mailbox-writing background services.
 * Extracted from main.ts so `canWrite === false` is unit-testable
 * (main itself is coverage-excluded).
 */

export interface MailboxWriterStarts {
  startHooks?: () => void;
  startWatcher?: () => Promise<void>;
  startScheduler?: () => Promise<void> | void;
}

/** Starts hooks/watcher/scheduler only when writes are allowed. Returns whether they ran. */
export async function maybeStartMailboxWriters(
  canWrite: boolean,
  starts: MailboxWriterStarts,
): Promise<boolean> {
  if (!canWrite) return false;
  starts.startHooks?.();
  if (starts.startWatcher) await starts.startWatcher();
  if (starts.startScheduler) await starts.startScheduler();
  return true;
}
