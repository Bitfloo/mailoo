import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import {
  jobSections,
  refEnv,
  releaseStep,
  releaseSteps,
  releaseYml,
  stepEnv,
} from './workflow-yaml.js';

const ciYml = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const dockerSha = readFileSync(join(repoRoot, '.github/workflows/docker-sha.yml'), 'utf8');
const lefthook = readFileSync(join(repoRoot, 'lefthook.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
  'scripts' | 'dependencies' | 'devDependencies',
  Record<string, string>
>;

function onBlock(yaml: string): string {
  const match = yaml.match(/^on:\n([\s\S]*?)\n(?:concurrency|permissions|jobs):/m);
  if (!match) {
    throw new Error('missing on: block');
  }
  return match[1];
}

describe('CI spend policy', () => {
  it('keeps GitHub ci.yml off push so the laptop script owns unit lint', () => {
    const on = onBlock(ciYml);
    expect(on).toContain('pull_request:');
    expect(on).toContain('workflow_dispatch:');
    expect(on).not.toMatch(/^\s+push:/m);
  });

  it('does not publish a SHA image on every main push', () => {
    expect(onBlock(dockerSha)).not.toMatch(/^\s+push:/m);
    expect(onBlock(dockerSha)).toContain('workflow_dispatch:');
  });

  it('wires ci-local into package scripts and pre-push', () => {
    expect(pkg.scripts['ci:local']).toBe('bash scripts/ci-local.sh');
    expect(lefthook).toContain('scripts/ci-local.sh');
  });

  it('names the dispatch include-unit flag in ci.yml and CLAUDE.md', () => {
    const claude = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(ciYml).toContain('include-unit');
    expect(claude).toContain('include-unit');
  });

  it('should list exactly the ci.yml jobs in the CONTRIBUTING pull request sentence', () => {
    const contributing = readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
    const sentence = contributing.match(/runs the `ci\.yml` jobs (.+?)\.(?:\s|$)/s)?.[1] ?? '';
    const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
    const names = jobSections(ciYml)
      .map((job) => job.match(/^ {4}name: (.+)$/m)?.[1])
      .sort();
    expect(listed).toEqual(names);
  });

  it('should describe CodeQL push and weekly runs only while codeql.yml has those triggers', () => {
    const contributing = readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
    const codeqlOn = onBlock(readFileSync(join(repoRoot, '.github/workflows/codeql.yml'), 'utf8'));
    expect(contributing).toContain('CodeQL also runs on pushes to `develop` and weekly');
    expect(codeqlOn).toMatch(/^ {2}push:\n {4}branches: \[develop\]$/m);
    expect(codeqlOn).toMatch(/^ {2}schedule:$/m);
  });
});

/** The workflow's grep -F operand is the only copy of the npm retry sentence. */
function npmRetryMarker(step: string): string {
  const match = step.match(/grep -F -q "([^"]+)"/);
  if (!match?.[1]) {
    throw new Error('Publish to MCP Registry has no npm retry marker');
  }
  return match[1];
}

function exactVersion(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe('release supply chain', () => {
  it('installs a fixed npm CLI at or above 11.5.1', () => {
    const steps = releaseSteps(releaseYml);
    expect(steps).not.toContain('npm@latest');
    expect(steps).not.toMatch(/npm install -g npm@/);
    expect(steps).toContain('npm ci --ignore-scripts');
    expect(steps).toContain('working-directory: .github/npm-cli');
    expect(steps).toContain('.github/npm-cli/node_modules/.bin/npm publish --access public');
    const cli = JSON.parse(
      readFileSync(join(repoRoot, '.github/npm-cli/package.json'), 'utf8'),
    ) as {
      dependencies: { npm: string };
    };
    const pinned = exactVersion(cli.dependencies.npm);
    expect(pinned).not.toBeNull();
    if (!pinned) {
      return;
    }
    const [major, minor, patch] = pinned;
    const atOrAbove =
      major > 11 || (major === 11 && minor > 5) || (major === 11 && minor === 5 && patch >= 1);
    expect(atOrAbove).toBe(true);
    const shrink = JSON.parse(
      readFileSync(join(repoRoot, '.github/npm-cli/npm-shrinkwrap.json'), 'utf8'),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };
    expect(shrink.packages['node_modules/npm']?.version).toBe(cli.dependencies.npm);
    expect(shrink.packages['node_modules/npm']?.integrity).toMatch(/^sha512-/);
  });

  it('installs the image pnpm CLI with npm ci against a shrinkwrap', () => {
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('npm ci --ignore-scripts');
    expect(dockerfile).not.toContain('npm install -g pnpm@');
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const cli = JSON.parse(
      readFileSync(join(repoRoot, 'docker/pnpm-cli/package.json'), 'utf8'),
    ) as {
      dependencies: { pnpm: string };
    };
    expect(`pnpm@${cli.dependencies.pnpm}`).toBe(root.packageManager);
    const shrink = JSON.parse(
      readFileSync(join(repoRoot, 'docker/pnpm-cli/npm-shrinkwrap.json'), 'utf8'),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };
    expect(shrink.packages['node_modules/pnpm']?.version).toBe(cli.dependencies.pnpm);
    expect(shrink.packages['node_modules/pnpm']?.integrity).toMatch(/^sha512-/);
  });

  it('prepares the packageManager pnpm by its tarball hash in the alpine image and the Cursor install', () => {
    // Corepack checks the download against a +sha512.<hex> suffix. The hash is the
    // shrinkwrap integrity the Debian image installs, so all three move together.
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const shrink = JSON.parse(
      readFileSync(join(repoRoot, 'docker/pnpm-cli/npm-shrinkwrap.json'), 'utf8'),
    ) as { packages: Record<string, { integrity?: string }> };
    const integrity = shrink.packages['node_modules/pnpm']?.integrity ?? '';
    const hex = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
    const pins = ['Dockerfile.alpine', '.cursor/environment.json'].map((file) => [
      file,
      readFileSync(join(repoRoot, file), 'utf8').match(/corepack prepare (pnpm@[^\s"]+)/)?.[1],
    ]);
    expect(pins).toEqual([
      ['Dockerfile.alpine', `${root.packageManager}+sha512.${hex}`],
      ['.cursor/environment.json', `${root.packageManager}+sha512.${hex}`],
    ]);
  });

  it('pins the mcp-publisher archive hash in the install step', () => {
    const step = releaseStep(releaseYml, 'Install mcp-publisher');
    expect(step).not.toContain('releases/latest');
    expect(step).toMatch(/\b[0-9a-f]{64}\b/);
    expect(step).toContain('sha256sum -c');
  });

  it('retries MCP publish only while npm has not propagated the version', () => {
    const step = releaseStep(releaseYml, 'Publish to MCP Registry');
    const marker = npmRetryMarker(step);
    const unmatched = step.indexOf('if ! grep -F -q');
    const exitStatus = step.indexOf('exit "$status"', unmatched);
    expect(step).toContain('./mcp-publisher publish');
    expect(step).toContain('attempts=6');
    expect(step).toContain('pause=20');
    expect(step).toContain('for ((attempt = 1; attempt <= attempts; attempt++)); do');
    expect(unmatched).toBeGreaterThan(step.indexOf('./mcp-publisher publish'));
    expect(exitStatus).toBeGreaterThan(unmatched);
    expect(step.indexOf('sleep "$pause"')).toBeGreaterThan(exitStatus);
    expect(step.slice(unmatched, exitStatus)).not.toContain('sleep');
    expect(marker.length).toBeGreaterThan(0);
    const docker = jobSections(releaseYml).find((job) =>
      job.includes('goreleaser/goreleaser-action@'),
    );
    expect(docker).toContain('needs: [npm, mcp]');
    expect(docker).toContain("needs.mcp.result == 'success'");
  });
});

/** The step's one-line `run:` command, as the runner would execute it. */
function runLine(step: string): string {
  const match = step.match(/^ {8}run: (?!\|)(.+)$/m);
  if (!match) {
    throw new Error('step has no one-line run');
  }
  return match[1];
}

describe('release version selection', () => {
  // The stamp refuses an empty or ref-shaped version, so a tag push breaks unless the step falls back to the tag.
  it.each([
    { event: 'tag push', ref: 'refs/tags/v1.4.2', inputVersion: '', version: '1.4.2' },
    { event: 'manual run', ref: 'refs/heads/develop', inputVersion: '2.0.0', version: '2.0.0' },
  ])('should hand the server.json stamp $version on a $event', ({ ref, inputVersion, version }) => {
    const step = releaseStep(releaseYml, 'Set version in server.json');
    const temp = mkdtempSync(join(tmpdir(), 'mailoo-server-json-step-'));
    try {
      mkdirSync(join(temp, 'scripts'));
      writeFileSync(join(temp, 'scripts/bump-server-json-version.sh'), 'printf "%s\\n" "$1"\n');
      // A run step without `shell:` gets `bash -e {0}` on the runner.
      const stamped = execFileSync('bash', ['-e', '-c', runLine(step)], {
        cwd: temp,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          ...refEnv(ref),
          ...stepEnv(step, { 'inputs.version': inputVersion }),
        },
      });
      expect(stamped).toBe(`${version}\n`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('should run the server.json stamp step on every release event', () => {
    // A tag push and a manual run both publish, so a step-level if: would ship one of them unstamped.
    expect(releaseStep(releaseYml, 'Set version in server.json')).not.toMatch(/^ {8}if:/m);
  });
});

const workflowDir = join(repoRoot, '.github/workflows');

describe('pinned GitHub Actions', () => {
  it('pins every uses: to a commit SHA with the version tag in a comment', () => {
    const files = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    const pin = /^\s*(?:-\s*)?uses:\s+\S+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/;
    const unpinned: string[] = [];
    for (const name of files) {
      const uses = readFileSync(join(workflowDir, name), 'utf8')
        .split('\n')
        .filter((line) => /^\s*(?:-\s*)?uses:/.test(line));
      for (const line of uses) {
        if (!pin.test(line)) {
          unpinned.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(unpinned).toEqual([]);
  });
});

describe('workflow shell input', () => {
  // An expression inside run: is pasted into the script before bash parses it,
  // so a crafted value runs as code. An env: value reaches bash as data. A pushed
  // branch or tag name can hold shell syntax just like a dispatch input.
  // The name can sit anywhere before the closing }}, even after a lone } such as format's {0}.
  const untrusted =
    /\$\{\{(?:[^}]|\}(?!\}))*\b(?:inputs\.|github\.event\.|github\.(?:head_ref|base_ref|ref(?:_name)?)\b)/;
  // A concurrency group is a name the runner compares, never a script.
  const allowed = /^\s*(?:if|group|[A-Z][A-Z0-9_]*):\s/;

  /** Line ranges of each run: key with its deeper lines, the whole script the runner hands bash. */
  function runRanges(lines: string[]): [number, number][] {
    return lines.flatMap((line, start): [number, number][] => {
      const key = line.match(/^(\s*(?:- )?)run:/);
      if (!key) {
        return [];
      }
      let end = start + 1;
      while (
        end < lines.length &&
        (!lines[end].trim() || lines[end].search(/\S/) > key[1].length)
      ) {
        end += 1;
      }
      return [[start, end]];
    });
  }

  /**
   * The workflow text that pastes an untrusted expression into code. A run: script is
   * matched whole: an expression can span lines, and a script line can look like an env key.
   */
  function shellPastes(yaml: string): string[] {
    const lines = yaml.split('\n');
    const runs = runRanges(lines);
    const inRun = (index: number) => runs.some(([start, end]) => index >= start && index < end);
    return [
      ...runs
        .map(([start, end]) => lines.slice(start, end).join('\n'))
        .filter((script) => untrusted.test(script)),
      ...lines.filter(
        (line, index) => !inRun(index) && untrusted.test(line) && !allowed.test(line),
      ),
    ].map((text) => text.trim());
  }

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: values are workflow lines with GitHub expressions, not JS templates
  it.each([
    'run: echo "${{ github.ref_name }}"',
    'run: git tag -d "${{ github.ref }}"',
    'run: echo "${{ github.head_ref }}"',
    'run: echo "${{ github.base_ref }}"',
    'run: echo "${{ github.event.pull_request.title }}"',
    'run: bash stamp.sh "${{ inputs.version }}"',
    'run: |\n  echo "${{\n    github.head_ref }}"',
    'run: |\n  cat <<EOF\n  REF: ${{ github.ref }}\n  EOF',
    '- run: |\n    echo "${{\n      github.head_ref }}"',
    '- run: |\n    cat <<EOF\n    REF: ${{ github.ref }}\n    EOF',
    'run: |\n  echo ok\n\n  cat <<EOF\n  REF: ${{ github.ref }}\n  EOF',
    'run: echo "${{ format(\'v{0}\', github.head_ref) }}"',
    'run: echo "${{ fromJSON(inputs.matrix).name }}"',
    'script: core.info("${{ github.head_ref }}")',
    'script: core.info("REF: ${{ github.head_ref }}")',
  ])('should flag %j as an untrusted expression pasted into code', (yaml) => {
    expect(shellPastes(yaml)).not.toEqual([]);
  });

  it.each([
    'GITHUB_REF_NAME: ${{ github.ref_name }}',
    'K8S_NS: ${{ inputs.namespace }}',
    "if: ${{ github.ref == 'refs/heads/develop' }}",
    'group: ${{ github.workflow }}-${{ github.ref }}',
    'run: echo "${{ github.ref_type }}"',
    '  run: echo "$REF"\n  env:\n    REF: ${{ github.ref }}',
  ])('should pass %j as a value no shell or script parses', (yaml) => {
    expect(shellPastes(yaml)).toEqual([]);
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of workflow lines

  it('should expand inputs, event fields and ref names only in if:, env: and group: lines', () => {
    const files = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    const inline = files.flatMap((name) =>
      shellPastes(readFileSync(join(workflowDir, name), 'utf8')).map((text) => `${name}: ${text}`),
    );
    expect(inline).toEqual([]);
  });
});

function workflowName(yaml: string): string {
  const match = yaml.match(/^name:\s*(\S+)\s*$/m);
  if (!match) {
    throw new Error('missing name');
  }
  return match[1];
}

/** Job keys are indented, so a column-0 match stays on the workflow permissions. */
function topLevelPermissions(yaml: string): string {
  const match = yaml.match(/^permissions:[^\n]*(?:\n {2}[^\n]*)*/m);
  if (!match) {
    throw new Error('missing top-level permissions');
  }
  return match[0];
}

function weeklyCron(yaml: string): string[] {
  const match = yaml.match(/cron:\s*"([^"]+)"/);
  if (!match) {
    throw new Error('missing cron');
  }
  return match[1].split(/\s+/);
}

describe('code scanning workflows', () => {
  it('runs CodeQL on develop pull requests, develop pushes, and weekly', () => {
    const path = join(workflowDir, 'codeql.yml');
    const yaml = readFileSync(path, 'utf8');
    expect(workflowName(yaml)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(topLevelPermissions(yaml)).not.toMatch(/write/);
    expect(topLevelPermissions(yaml)).toContain('contents: read');
    const analyzeJobs = jobSections(yaml).filter((job) =>
      job.includes('github/codeql-action/analyze@'),
    );
    expect(analyzeJobs).toHaveLength(1);
    expect(analyzeJobs[0]).toContain('contents: read');
    expect(analyzeJobs[0]).toContain('security-events: write');
    expect(yaml.replace(analyzeJobs[0], '')).not.toContain('security-events: write');
    const on = onBlock(yaml);
    expect(on).toContain('pull_request:');
    expect(on).toContain('develop');
    expect(on).toContain('schedule:');
    expect(on).toContain('workflow_dispatch:');
    expect(on).toMatch(/push:\n\s+branches:\s*\[develop\]/);
    const cron = weeklyCron(yaml);
    expect(cron).toHaveLength(5);
    expect(cron[2]).toBe('*');
    expect(cron[3]).toBe('*');
    expect(cron[4]).toMatch(/^[0-6]$/);
    expect(yaml).toContain('languages: javascript-typescript');
    expect(yaml).toContain('github/codeql-action/init@');
    expect(yaml).toContain('github/codeql-action/analyze@');
  });

  it('runs OpenSSF Scorecard weekly and when branch protection changes', () => {
    const path = join(workflowDir, 'scorecard.yml');
    const yaml = readFileSync(path, 'utf8');
    expect(workflowName(yaml)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(topLevelPermissions(yaml)).not.toMatch(/write/);
    const jobs = jobSections(yaml);
    const scorecardJobs = jobs.filter((job) => job.includes('ossf/scorecard-action@'));
    expect(scorecardJobs).toHaveLength(1);
    expect(scorecardJobs[0]).toContain('id-token: write');
    expect(scorecardJobs[0]).toContain('security-events: write');
    expect(scorecardJobs[0]).toContain('actions: read');
    expect(scorecardJobs[0]).not.toContain('contents: write');
    expect(scorecardJobs[0]).not.toContain('packages: write');
    expect(yaml.replace(scorecardJobs[0], '')).not.toContain('id-token: write');
    const on = onBlock(yaml);
    expect(on).toContain('schedule:');
    expect(on).toContain('branch_protection_rule:');
    expect(on).not.toMatch(/^\s+push:/m);
    const cron = weeklyCron(yaml);
    expect(cron).toHaveLength(5);
    expect(cron[2]).toBe('*');
    expect(cron[3]).toBe('*');
    expect(cron[4]).toMatch(/^[0-6]$/);
    expect(yaml).toContain('ossf/scorecard-action@');
  });
});

describe('workflow token is no wider than the job writes', () => {
  it('gives CodeQL security-events write and no other write scope', () => {
    const yaml = readFileSync(join(workflowDir, 'codeql.yml'), 'utf8');
    const analyze = jobSections(yaml).find((job) => job.includes('github/codeql-action/analyze@'));
    expect(analyze).toContain('contents: read');
    expect(analyze).toContain('security-events: write');
    expect(analyze).not.toContain('contents: write');
    expect(analyze).not.toContain('packages: write');
    expect(analyze).not.toContain('id-token:');
  });

  it('lets GHCR push jobs write packages and not repository contents', () => {
    for (const name of ['docker-sha.yml', 'docker-rebuild.yml']) {
      const yaml = readFileSync(join(workflowDir, name), 'utf8');
      expect(topLevelPermissions(yaml)).not.toMatch(/write/);
      const pushJobs = jobSections(yaml).filter((job) => job.includes('push: true'));
      expect(pushJobs.length).toBeGreaterThan(0);
      for (const job of pushJobs) {
        expect(job).toContain('packages: write');
        expect(job).toContain('contents: read');
        expect(job).not.toContain('contents: write');
        expect(job).not.toContain('security-events:');
        expect(job).not.toContain('id-token:');
      }
    }
  });

  it('keeps contents write on the GoReleaser job and id-token on the publish jobs', () => {
    const jobs = jobSections(releaseYml);
    const npm = jobs.find((job) => job.includes('npm publish'));
    const mcp = jobs.find((job) => job.includes('mcp-publisher publish'));
    const docker = jobs.find((job) => job.includes('goreleaser/goreleaser-action@'));
    expect(npm).toContain('id-token: write');
    expect(npm).toContain('contents: read');
    expect(npm).not.toContain('contents: write');
    expect(npm).not.toContain('packages: write');
    expect(mcp).toContain('id-token: write');
    expect(mcp).not.toContain('contents: write');
    expect(mcp).not.toContain('packages: write');
    expect(docker).toContain('contents: write');
    expect(docker).toContain('packages: write');
    expect(docker).not.toContain('id-token:');
    expect(docker).not.toContain('security-events:');
  });

  it('does not grant ci.yml any write scope', () => {
    expect(ciYml).not.toMatch(/:\s*write\b/);
    expect(topLevelPermissions(ciYml)).toContain('contents: read');
  });
});

describe('workflow token scope', () => {
  it('does not grant write at the workflow level', () => {
    const files = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const yaml = readFileSync(join(workflowDir, name), 'utf8');
      expect(topLevelPermissions(yaml), name).not.toMatch(/\bwrite\b/);
    }
  });
});

describe('docker rebuild images', () => {
  it('rebuilds bookworm and alpine for the release architectures', () => {
    const yaml = readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8');
    expect(yaml).toContain('docker/setup-qemu-action@');
    expect(yaml).toContain('-alpine');
    expect(yaml).toContain(':bookworm');
    expect(yaml).toContain(':latest');
    expect(yaml).not.toContain('sha-${{');
    expect(topLevelPermissions(yaml)).not.toMatch(/write/);
    const jobs = jobSections(yaml);
    expect(jobs.some((job) => job.includes('packages: write'))).toBe(true);
  });
});

/** Each pnpm-lock.yaml package with its peerDependencies ranges, read as text like the rest of this file. */
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

function lockPeerRange(holder: string, peer: string): string {
  const ranges = lockPeers
    .filter((entry) => entry.name === holder)
    .map((entry) => entry.peers[peer]);
  if (ranges.length !== 1 || ranges[0] === undefined) {
    throw new Error(`expected one ${holder} with a ${peer} peer range in pnpm-lock.yaml`);
  }
  return ranges[0];
}

/** The first version a peer range shuts out: `^9.0.0` → 10.0.0, `>=4.8.4 <6.1.0` → 6.1.0. Other shapes throw. */
function peerCeiling(range: string): string {
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
function nextMajor(name: string): string {
  const range = pkg.dependencies[name] ?? pkg.devDependencies[name] ?? '';
  const major = range.match(/^[\^~]?(\d+)\./)?.[1];
  if (!major) {
    throw new Error(`package.json has no versioned ${name}`);
  }
  return `${Number(major) + 1}.0.0`;
}

describe('dependabot groups', () => {
  const config = readFileSync(join(repoRoot, '.github/dependabot.yml'), 'utf8');
  /** Each group's name and settings, read as text: the repo has no YAML parser, so lists stay inline and double-quoted. */
  const groups = [...config.matchAll(/^ {6}([\w-]+):\n((?: {8}.*\n)+)/gm)].map(
    (match) => [match[1], match[2]] as const,
  );

  function group(name: string): string {
    const found = groups.find(([key]) => key === name);
    if (!found) {
      throw new Error(`missing group ${name}`);
    }
    return found[1];
  }

  it('keeps every dependency still on 0.x out of its update group', () => {
    // Dependabot calls 0.25 → 0.27 a minor update, but on 0.x that can break the API (node-ical 0.27 did).
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
      'dependencies' | 'devDependencies',
      Record<string, string>
    >;
    const onZero = (deps: Record<string, string>) =>
      Object.keys(deps)
        .filter((name) => /^[\^~]?0\./.test(deps[name]))
        .sort();
    const excluded = (name: string) => {
      const list = group(name).match(/^ {8}exclude-patterns: \[(.*)\]$/m)?.[1] ?? '';
      return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    };
    expect({
      production: excluded('production-dependencies'),
      development: excluded('dev-dependencies'),
    }).toEqual({
      production: onZero(manifest.dependencies),
      development: onZero(manifest.devDependencies),
    });
  });

  it('should update every npm manifest the repository tracks', () => {
    // With only / listed, the release npm CLI and the image pnpm CLI never got an update.
    const manifests = execFileSync('git', ['ls-files', '--', 'package.json', '**/package.json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((file) => `/${dirname(file)}`.replace(/\/\.$/, '/'));
    const covered = config
      .split(/\n {2}- package-ecosystem: /)
      .filter((entry) => entry.startsWith('npm\n'))
      .flatMap((entry) => {
        const list = entry.match(/^ {4}directories: \[(.*)\]$/m)?.[1];
        const single = entry.match(/^ {4}directory: (\S+)$/m)?.[1];
        return list ? [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]) : [single];
      });
    expect(manifests.filter((dir) => !covered.includes(dir))).toEqual([]);
  });

  it('should hold each blocked major at the first version its holder rules out', () => {
    // A missing hold lets Dependabot open a major that breaks lint or the build. A hold at the
    // manifest's own major blocks that major's patches too. Every npm update is read: the
    // tooling CLI update holds nothing, so a hold added there has to be derived here as well.
    const npmUpdates = config
      .split(/\n {2}- package-ecosystem: /)
      .filter((entry) => entry.startsWith('npm\n'))
      .join('\n');
    const held = Object.fromEntries(
      [
        ...npmUpdates.matchAll(
          /^ {6}- dependency-name: "([^"]+)"\n {8}versions: \[">=(\d+\.\d+\.\d+)"\]$/gm,
        ),
      ].map(([, name, floor]) => [name, floor]),
    );
    const eslintCeiling = peerCeiling(lockPeerRange('eslint-config-airbnb-extended', 'eslint'));
    expect(held).toEqual({
      eslint: eslintCeiling,
      '@eslint/js': eslintCeiling,
      typescript: peerCeiling(lockPeerRange('typescript-eslint', 'typescript')),
      vite: nextMajor('vite'),
      '@types/node': nextMajor('@types/node'),
    });
  });

  it('groups only minor and patch updates', () => {
    // A major can break the API, so it gets its own pull request instead of holding back a group.
    expect(groups.length).toBeGreaterThan(0);
    expect(
      groups.map(([name, block]) => [name, block.match(/^ {8}update-types: (.*)$/m)?.[1]]),
    ).toEqual(groups.map(([name]) => [name, '[minor, patch]']));
  });
});
