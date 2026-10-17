import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const servicesDir = join(dirname(fileURLToPath(import.meta.url)), '../services');

/**
 * lockMailbox calls in one services/ file, counted by the class method,
 * function or `fn.member` (a strategy method) that makes them. A table that
 * names every call site compares itself with this, so a new call without a
 * row fails instead of going unpinned.
 */
export default async function lockCallsByOwner(file: string): Promise<Record<string, number>> {
  const source = await readFile(join(servicesDir, file), 'utf-8');
  const counts: Record<string, number> = {};
  let owner = '';
  let member = '';
  source.split('\n').forEach((line) => {
    const fn =
      /^ {2}(?:private |static )*(?:async )?(\w+)\(/.exec(line) ??
      /^(?:export )?(?:async )?function (\w+)/.exec(line);
    const strategyMethod = /^ {4}(\w+): async/.exec(line);
    if (fn) {
      [, owner] = fn;
      member = '';
    } else if (strategyMethod) {
      [, member] = strategyMethod;
    } else if (line.includes('lockMailbox(') && !/^\s*(\*|\/\/)/.test(line)) {
      const key = member ? `${owner}.${member}` : owner;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  });
  return counts;
}
