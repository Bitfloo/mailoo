import { ImapConfigSchema, SettingsSchema, SmtpConfigSchema } from './schema.js';

interface ParseResult {
  success: boolean;
  error?: { issues: { path: PropertyKey[] }[] };
}

function issuePaths(result: ParseResult): string[] | undefined {
  return result.error?.issues.map((issue) => issue.path.join('.'));
}

// The default skips validation, so only an explicit value reaches the bound.
describe('account numeric bounds', () => {
  const accountAt: Record<string, (value: number) => ParseResult> = {
    'pool.max_connections': (value) =>
      SmtpConfigSchema.safeParse({ host: 'smtp.example.com', pool: { max_connections: value } }),
    'pool.max_messages': (value) =>
      SmtpConfigSchema.safeParse({ host: 'smtp.example.com', pool: { max_messages: value } }),
    sieve_port: (value) =>
      ImapConfigSchema.safeParse({ host: 'imap.example.com', sieve_port: value }),
  };

  it.each([
    ['pool.max_connections', 1],
    ['pool.max_messages', 1],
    ['sieve_port', 1],
    ['sieve_port', 65_535],
  ])('should accept %s = %d at its bound', (field, value) => {
    expect(accountAt[field](value).success).toBe(true);
  });

  it.each([
    ['pool.max_connections', 0],
    ['pool.max_messages', 0],
    ['sieve_port', 0],
    ['sieve_port', 65_536],
  ])('should refuse %s = %d one step past its bound', (field, value) => {
    expect(issuePaths(accountAt[field](value))).toEqual([field]);
  });
});

// idle_timeout stops at 1740 s (29 min): servers may drop an IDLE that runs
// 30 minutes, so the watcher has to re-issue it before then (RFC 2177).
describe('SettingsSchema numeric bounds', () => {
  const THRESHOLDS = [
    'folder_fit_min',
    'spam_high',
    'spam_uncertain_low',
    'spam_uncertain_high',
    'injection_high',
    'importance_min_confidence',
    'is_critical_min',
  ];
  const settingAt: Record<string, (value: number) => Record<string, unknown>> = {
    'watcher.idle_timeout': (value) => ({ watcher: { idle_timeout: value } }),
    'hooks.batch_delay': (value) => ({ hooks: { batch_delay: value } }),
    'hooks.calendar_alarm_minutes': (value) => ({ hooks: { calendar_alarm_minutes: value } }),
    rate_limit: (value) => ({ rate_limit: value }),
    'system_one.body_max_chars': (value) => ({ system_one: { body_max_chars: value } }),
    ...Object.fromEntries(
      THRESHOLDS.map((name) => [
        `system_one.thresholds.${name}`,
        (value: number) => ({ system_one: { thresholds: { [name]: value } } }),
      ]),
    ),
  };
  const thresholdRows = (values: number[]) =>
    THRESHOLDS.flatMap((name) =>
      values.map((value): [string, number] => [`system_one.thresholds.${name}`, value]),
    );

  it.each<[string, number]>([
    ['watcher.idle_timeout', 60],
    ['watcher.idle_timeout', 1740],
    ['hooks.batch_delay', 1],
    ['hooks.batch_delay', 60],
    ['hooks.calendar_alarm_minutes', 0],
    ['hooks.calendar_alarm_minutes', 1440],
    ['rate_limit', 1],
    ['system_one.body_max_chars', 256],
    ['system_one.body_max_chars', 24_000],
    ...thresholdRows([0, 1]),
  ])('should accept %s = %d at its bound', (field, value) => {
    expect(SettingsSchema.safeParse(settingAt[field](value)).success).toBe(true);
  });

  it.each<[string, number]>([
    ['watcher.idle_timeout', 59],
    ['watcher.idle_timeout', 1741],
    ['hooks.batch_delay', 0],
    ['hooks.batch_delay', 61],
    ['hooks.calendar_alarm_minutes', -1],
    ['hooks.calendar_alarm_minutes', 1441],
    ['rate_limit', 0],
    ['system_one.body_max_chars', 255],
    ['system_one.body_max_chars', 24_001],
    ...thresholdRows([-0.01, 1.01]),
  ])('should refuse %s = %d one step past its bound', (field, value) => {
    expect(issuePaths(SettingsSchema.safeParse(settingAt[field](value)))).toEqual([field]);
  });
});
