import { existsSync, readFileSync } from 'node:fs';

import {
  agentFileContract,
  CLAUDE_TEST_AGENT_MODEL,
  descriptionBlock,
  doctrineDetectionBands,
  doctrinePath,
  doctrineShipBarScore,
  exampleUserLines,
  readTwinAgent,
  toolsList,
  triggerPhrases,
} from './agent-file.js';

const { claude, cursor } = readTwinAgent('test-auditor');

describe('test-auditor L4 doctrine', () => {
  agentFileContract('test-auditor', 4);

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
    ['the include list it reads first', 'vitest.config.integration.ts` `test.include`'],
    [
      'the wrong-lane abort for integration files',
      '`ABORTED: integration path needs pnpm test:integration`',
    ],
    ['the wrong-lane abort for unit files', '`ABORTED: unit path needs pnpm test`'],
    ['the unaudited integration lane', 'integration lane UNAUDITED or C3 WARN'],
    ['a fresh session', 'fresh** session on the same files'],
  ])('binds the Mailoo runners: %s', (_name, phrase) => {
    for (const text of [claude, cursor]) {
      expect(text).toContain(phrase);
    }
  });

  it.each([
    ['score 10', '10 all killed, no findings.'],
    ['score 7–8', '7–8 WARN debt.'],
    ['score 6', '6 two WARN max.'],
    ['score 3–5', '3–5 three+ WARN.'],
    ['score 1–2', '1–2 any CRITICAL.'],
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

  it('quotes the detection bands of the testing doctrine', () => {
    const bands = doctrineDetectionBands();
    expect(bands.map(([, band]) => band)).toEqual(['weak', 'needs work', 'target']);
    for (const text of [claude, cursor]) {
      for (const [rate, band] of bands) {
        expect(text).toContain(`\`${rate}\` ${band}`);
      }
    }
  });

  it('passes only at the doctrine ship bar and with zero CRITICAL', () => {
    const score = doctrineShipBarScore();
    expect(score).toMatch(/^\d+$/);
    for (const text of [claude, cursor]) {
      expect(text).toContain(`${score} INFO only (Mailoo ship bar).`);
      expect(text).toContain(`PASS if score ≥ ${score} AND zero CRITICAL`);
    }
  });

  it('requires C1 and C2 before the rest of the rubric', () => {
    expect(claude).toContain('C1 and C2 first');
    expect(claude).toContain('C1–C10');
    expect(claude).toContain('C1 and C2 were attempted');
    expect(claude).toContain('cite by section');
    expect(claude).toContain('Never repair');
  });

  it.each([
    ['the score line', 'SCORE: N/10'],
    ['the verdict line', 'VERDICT: PASS | FAIL | ABORTED: <reason> | NEEDS_INPUT: <what>'],
    ['the detection line', 'DETECTION:'],
    ['the findings line', 'FINDINGS:'],
    ['the unaudited line', 'UNAUDITED:'],
    ['the tree line', 'TREE:'],
    ['the runner abort', 'ABORTED: runner unresolved'],
  ])('emits a SCORE/VERDICT block: %s', (_name, phrase) => {
    for (const text of [claude, cursor]) {
      expect(text).toContain(phrase);
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
