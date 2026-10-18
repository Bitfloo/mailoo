import { ImapConfigSchema, SettingsSchema, SmtpConfigSchema } from './schema.js';

// account add writes SettingsSchema.parse({}) and the loader tests compare
// with the schema itself, so a changed default passed every one of them.
describe('schema defaults', () => {
  it('should default every setting to its documented value when parsing an empty object', () => {
    expect(SettingsSchema.parse({})).toEqual({
      rate_limit: 10,
      read_only: false,
      toolset: 'full',
      save_to_sent: true,
      watcher: { enabled: false, folders: ['INBOX'], idle_timeout: 1740 },
      system_one: {
        enabled: false,
        model: 'jev-latest',
        include_body: false,
        body_max_chars: 6000,
        auto_move: false,
        auto_flag: false,
        folders: [],
        source_folders: ['INBOX'],
        thresholds: {
          folder_fit_min: 0.85,
          spam_high: 0.72,
          spam_uncertain_low: 0.4,
          spam_uncertain_high: 0.6,
          injection_high: 0.75,
          importance_flag_min: 3,
          importance_min_confidence: 0.7,
          is_critical_min: 0.85,
        },
      },
      hooks: {
        on_new_email: 'notify',
        preset: 'priority-focus',
        auto_label: false,
        auto_flag: false,
        batch_delay: 5,
        rules: [],
        alerts: {
          desktop: false,
          sound: false,
          urgency_threshold: 'high',
          webhook_url: '',
          webhook_events: ['urgent', 'high'],
          allow_private_webhooks: false,
        },
        auto_calendar: false,
        calendar_name: '',
        calendar_alarm_minutes: 15,
        calendar_confirm: true,
      },
    });
  });

  it('should verify the SMTP certificate by default', () => {
    expect(SmtpConfigSchema.parse({ host: 'smtp.example.com' }).verify_ssl).toBe(true);
  });

  it.each([
    {
      name: 'IMAP',
      parse: () => ImapConfigSchema.parse({ host: 'imap.example.com' }),
      expected: {
        host: 'imap.example.com',
        port: 993,
        tls: true,
        starttls: false,
        verify_ssl: true,
        disable_imap4rev2: false,
      },
    },
    {
      name: 'SMTP',
      parse: () => SmtpConfigSchema.parse({ host: 'smtp.example.com' }),
      expected: {
        host: 'smtp.example.com',
        port: 465,
        tls: true,
        starttls: false,
        verify_ssl: true,
        pool: { enabled: true, max_connections: 1, max_messages: 100 },
      },
    },
  ])(
    'should default every $name field but the host when only the host is set',
    ({ parse, expected }) => {
      expect(parse()).toEqual(expected);
    },
  );
});
