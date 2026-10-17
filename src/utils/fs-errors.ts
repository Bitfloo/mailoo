/**
 * Callers treat only a missing path as absent and pass on every other error,
 * such as EACCES, so a file they cannot read is never mistaken for none.
 */

export default function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
