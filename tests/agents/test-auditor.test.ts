import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  agentTwinBody,
  CLAUDE_TEST_AGENT_MODEL,
  CURSOR_TEST_AGENT_MODEL,
  checkerBuiltinPattern,
  descriptionBlock,
  exampleBlocks,
  exampleUserLines,
  PERMISSION_GRANT,
  POLISH_TEXT,
  readTwinAgent,
  repoRoot,
  SYSTEM_PROMPT_MAX_WORDS,
  sectionLines,
  systemPromptWords,
  toolsList,
  triggerPhrases,
  USER_DESCRIPTION_MAX_CHARS,
} from './agent-file.js';

const doctrinePath = join(repoRoot, '.claude/rules/testing-doctrine.md');
const { claude, cursor } = readTwinAgent('test-auditor');

const PINNED_SECTIONS: [string, string | null, string[]][] = [
  [
    'the opening',
    null,
    [
      'Read before judging: `.claude/rules/testing-doctrine.md` (rubric — cite by section; if missing emit `ABORTED: testing doctrine missing`), `CLAUDE.md` (when integration is required), `package.json` (runner — never infer it), then the matching `vitest.config.ts` or `vitest.config.integration.ts` `test.include` before the first Bash run.',
      'You audit a suite you did not write. One question: would these tests fail if the code were wrong? Measure first. Never repair.',
    ],
  ],
  [
    'the Scope section',
    'Scope',
    [
      'You are not test-smith. You never write or fix a test or source file. You have no Write tool; Edit exists only to apply and revert a mutant. Do not spawn nested subagents. Return the parsed block. Nothing after it.',
    ],
  ],
  [
    'the Rails section',
    'Rails',
    [
      'Bash is read-only plus the `package.json` runner. NEVER stage, commit, install, or push. Refuse a dirty baseline: `git status --short <target>` must be empty, else `NEEDS_INPUT: commit or stash <target> first`. One file per mutant, Edit then inverse Edit (same strings, swapped). After each: `git diff --stat -- <target>` empty — quote it. Revert failure first, with inverse-Edit recovery. Mutate only the named target slice.',
    ],
  ],
  [
    'the Runner section',
    'Runner',
    [
      'Unit: `pnpm test -- <file>`. Integration: `pnpm test:integration -- <file>` for `src/__integration__/` or `*.integration.test.ts`. Wrong lane → `ABORTED: integration path needs pnpm test:integration` or `ABORTED: unit path needs pnpm test --`. `mailoo test` is a CLI connection probe, not this runner. No browser automation. Auditing unit tests for IMAP/SMTP/watcher/scheduler/transport when `CLAUDE.md` requires integration → name integration lane UNAUDITED or C3 WARN in FINDINGS.',
    ],
  ],
  [
    'the Rubric section',
    'Rubric',
    [
      'Doctrine C1–C10 in order. C1 and C2 first. CRITICAL = green proven meaningless (zero killed, code gone still green, `retry:`, order-dependent green). Never a rate without survivors; bands from doctrine (`<60%` weak, `60–80%` needs work, `>80%` target). Never credit a test count. C1 and C2 were attempted or the reason each was impossible is stated.',
    ],
  ],
  [
    'the Scoring section',
    'Scoring',
    [
      '10 all killed, no findings. 9 INFO only (Mailoo ship bar). 7–8 WARN debt. 6 two WARN max. 3–5 three+ WARN. 1–2 any CRITICAL. PASS if score ≥ 9 AND zero CRITICAL.',
    ],
  ],
  [
    'the Failure Mode section',
    'Failure Mode',
    [
      'Never raise an error. No runner → `ABORTED: runner unresolved`. Dirty target → `NEEDS_INPUT`. Revert failure first. Too large → UNAUDITED the rest. Unrunnable suite → CRITICAL C1, FAIL. A negative claim names its search.',
    ],
  ],
];

describe('test-auditor L4 doctrine', () => {
  it('keeps Claude Code and Cursor copies aligned except host model tier', () => {
    expect(agentTwinBody(claude)).toBe(agentTwinBody(cursor));
    expect(claude).toMatch(new RegExp(`^model: ${CLAUDE_TEST_AGENT_MODEL}$`, 'm'));
    expect(cursor).toMatch(new RegExp(`^model: ${CURSOR_TEST_AGENT_MODEL}$`, 'm'));
  });

  it('grounds on the Mailoo doctrine file that exists in this clone', () => {
    expect(existsSync(doctrinePath)).toBe(true);
    expect(claude).toContain('.claude/rules/testing-doctrine.md');
    expect(claude).toContain('ABORTED: testing doctrine missing');
  });

  it('treats GreenMail as a disposable IMAP/SMTP test server, not a database', () => {
    const doctrine = readFileSync(doctrinePath, 'utf8');
    expect(doctrine).toMatch(/test IMAP\/SMTP server/);
    expect(doctrine).toMatch(/not a database/);
    expect(doctrine).toContain('GreenMail');
  });

  it('stays inside the user-class description budget', () => {
    expect(descriptionBlock(claude).length).toBeGreaterThan(10);
    expect(descriptionBlock(claude).length).toBeLessThanOrEqual(USER_DESCRIPTION_MAX_CHARS);
  });

  it('routes English audit phrases and defers authorship', () => {
    const description = descriptionBlock(claude);
    expect(triggerPhrases(description)).toEqual([
      'rate these tests',
      'do these tests catch anything',
      'test audit',
      'audit these tests',
      'are the PR tests enough',
      'are these tests sufficient',
      'test-auditor',
    ]);
    expect(description).toMatch(/NOT:.*test-smith/);
    expect(description).toMatch(/mutation\/detection judgment only here/);
  });

  it('declares auditor identity, Claude sonnet tier, and yellow color', () => {
    expect(claude).toMatch(/^name: test-auditor$/m);
    expect(claude).toMatch(new RegExp(`^model: ${CLAUDE_TEST_AGENT_MODEL}$`, 'm'));
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

  it.each([
    ['the unit runner', 'pnpm test -- <file>'],
    ['the integration runner', 'pnpm test:integration -- <file>'],
    ['the include list it reads first', 'vitest.config.integration.ts` `test.include`'],
    [
      'the wrong-lane abort for integration files',
      'ABORTED: integration path needs pnpm test:integration',
    ],
    ['the wrong-lane abort for unit files', 'ABORTED: unit path needs pnpm test --'],
    ['the unaudited integration lane', 'integration lane UNAUDITED or C3 WARN'],
    ['the CLI probe refusal', '`mailoo test` is a CLI connection probe, not this runner'],
    ['the runner source', 'package.json` (runner — never infer it)'],
    ['no browser automation', 'No browser automation'],
    ['a fresh session', 'fresh** session on the same files'],
  ])('binds the Mailoo runners: %s', (_name, phrase) => {
    for (const text of [claude, cursor]) {
      expect(text).toContain(phrase);
    }
  });

  it.each([
    ['score 10', '10 all killed, no findings.'],
    ['score 9', '9 INFO only (Mailoo ship bar).'],
    ['score 7–8', '7–8 WARN debt.'],
    ['score 6', '6 two WARN max.'],
    ['score 3–5', '3–5 three+ WARN.'],
    ['score 1–2', '1–2 any CRITICAL.'],
    ['the weak detection band', '`<60%` weak'],
    ['the needs-work detection band', '`60–80%` needs work'],
    ['the target detection band', '`>80%` target'],
    ['an unrunnable suite', 'Unrunnable suite → CRITICAL C1, FAIL.'],
    ['survivors behind every rate', 'Never a rate without survivors'],
    ['reverting before anything else', 'Revert failure first'],
    ['the mutation scope', 'Mutate only the named target slice.'],
    ['read-only Bash', 'Bash is read-only plus the `package.json` runner.'],
    ['Edit only for mutants', 'Edit exists only to apply and revert a mutant.'],
    ['no authoring', 'You never write or fix a test or source file.'],
  ])('pins the audit contract: %s', (_name, phrase) => {
    for (const text of [claude, cursor]) {
      expect(text).toContain(phrase);
    }
  });

  it('requires C1 and C2 before the rest of the rubric', () => {
    expect(claude).toContain('C1 and C2 first');
    expect(claude).toContain('C1–C10');
    expect(claude).toContain('C1 and C2 were attempted');
    expect(claude).toContain('cite by section');
    expect(claude).toContain('Never repair');
    expect(claude).toContain('>80%` target');
  });

  it('emits a SCORE/VERDICT block with a CRITICAL veto', () => {
    expect(claude).toContain('SCORE: N/10');
    expect(claude).toContain('VERDICT: PASS | FAIL | ABORTED: <reason> | NEEDS_INPUT: <what>');
    expect(claude).toContain('DETECTION:');
    expect(claude).toContain('FINDINGS:');
    expect(claude).toContain('UNAUDITED:');
    expect(claude).toContain('TREE:');
    expect(claude).toContain('ABORTED: runner unresolved');
    expect(claude).toMatch(/PASS if score ≥ 9 AND zero CRITICAL/);
    expect(claude).toMatch(/Mailoo ship bar/);
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
    expect(examples).toHaveLength(4);
    for (const example of examples) {
      expect(example).toMatch(/^\s*Context: \S/m);
      expect(example).toMatch(/^\s*user: "[^"]+"$/m);
      expect(example).toMatch(/^\s*assistant: "[^"]+"$/m);
    }
  });

  it.each(PINNED_SECTIONS)('pins %s word for word in both copies', (_label, heading, lines) => {
    for (const text of [claude, cursor]) {
      expect(sectionLines(text, heading)).toEqual(lines);
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
        'Are the tests in this PR enough?',
        'Check whether these tests really catch anything',
        'Audit src/__integration__/email-send.integration.test.ts',
        'These tests are weak, add the missing ones',
      ]);
    }
  });
});
