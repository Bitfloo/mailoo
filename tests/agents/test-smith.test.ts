import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  descriptionBlock,
  readTwinAgent,
  repoRoot,
  systemPromptWords,
  toolsList,
} from './agent-file.js';

const doctrinePath = join(repoRoot, '.claude/rules/testing-doctrine.md');
const { claude, cursor } = readTwinAgent('test-smith');

describe('test-smith L4 doctrine', () => {
  it('keeps the Claude Code and Cursor copies byte-identical', () => {
    expect(claude).toBe(cursor);
  });

  it('grounds on the Mailoo doctrine file that exists in this clone', () => {
    expect(existsSync(doctrinePath)).toBe(true);
    expect(claude).toContain('.claude/rules/testing-doctrine.md');
    expect(claude).toMatch(/do not invent thresholds/);
  });

  it('stays inside the user-class description budget', () => {
    expect(descriptionBlock(claude).length).toBeGreaterThan(10);
    expect(descriptionBlock(claude).length).toBeLessThanOrEqual(800);
  });

  it('routes Polish and English authoring phrases and defers grading', () => {
    const description = descriptionBlock(claude);
    expect(description).toContain('Trigger:');
    expect(description).toMatch(/napisz testy/);
    expect(description).toMatch(/write tests for/);
    expect(description).toMatch(/NOT:.*test-auditor/);
  });

  it('declares smith identity, sonnet tier, and green color', () => {
    expect(claude).toMatch(/^name: test-smith$/m);
    expect(claude).toMatch(/^model: sonnet$/m);
    expect(claude).toMatch(/^color: green$/m);
    expect(claude).toMatch(/^dispatch: user$/m);
    expect(claude).toMatch(/^effort: high$/m);
  });

  it('may Write tests but must not grade existing suites as judgment', () => {
    const tools = toolsList(claude);
    expect(tools).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']);
    expect(claude).toMatch(/you never grade an existing suite as judgment/);
    expect(claude).toMatch(/[Nn]ever edit source to make a test pass/);
    expect(claude).toMatch(/Do not spawn nested subagents/);
    expect(claude).not.toMatch(/via the Agent tool/);
  });

  it('requires a quoted red artifact and inverse-Edit restore', () => {
    expect(claude).toContain('Red is quoted runner output');
    expect(claude).toContain('"Should fail" is not evidence');
    expect(claude).toContain('No test may pass with the tested code gone');
    expect(claude).toContain('inverse Edit');
    expect(claude).toContain('git status --short <target>');
    expect(claude).toContain('git diff --stat -- <target>');
    expect(claude).toContain('One file per mutant');
    expect(claude).toContain('NEEDS_INPUT: commit or stash <target> first');
    expect(claude).toContain('NEVER stage, commit, install, or push');
  });

  it('binds the Mailoo runners and refuses the CLI probe', () => {
    expect(claude).toContain('pnpm test -- <file>');
    expect(claude).toContain('pnpm test:integration -- <file>');
    expect(claude).toContain('`mailoo test` is a CLI connection probe, not this runner');
    expect(claude).toContain('package.json` (runner — never infer it)');
    expect(claude).toContain('No browser automation');
    expect(claude).toContain('Pick the layer from the doctrine table');
    expect(claude).toContain('Fixture from a production artifact');
    expect(claude).toContain('Pin env input');
    expect(claude).toContain('One behaviour per `it`');
    expect(claude).toContain('boundary, logic');
    expect(claude).toContain('A survivor is a task, not a statistic');
  });

  it('forbids mock-as-oracle, retry masking, and secret fixtures', () => {
    expect(claude).toContain('expect(mock).toHaveBeenCalled()');
    expect(claude).toContain('may never be the main assertion');
    expect(claude).toContain('No `retry:`');
    expect(claude).toContain('No credentials, no real domains');
    expect(claude).toContain('Never report a test count as quality');
  });

  it('emits a SHIPPED/GAPS block with red and mutation sections', () => {
    expect(claude).toContain('VERDICT: SHIPPED | GAPS | ABORTED: <reason> | NEEDS_INPUT: <what>');
    expect(claude).toContain('RED ARTIFACT:');
    expect(claude).toContain('MUTATION:');
    expect(claude).toContain('LAYER:');
    expect(claude).toContain('FILES:');
    expect(claude).toContain('TREE:');
    expect(claude).toContain('score:');
    expect(claude).toContain('ABORTED: runner unresolved');
    expect(claude).toContain('`GAPS` when the suite is green but mutants survived');
  });

  it('keeps the generated system prompt (excluding When to invoke) inside the 500-word cap', () => {
    expect(systemPromptWords(claude).length).toBeLessThanOrEqual(500);
  });

  it('does not cite CBC plugin paths in the agent file', () => {
    expect(claude).not.toContain('_knowledge/testing-doctrine.md');
    expect(claude).not.toContain('skills/cbc-internals');
    expect(claude).not.toContain('rules/cbc-engineering-principles.md');
    expect(claude).not.toMatch(/\/Users\//);
  });
});
