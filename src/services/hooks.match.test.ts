import { meta } from '../test-support/hooks-harness.js';
import type { HookRule } from '../types/index.js';
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

  it('should not match a to pattern when the mail has no recipients', () => {
    const outcome = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: meta({ to: [] }) },
      [{ name: 'anyone', match: { to: '*' }, actions: {} }],
    );
    expect(outcome.matched).toBe(false);
  });
});
