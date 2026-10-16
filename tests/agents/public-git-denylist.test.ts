import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  clean,
  denylist,
  git,
  initRepo,
  leak,
  makeTmpDir,
  passed,
  removeTmpDirs,
  runChecker,
  scanFile,
} from './public-git-checker.js';

afterEach(removeTmpDirs);

describe('public git checker: private patterns', () => {
  it('rejects a private pattern from the environment only when it is set', () => {
    const body = 'docs: load the example-private-tree notes\n';
    expect(scanFile(body).status).toBe(0);
    const result = scanFile(body, { PUBLIC_GIT_EXTRA_FORBIDDEN: 'example-private-tree' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('docs: load the example-private-tree notes');
    expect(result.stderr).toContain('forbidden token');
  });

  it('applies environment and denylist patterns together and reports each hit', () => {
    const env = {
      PUBLIC_GIT_EXTRA_FORBIDDEN: 'alpha-secret',
      PUBLIC_GIT_DENYLIST_FILE: denylist('beta-secret\n'),
    };
    expect(scanFile('docs: mention alpha-secret\n', env).status).toBe(1);
    expect(scanFile('docs: mention beta-secret\n', env).status).toBe(1);
    expect(scanFile(clean, env)).toEqual(passed);
    const both = scanFile('docs: mention alpha-secret\n\nAlso beta-secret here.\n', env);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain('docs: mention alpha-secret');
    expect(both.stderr).toContain('Also beta-secret here.');
  });

  it('echoes a mixed-case hit on an extra pattern', () => {
    const env = { PUBLIC_GIT_EXTRA_FORBIDDEN: 'example-private-tree' };
    const result = scanFile('docs: load the Example-Private-Tree notes\n', env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs: load the Example-Private-Tree notes');
  });

  it('matches a denylist pattern case-insensitively', () => {
    const env = { PUBLIC_GIT_DENYLIST_FILE: denylist('example-private-tree\n') };
    expect(scanFile('docs: load the Example-Private-Tree notes\n', env).status).toBe(1);
  });

  it('reads a denylist saved with CRLF line endings', () => {
    const env = {
      PUBLIC_GIT_DENYLIST_FILE: denylist(
        '# private patterns\r\nexample-private-tree\r\nother-secret-name\r\n',
      ),
    };
    expect(scanFile('docs: load the example-private-tree notes\n', env).status).toBe(1);
    expect(scanFile('docs: mention other-secret-name\n', env).status).toBe(1);
    expect(scanFile(clean, env)).toEqual(passed);
  });

  it('ignores an extra-pattern variable that is set but empty', () => {
    const env = { PUBLIC_GIT_EXTRA_FORBIDDEN: '' };
    expect(scanFile(clean, env)).toEqual(passed);
    const result = scanFile(leak, env);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('/Users/me/mailoo');
  });

  it('keeps backslashes in a denylist line', () => {
    const env = { PUBLIC_GIT_DENYLIST_FILE: denylist('private\\.marker\n') };
    expect(scanFile('docs: drop private.marker notes\n', env).status).toBe(1);
    expect(scanFile('docs: drop privateXmarker notes\n', env)).toEqual(passed);
  });

  it('uses a denylist line verbatim, leading and trailing spaces included', () => {
    const env = { PUBLIC_GIT_DENYLIST_FILE: denylist(' private-tree-x \n') };
    expect(scanFile('docs: a private-tree-x b\n', env).status).toBe(1);
    expect(scanFile('docs: a-private-tree-x-b\n', env)).toEqual(passed);
  });

  it('treats a # inside a denylist line as part of the pattern', () => {
    const env = { PUBLIC_GIT_DENYLIST_FILE: denylist('secret#tag\n') };
    expect(scanFile('docs: drop secret#tag\n', env).status).toBe(1);
  });

  it('ignores a denylist path that is a directory', () => {
    const dir = makeTmpDir('mailoo-public-git-dir-');
    expect(scanFile(clean, { PUBLIC_GIT_DENYLIST_FILE: dir })).toEqual(passed);
  });

  it('treats a denylist line that starts with a dash as a pattern, not an option', () => {
    const env = { PUBLIC_GIT_DENYLIST_FILE: denylist('-private-marker\n') };
    const hit = scanFile('docs: drop the x-private-marker notes\n', env);
    expect(hit.status).toBe(1);
    expect(hit.stdout).toBe('');
    expect(hit.stderr).toContain('docs: drop the x-private-marker notes');
    expect(scanFile(clean, env)).toEqual(passed);
  });

  it('treats an environment pattern that starts with a dash as a pattern, not an option', () => {
    const env = { PUBLIC_GIT_EXTRA_FORBIDDEN: '--private-marker' };
    expect(scanFile('docs: drop the x--private-marker notes\n', env).status).toBe(1);
    expect(scanFile(clean, env)).toEqual(passed);
  });

  it('skips blank lines and comments between denylist patterns', () => {
    const env = {
      PUBLIC_GIT_DENYLIST_FILE: denylist(
        'example-private-tree\n\n# comment with (regex) metachars [ * |\nother-secret-name',
      ),
    };
    expect(scanFile(clean, env)).toEqual(passed);
    expect(scanFile('docs: load the example-private-tree notes\n', env).status).toBe(1);
    expect(scanFile('docs: mention other-secret-name\n', env).status).toBe(1);
  });

  it('reads the default denylist from the repository git dir', () => {
    const repo = initRepo();
    writeFileSync(join(repo, '.git/info/public-git-denylist'), 'example-private-tree\n');
    const msg = join(repo, 'MSG');
    writeFileSync(msg, 'docs: load the example-private-tree notes\n');
    expect(runChecker(['--file', msg], repo, {}).status).toBe(1);
    writeFileSync(msg, clean);
    expect(runChecker(['--file', msg], repo, {}).status).toBe(0);
  });

  it('reads the default denylist when the override variable is set but empty', () => {
    const repo = initRepo();
    writeFileSync(join(repo, '.git/info/public-git-denylist'), 'example-private-tree\n');
    const msg = join(repo, 'MSG');
    writeFileSync(msg, 'docs: load the example-private-tree notes\n');
    expect(runChecker(['--file', msg], repo, { PUBLIC_GIT_DENYLIST_FILE: '' }).status).toBe(1);
  });

  it('reads the shared denylist from a linked worktree, where .git is a file', () => {
    const repo = initRepo();
    mkdirSync(join(repo, '.git/info'), { recursive: true });
    writeFileSync(join(repo, '.git/info/public-git-denylist'), 'example-private-tree\n');
    const worktree = join(makeTmpDir('mailoo-public-git-wt-'), 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', worktree);
    const msg = join(worktree, 'MSG');
    writeFileSync(msg, 'docs: load the example-private-tree notes\n');
    expect(runChecker(['--file', msg], worktree, {}).status).toBe(1);
  });

  it('runs the built-in patterns outside a git repository', () => {
    const dir = makeTmpDir('mailoo-public-git-norepo-');
    mkdirSync(join(dir, '.git/info'), { recursive: true });
    writeFileSync(join(dir, '.git/info/public-git-denylist'), 'example-private-tree\n');
    const msg = join(dir, 'MSG');
    writeFileSync(msg, 'docs: load the example-private-tree notes\n');
    const env = { GIT_CEILING_DIRECTORIES: dirname(dir) };
    expect(runChecker(['--file', msg], dir, env)).toEqual(passed);
    writeFileSync(msg, leak);
    expect(runChecker(['--file', msg], dir, env).status).toBe(1);
  });

  it.each([
    ['the environment', () => ({ PUBLIC_GIT_EXTRA_FORBIDDEN: 'example-private-tree' })],
    ['the denylist file', () => ({ PUBLIC_GIT_DENYLIST_FILE: denylist('example-private-tree\n') })],
  ])('echoes a built-in hit and an extra hit from %s in one message', (_source, makeEnv) => {
    const dir = makeTmpDir('mailoo-public-git-both-');
    const msg = join(dir, 'MSG');
    writeFileSync(msg, 'fix: path /Users/me/mailoo\n\nAlso example-private-tree here.\n');
    const result = runChecker(['--file', msg], dir, {
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
      ...makeEnv(),
    });
    expect(result).toEqual({
      status: 1,
      stdout: '',
      stderr:
        'fix: path /Users/me/mailoo\n' +
        'Also example-private-tree here.\n' +
        `public-git: forbidden token in ${msg} (see .claude/rules/public-git.md)\n`,
    });
  });
});
