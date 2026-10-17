/**
 * A throwaway XDG_DATA_HOME for suites that reach src/safety/audit.ts, so they
 * never append to the user's real audit log. audit.ts fixes its path when it
 * loads: call pinAuditHome from vi.hoisted, before the suite's imports run.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AuditEntry } from '../types/index.js';

export interface AuditHome {
  dir: string;
  restore: () => Promise<void>;
}

export async function pinAuditHome(): Promise<AuditHome> {
  const previous = process.env.XDG_DATA_HOME;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-audit-'));
  process.env.XDG_DATA_HOME = dir;
  return {
    dir,
    restore: async () => {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Every line audit.log appended so far, oldest first; empty before the first write. */
export async function readAuditEntries(home: AuditHome): Promise<AuditEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(home.dir, 'mailoo', 'audit.log'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}
