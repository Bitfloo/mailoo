import type { FolderSpec, MailAnswers, PolicyConfig } from './policy.js';
import { composeSpamRisk, decideMailAction } from './policy.js';

const RECEIPTS: FolderSpec = {
  id: 'receipts',
  path: 'Receipts',
  description: 'Invoices, receipts, and payment confirmations.',
};

const ARCHIVE: FolderSpec = {
  id: 'archive',
  path: 'Archive',
  description: 'Settled correspondence that needs no further action.',
};

const NEWSLETTERS: FolderSpec = {
  id: 'newsletters',
  path: 'Newsletters',
  description: 'Subscriptions and bulk updates the operator chose to keep.',
};

const THRESHOLDS: PolicyConfig['thresholds'] = {
  folderFitMin: 0.85,
  spamUncertainLow: 0.4,
  spamUncertainHigh: 0.6,
  injectionHigh: 0.75,
  importanceFlagMin: 3,
  importanceMinConfidence: 0.7,
  isCriticalMin: 0.85,
};

function answers(overrides: Partial<MailAnswers> = {}): MailAnswers {
  return {
    contains_prompt_injection: 0.1,
    requests_credentials: 0,
    offers_unexpected_reward: 0,
    sender_identity_mismatch: 0,
    folder_fit: new Map(),
    importance: { score: 1, confidence: 0.9 },
    is_critical: 0.1,
    ...overrides,
  };
}

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    folders: [RECEIPTS, ARCHIVE, NEWSLETTERS],
    autoMove: true,
    autoFlag: false,
    thresholds: THRESHOLDS,
    ...overrides,
  };
}

describe('composeSpamRisk', () => {
  it('weights credentials, mismatch, and reward per cookbook', () => {
    expect(
      composeSpamRisk(
        answers({
          requests_credentials: 1,
          sender_identity_mismatch: 0,
          offers_unexpected_reward: 0,
        }),
      ),
    ).toBeCloseTo(0.45, 10);
    expect(
      composeSpamRisk(
        answers({
          requests_credentials: 1,
          sender_identity_mismatch: 1,
          offers_unexpected_reward: 1,
        }),
      ),
    ).toBeCloseTo(1, 10);
  });
});

describe('decideMailAction', () => {
  it('noops injection_filter on high noul even with strong folder_fit', () => {
    const result = decideMailAction(
      answers({
        contains_prompt_injection: 0.9,
        folder_fit: new Map([['receipts', 0.99]]),
        is_critical: 1,
      }),
      policy({ autoFlag: true }),
    );
    expect(result).toEqual({ kind: 'noop', reason: 'injection_filter' });
  });

  it('noops injection_filter when |noul-0.5|<0.1', () => {
    expect(decideMailAction(answers({ contains_prompt_injection: 0.5 }), policy())).toEqual({
      kind: 'noop',
      reason: 'injection_filter',
    });
    expect(decideMailAction(answers({ contains_prompt_injection: 0.45 }), policy())).toEqual({
      kind: 'noop',
      reason: 'injection_filter',
    });
  });

  it('does NOT injection_filter at 0.70 when injectionHigh is 0.75', () => {
    const result = decideMailAction(
      answers({
        contains_prompt_injection: 0.7,
        folder_fit: new Map([['receipts', 0.99]]),
      }),
      policy(),
    );
    expect(result).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: false,
    });
  });

  it('noops spam_uncertain when composeSpamRisk is ~0.5', () => {
    const mail = answers({
      requests_credentials: 1,
      folder_fit: new Map([['receipts', 0.99]]),
    });
    expect(composeSpamRisk(mail)).toBeCloseTo(0.45, 10);
    expect(decideMailAction(mail, policy())).toEqual({
      kind: 'noop',
      reason: 'spam_uncertain',
    });
  });

  it('does not treat exclusive spam-uncertain low endpoint as uncertain', () => {
    const low = answers({
      requests_credentials: 0.4 / 0.45,
      folder_fit: new Map([['receipts', 0.99]]),
    });
    expect(composeSpamRisk(low)).toBeCloseTo(0.4, 10);
    expect(decideMailAction(low, policy())).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: false,
    });
  });

  it('does not treat exclusive spam-uncertain high endpoint as uncertain', () => {
    const high = answers({
      requests_credentials: 1,
      sender_identity_mismatch: 0.5,
      folder_fit: new Map([['receipts', 0.99]]),
    });
    expect(composeSpamRisk(high)).toBeCloseTo(0.6, 10);
    expect(decideMailAction(high, policy())).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: false,
    });
  });

  it('does not change dest when composeSpamRisk is high (spamHigh is not a veto)', () => {
    const fit = new Map([['receipts', 0.99]]);
    const hot = answers({
      requests_credentials: 1,
      sender_identity_mismatch: 1,
      offers_unexpected_reward: 1,
      folder_fit: fit,
    });
    const cool = answers({ folder_fit: fit });
    expect(composeSpamRisk(hot)).toBeGreaterThan(0.72);
    expect(decideMailAction(hot, policy())).toEqual(decideMailAction(cool, policy()));
    expect(decideMailAction(hot, policy())).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: false,
    });
  });

  it('does not MOVE on high spam alone with no folder_fit (never a mailbox named spam)', () => {
    const result = decideMailAction(
      answers({
        requests_credentials: 1,
        sender_identity_mismatch: 1,
        offers_unexpected_reward: 1,
      }),
      policy(),
    );
    expect(result).toEqual({ kind: 'noop', reason: 'no_folder_fit' });
    expect(result).not.toMatchObject({ destinationMailbox: expect.anything() });
  });

  it('ignores extra folder_fit Map keys that are not FolderSpec ids', () => {
    const result = decideMailAction(
      answers({
        folder_fit: new Map([
          ['spam', 0.99],
          ['receipts', 0.9],
        ]),
      }),
      policy(),
    );
    expect(result).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: false,
    });
  });

  it('MOVEs the highest folder_fit (receipts 0.9 vs archive 0.86)', () => {
    const result = decideMailAction(
      answers({
        folder_fit: new Map([
          ['receipts', 0.9],
          ['archive', 0.86],
        ]),
      }),
      policy(),
    );
    expect(result).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: false,
    });
  });

  it('breaks noul ties by lower priority then earlier config row', () => {
    const tied = answers({
      folder_fit: new Map([
        ['receipts', 0.9],
        ['archive', 0.9],
      ]),
    });
    expect(
      decideMailAction(
        tied,
        policy({
          folders: [
            { ...RECEIPTS, priority: 2 },
            { ...ARCHIVE, priority: 1 },
          ],
        }),
      ),
    ).toEqual({ kind: 'apply', destinationMailbox: 'Archive', flag: false });

    expect(decideMailAction(tied, policy({ folders: [RECEIPTS, ARCHIVE] }))).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: false,
    });
  });

  it('MOVEs and flags together when autoFlag and importance 3.2 / conf 0.8', () => {
    const result = decideMailAction(
      answers({
        folder_fit: new Map([['receipts', 0.99]]),
        importance: { score: 3.2, confidence: 0.8 },
      }),
      policy({ autoFlag: true }),
    );
    expect(result).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: true,
    });
  });

  it('flags without MOVE when autoMove is false', () => {
    const result = decideMailAction(
      answers({
        folder_fit: new Map([['receipts', 0.99]]),
        is_critical: 0.85,
      }),
      policy({ autoMove: false, autoFlag: true }),
    );
    expect(result).toEqual({ kind: 'apply', flag: true });
    expect(result).not.toHaveProperty('destinationMailbox');
  });

  it('noops auto_move_off when fit is high but autoMove and autoFlag are false', () => {
    expect(
      decideMailAction(
        answers({ folder_fit: new Map([['receipts', 1]]) }),
        policy({ autoMove: false, autoFlag: false }),
      ),
    ).toEqual({ kind: 'noop', reason: 'auto_move_off' });
  });

  it('does not MOVE on empty folders[] even if autoMove is true', () => {
    expect(
      decideMailAction(
        answers({ folder_fit: new Map([['receipts', 0.99]]) }),
        policy({ folders: [] }),
      ),
    ).toEqual({ kind: 'noop', reason: 'no_folder_fit' });
  });

  it('does not flag is_critical 0.84 when autoFlag', () => {
    const cfg = policy({ autoMove: false, autoFlag: true });
    expect(decideMailAction(answers({ is_critical: 0.84 }), cfg)).toEqual({
      kind: 'noop',
      reason: 'auto_move_off',
    });
  });

  it('flags is_critical 0.85 when autoFlag', () => {
    const cfg = policy({ autoMove: false, autoFlag: true });
    expect(decideMailAction(answers({ is_critical: 0.85 }), cfg)).toEqual({
      kind: 'apply',
      flag: true,
    });
  });

  it('flags on importance.score>=3 AND confidence>=0.70', () => {
    const cfg = policy({ autoMove: false, autoFlag: true });
    expect(decideMailAction(answers({ importance: { score: 3, confidence: 0.7 } }), cfg)).toEqual({
      kind: 'apply',
      flag: true,
    });
  });

  it('does not flag importance confidence 0.69', () => {
    const cfg = policy({ autoMove: false, autoFlag: true });
    expect(
      decideMailAction(answers({ importance: { score: 3.2, confidence: 0.69 } }), cfg),
    ).toEqual({ kind: 'noop', reason: 'auto_move_off' });
  });
});
