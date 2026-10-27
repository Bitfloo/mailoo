/**
 * `mailoo test <account>` reaches the code after its probe only when IMAP and
 * SMTP both answer, so only a live mailbox can show that a successful `test`
 * run does not send the install count.
 */

import { stat } from 'node:fs/promises';

import {
  markerPath,
  SERVER_START_MS,
  SPAWN_TEST_MS,
  startCollector,
  startMailoo,
  withinMs,
} from '../test-support/install-count-child.js';
import { getGreenMailPorts, TEST_ACCOUNT_NAME, TEST_USER } from './helpers/config.js';

// The config schema wants a dotted domain; GreenMail logs in by username, so the address is only a From.
const CONFIG_EMAIL = 'test@example.test';

function greenMailConfig(): string {
  const { host, imapPort, smtpPort } = getGreenMailPorts();
  const endpoint = (port: number): string =>
    [
      `host = "${host}"`,
      `port = ${port}`,
      'tls = false',
      'starttls = false',
      'verify_ssl = false',
    ].join('\n');
  return `[[accounts]]
name = "${TEST_ACCOUNT_NAME}"
email = "${CONFIG_EMAIL}"
username = "${TEST_USER}"
password = "${TEST_USER}"

[accounts.imap]
${endpoint(imapPort)}

[accounts.smtp]
${endpoint(smtpPort)}
`;
}

describe('install count on a successful `test` run', () => {
  it(
    'should exit 0 and send nothing when both connections answer',
    async () => {
      const collector = await startCollector();
      const started = await startMailoo(
        ['test', TEST_ACCOUNT_NAME],
        collector.url,
        greenMailConfig(),
      );
      const code = await withinMs(started.exited, SERVER_START_MS, 'the test command exit');
      expect(code, started.output()).toBe(0);
      expect(collector.received).toHaveLength(0);
      await expect(stat(markerPath(started))).rejects.toMatchObject({ code: 'ENOENT' });
    },
    SPAWN_TEST_MS,
  );
});
