import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agent-file.js';

const script = join(repoRoot, 'scripts/check-public-git-log.sh');
const publicGit = join(repoRoot, '.claude/rules/public-git.md');

function scanFile(
  body: string,
  env: Record<string, string> = {},
): { status: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mailoo-public-git-'));
  const file = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(file, body);
  const result = spawnSync('bash', [script, '--file', file], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PUBLIC_GIT_EXTRA_FORBIDDEN: '',
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'no-denylist'),
      ...env,
    },
  });
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

  it('reads the forbidden regex from the checker, not a second copy', () => {
    const src = readFileSync(script, 'utf8');
    const match = src.match(/^FORBIDDEN='([^']+)'/m);
    expect(match?.[1]).toContain(':(test-auditor|test-smith|push-gate)');
    expect(match?.[1]).toContain('/Users/');
    expect(readFileSync(publicGit, 'utf8')).toContain('scripts/check-public-git-log.sh');
  });

  it('rejects plugin dispatch names and machine paths', () => {
    expect(scanFile('chore: do not dispatch acme:test-auditor\n').status).not.toBe(0);
    expect(scanFile('fix: path /Users/me/mailoo\n').status).not.toBe(0);
  });

  it('should reject a private pattern from the environment only when it is set', () => {
    const body = 'docs: load the example-private-tree notes\n';
    expect(scanFile(body).status).toBe(0);
    expect(
      scanFile(body, { PUBLIC_GIT_EXTRA_FORBIDDEN: 'example-private-tree' }).status,
    ).not.toBe(0);
  });

  it('should reject a private pattern listed in the local denylist file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailoo-public-git-list-'));
    const list = join(dir, 'public-git-denylist');
    writeFileSync(list, '# private patterns\n\nexample-private-tree\nother-secret-name');
    const env = { PUBLIC_GIT_DENYLIST_FILE: list };
    expect(scanFile('docs: load the example-private-tree notes\n', env).status).not.toBe(0);
    expect(scanFile('docs: mention other-secret-name\n', env).status).not.toBe(0);
    expect(scanFile('docs: name the integration IMAP server\n', env).status).toBe(0);
  });

  it('should reject a private session link', () => {
    expect(
      scanFile(
        'docs: note a public change\n\nClaude-Session: https://claude.ai/code/session_0123abc\n',
      ).status,
    ).not.toBe(0);
  });
});
