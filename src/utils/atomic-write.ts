/**
 * Replace a file so readers see the old bytes or the new ones, never a
 * truncated mix. fs.writeFile truncates first, so a crash or ENOSPC part-way
 * leaves half a JSON document behind. The new bytes go to a sibling temp
 * file, are flushed, and are then renamed over the target.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Owner-only: the files written here hold message bodies and mailbox state. */
export const PRIVATE_FILE_MODE = 0o600;

export default async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  // A dot prefix and a .tmp suffix keep the temp file out of directory scans by name.
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    const handle = await fs.open(tmpPath, 'wx', PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
