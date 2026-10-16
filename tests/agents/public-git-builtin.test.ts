import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { checkerBuiltinSource, repoRoot } from './agent-file.js';
import {
  clean,
  cleanEnv,
  passed,
  publicGitRule,
  removeTmpDirs,
  scanFile,
} from './public-git-checker.js';

afterEach(removeTmpDirs);

describe('public git checker: built-in patterns', () => {
  describe('with git and checker variables set by the caller', () => {
    beforeEach(() => {
      vi.stubEnv('GIT_DIR', '/elsewhere');
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath');
      vi.stubEnv('GIT_CONFIG_VALUE_0', '/elsewhere');
      vi.stubEnv('GIT_CONFIG_SYSTEM', '/elsewhere');
      vi.stubEnv('PUBLIC_GIT_EXTRA_FORBIDDEN', 'docs');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('drops them and turns off the global and system git config', () => {
      const gitEntries = Object.entries(cleanEnv({})).filter(([key]) => key.includes('GIT_'));
      expect(Object.fromEntries(gitEntries)).toEqual({
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      });
    });

    it('runs the checker without them', () => {
      expect(scanFile(clean)).toEqual(passed);
    });
  });

  it('tracks the checker as executable for the agents that run it without bash', () => {
    const mode = spawnSync('git', ['ls-files', '-s', 'scripts/check-public-git-log.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanEnv({}),
    });
    expect(mode.stdout).toMatch(/^100755 /);
  });

  it('points the rubric at the checker', () => {
    expect(readFileSync(publicGitRule, 'utf8')).toContain('scripts/check-public-git-log.sh');
  });

  // Split at top-level pipes only, so a group such as (test-auditor|test-smith) stays whole.
  it.each(
    checkerBuiltinSource()
      .slice(1, -1)
      .split(/\|(?![^(]*\))/),
  )('keeps the built-in alternative %s out of the rubric', (alternative) => {
    expect(readFileSync(publicGitRule, 'utf8')).not.toContain(alternative);
  });

  it('accepts a conventional subject with no operator leak', () => {
    expect(scanFile(clean)).toEqual(passed);
  });

  it('accepts a project agent name without a plugin prefix', () => {
    expect(scanFile('docs: run the project test-auditor and push-gate agents\n').status).toBe(0);
  });

  it.each([
    ['a macOS home path', 'fix: path /Users/me/mailoo\n'],
    ['a Linux home path', 'fix: path /home/me/mailoo\n'],
    ['a session trailer', 'docs: note a change\n\nClaude-Session: 0123abc\n'],
    ['a session link', 'docs: see https://claude.ai/code/session_0123abc\n'],
    ['a plugin test-auditor dispatch', 'chore: do not dispatch acme:test-auditor\n'],
    ['a plugin test-smith dispatch', 'chore: do not dispatch acme:test-smith\n'],
    ['a plugin push-gate dispatch', 'chore: do not dispatch acme:push-gate\n'],
    ['a plugin name with a digit', 'chore: do not dispatch acme2:test-smith\n'],
    ['a one-letter plugin name', 'chore: do not dispatch x:test-smith\n'],
    ['a hyphenated plugin name', 'chore: do not dispatch my-plugin:push-gate\n'],
    ['a plugin name that ends in a hyphen', 'chore: do not dispatch acme-:test-smith\n'],
  ])('rejects %s', (_name, body) => {
    const result = scanFile(body);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('forbidden token');
    expect(result.stderr).toContain('see .claude/rules/public-git.md');
    expect(result.stdout).toBe('');
  });

  it.each([
    ['a path that only starts like a home dir', 'docs: link /homepage and /Userspace\n'],
    ['a session header named without its colon', 'docs: explain the Claude-Session header\n'],
    ['a session link with another separator', 'docs: see claude-ai/code/session_0123abc\n'],
    ['an agent name with an empty prefix', 'docs: run :test-smith and :push-gate\n'],
    ['an agent name without a colon', 'docs: run acme test-auditor\n'],
    ['a hyphenated project agent name', 'docs: run oss-push-gate before pushing\n'],
    ['a link to the product page', 'docs: see https://claude.ai/code\n'],
    [
      'a link that only starts like a session path',
      'docs: see https://claude.ai/code/sessions-guide\n',
    ],
  ])('accepts %s', (_name, body) => {
    expect(scanFile(body)).toEqual(passed);
  });

  it.each([
    ['a home path', 'fix: path /users/me/mailoo\n'],
    ['a session trailer', 'docs: note\n\nclaude-session: 0123abc\n'],
    ['a plugin dispatch name', 'chore: do not dispatch ACME:TEST-SMITH\n'],
    ['a plugin name with a digit', 'chore: do not dispatch ACME2:TEST-SMITH\n'],
  ])('matches %s case-insensitively', (_name, body) => {
    expect(scanFile(body).status).toBe(1);
  });

  it('echoes a mixed-case hit on a built-in pattern', () => {
    const result = scanFile('fix: path /USERS/me/mailoo\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fix: path /USERS/me/mailoo');
  });
});
