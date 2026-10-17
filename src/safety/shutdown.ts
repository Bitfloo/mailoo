/**
 * Process shutdown with a deadline. One dead socket can keep an IMAP logout or
 * a server close waiting forever, and a process that never exits keeps its
 * connections and its file claims alive.
 */

export const SHUTDOWN_DEADLINE_MS = 10_000;

export type ShutdownStep = [name: string, run: () => Promise<void> | void];

export interface ShutdownOptions {
  exit: (code: number) => void;
  report: (message: string) => void;
  deadlineMs?: number;
}

/** Runs the steps in order once, however often it is called, then exits. */
export default function createShutdown(
  steps: ShutdownStep[],
  options: ShutdownOptions,
): () => Promise<void> {
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let running: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    let current = '';
    let failed = false;
    const sequence = (async () => {
      // eslint-disable-next-line no-restricted-syntax
      for (const [name, step] of steps) {
        current = name;
        try {
          await step(); // eslint-disable-line no-await-in-loop -- each step needs the one before it closed
        } catch (err) {
          failed = true;
          options.report(
            `shutdown: ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return 'done' as const;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => {
        resolve('deadline');
      }, deadlineMs);
    });
    const outcome = await Promise.race([sequence, deadline]);
    clearTimeout(timer);
    if (outcome === 'deadline') {
      options.report(`shutdown: ${current} did not finish within ${deadlineMs / 1000} s; exiting`);
      options.exit(1);
      return;
    }
    options.exit(failed ? 1 : 0);
  };

  return async () => {
    running ??= run();
    return running;
  };
}
