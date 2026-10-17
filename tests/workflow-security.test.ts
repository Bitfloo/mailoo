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
