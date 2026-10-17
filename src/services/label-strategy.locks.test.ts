import type { ImapFlow } from 'imapflow';

import type { LabelClient } from '../test-support/label-client-fake.js';
import {
  gmailStrategy,
  keywordStrategy,
  mockClient,
  protonStrategy,
} from '../test-support/label-client-fake.js';
import lockCallsByOwner from '../test-support/lock-sites.js';
import type { LabelStrategy } from './label-strategy.js';
import { detectLabelStrategy } from './label-strategy.js';

type Command = Exclude<keyof LabelClient, 'capabilities' | 'mailbox' | 'releaseFn'>;

interface Prepared {
  client: LabelClient;
  call: () => Promise<unknown>;
}

/** One lockMailbox call site in label-strategy.ts. */
interface LabelLockSite {
  /** The function or `factory.method` that makes the call, as lockCallsByOwner names it. */
  owner: string;
  /** The client and the call under test, after any lock that detection itself takes. */
  prepare: () => Promise<Prepared>;
  /** Programs the commands after the lock so the call succeeds; the default fake already does. */
  serve?: (client: LabelClient) => void;
  /** Makes the first step after the lock fail, and returns whether that step ran. */
  fail: (client: LabelClient) => () => boolean;
  /** Locks a successful call takes. */
  locks?: number;
  /** Releases after the failure: fewer than locks when it comes before a later lock. */
  failReleases?: number;
}

function on(
  setup: () => Promise<{ client: LabelClient; strategy: LabelStrategy }>,
  run: (strategy: LabelStrategy, client: ImapFlow) => Promise<unknown>,
): () => Promise<Prepared> {
  return async () => {
    const { client, strategy } = await setup();
    return { client, call: async () => run(strategy, client as unknown as ImapFlow) };
  };
}

function rejects(command: Command) {
  return (client: LabelClient) => {
    client[command].mockRejectedValue(new Error('Command failed: NO [UNAVAILABLE]'));
    return () => client[command].mock.calls.length > 0;
  };
}

/** The selected mailbox's PERMANENTFLAGS cannot be read. */
function mailboxUnreadable(client: LabelClient) {
  let reads = 0;
  Object.defineProperty(client, 'mailbox', {
    get() {
      reads += 1;
      throw new Error('No mailbox selected');
    },
  });
  return () => reads > 0;
}

function servesProtonRemoval(client: LabelClient) {
  client.fetchOne.mockResolvedValue({ uid: 5, envelope: { messageId: '<lock@example.test>' } });
  client.search.mockResolvedValue([12]);
}

const SITES: Record<string, LabelLockSite> = {
  'keyword detection': {
    owner: 'detectLabelStrategy',
    prepare: async () => {
      const client = mockClient(false);
      return { client, call: async () => detectLabelStrategy(client as unknown as ImapFlow) };
    },
    fail: mailboxUnreadable,
  },
  'keyword listLabels': {
    owner: 'createKeywordStrategy.listLabels',
    prepare: on(keywordStrategy, async (s, c) => s.listLabels(c)),
    fail: mailboxUnreadable,
  },
  'keyword addLabel': {
    owner: 'createKeywordStrategy.addLabel',
    prepare: on(keywordStrategy, async (s, c) => s.addLabel(c, '5', 'Archive', 'Work')),
    fail: rejects('messageFlagsAdd'),
  },
  'keyword removeLabel': {
    owner: 'createKeywordStrategy.removeLabel',
    prepare: on(keywordStrategy, async (s, c) => s.removeLabel(c, '5', 'Archive', 'Work')),
    fail: rejects('messageFlagsRemove'),
  },
  'Gmail addLabel': {
    owner: 'createGmailStrategy.addLabel',
    prepare: on(gmailStrategy, async (s, c) => s.addLabel(c, '5', 'Archive', 'Work')),
    fail: rejects('messageFlagsAdd'),
  },
  'Gmail removeLabel': {
    owner: 'createGmailStrategy.removeLabel',
    prepare: on(gmailStrategy, async (s, c) => s.removeLabel(c, '5', 'Archive', 'Work')),
    fail: rejects('messageFlagsRemove'),
  },
  'ProtonMail addLabel': {
    owner: 'createProtonMailStrategy.addLabel',
    prepare: on(protonStrategy, async (s, c) => s.addLabel(c, '5', 'Archive', 'Work')),
    fail: rejects('messageCopy'),
  },
  'ProtonMail removeLabel in the message mailbox': {
    owner: 'createProtonMailStrategy.removeLabel',
    prepare: on(protonStrategy, async (s, c) => s.removeLabel(c, '5', 'Archive', 'Work')),
    serve: servesProtonRemoval,
    fail: rejects('fetchOne'),
    locks: 2,
    failReleases: 1,
  },
  'ProtonMail removeLabel in the label folder': {
    owner: 'createProtonMailStrategy.removeLabel',
    prepare: on(protonStrategy, async (s, c) => s.removeLabel(c, '5', 'Archive', 'Work')),
    serve: servesProtonRemoval,
    fail: rejects('search'),
    locks: 2,
  },
};

it('should have one lock site row per lockMailbox call in label-strategy.ts', async () => {
  const rows: Record<string, number> = {};
  Object.values(SITES).forEach(({ owner }) => {
    rows[owner] = (rows[owner] ?? 0) + 1;
  });

  expect(rows).toEqual(await lockCallsByOwner('label-strategy.ts'));
});

// A lock left held makes every later call on the account wait out the lock timeout.
describe('label lock release', () => {
  it.each(Object.entries(SITES))(
    'should release each lock once when %s succeeds',
    async (_, site) => {
      const { client, call } = await site.prepare();
      site.serve?.(client);
      client.releaseFn.mockClear();

      await call();

      expect(client.releaseFn).toHaveBeenCalledTimes(site.locks ?? 1);
    },
  );

  it.each(Object.entries(SITES))(
    'should release each lock it took when the server fails a step of %s',
    async (_, site) => {
      const { client, call } = await site.prepare();
      site.serve?.(client);
      const failed = site.fail(client);
      client.releaseFn.mockClear();

      await call().catch(() => undefined);

      // Without the failing step having run, this would only repeat the success case.
      expect({ failed: failed(), releases: client.releaseFn.mock.calls.length }).toEqual({
        failed: true,
        releases: site.failReleases ?? site.locks ?? 1,
      });
    },
  );
});
