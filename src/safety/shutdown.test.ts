import type { ShutdownStep } from './shutdown.js';
import createShutdown, { SHUTDOWN_DEADLINE_MS } from './shutdown.js';

function harness(steps: ShutdownStep[]) {
  const exits: number[] = [];
  const reports: string[] = [];
  const shutdown = createShutdown(steps, {
    exit: (code) => {
      exits.push(code);
    },
    report: (message) => {
      reports.push(message);
    },
  });
  return { shutdown, exits, reports };
}

/** An IMAP logout on a socket the server stopped answering. */
const neverSettles = async () => new Promise<void>(() => {});

describe('createShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should exit with 1 at the deadline when a step never settles', async () => {
    const { shutdown, exits } = harness([['watcher', neverSettles]]);
    shutdown().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    expect(exits).toEqual([1]);
  });

  it('should not exit before the deadline while a step is still running', async () => {
    const { shutdown, exits } = harness([['watcher', neverSettles]]);
    shutdown().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(exits).toEqual([]);
  });

  it('should name the step that was still running at the deadline', async () => {
    const { shutdown, reports } = harness([
      ['hooks', () => undefined],
      ['watcher', neverSettles],
    ]);
    shutdown().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    expect(reports).toEqual(['shutdown: watcher did not finish within 10 s; exiting']);
  });

  it('should run the remaining steps after one throws and exit with 1', async () => {
    const ran: string[] = [];
    const { shutdown, exits, reports } = harness([
      [
        'watcher',
        () => {
          throw new Error('socket hang up');
        },
      ],
      [
        'connections',
        () => {
          ran.push('connections');
        },
      ],
    ]);
    await shutdown();
    expect({ ran, exits, reports }).toEqual({
      ran: ['connections'],
      exits: [1],
      reports: ['shutdown: watcher failed: socket hang up'],
    });
  });

  it('should exit with 0 once every step has finished', async () => {
    const { shutdown, exits } = harness([
      ['hooks', () => undefined],
      ['connections', async () => undefined],
    ]);
    await shutdown();
    expect(exits).toEqual([0]);
  });

  it('should run the steps once when shutdown is requested twice', async () => {
    let runs = 0;
    const { shutdown, exits } = harness([
      [
        'connections',
        () => {
          runs += 1;
        },
      ],
    ]);
    await Promise.all([shutdown(), shutdown()]);
    expect({ runs, exits }).toEqual({ runs: 1, exits: [0] });
  });
});
