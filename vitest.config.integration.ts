import { defineConfig } from 'vitest/config';

/**
 * A test opens real IMAP and SMTP sessions to GreenMail in Docker (TCP, TLS,
 * login), and a send waits a fixed 500 ms for delivery before it reads. Vitest's
 * 5 s default is sized for in-process tests, not for that I/O on a slow CI runner.
 */
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

/**
 * A beforeAll can seed several messages, each over its own SMTP connection, then
 * wait for delivery. The GreenMail container start is not under this limit:
 * Vitest awaits globalSetup without one, and globalSetup.ts gives it 60 s.
 */
const INTEGRATION_HOOK_TIMEOUT_MS = 60_000;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__integration__/**/*.integration.test.ts'],
    reporters: ['default', 'junit', 'json'],
    outputFile: {
      junit: 'reports/integration-results.xml',
      json: 'reports/integration-results.json',
    },
    testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    globalSetup: ['src/__integration__/globalSetup.ts'],
    sequence: {
      concurrent: false,
    },
  },
});
