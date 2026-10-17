import { SettingsSchema, SmtpConfigSchema } from './schema.js';

describe('SmtpConfigSchema', () => {
  // The default skips validation, so only an explicit value reaches the bound.
  it('should accept pool.max_connections = 1 at its bound', () => {
    const result = SmtpConfigSchema.safeParse({
      host: 'smtp.example.com',
      pool: { max_connections: 1 },
    });

    expect(result.success).toBe(true);
  });

  it('should refuse pool.max_connections = 0 one step past its bound', () => {
    const result = SmtpConfigSchema.safeParse({
      host: 'smtp.example.com',
      pool: { max_connections: 0 },
    });

    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'pool.max_connections',
    ]);
  });
});

// idle_timeout stops at 1740 s (29 min): servers may drop an IDLE that runs
// 30 minutes, so the watcher has to re-issue it before then (RFC 2177).
describe('SettingsSchema numeric bounds', () => {
  const settingAt: Record<string, (value: number) => Record<string, unknown>> = {
    'watcher.idle_timeout': (value) => ({ watcher: { idle_timeout: value } }),
    'hooks.batch_delay': (value) => ({ hooks: { batch_delay: value } }),
    'hooks.calendar_alarm_minutes': (value) => ({ hooks: { calendar_alarm_minutes: value } }),
    rate_limit: (value) => ({ rate_limit: value }),
    'system_one.body_max_chars': (value) => ({ system_one: { body_max_chars: value } }),
    'system_one.thresholds.injection_high': (value) => ({
      system_one: { thresholds: { injection_high: value } },
    }),
  };

  it.each([
    ['watcher.idle_timeout', 60],
    ['watcher.idle_timeout', 1740],
    ['hooks.batch_delay', 1],
    ['hooks.batch_delay', 60],
    ['hooks.calendar_alarm_minutes', 0],
    ['hooks.calendar_alarm_minutes', 1440],
    ['rate_limit', 1],
    ['system_one.body_max_chars', 256],
    ['system_one.body_max_chars', 24_000],
    ['system_one.thresholds.injection_high', 0],
    ['system_one.thresholds.injection_high', 1],
  ])('should accept %s = %d at its bound', (field, value) => {
    expect(SettingsSchema.safeParse(settingAt[field](value)).success).toBe(true);
  });

  it.each([
    ['watcher.idle_timeout', 59],
    ['watcher.idle_timeout', 1741],
    ['hooks.batch_delay', 0],
    ['hooks.batch_delay', 61],
    ['hooks.calendar_alarm_minutes', -1],
    ['hooks.calendar_alarm_minutes', 1441],
    ['rate_limit', 0],
    ['system_one.body_max_chars', 255],
    ['system_one.body_max_chars', 24_001],
    ['system_one.thresholds.injection_high', -0.01],
    ['system_one.thresholds.injection_high', 1.01],
  ])('should refuse %s = %d one step past its bound', (field, value) => {
    const result = SettingsSchema.safeParse(settingAt[field](value));

    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([field]);
  });
});
