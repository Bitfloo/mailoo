/**
 * A claim renewal calls fs.utimes from a timer and does not await it. The body
 * gets a function that waits for every utimes started so far, so a test reads
 * an mtime after the renewals its fake clock fired, not while one is in flight.
 */

import fs from 'node:fs/promises';

export default async function withTrackedUtimes(
  body: (settled: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const touches: Promise<unknown>[] = [];
  const original = fs.utimes.bind(fs);
  const spy = vi.spyOn(fs, 'utimes').mockImplementation(async (file, atime, mtime) => {
    const touch = original(file, atime, mtime);
    touches.push(touch.catch(() => undefined));
    return touch;
  });
  try {
    await body(async () => {
      await Promise.all(touches);
    });
  } finally {
    spy.mockRestore();
  }
}
