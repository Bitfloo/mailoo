/**
 * MCP stdio contract: the server must shut down when the client closes stdin.
 * Do not attach a 'data' listener — that would steal protocol bytes from the SDK.
 */

export default function attachStdioShutdown(
  stdin: NodeJS.ReadableStream,
  shutdown: () => void | Promise<void>,
): () => void {
  let called = false;
  const run = (): void => {
    if (called) return;
    called = true;
    Promise.resolve(shutdown()).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mailoo] shutdown failed: ${message}\n`);
      process.exit(1); // eslint-disable-line n/no-process-exit -- stdin closed; a failed shutdown must not hang
    });
  };
  stdin.on('end', run);
  stdin.on('close', run);
  return run;
}
