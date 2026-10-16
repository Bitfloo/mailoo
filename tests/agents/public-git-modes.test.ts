import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  clean,
  git,
  initRepo,
  leak,
  makeTmpDir,
  passed,
  pathWithFailingCat,
  removeTmpDirs,
  runChecker,
} from './public-git-checker.js';

afterEach(removeTmpDirs);

describe('public git checker: --range and --file modes', () => {
  it('checks every commit in a --range and names the leaking one', () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'docs: clean change');
    const cleanSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: tidy', '-m', 'Built in /home/me/mailoo');
    const leakSha = git(repo, 'rev-parse', 'HEAD');
    const env = { PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none') };
    expect(runChecker(['--range', `${base}..${cleanSha}`], repo, env)).toEqual(passed);
    const result = runChecker(['--range', `${base}..${leakSha}`], repo, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(leakSha);
    expect(result.stderr).not.toContain(cleanSha);
  });

  it('checks older commits in a --range, not only the tip', () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: tidy', '-m', 'Built in /home/me/mailoo');
    const leakSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'docs: clean tip');
    const tipSha = git(repo, 'rev-parse', 'HEAD');
    const result = runChecker(['--range', `${base}..${tipSha}`], repo, {
      PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none'),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(leakSha);
    expect(result.stderr).not.toContain(tipSha);
  });

  it('passes an empty --range without output', () => {
    const repo = initRepo();
    expect(
      runChecker(['--range', 'HEAD..HEAD'], repo, { PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none') }),
    ).toEqual(passed);
  });

  it('scans the commit subject in --range mode', () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    git(
      repo,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fix: path /home/me/mailoo',
      '-m',
      'Clean body.',
    );
    const leakSha = git(repo, 'rev-parse', 'HEAD');
    const result = runChecker(['--range', `${base}..${leakSha}`], repo, {
      PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none'),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(leakSha);
  });

  it('fails on a --range git cannot resolve', () => {
    const repo = initRepo();
    const result = runChecker(['--range', 'no-such-ref..HEAD'], repo, {
      PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none'),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot list commits');
  });

  it('fails on a commit in the --range that git cannot read', () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: path /home/me/mailoo');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    expect(realGit.startsWith('/')).toBe(true);
    const bin = join(makeTmpDir('mailoo-public-git-log-'), 'bin');
    mkdirSync(bin);
    // Lists the range with the real git, then fails the read of each commit message.
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\n[ "$1" = log ] && exit 128\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const result = runChecker(['--range', `${base}..${sha}`], repo, {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none'),
    });
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr: `public-git: cannot read commit ${sha}\n`,
    });
  });

  it('rejects a --file that does not exist with usage', () => {
    const dir = makeTmpDir('mailoo-public-git-absent-');
    const result = runChecker(['--file', join(dir, 'absent')], dir, {
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });

  it('fails closed when grep itself errors', () => {
    const dir = makeTmpDir('mailoo-public-git-grep-');
    const shim = join(dir, 'grep');
    writeFileSync(shim, '#!/bin/sh\nexit 2\n');
    chmodSync(shim, 0o755);
    const msg = join(dir, 'MSG');
    writeFileSync(msg, clean);
    const result = runChecker(['--file', msg], dir, {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('grep failed');
  });

  it.each([['--file'], ['--range']])('rejects %s without an argument with usage', (mode) => {
    const dir = makeTmpDir('mailoo-public-git-noarg-');
    const result = runChecker([mode], dir, { PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none') });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });

  it.skipIf(process.getuid?.() === 0)('fails on a message file it cannot read', () => {
    const dir = makeTmpDir('mailoo-public-git-unreadable-');
    const msg = join(dir, 'MSG');
    writeFileSync(msg, leak);
    chmodSync(msg, 0o000);
    const result = runChecker(['--file', msg], dir, {
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
    });
    chmodSync(msg, 0o600);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot read');
  });

  it('fails on a message file it cannot read, for any user', () => {
    const dir = makeTmpDir('mailoo-public-git-cat-msg-');
    const msg = join(dir, 'MSG');
    writeFileSync(msg, leak);
    const result = runChecker(['--file', msg], dir, {
      PATH: pathWithFailingCat(),
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
    });
    expect(result).toEqual({ status: 2, stdout: '', stderr: `public-git: cannot read ${msg}\n` });
  });

  it('reads a message file whose name starts with a dash', () => {
    const dir = makeTmpDir('mailoo-public-git-dash-');
    const env = { PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none') };
    writeFileSync(join(dir, '-msg'), clean);
    expect(runChecker(['--file', '-msg'], dir, env)).toEqual(passed);
    writeFileSync(join(dir, '-msg'), leak);
    expect(runChecker(['--file', '-msg'], dir, env)).toEqual({
      status: 1,
      stdout: '',
      stderr:
        'fix: path /Users/me/mailoo\n' +
        'public-git: forbidden token in -msg (see .claude/rules/public-git.md)\n',
    });
  });

  it('rejects a missing mode with usage', () => {
    const dir = makeTmpDir('mailoo-public-git-usage-');
    const result = runChecker([], dir, { PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none') });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });
});
