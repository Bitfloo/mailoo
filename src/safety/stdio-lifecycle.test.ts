import { PassThrough } from 'node:stream';

import attachStdioShutdown from './stdio-lifecycle.js';

describe('attachStdioShutdown', () => {
  it('runs shutdown once when stdin emits end', async () => {
    const stdin = new PassThrough();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    attachStdioShutdown(stdin, shutdown);
    stdin.resume();
    stdin.end();
    await vi.waitFor(() => {
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });

  it('does not subscribe to data events', () => {
    const stdin = new PassThrough();
    attachStdioShutdown(stdin, () => {});
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(1);
    expect(stdin.listenerCount('close')).toBe(1);
  });

  it('writes to stderr and exits 1 when shutdown rejects', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stdin = new PassThrough();
    attachStdioShutdown(stdin, async () => {
      throw new Error('boom');
    });
    stdin.resume();
    stdin.end();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    expect(stderr.mock.calls.some((call) => String(call[0]).includes('boom'))).toBe(true);
    stderr.mockRestore();
    exit.mockRestore();
  });
});
