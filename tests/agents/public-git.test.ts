import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agent-file.js';

const script = join(repoRoot, 'scripts/check-public-git-log.sh');
const publicGit = join(repoRoot, '.claude/rules/public-git.md');

function scanFile(body: string): { status: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mailoo-public-git-'));
  const file = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(file, body);
  const result = spawnSync('bash', [script, '--file', file], { encoding: 'utf8' });
  return { status: result.status ?? 1, stderr: result.stderr };
}

describe('public git log gate', () => {
  it('ships the rubric and an executable checker', () => {
    expect(publicGit).toBeTruthy();
    const rule = spawnSync('test', ['-f', publicGit]);
    expect(rule.status).toBe(0);
    chmodSync(script, 0o755);
    expect(spawnSync('test', ['-x', script]).status).toBe(0);
  });

  it('accepts a conventional subject with no operator leak', () => {
    expect(scanFile('docs: name the integration IMAP server\n').status).toBe(0);
  });

  it('rejects plugin dispatch names and machine paths', () => {
    expect(scanFile('chore: do not dispatch cbc:test-auditor\n').status).not.toBe(0);
    expect(scanFile('fix: path /Users/me/mailoo\n').status).not.toBe(0);
    expect(scanFile('docs: load AI-DATA brand\n').status).not.toBe(0);
  });
});
