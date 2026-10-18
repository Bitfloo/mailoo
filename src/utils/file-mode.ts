/**
 * Permission checks for files that hold credentials or mail metadata.
 */

export default function hasGroupOrOtherBits(mode: number): boolean {
  // eslint-disable-next-line no-bitwise
  return (mode & 0o077) !== 0;
}
