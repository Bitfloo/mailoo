import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  jobSections,
  onBlock,
  releaseYml,
  topLevelPermissions,
  workflowDir,
} from './workflow-yaml.js';

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

  it('should let the CodeQL analyze job read contents and write security-events', () => {
    expect(analyzeJobs[0]).toContain('contents: read');
    expect(analyzeJobs[0]).toContain('security-events: write');
  });

  it('should keep security-events write off every CodeQL job but analyze', () => {
    expect(codeqlYml.replace(analyzeJobs[0], '')).not.toContain('security-events: write');
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

  it('should let the Scorecard job read actions', () => {
    expect(scorecardJobs[0]).toContain('actions: read');
  });

  it('should keep id-token write off every Scorecard workflow job but the analysis', () => {
    expect(scorecardYml.replace(scorecardJobs[0], '')).not.toContain('id-token: write');
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

/** Every scope the job's token may write, so a grant no test names fails the exact-set checks. */
function writeScopes(job?: string): string[] {
  return [...(job ?? '').matchAll(/^ +([\w-]+):\s*write\b/gm)].map((match) => match[1]).sort();
}

describe('workflow token is no wider than the job writes', () => {
  it('gives CodeQL security-events write and no other write scope', () => {
    expect(analyzeJobs[0]).toContain('contents: read');
    expect(writeScopes(analyzeJobs[0])).toEqual(['security-events']);
  });

  it('should give the Scorecard job id-token and security-events write and no other write scope', () => {
    expect(writeScopes(scorecardJobs[0])).toEqual(['id-token', 'security-events']);
  });

  it('lets GHCR push jobs write packages and not repository contents', () => {
    for (const name of ['docker-sha.yml', 'docker-rebuild.yml']) {
      const yaml = readFileSync(join(workflowDir, name), 'utf8');
      expect(topLevelPermissions(yaml)).not.toMatch(/write/);
      const pushJobs = jobSections(yaml).filter((job) => job.includes('push: true'));
      expect(pushJobs.length).toBeGreaterThan(0);
      for (const job of pushJobs) {
        expect(job).toContain('contents: read');
        expect(writeScopes(job), name).toEqual(['packages']);
      }
    }
  });

  it.each([
    { name: 'npm', marker: 'npm publish', scopes: ['id-token'] },
    { name: 'mcp', marker: 'mcp-publisher publish', scopes: ['id-token'] },
    { name: 'docker', marker: 'goreleaser/goreleaser-action@', scopes: ['contents', 'packages'] },
  ])('should let the release $name job write $scopes and no other scope', ({ marker, scopes }) => {
    const job = jobSections(releaseYml).find((section) => section.includes(marker));
    expect(writeScopes(job)).toEqual(scopes);
  });

  it('should let the npm job read the checkout it publishes', () => {
    expect(jobSections(releaseYml).find((job) => job.includes('npm publish'))).toContain(
      'contents: read',
    );
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
