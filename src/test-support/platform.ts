/**
 * Runs `fn` with the service believing it is on macOS, where osascript is used. Services
 * read `process.platform` when they are built, so build the service inside `fn`.
 */
export default async function onDarwin<T>(fn: () => Promise<T>): Promise<T> {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  try {
    return await fn();
  } finally {
    platform.mockRestore();
  }
}
