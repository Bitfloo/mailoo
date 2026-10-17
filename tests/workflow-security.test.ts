import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { jobSections, onBlock, topLevelPermissions, workflowDir } from './workflow-yaml.js';

const ciYml = readFileSync(join(workflowDir, 'ci.yml'), 'utf8');

function workflowName(yaml: string): string {
  const match = yaml.match(/^name:\s*(\S+)\s*$/m);
  if (!match) {
    throw new Error('missing name');
  }
  return match[1];
}

function weeklyCron(yaml: string): string[] {
  const match = yaml.match(/cron:\s*"([^"]+)"/);
  if (!match) {
    throw new Error('missing cron');
  }
  return match[1].split(/\s+/);
}

const codeqlYml = readFileSync(join(workflowDir, 'codeql.yml'), 'utf8');
const scorecardYml = readFileSync(join(workflowDir, 'scorecard.yml'), 'utf8');
const analyzeJobs = jobSections(codeqlYml).filter((job) =>
  job.includes('github/codeql-action/analyze@'),
);
const scorecardJobs = jobSections(scorecardYml).filter((job) =>
  job.includes('ossf/scorecard-action@'),
);

describe('code scanning workflows', () => {
  it('should name the CodeQL workflow in lowercase kebab-case', () => {
    expect(workflowName(codeqlYml)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('should hold the CodeQL workflow token at contents read', () => {
    expect(topLevelPermissions(codeqlYml)).not.toMatch(/write/);
    expect(topLevelPermissions(codeqlYml)).toContain('contents: read');
  });

  it('should run CodeQL analysis in exactly one job', () => {
    expect(analyzeJobs).toHaveLength(1);
  });

  it('should run CodeQL on develop pull requests', () => {
    expect(onBlock(codeqlYml)).toContain('pull_request:');
    expect(onBlock(codeqlYml)).toContain('develop');
  });

  it('should run CodeQL on develop pushes', () => {
    expect(onBlock(codeqlYml)).toMatch(/push:\n\s+branches:\s*\[develop\]/);
  });

  it('should run CodeQL on a weekly schedule', () => {
    expect(onBlock(codeqlYml)).toContain('schedule:');
    const cron = weeklyCron(codeqlYml);
    expect(cron).toHaveLength(5);
    expect(cron[2]).toBe('*');
    expect(cron[3]).toBe('*');
    expect(cron[4]).toMatch(/^[0-6]$/);
  });

  it('should let a maintainer start CodeQL by hand', () => {
    expect(onBlock(codeqlYml)).toContain('workflow_dispatch:');
  });

  it('should analyze javascript-typescript with the CodeQL init and analyze actions', () => {
    expect(codeqlYml).toContain('languages: javascript-typescript');
    expect(codeqlYml).toContain('github/codeql-action/init@');
    expect(codeqlYml).toContain('github/codeql-action/analyze@');
  });

  it('should name the Scorecard workflow in lowercase kebab-case', () => {
    expect(workflowName(scorecardYml)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('should keep write scopes off the Scorecard workflow token', () => {
    expect(topLevelPermissions(scorecardYml)).not.toMatch(/write/);
  });

  it('should run the Scorecard action in exactly one job', () => {
    expect(scorecardJobs).toHaveLength(1);
    expect(scorecardYml).toContain('ossf/scorecard-action@');
  });

  it('should run Scorecard on a weekly schedule', () => {
    expect(onBlock(scorecardYml)).toContain('schedule:');
    const cron = weeklyCron(scorecardYml);
    expect(cron).toHaveLength(5);
    expect(cron[2]).toBe('*');
    expect(cron[3]).toBe('*');
    expect(cron[4]).toMatch(/^[0-6]$/);
  });

  it('should run Scorecard when branch protection changes', () => {
    expect(onBlock(scorecardYml)).toContain('branch_protection_rule:');
  });

  it('should not run Scorecard on push', () => {
    expect(onBlock(scorecardYml)).not.toMatch(/^\s+push:/m);
  });
});

/** A job's own token: the scope: level lines of its permissions block, or a one-line value such as write-all. */
function jobToken(job: string): string[] {
  const block = job.match(/^ {4}permissions:(.*)((?:\n {6}.*)*)/m);
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

describe('workflow job reader', () => {
  it('should read a job key with an underscore, a comment or quotes as its own job', () => {
    // The first key needs no split, so each form under test follows another job.
    const yaml =
      'jobs:\n  a:\n    runs-on: x\n  b_c:\n    runs-on: x\n  d: # note\n    runs-on: x\n  "e":\n    runs-on: x\n';
    expect(jobSections(yaml).map(jobKey)).toEqual(['a', 'b_c', 'd', 'e']);
  });

  it('should refuse a jobs block with a job key it cannot split on', () => {
    // The roster below would otherwise read a flow-style job as part of the job above it.
    expect(() => jobSections('jobs:\n  a:\n    runs-on: x\n  b: { runs-on: x }\n')).toThrow(
      'read 1 of 2 jobs',
    );
  });
});

describe('workflow token is no wider than the job writes', () => {
  it('should give every workflow job exactly the token scopes this roster lists', () => {
    // Read from the tree, so a new workflow, a new job or a new scope at any level fails until listed here.
    const roster = Object.fromEntries(
      readdirSync(workflowDir)
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => [
          name,
          Object.fromEntries(
            jobSections(readFileSync(join(workflowDir, name), 'utf8')).map((job) => [
              jobKey(job),
              jobToken(job),
            ]),
          ),
        ]),
    );
    expect(roster).toEqual({
      'ci.yml': { check: [], docker: [], integration: [], 'public-log': [] },
      'codeql.yml': { analyze: ['contents: read', 'security-events: write'] },
      'docker-rebuild.yml': { rebuild: ['contents: read', 'packages: write'] },
      'docker-sha.yml': { 'sha-images': ['contents: read', 'packages: write'] },
      'release.yml': {
        npm: ['contents: read', 'id-token: write'],
        mcp: ['contents: read', 'id-token: write'],
        docker: ['contents: write', 'packages: write'],
      },
      'scorecard.yml': {
        analysis: ['actions: read', 'contents: read', 'id-token: write', 'security-events: write'],
      },
    });
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
