import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
  'dependencies' | 'devDependencies',
  Record<string, string>
>;

/**
 * Each pnpm-lock.yaml package with its peerDependencies ranges, read as text: lockPeerRange refuses
 * unless it finds one holder with that peer, so a lockfile form this reader misses fails the test.
 */
const lockPeers = (
  readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8').split(/^packages:\n/m)[1] ?? ''
)
  .split(/^snapshots:\n/m)[0]
  .split(/\n(?= {2}\S)/)
  .map((entry) => {
    const key = entry.match(/^\s*'?([^'\n]+?)'?:\n/)?.[1] ?? '';
    const block = entry.match(/^ {4}peerDependencies:\n((?: {6}.*\n?)+)/m)?.[1] ?? '';
    return {
      name: key.slice(0, key.lastIndexOf('@')),
      peers: Object.fromEntries(
        [...block.matchAll(/^ {6}'?([^':]+)'?: '?([^'\n]+?)'?$/gm)].map(([, peer, range]) => [
          peer,
          range,
        ]),
      ),
    };
  });

export function lockPeerRange(holder: string, peer: string): string {
  const ranges = lockPeers
    .filter((entry) => entry.name === holder)
    .map((entry) => entry.peers[peer]);
  if (ranges.length !== 1 || ranges[0] === undefined) {
    throw new Error(`expected one ${holder} with a ${peer} peer range in pnpm-lock.yaml`);
  }
  return ranges[0];
}

/** The first version a peer range shuts out: `^9.0.0` → 10.0.0, `>=4.8.4 <6.1.0` → 6.1.0. Other shapes throw. */
export function peerCeiling(range: string): string {
  const below = range.match(/^>=\d+\.\d+\.\d+ <(\d+\.\d+\.\d+)$/)?.[1];
  const caret = range.match(/^\^(\d+)\.\d+\.\d+$/)?.[1];
  if (below) {
    return below;
  }
  if (caret) {
    return `${Number(caret) + 1}.0.0`;
  }
  throw new Error(`no ceiling in peer range ${range}`);
}

/** The major after the one package.json takes for `name`. */
export function nextMajor(name: string): string {
  const range = pkg.dependencies[name] ?? pkg.devDependencies[name] ?? '';
  const major = range.match(/^[\^~]?(\d+)\./)?.[1];
  if (!major) {
    throw new Error(`package.json has no versioned ${name}`);
  }
  return `${Number(major) + 1}.0.0`;
}
