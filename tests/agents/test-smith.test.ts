import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  agentTwinBody,
  CLAUDE_TEST_AGENT_MODEL,
  CURSOR_TEST_AGENT_MODEL,
  checkerBuiltinPattern,
  descriptionBlock,
  differingLines,
  exampleBlocks,
  exampleUserLines,
  expectedAgentText,
  PERMISSION_GRANT,
  POLISH_TEXT,
  readTwinAgent,
  repoRoot,
  SYSTEM_PROMPT_MAX_WORDS,
  systemPromptWords,
  toolsList,
  triggerPhrases,
  USER_DESCRIPTION_MAX_CHARS,
} from './agent-file.js';

const doctrinePath = join(repoRoot, '.claude/rules/testing-doctrine.md');
const { claude, cursor } = readTwinAgent('test-smith');
const expected = expectedAgentText('test-smith');

describe('test-smith L4 doctrine', () => {
  it('matches the checked-in agent text word for word in the Claude Code copy', () => {
    expect(claude).toBe(expected);
  });

  it('matches the checked-in agent text word for word in the Cursor copy, except the model line', () => {
    const modelLine = expected.split('\n').indexOf(`model: ${CLAUDE_TEST_AGENT_MODEL}`);
    expect(modelLine).toBeGreaterThan(0);
    expect(differingLines(expected, cursor)).toEqual([modelLine]);
    expect(cursor.split('\n')[modelLine]).toBe(`model: ${CURSOR_TEST_AGENT_MODEL}`);
  });

  it('keeps Claude Code and Cursor copies aligned except host model tier', () => {
    expect(agentTwinBody(claude)).toBe(agentTwinBody(cursor));
    expect(claude).toMatch(new RegExp(`^model: ${CLAUDE_TEST_AGENT_MODEL}$`, 'm'));
    expect(cursor).toMatch(new RegExp(`^model: ${CURSOR_TEST_AGENT_MODEL}$`, 'm'));
  });

  it('grounds on the Mailoo doctrine file that exists in this clone', () => {
    expect(existsSync(doctrinePath)).toBe(true);
    expect(claude).toContain('.claude/rules/testing-doctrine.md');
    expect(claude).toMatch(/do not invent thresholds/);
  });

  it('stays inside the user-class description budget', () => {
    expect(descriptionBlock(claude).length).toBeGreaterThan(10);
    expect(descriptionBlock(claude).length).toBeLessThanOrEqual(USER_DESCRIPTION_MAX_CHARS);
  });

  it('routes English authoring phrases and defers grading', () => {
    const description = descriptionBlock(claude);
    expect(triggerPhrases(description)).toEqual([
      'write tests',
      'add tests',
      'write tests for',
      'test this properly',
      'test-smith',
    ]);
    expect(description).toMatch(/NOT:.*test-auditor/);
  });

  it('declares smith identity, Claude sonnet tier, and green color', () => {
    expect(claude).toMatch(/^name: test-smith$/m);
    expect(claude).toMatch(new RegExp(`^model: ${CLAUDE_TEST_AGENT_MODEL}$`, 'm'));
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

  it.each([
    ['the unit runner', 'pnpm test -- <file>'],
    ['the integration runner', 'pnpm test:integration -- <file>'],
    ['the CLI probe refusal', '`mailoo test` is a CLI connection probe, not this runner'],
    ['the runner source', 'package.json` (runner — never infer it)'],
    ['no browser automation', 'No browser automation'],
  ])('binds the Mailoo runners: %s', (_name, phrase) => {
    for (const text of [claude, cursor]) {
      expect(text).toContain(phrase);
    }
  });

  it.each([
    ['layer choice', 'Pick the layer from the doctrine table'],
    ['production fixtures', 'Fixture from a production artifact'],
    ['pinned env input', 'Pin env input'],
    ['one behaviour per test', 'One behaviour per `it`'],
    ['mutation targets', 'boundary, logic'],
    ['survivors as tasks', 'A survivor is a task, not a statistic'],
    ['searched negative claims', 'A negative claim names its search.'],
  ])('pins the authoring contract: %s', (_name, phrase) => {
    for (const text of [claude, cursor]) {
      expect(text).toContain(phrase);
    }
  });

  it('forbids mock-as-oracle, retry masking, and secret fixtures', () => {
    expect(claude).toContain('expect(mock).toHaveBeenCalled()');
    expect(claude).toContain('may never be the main assertion');
    expect(claude).toContain('No `retry:`');
    expect(claude).toContain('No credentials, no real domains');
    expect(claude).toContain('Never report a test count as quality');
  });

  it('ships only when a fresh auditor would pass the Mailoo score bar', () => {
    expect(claude).toContain('PASS at score ≥ 9');
    expect(claude).toContain('**SHIPPED**');
    expect(claude).toMatch(/test-auditor/);
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
    expect(systemPromptWords(claude).length).toBeLessThanOrEqual(SYSTEM_PROMPT_MAX_WORDS);
  });

  it('does not cite anything the public git checker forbids, or a home path', () => {
    for (const text of [claude, cursor]) {
      expect(text).not.toMatch(checkerBuiltinPattern());
      expect(text).not.toMatch(/(^|[\s`("'])~\//m);
    }
  });

  it('keeps the agent text English-only', () => {
    for (const text of [claude, cursor]) {
      expect(text).not.toMatch(POLISH_TEXT);
    }
  });

  it('gives each When to invoke example a context, a user request, and an answer', () => {
    const examples = exampleBlocks(claude);
    expect(examples).toHaveLength(3);
    for (const example of examples) {
      expect(example).toMatch(/^\s*Context: \S/m);
      expect(example).toMatch(/^\s*user: "[^"]+"$/m);
      expect(example).toMatch(/^\s*assistant: "[^"]+"$/m);
    }
  });

  it('never grants extra permissions anywhere in the agent file', () => {
    for (const text of [claude, cursor]) {
      expect(text).not.toMatch(PERMISSION_GRANT);
    }
  });

  it('pins the user request of every When to invoke example in both copies', () => {
    for (const text of [claude, cursor]) {
      expect(exampleUserLines(text)).toEqual([
        'Write proper tests for the notifier',
        'Test the watcher hard enough that races make it fail',
        'See whether the tests in this PR are sufficient',
      ]);
    }
  });
});
