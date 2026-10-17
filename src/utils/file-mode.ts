/**
 * Permission checks for files that hold credentials or mail metadata.
 */

export default function hasGroupOrOtherBits(mode: number | bigint): boolean {
  const bits = typeof mode === 'bigint' ? Number(mode) : mode;
  // eslint-disable-next-line no-bitwise
  return (bits & 0o077) !== 0;
}
