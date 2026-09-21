import { defineConfig } from 'vitest/config';

/** Cold node plus junit/json reporters exceed Vitest's 5s default. */
const UNIT_TEST_TIMEOUT_MS = 10_000;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['src/__integration__/**'],
    reporters: ['default', 'junit', 'json'],
    outputFile: {
      junit: 'reports/test-results.xml',
      json: 'reports/test-results.json',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'reports/coverage',
    },
    testTimeout: UNIT_TEST_TIMEOUT_MS,
  },
});
