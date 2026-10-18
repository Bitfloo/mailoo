/**
 * A full disk accepts a few bytes of a write and then fails with ENOSPC. Both
 * fs.writeFile and FileHandle.writeFile are covered, so a suite does not depend
 * on which of the two the code under test uses.
 */

import type { FileHandle } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';

function enospc(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

export default async function withFullDisk(
  matches: (data: string) => boolean,
  body: () => Promise<void>,
): Promise<void> {
  let filled = false;
  const hit = (data: unknown): data is string => {
    if (typeof data !== 'string' || !matches(data)) return false;
    filled = true;
    return true;
  };
  const original = fs.writeFile.bind(fs);
  const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
    if (!hit(data)) return original(file, data, options);
    await original(file, data.slice(0, 8), options);
    throw enospc();
  });
  const probe = await fs.open(os.devNull, 'r');
  const proto = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const handleWrite = proto.writeFile;
  const handleSpy = vi.spyOn(proto, 'writeFile').mockImplementation(async function partialWrite(
    this: FileHandle,
    data,
    options,
  ) {
    if (!hit(data)) return handleWrite.call(this, data, options);
    await handleWrite.call(this, data.slice(0, 8), options);
    throw enospc();
  });
  try {
    await body();
  } finally {
    writeSpy.mockRestore();
    handleSpy.mockRestore();
  }
  // A predicate that matches nothing leaves the disk empty, and the test would then
  // pass on writes that all succeeded.
  if (!filled) throw new Error('no write matched the full-disk predicate');
}
