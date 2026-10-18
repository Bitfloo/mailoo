import { meta } from '../test-support/hooks-harness.js';
import type { EmailMeta, HookRule } from '../types/index.js';
import HooksService from './hooks.service.js';

describe('HooksService.matchStaticRules from.address', () => {
  const rule: HookRule = {
    name: 'known-alice',
    match: { from: 'alice@example.com' },
    actions: { labels: ['known'] },
  };

  it('matches the envelope address', () => {
    const outcome = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: meta() },
      [rule],
    );
    expect(outcome.matched).toBe(true);
  });

  it('does not match a display-name spoof on a different address', () => {
    const globRule: HookRule = {
      name: 'alice-glob',
      match: { from: 'alice@example.com*' },
      actions: {},
    };
    const spoof = meta({
      from: { name: 'alice@example.com', address: 'mallory@example.com' },
    });
    const exact = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: spoof },
      [rule],
    );
    const glob = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: spoof },
      [globRule],
    );
    expect(exact.matched).toBe(false);
    expect(glob.matched).toBe(false);
  });
});

describe('HooksService.matchStaticRules conditions', () => {
  it('should not match a rule that names no condition', () => {
    const outcome = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: meta() },
      [{ name: 'everything', match: {}, actions: { flag: true } }],
    );
    expect(outcome.matched).toBe(false);
  });

  it('should match a to pattern against every recipient, not only the first', () => {
    const outcome = HooksService.matchStaticRules(
      {
        account: 'personal',
        mailbox: 'INBOX',
        meta: meta({ to: [{ address: 'me@example.com' }, { address: 'team@example.com' }] }),
      },
      [{ name: 'team', match: { to: '*team@example.com*' }, actions: {} }],
    );
    expect(outcome.matched).toBe(true);
  });

  it('should match an exact to address when it is one of several recipients', () => {
    const outcome = HooksService.matchStaticRules(
      {
        account: 'personal',
        mailbox: 'INBOX',
        meta: meta({ to: [{ address: 'me@example.com' }, { address: 'team@example.com' }] }),
      },
      [{ name: 'team', match: { to: 'team@example.com' }, actions: {} }],
    );
    expect(outcome.matched).toBe(true);
  });

  it('should treat an empty from as no condition when the rule also names a subject', () => {
    const outcome = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: meta({ subject: 'Hello' }) },
      [{ name: 'hello', match: { from: '', subject: 'Hello' }, actions: {} }],
    );
    expect(outcome.matched).toBe(true);
  });

  it('should not match a rule whose only condition is empty', () => {
    const outcome = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: meta() },
      [{ name: 'blank', match: { from: '' }, actions: { flag: true } }],
    );
    expect(outcome.matched).toBe(false);
  });

  it('should not match a to pattern when the mail has no recipients', () => {
    const outcome = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: meta({ to: [] }) },
      [{ name: 'anyone', match: { to: '*' }, actions: {} }],
    );
    expect(outcome.matched).toBe(false);
  });
});

describe('HooksService.matchStaticRules patterns', () => {
  type Row = [string, HookRule['match'], Partial<EmailMeta>];

  function matches(match: HookRule['match'], overrides: Partial<EmailMeta>): boolean {
    return HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: meta(overrides) },
      [{ name: 'rule', match, actions: {} }],
    ).matched;
  }

  const sender = (address: string): Partial<EmailMeta> => ({ from: { address } });

  it.each<Row>([
    ['one of several | alternatives', { from: 'ceo@example.com|alice@example.com' }, {}],
    ['alternatives with spaces around them', { from: ' ceo@example.com | alice@example.com ' }, {}],
    ['the address written in another case', { from: 'ALICE@Example.COM' }, {}],
    [
      'a plus-addressed sender taken literally',
      { from: 'alice+news@example.com' },
      sender('alice+news@example.com'),
    ],
    ['a subject pattern', { subject: 'Invoice*' }, { subject: 'Invoice 42' }],
  ])('should match %s', (_case, match, overrides) => {
    expect(matches(match, overrides)).toBe(true);
  });

  it.each<Row>([
    ['a pattern that is only the end of the address', { from: 'example.com' }, {}],
    ['a pattern that is only the start of the address', { from: 'alice@example' }, {}],
    [
      'a dot in the pattern against another character',
      { from: 'alice@example.com' },
      sender('alice@exampleXcom'),
    ],
    [
      'a plus read as a regex quantifier',
      { from: 'alice+news@example.com' },
      sender('alicenews@example.com'),
    ],
    ['a different subject', { subject: 'Invoice*' }, { subject: 'Re: lunch' }],
  ])('should not match %s', (_case, match, overrides) => {
    expect(matches(match, overrides)).toBe(false);
  });
});
