import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  descriptionBlock,
  readTwinAgent,
  repoRoot,
  SYSTEM_PROMPT_MAX_WORDS,
  systemPromptWords,
  toolsList,
  USER_DESCRIPTION_MAX_CHARS,
} from './agent-file.js';

const doctrinePath = join(repoRoot, '.claude/rules/testing-doctrine.md');
const { claude, cursor } = readTwinAgent('test-auditor');

describe('test-auditor L4 doctrine', () => {
  it('keeps the Claude Code and Cursor copies byte-identical', () => {
    expect(claude).toBe(cursor);
  });

  it('grounds on the Mailoo doctrine file that exists in this clone', () => {
    expect(existsSync(doctrinePath)).toBe(true);
    expect(claude).toContain('.claude/rules/testing-doctrine.md');
    expect(claude).toContain('ABORTED: testing doctrine missing');
  });

  it('stays inside the user-class description budget', () => {
    expect(descriptionBlock(claude).length).toBeGreaterThan(10);
    expect(descriptionBlock(claude).length).toBeLessThanOrEqual(USER_DESCRIPTION_MAX_CHARS);
  });

  it('routes Polish and English audit phrases and defers authorship', () => {
    const description = descriptionBlock(claude);
    expect(description).toContain('Trigger:');
    expect(description).toMatch(/oceń te testy/);
    expect(description).toMatch(/audit these tests/);
    expect(description).toMatch(/NOT:.*test-smith/);
  });

  it('declares auditor identity, sonnet tier, and yellow color', () => {
    expect(claude).toMatch(/^name: test-auditor$/m);
    expect(claude).toMatch(/^model: sonnet$/m);
    expect(claude).toMatch(/^color: yellow$/m);
    expect(claude).toMatch(/^dispatch: user$/m);
    expect(claude).toMatch(/^effort: high$/m);
  });

  it('allows Edit for mutants but never Write or nested dispatch', () => {
    const tools = toolsList(claude);
    expect(tools).toEqual(['Read', 'Edit', 'Bash', 'Grep', 'Glob']);
    expect(claude).toMatch(/You have no Write tool/);
    expect(claude).toMatch(/Do not spawn nested subagents/);
    expect(claude).not.toMatch(/via the Agent tool/);
  });

  it('refuses a dirty target and restores with inverse Edit', () => {
    expect(claude).toContain('git status --short <target>');
    expect(claude).toContain('NEEDS_INPUT: commit or stash <target> first');
    expect(claude).toContain('Edit then inverse Edit');
    expect(claude).toContain('git diff --stat -- <target>');
    expect(claude).toContain('NEVER stage, commit, install, or push');
  });

  it('binds the Mailoo runners and refuses the CLI probe', () => {
    expect(claude).toContain('pnpm test -- <file>');
    expect(claude).toContain('pnpm test:integration -- <file>');
    expect(claude).toContain('`mailoo test` is a CLI connection probe, not this runner');
    expect(claude).toContain('package.json` (runner — never infer it)');
    expect(claude).toContain('No browser automation');
  });

  it('requires C1 and C2 before the rest of the rubric', () => {
    expect(claude).toContain('C1 and C2 first');
    expect(claude).toContain('C1–C10');
    expect(claude).toContain('C1 and C2 were attempted');
    expect(claude).toContain('cite by section');
    expect(claude).toContain('Never repair');
  });

  it('emits a SCORE/VERDICT block with a CRITICAL veto', () => {
    expect(claude).toContain('SCORE: N/10');
    expect(claude).toContain('VERDICT: PASS | FAIL | ABORTED: <reason> | NEEDS_INPUT: <what>');
    expect(claude).toContain('DETECTION:');
    expect(claude).toContain('FINDINGS:');
    expect(claude).toContain('UNAUDITED:');
    expect(claude).toContain('TREE:');
    expect(claude).toContain('ABORTED: runner unresolved');
    expect(claude).toMatch(/PASS if score ≥ 6 AND zero CRITICAL/);
  });

  it('keeps the generated system prompt (excluding When to invoke) inside the 500-word cap', () => {
    expect(systemPromptWords(claude).length).toBeLessThanOrEqual(SYSTEM_PROMPT_MAX_WORDS);
  });

  it('does not cite CBC plugin paths in the agent file', () => {
    expect(claude).not.toContain('_knowledge/testing-doctrine.md');
    expect(claude).not.toContain('skills/cbc-internals');
    expect(claude).not.toContain('rules/cbc-engineering-principles.md');
    expect(claude).not.toMatch(/\/Users\//);
  });
});
