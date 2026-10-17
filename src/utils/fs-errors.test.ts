import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import isEnoent from './fs-errors.js';

describe('isEnoent', () => {
  it('should return true for the error fs gives when a file is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-enoent-'));
    try {
      const error: unknown = await fs
        .readFile(path.join(dir, 'missing'))
        .catch((err: unknown) => err);

      expect(isEnoent(error)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['an EACCES error', Object.assign(new Error('permission denied'), { code: 'EACCES' })],
    ['an error without a code', new Error('ENOENT')],
    ['null', null],
    ['the string ENOENT', 'ENOENT'],
  ])('should return false for %s', (_label, value) => {
    expect(isEnoent(value)).toBe(false);
  });
});
