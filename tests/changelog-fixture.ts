import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';

export const changelogMd = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');

/** `text` with `from` replaced by `to`; throws unless `from` occurs exactly once, so a fixture cannot go stale silently. */
export function swapOnce(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) {
    throw new Error(`expected exactly one ${from}`);
  }
  return text.replace(from, to);
}
