/**
 * Runs a test body on a pretended platform. Services read `process.platform` when they
 * are built, so build the service inside `fn`.
 */

/** Runs `fn` with the service believing it is on macOS, where osascript is used. */
export default async function onDarwin<T>(fn: () => Promise<T>): Promise<T> {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  try {
    return await fn();
  } finally {
    platform.mockRestore();
  }
}
