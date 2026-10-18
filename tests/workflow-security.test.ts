import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, YAMLParseError } from 'yaml';

import {
  jobSections,
  onBlock,
  readKeyLines,
  topLevelPermissions,
  triggers,
  unreadKeys,
  workflowDir,
  workflowFiles,
  workflowTexts,
} from './workflow-yaml.js';

const ciYml = readFileSync(join(workflowDir, 'ci.yml'), 'utf8');

function weeklyCron(yaml: string): string[] {
  const match = yaml.match(/cron:\s*"([^"]+)"/);
  if (!match) {
    throw new Error('missing cron');
  }
  return match[1].split(/\s+/);
}

const codeqlYml = readFileSync(join(workflowDir, 'codeql.yml'), 'utf8');
const scorecardYml = readFileSync(join(workflowDir, 'scorecard.yml'), 'utf8');

describe('code scanning workflows', () => {
  it('should run CodeQL on develop pull requests', () => {
    expect(onBlock(codeqlYml)).toMatch(/^ {2}pull_request:\n {4}branches: \[develop\]$/m);
  });

  it('should run CodeQL on develop pushes', () => {
    expect(onBlock(codeqlYml)).toMatch(/push:\n\s+branches:\s*\[develop\]/);
  });

  it('should let a maintainer start CodeQL by hand', () => {
    expect(onBlock(codeqlYml)).toContain('workflow_dispatch:');
  });

  it('should run Scorecard only on its schedule and when branch protection changes', () => {
    expect(triggers(scorecardYml)).toEqual(['  schedule:', '  branch_protection_rule:']);
  });
});

describe('dependency installs', () => {
  it('should install from the lockfile wherever a workflow runs pnpm install', () => {
    const installs = workflowFiles().flatMap((name) =>
      [...readFileSync(join(workflowDir, name), 'utf8').matchAll(/\bpnpm (?:install|i)\b.*/g)].map(
        (match) => match[0],
      ),
    );
    expect([...new Set(installs)]).toEqual(['pnpm install --frozen-lockfile']);
  });
});

describe('scheduled workflows', () => {
  // Each scheduled run spends runner minutes, so every schedule is one fixed time a week. Read
  // from the tree, so a schedule added to any workflow is checked here.
  const scheduled = workflowTexts().filter(
    ([, yaml]) => (parse(yaml) as { on?: { schedule?: unknown } }).on?.schedule !== undefined,
  );

  it.each(scheduled)('should run %s on a weekly schedule', (_, yaml) => {
    const [digits, weekday] = [expect.stringMatching(/^\d+$/), expect.stringMatching(/^[0-6]$/)];
    expect(weeklyCron(yaml)).toEqual([digits, digits, '*', '*', weekday]);
  });

  it.each(scheduled)('should schedule %s exactly once', (_, yaml) => {
    // The weekly check reads the first cron only, so a second one would run unchecked.
    expect(readKeyLines(yaml, 'cron')).toHaveLength(1);
  });
});

/**
 * The token a permissions key at this indent grants: the scope: level lines of its block, or a
 * one-line value such as write-all. Indent 0 reads the workflow token, indent 4 a job's own.
 */
function token(text: string, indent: number): string[] {
  const block = text.match(
    new RegExp(`^ {${indent}}permissions:(.*)((?:\\n {${indent + 2}}.*)*)`, 'm'),
  );
  if (!block) {
    return [];
  }
  if (block[1].trim()) {
    return [block[1].trim()];
  }
  return block[2]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .sort();
}

function jobKey(job: string): string | undefined {
  return job.match(/^ {2}(["']?)([\w-]+)\1:/)?.[2];
}

describe('workflow file, job and key readers', () => {
  it.each([
    ['"continue-on\\x2Derror": true', ['"continue-on\\x2Derror": true']],
    ['? if\n: false', ['? if']],
    ['- { "uses"\n    : a/b@v4 }', ['- { "uses"']],
    ['k: &n uses\n*n : a/b@v4', ['*n : a/b@v4']],
    ['- &s { run: x }\n- *s', ['- *s']],
    ['? [if]\n: false', ['? [if]']],
    ['- { run: "echo if: x", "\\x69f": false }', ['- { run: "echo if: x", "\\x69f": false }']],
  ])('should list %j as a key the text readers cannot see', (yaml, lines) => {
    expect(unreadKeys(yaml)).toEqual(lines);
  });

  it('should refuse to list a key in a text that holds a key the readers cannot see', () => {
    expect(() => readKeyLines('a: 1\n"\\x69f": x\n', 'a')).toThrow('"\\x69f": x');
  });

  it.each(['if: a\nif: b\n', 'a: 1\n---\nif: x\n', 'a:\n\tif: x\n', '"\\x69f": x\nb:\n\tc: 1\n'])(
    'should refuse %j as text the YAML parser rejects',
    (text) => {
      // A document the parser cannot read whole could hide a key from the guard.
      expect(() => readKeyLines(text, 'if')).toThrow(YAMLParseError);
    },
  );

  it('should not read a key that only ends in the name', () => {
    expect(readKeyLines('a-if: 1\n', 'if')).toEqual([]);
  });

  it('should pass plain, quoted, flow, spaced and symbol keys', () => {
    expect(unreadKeys('a:\n  - { uses: a/b, \'with\': { x: 1 } }\n  - "if" : y\na+b: 1\n')).toEqual(
      [],
    );
  });

  it('should read a job key with an underscore, a comment or quotes as its own job', () => {
    // The first key needs no split, so each form under test follows another job.
    const yaml =
      'jobs:\n  a:\n    runs-on: x\n  b_c:\n    runs-on: x\n  d: # note\n    runs-on: x\n  "e":\n    runs-on: x\n  \'f\':\n    runs-on: x\n';
    expect(jobSections(yaml).map(jobKey)).toEqual(['a', 'b_c', 'd', 'e', 'f']);
  });

  it('should refuse a jobs block with a job key it cannot split on', () => {
    // The roster below would otherwise read a flow-style job as part of the job above it.
    expect(() => jobSections('jobs:\n  a:\n    runs-on: x\n  b: { runs-on: x }\n')).toThrow(
      'read 1 of 2 jobs',
    );
  });

  it('should list .yml and .yaml workflows and skip other files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailoo-workflows-'));
    try {
      ['c.txt', 'b.yaml', 'a.yml'].forEach((name) => {
        writeFileSync(join(dir, name), '');
      });
      expect(workflowFiles(dir)).toEqual(['a.yml', 'b.yaml']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should hand the rosters the text of every workflow file in the tree', () => {
    // The step, key and job rosters run over this list, so a file left out would be checked by none.
    expect(workflowTexts().map(([name]) => name)).toEqual(workflowFiles());
  });
});

describe('workflow token is no wider than the job writes', () => {
  it('should give every workflow job exactly the token scopes this roster lists', () => {
    // Read from the tree, so a new workflow, a new job or a new scope at any level fails until listed here.
    // (workflow) is the token of every job that sets none; no job id can take that name.
    const roster = Object.fromEntries(
      workflowFiles().map((name) => {
        const yaml = readFileSync(join(workflowDir, name), 'utf8');
        const jobs = jobSections(yaml).map((job) => [jobKey(job), token(job, 4)]);
        return [name, Object.fromEntries([['(workflow)', token(yaml, 0)], ...jobs])];
      }),
    );
    const read = ['contents: read'];
    expect(roster).toEqual({
      'ci.yml': { '(workflow)': read, check: [], docker: [], integration: [], 'public-log': [] },
      'codeql.yml': { '(workflow)': read, analyze: ['contents: read', 'security-events: write'] },
      'docker-rebuild.yml': { '(workflow)': read, rebuild: ['contents: read', 'packages: write'] },
      'docker-sha.yml': { '(workflow)': read, 'sha-images': ['contents: read', 'packages: write'] },
      'release.yml': {
        '(workflow)': read,
        npm: ['contents: read', 'id-token: write'],
        mcp: ['contents: read', 'id-token: write'],
        docker: ['contents: write', 'packages: write'],
      },
      'scorecard.yml': {
        '(workflow)': ['read-all'],
        analysis: ['actions: read', 'contents: read', 'id-token: write', 'security-events: write'],
      },
    });
  });

  it('should read every permissions key as a workflow or job token', () => {
    // The roster reads only a plain key at the workflow or job indent, so a quoted key would be a
    // token it reads as none.
    const unread = workflowFiles().flatMap((name) =>
      readKeyLines(readFileSync(join(workflowDir, name), 'utf8'), 'permissions')
        .filter((line) => !/^(?: {4})?permissions:/.test(line))
        .map((line) => `${name}: ${line.trim()}`),
    );
    expect(unread).toEqual([]);
  });

  it('should not grant ci.yml any write scope', () => {
    expect(ciYml).not.toMatch(/:\s*write\b/);
    expect(topLevelPermissions(ciYml)).toContain('contents: read');
  });
});

describe('workflow token scope', () => {
  it('should not grant write at the workflow level of any workflow', () => {
    for (const name of workflowFiles()) {
      const yaml = readFileSync(join(workflowDir, name), 'utf8');
      expect(topLevelPermissions(yaml), name).not.toMatch(/\bwrite\b/);
    }
  });
});
