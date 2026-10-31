import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { repoRoot as root } from './agents/agent-file.js';
import { jobSteps, releaseYml, requireTools } from './workflow-yaml.js';

requireTools(['bash', 'jq']);

const execFileAsync = promisify(execFile);

interface RootPackage {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  license: string;
  author: unknown;
  repository: { url: string };
  homepage: string;
  bugs: unknown;
  engines: unknown;
  bin: Record<string, string>;
}

interface AliasPackage extends RootPackage {
  type: string;
  files: string[];
  dependencies: Record<string, string>;
}

async function rootPackage(): Promise<RootPackage> {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as RootPackage;
}

async function aliasNames(): Promise<string[]> {
  const text = await readFile(join(root, 'scripts/npm-aliases.txt'), 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Build `name` into a scratch dir; the callback sees the dir, which is removed afterwards. */
async function withBuilt<T>(name: string, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mailoo-alias-'));
  try {
    await execFileAsync('bash', [join(root, 'scripts/build-npm-alias.sh'), name, dir], {
      env: { PATH: process.env.PATH },
    });
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function builtPackage(name: string): Promise<AliasPackage> {
  return withBuilt(
    name,
    async (dir) => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as AliasPackage,
  );
}

describe('npm alias list', () => {
  it('should not be empty', async () => {
    expect((await aliasNames()).length).toBeGreaterThan(0);
  });

  it('should hold each name once', async () => {
    const names = await aliasNames();

    expect(new Set(names).size).toBe(names.length);
  });

  it('should not hold the main package', async () => {
    expect(await aliasNames()).not.toContain((await rootPackage()).name);
  });

  it('should hold only names the build script accepts', async () => {
    // The build script owns the name rule; a copy of its pattern here could drift from it.
    for (const name of await aliasNames()) {
      await expect(withBuilt(name, async () => name)).resolves.toBe(name);
    }
  });
});

describe('build-npm-alias.sh', () => {
  it('should take version, description and keywords from the main package and depend on that exact version', async () => {
    const main = await rootPackage();

    const built = await builtPackage('mailoo-mcp');

    expect(built.name).toBe('mailoo-mcp');
    expect(built.version).toBe(main.version);
    expect(built.description).toBe(main.description);
    expect(built.keywords).toEqual(main.keywords);
    expect(built.dependencies).toEqual({ [main.name]: main.version });
  });

  it('should copy the publishing metadata from the main package', async () => {
    // repository is what publish-npm-aliases.sh reads to tell its own alias from another package.
    const main = await rootPackage();

    const built = await builtPackage('mailoo-mcp');

    // A field copied from the root by accident would run with the alias: its `scripts` include
    // `prepublishOnly` (a build) and `prepare` (a git hook install).
    expect(Object.keys(built).sort()).toEqual([
      'author',
      'bin',
      'bugs',
      'dependencies',
      'description',
      'engines',
      'files',
      'homepage',
      'keywords',
      'license',
      'name',
      'repository',
      'type',
      'version',
    ]);
    expect({
      license: built.license,
      author: built.author,
      repository: built.repository,
      homepage: built.homepage,
      bugs: built.bugs,
      engines: built.engines,
    }).toEqual({
      license: main.license,
      author: main.author,
      repository: main.repository,
      homepage: main.homepage,
      bugs: main.bugs,
      engines: main.engines,
    });
  });

  it('should be an ES module, because bin.js is an import', async () => {
    expect((await builtPackage('mailoo-mcp')).type).toBe('module');
  });

  it('should expose the alias name as the only bin and ship only the files it writes', async () => {
    await withBuilt('mailoo-mcp', async (dir) => {
      const built = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as AliasPackage;
      const shipped = ['COPYING', 'LICENSE', 'NOTICE', 'README.md', 'bin.js'];

      expect(built.bin).toEqual({ 'mailoo-mcp': 'bin.js' });
      expect([...built.files].sort()).toEqual(shipped);
      expect((await readdir(dir)).sort()).toEqual([...shipped, 'package.json']);
      expect((await stat(join(dir, 'bin.js'))).mode & 0o111).not.toBe(0);
    });
  });

  it('should ship the licence texts the main package ships', async () => {
    await withBuilt('mailoo-mcp', async (dir) => {
      for (const file of ['LICENSE', 'COPYING', 'NOTICE']) {
        expect(await readFile(join(dir, file), 'utf8')).toBe(
          await readFile(join(root, file), 'utf8'),
        );
      }
    });
  });

  it('should import the entry point the main package names as its bin', async () => {
    const main = await rootPackage();

    const bin = await withBuilt('mailoo-mcp', (dir) => readFile(join(dir, 'bin.js'), 'utf8'));

    expect(bin).toBe(`#!/usr/bin/env node\nimport '${main.name}/${main.bin.mailoo}';\n`);
  });

  it('should tell users to run the latest tag, not the bare name', async () => {
    // A bare name runs a project or global copy of the same name before it asks the registry.
    const readme = await withBuilt('mailoo-mcp', (dir) => readFile(join(dir, 'README.md'), 'utf8'));

    expect(readme).toContain('npx -y mailoo-mcp@latest');
    expect(readme).not.toMatch(/npx -y mailoo-mcp(?!@)/);
  });

  it('should write a README that names the alias, links the main package and the homepage', async () => {
    const main = await rootPackage();

    const readme = await withBuilt('mailoo-mcp', (dir) => readFile(join(dir, 'README.md'), 'utf8'));

    expect(readme).toBe(
      [
        '# mailoo-mcp',
        '',
        `\`mailoo-mcp\` is an alias for [\`${main.name}\`](https://www.npmjs.com/package/${main.name}), an email MCP server`,
        'for AI agents. It starts the same server and contains nothing else.',
        '',
        '```bash',
        'npx -y mailoo-mcp@latest',
        '```',
        '',
        `Setup for Claude Code, Claude Desktop, Cursor and other clients: ${main.homepage}`,
        '',
      ].join('\n'),
    );
  });

  it('should not claim the MCP registry name of the main package', async () => {
    const built = await builtPackage('mailoo-mcp');

    expect(built).not.toHaveProperty('mcpName');
  });

  it.each(['mailoo-mcp', 'mail.mcp', 'mail_mcp', 'mail2', '2mail', 'a'])(
    'should accept the name %j',
    async (name) => {
      expect((await builtPackage(name)).name).toBe(name);
    },
  );

  // The name becomes a directory under the publish script's scratch dir: a `/` must never get in.
  it.each([
    '@bitfloo/mail',
    'Mail-MCP',
    'mailMCP',
    '-mail',
    '.mail',
    '_mail',
    'mail mcp',
    'a/b',
    'a/../b',
    'mail@x',
    '',
  ])('should refuse the name %j and write nothing', async (name) => {
    const dir = await mkdtemp(join(tmpdir(), 'mailoo-alias-'));
    try {
      await expect(
        execFileAsync('bash', [join(root, 'scripts/build-npm-alias.sh'), name, dir], {
          env: { PATH: process.env.PATH },
        }),
      ).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('should say why it refuses a name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailoo-alias-'));
    try {
      await expect(
        execFileAsync('bash', [join(root, 'scripts/build-npm-alias.sh'), 'Mail-MCP', dir], {
          env: { PATH: process.env.PATH },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('not an unscoped lowercase npm name: Mail-MCP'),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Stands in for npm. `view` answers from STUB_PUBLISHED ("name@version ...") and STUB_REPOS
 * ("name=url ...", an empty url is a package without a repository field) with the E404 npm gives
 * for what is not there, or fails with the code in STUB_VIEW_ERROR ("name=code ...") for that
 * name. `publish` records the package it ran in and its flags, reads standard input as npm does
 * when it asks for a one-time password, fails for the names in STUB_FAIL_PUBLISH and, for the names
 * in STUB_HANG_PUBLISH, writes its pid to "$STUB_LOG.pid" and waits there, as npm does at that
 * prompt. Nothing leaves the machine.
 */
const STUB_NPM = `#!/usr/bin/env bash
case "$1" in
  view)
    if [[ $3 == version ]]; then
      [[ " $STUB_PUBLISHED " == *" $2 "* ]] && echo "\${2##*@}" && exit 0
      echo "npm error code E404" >&2
      exit 1
    fi
    for entry in $STUB_VIEW_ERROR; do
      if [[ \${entry%%=*} == "$2" ]]; then
        echo "npm error code \${entry#*=}" >&2
        exit 1
      fi
    done
    for entry in $STUB_REPOS; do
      if [[ \${entry%%=*} == "$2" ]]; then
        # npm prints nothing, and exits 0, for a field a package that exists does not have.
        [[ $3 == repository.url ]] && echo "\${entry#*=}"
        exit 0
      fi
    done
    echo "npm error code E404" >&2
    exit 1
    ;;
  publish)
    name=$(jq -r .name package.json)
    echo "publish $name@$(jq -r .version package.json) \${*:2}" >> "$STUB_LOG"
    pwd -P >> "$STUB_LOG.cwd"
    if [[ " $STUB_HANG_PUBLISH " == *" $name "* ]]; then
      echo $$ > "$STUB_LOG.pid"
      exec sleep "$STUB_HANG_SECONDS"
    fi
    cat > /dev/null
    [[ " $STUB_FAIL_PUBLISH " == *" $name "* ]] && exit 1
    ;;
esac
exit 0
`;

/** Long enough for the test to signal the stub; short enough that a stray one ends by itself. */
const STUB_HANG_SECONDS = 5;
const POLL_INTERVAL_MS = 20;
const POLL_ATTEMPTS = 150;

interface PublishRun {
  code: number;
  stdout: string;
  stderr: string;
  published: string[];
  leftovers: string[];
  /** Where each publish ran, and the real path of the temp directory the run was given. */
  builtIn: string[];
  tempRoot: string;
}

interface PublishSetup {
  args?: string[];
  inActions?: boolean;
  /** Versions npm already has, as "name@version". The main package's own version is always there. */
  published?: string[];
  mainOnNpm?: boolean;
  repos?: Record<string, string>;
  failPublish?: string[];
  /** Names whose publish waits for a signal instead of finishing. */
  hangPublish?: string[];
  /** How long such a publish waits when nothing signals it. */
  hangSeconds?: number;
  /** Run without TMPDIR in the environment. */
  noTmpdir?: boolean;
  /** The error code npm answers with when asked about a name, by name. */
  viewError?: Record<string, string>;
  /** What the workflow's `needs.npm.result` is; unset outside the workflow. */
  npmJob?: string;
  /** Names to read instead of scripts/npm-aliases.txt, in a copy of the scripts. */
  list?: string[];
  /** Leave the last line of `list` without its newline. */
  unterminated?: boolean;
  /** A root file left out of the copy that `list` makes, so the build fails once it is under way. */
  omit?: string;
}

function failureOf(
  error: unknown,
): Omit<PublishRun, 'published' | 'leftovers' | 'builtIn' | 'tempRoot'> {
  const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
  return { code, stdout, stderr };
}

async function lines(file: string): Promise<string[]> {
  return readFile(file, 'utf8').then(
    (text) => text.split('\n').filter(Boolean),
    () => [],
  );
}

/** A copy of the scripts and the files they read, with `list` as the alias list. */
async function copyWithList(
  into: string,
  setup: PublishSetup & { list: string[] },
): Promise<string> {
  await cp(join(root, 'scripts'), join(into, 'scripts'), { recursive: true });
  for (const file of ['package.json', 'LICENSE', 'COPYING', 'NOTICE']) {
    if (file !== setup.omit) {
      await cp(join(root, file), join(into, file));
    }
  }
  await writeFile(
    join(into, 'scripts/npm-aliases.txt'),
    setup.list.join('\n') + (setup.unterminated ? '' : '\n'),
  );
  return join(into, 'scripts/publish-npm-aliases.sh');
}

interface StubbedNpm {
  script: string;
  env: Record<string, string>;
  log: string;
  /** What the script sees as its temp directory. */
  scratch: string;
}

/** Runs `use` with the publish script and an environment where `npm` is the stub. */
async function withStubbedNpm<T>(
  setup: PublishSetup,
  use: (stub: StubbedNpm) => Promise<T>,
): Promise<T> {
  const main = await rootPackage();
  const dir = await mkdtemp(join(tmpdir(), 'mailoo-stub-npm-'));
  const log = join(dir, 'publishes.log');
  // A space in both paths: an unquoted expansion in the scripts would split them.
  const scratch = join(dir, 'tmp dir');
  try {
    await mkdir(scratch);
    await writeFile(join(dir, 'npm'), STUB_NPM);
    await chmod(join(dir, 'npm'), 0o755);
    const script = setup.list
      ? await copyWithList(join(dir, 'copy dir'), { ...setup, list: setup.list })
      : join(root, 'scripts/publish-npm-aliases.sh');
    const published = [
      ...(setup.published ?? []),
      ...(setup.mainOnNpm === false ? [] : [`${main.name}@${main.version}`]),
    ];
    const env = {
      PATH: `${dir}:${process.env.PATH}`,
      ...(setup.noTmpdir ? {} : { TMPDIR: scratch }),
      STUB_LOG: log,
      STUB_PUBLISHED: published.join(' '),
      STUB_FAIL_PUBLISH: (setup.failPublish ?? []).join(' '),
      STUB_HANG_PUBLISH: (setup.hangPublish ?? []).join(' '),
      STUB_HANG_SECONDS: String(setup.hangSeconds ?? STUB_HANG_SECONDS),
      STUB_VIEW_ERROR: Object.entries(setup.viewError ?? {})
        .map(([name, code]) => `${name}=${code}`)
        .join(' '),
      STUB_REPOS: Object.entries(setup.repos ?? {})
        .map(([name, url]) => `${name}=${url}`)
        .join(' '),
      ...(setup.inActions ? { GITHUB_ACTIONS: 'true' } : {}),
      ...(setup.npmJob ? { NPM_JOB_RESULT: setup.npmJob } : {}),
    };
    return await use({ script, env, log, scratch });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runPublish(setup: PublishSetup = {}): Promise<PublishRun> {
  return withStubbedNpm(setup, async ({ script, env, log, scratch }) => {
    const pending = execFileAsync('bash', [script, ...(setup.args ?? [])], { env });
    // A terminal is not what a test run has; end-of-input is the nearest thing that lets npm's
    // read return.
    pending.child.stdin?.end();
    const run = await pending.then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      failureOf,
    );
    return {
      ...run,
      published: await lines(log),
      leftovers: await readdir(scratch),
      builtIn: await lines(`${log}.cwd`),
      tempRoot: await realpath(scratch),
    };
  });
}

/** The file appears when the stub's publish starts; a test cannot otherwise know that moment. */
async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const text = (await readFile(file, 'utf8').catch(() => '')).trim();
    if (text !== '') {
      return text;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${file} did not appear`);
}

/** The names, as `name@version`, of the publishes a run logged. */
function publishedPackages(run: PublishRun): string[] {
  return run.published.map((line) => line.split(' ')[1]);
}

/** Every alias name mapped to the main package's repository, as npm reports a package of ours. */
async function ownRepos(names?: string[]): Promise<Record<string, string>> {
  const main = await rootPackage();
  return Object.fromEntries(
    (names ?? (await aliasNames())).map((name) => [name, main.repository.url]),
  );
}

// Continuation must exercise another publish even when the live roster contains only one alias.
const MULTI_ALIAS_NAMES = ['fixture-first', 'fixture-next'];

describe('publish-npm-aliases.sh', () => {
  it('should publish every alias at the main version, confirmed in the browser, from a terminal', async () => {
    const main = await rootPackage();
    const names = await aliasNames();

    const run = await runPublish();

    expect(run.code).toBe(0);
    expect(run.published).toEqual(
      names.map((name) => `publish ${name}@${main.version} --access public --auth-type=web`),
    );
    // npm's answers to the lookups stay out of the maintainer's terminal.
    expect(run.stdout).toBe(names.map((name) => `publish ${name}@${main.version}\n`).join(''));
    expect(run.stderr).toBe('');
  });

  it('should build and publish inside the temp directory it was given', async () => {
    // The leftover checks look only in that directory; one that is ignored would pass vacuously.
    const run = await runPublish();

    expect(run.builtIn.length).toBeGreaterThan(0);
    for (const dir of run.builtIn) {
      expect(dir.startsWith(`${run.tempRoot}/`)).toBe(true);
    }
  });

  it('should fall back to /tmp when TMPDIR is not set', async () => {
    const names = await aliasNames();

    const run = await runPublish({ noTmpdir: true });

    expect(run.code).toBe(0);
    expect(run.builtIn).toHaveLength(names.length);
    for (const dir of run.builtIn) {
      expect(dir.startsWith(`${await realpath('/tmp')}/mailoo-alias.`)).toBe(true);
    }
  });

  it('should publish through the workflow without a browser confirmation', async () => {
    const main = await rootPackage();
    const [name] = await aliasNames();

    const run = await runPublish({ inActions: true, repos: await ownRepos() });

    expect(run.code).toBe(0);
    expect(run.published[0]).toBe(`publish ${name}@${main.version} --access public`);
    expect(run.published.join('\n')).not.toContain('--auth-type');
  });

  it('should leave standard input to npm, which asks for the one-time password there', async () => {
    // The stub's publish reads standard input to the end, as npm does at the prompt. A loop that
    // read the alias list from there would hand npm the list and leave the names after the first
    // unpublished.
    const main = await rootPackage();

    const run = await runPublish({ list: MULTI_ALIAS_NAMES });

    expect(publishedPackages(run)).toEqual(
      MULTI_ALIAS_NAMES.map((name) => `${name}@${main.version}`),
    );
  });

  it.each([
    { where: 'a terminal', inActions: false },
    { where: 'the workflow', inActions: true },
  ])(
    'should publish nothing for a version that is already on npm, from $where',
    async ({ inActions }) => {
      // The names exist and belong to this repository, so only the skip keeps a re-run from
      // publishing the same version again.
      const main = await rootPackage();
      const names = await aliasNames();

      const run = await runPublish({
        inActions,
        published: names.map((name) => `${name}@${main.version}`),
        repos: await ownRepos(),
      });

      expect(run.code).toBe(0);
      expect(run.published).toEqual([]);
      expect(run.stdout).toBe(
        names.map((name) => `skip ${name}@${main.version}: already published\n`).join(''),
      );
    },
  );

  it('should warn and skip a name that is not on npm yet in the workflow, without failing the run', async () => {
    const run = await runPublish({ inActions: true });

    expect(run.code).toBe(0);
    expect(run.published).toEqual([]);
    expect(run.stdout).toContain('::warning::');
  });

  // Only E404 means absent: an auth or rate-limit error is not an answer either.
  it.each(['E500', 'E403', 'E429'])(
    'should fail the run when npm answers %s about a name, instead of treating it as absent',
    async (code) => {
      // A green run would leave the alias on the previous release.
      const names = await aliasNames();

      const run = await runPublish({
        inActions: true,
        viewError: Object.fromEntries(names.map((name) => [name, code])),
      });

      expect(run.code).not.toBe(0);
      expect(run.published).toEqual([]);
      expect(run.stdout).not.toContain('::warning::');
      expect(run.stderr).toContain('could not look up');
      expect(run.stderr).toContain(`npm error code ${code}`);
    },
  );

  it('should go on to the next name after one it cannot look up', async () => {
    const main = await rootPackage();
    const [broken, next] = MULTI_ALIAS_NAMES;

    const run = await runPublish({
      list: MULTI_ALIAS_NAMES,
      inActions: true,
      repos: await ownRepos(MULTI_ALIAS_NAMES),
      viewError: { [broken]: 'E500' },
    });

    expect(run.code).not.toBe(0);
    expect(publishedPackages(run)).toEqual([`${next}@${main.version}`]);
  });

  it('should go on to the next name after one that is already published', async () => {
    const main = await rootPackage();
    const [first, next] = MULTI_ALIAS_NAMES;

    const run = await runPublish({
      list: MULTI_ALIAS_NAMES,
      published: [`${first}@${main.version}`],
      repos: await ownRepos(MULTI_ALIAS_NAMES),
    });

    expect(run.code).toBe(0);
    expect(publishedPackages(run)).toEqual([`${next}@${main.version}`]);
  });

  it('should go on to the next name after one that is not on npm yet, in the workflow', async () => {
    // A release adds a new alias next to ones that exist: the absent name must not end the run.
    const main = await rootPackage();
    const [absent, next] = MULTI_ALIAS_NAMES;

    const run = await runPublish({
      list: MULTI_ALIAS_NAMES,
      inActions: true,
      npmJob: 'success',
      repos: { [next]: main.repository.url },
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`::warning::${absent} is not on npm yet`);
    expect(publishedPackages(run)).toEqual([`${next}@${main.version}`]);
  });

  it('should skip blank lines and comments in the list', async () => {
    const main = await rootPackage();
    const [name] = await aliasNames();

    const run = await runPublish({ list: ['# a comment', '', name] });

    expect(run.code).toBe(0);
    expect(publishedPackages(run)).toEqual([`${name}@${main.version}`]);
  });

  it('should read the last name when the list does not end in a newline', async () => {
    const main = await rootPackage();
    const [name] = await aliasNames();

    const run = await runPublish({ list: [name], unterminated: true });

    expect(run.code).toBe(0);
    expect(publishedPackages(run)).toEqual([`${name}@${main.version}`]);
  });

  it('should refuse a name that belongs to another repository and still publish the rest', async () => {
    const main = await rootPackage();
    const [taken, next] = MULTI_ALIAS_NAMES;

    const run = await runPublish({
      list: MULTI_ALIAS_NAMES,
      repos: {
        ...(await ownRepos(MULTI_ALIAS_NAMES)),
        [taken]: 'git+https://github.com/someone-else/other.git',
      },
    });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`TAKEN ${taken}`);
    expect(publishedPackages(run)).toEqual([`${next}@${main.version}`]);
  });

  it('should refuse a package that has no repository field, which is never one of ours', async () => {
    const main = await rootPackage();
    const [taken] = await aliasNames();

    const run = await runPublish({ repos: { ...(await ownRepos()), [taken]: '' } });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`TAKEN ${taken}`);
    expect(publishedPackages(run)).not.toContain(`${taken}@${main.version}`);
  });

  it('should fail the run when a publish fails and still try the other names', async () => {
    const main = await rootPackage();

    const run = await runPublish({
      list: MULTI_ALIAS_NAMES,
      failPublish: [MULTI_ALIAS_NAMES[0]],
    });

    expect(run.code).not.toBe(0);
    expect(publishedPackages(run)).toEqual(
      MULTI_ALIAS_NAMES.map((name) => `${name}@${main.version}`),
    );
    expect(run.leftovers).toEqual([]);
  });

  it('should remove the directory it builds each alias in', async () => {
    const run = await runPublish();

    expect(run.published.length).toBeGreaterThan(0);
    expect(run.leftovers).toEqual([]);
  });

  it('should publish nothing for an alias whose build fails once it is under way', async () => {
    // The build writes package.json before it needs NOTICE: a half-built package must not go out.
    const [name] = await aliasNames();

    const run = await runPublish({ list: [name], omit: 'NOTICE' });

    expect(run.code).not.toBe(0);
    expect(run.published).toEqual([]);
    expect(run.leftovers).toEqual([]);
  });

  it('should refuse a list line with surrounding whitespace instead of trimming it', async () => {
    const [name] = await aliasNames();

    const run = await runPublish({ list: [` ${name}`] });

    expect(run.code).not.toBe(0);
    expect(run.published).toEqual([]);
  });

  // Ctrl-C in a terminal reaches the script and the npm under it; a kill from outside may reach only
  // the script, which then acts once npm returns (here after `hangSeconds`).
  const interrupts: {
    signal: NodeJS.Signals;
    code: number;
    reachesNpm: boolean;
    hangSeconds?: number;
  }[] = [
    { signal: 'SIGINT', code: 130, reachesNpm: true },
    { signal: 'SIGTERM', code: 143, reachesNpm: true },
    { signal: 'SIGINT', code: 130, reachesNpm: false, hangSeconds: 1 },
    { signal: 'SIGTERM', code: 143, reachesNpm: false, hangSeconds: 1 },
  ];

  it.each(interrupts)(
    'should stop and remove what it built on $signal at the publish prompt (reaching npm: $reachesNpm)',
    async ({ signal, code, reachesNpm, hangSeconds }) => {
      // Continuing to the next name after it would ask for another one-time password.
      const [name] = await aliasNames();

      await withStubbedNpm(
        { hangPublish: [name], hangSeconds },
        async ({ script, env, log, scratch }) => {
          const pending = execFileAsync('bash', [script], { env });
          pending.child.stdin?.end();
          const npmPid = Number(await waitForFile(`${log}.pid`));
          const scriptPid = pending.child.pid;
          if (scriptPid === undefined) {
            throw new Error('the script did not start');
          }
          // The script first: bash holds the signal until the command it waits for ends.
          process.kill(scriptPid, signal);
          if (reachesNpm) {
            process.kill(npmPid, signal);
          }

          const run = await pending.then(
            ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
            failureOf,
          );

          expect(run.code).toBe(code);
          expect(await lines(log)).toHaveLength(1);
          expect(await readdir(scratch)).toEqual([]);
        },
      );
    },
  );

  it('should fail the run for an alias that does not build, clean up after it and publish the rest', async () => {
    const main = await rootPackage();
    const [name] = await aliasNames();

    const run = await runPublish({ list: ['Bad Name', name] });

    expect(run.code).not.toBe(0);
    expect(run.published).toEqual([
      `publish ${name}@${main.version} --access public --auth-type=web`,
    ]);
    expect(run.leftovers).toEqual([]);
  });

  it('should refuse to run from a terminal at a version the main package does not have on npm', async () => {
    // An alias depends on exactly this version; published first, it would not install.
    const run = await runPublish({ mainOnNpm: false });

    expect(run.code).not.toBe(0);
    expect(run.published).toEqual([]);
    expect(run.stderr).toContain('is not on npm');
  });

  it.each([{ npmJob: 'success' }, { npmJob: undefined }])(
    'should not check the main version in the workflow when the npm job result is $npmJob, where npm answers 404 for a version just published',
    async ({ npmJob }) => {
      // Only `skipped` means nothing published the version in this run.
      const names = await aliasNames();

      const run = await runPublish({
        inActions: true,
        mainOnNpm: false,
        npmJob,
        repos: await ownRepos(),
      });

      expect(run.code).toBe(0);
      expect(run.published).toHaveLength(names.length);
    },
  );

  it('should check the main version in the workflow when the npm job was skipped', async () => {
    // Nothing published the version in that run, so a version npm lacks is a broken alias.
    const run = await runPublish({
      inActions: true,
      mainOnNpm: false,
      npmJob: 'skipped',
      repos: await ownRepos(),
    });

    expect(run.code).not.toBe(0);
    expect(run.published).toEqual([]);
    expect(run.stderr).toContain('is not on npm');
  });

  it('should publish in the workflow when the npm job was skipped and the main version is on npm', async () => {
    const names = await aliasNames();

    const run = await runPublish({ inActions: true, npmJob: 'skipped', repos: await ownRepos() });

    expect(run.code).toBe(0);
    expect(run.published).toHaveLength(names.length);
  });

  it.each([['--dryrun'], ['--dry-run', '--dry-run'], ['x', '--dry-run']])(
    'should refuse the arguments %j instead of publishing for real',
    async (...args) => {
      const run = await runPublish({ args });

      expect(run.code).toBe(2);
      expect(run.published).toEqual([]);
      expect(run.stderr).toContain('usage:');
    },
  );

  it('should pass --dry-run on to npm', async () => {
    const run = await runPublish({ args: ['--dry-run'] });

    expect(run.code).toBe(0);
    expect(run.published.length).toBeGreaterThan(0);
    for (const line of run.published) {
      expect(line).toContain('--dry-run');
    }
  });
});

describe('release.yml aliases job', () => {
  it('should hand the npm job result to the step that runs the publish script', () => {
    // The script reads it from its environment; on any other step it would never see it.
    const step = jobSteps(releaseYml).aliases.find((candidate) =>
      candidate.run?.includes('publish-npm-aliases.sh'),
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow expression, not a template
    expect(step?.env).toEqual({ NPM_JOB_RESULT: '${{ needs.npm.result }}' });
  });
});
