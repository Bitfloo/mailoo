import type { AccountConfig, AppConfig } from '../types/index.js';
import { createMailConnections, createMailServices } from './mail-services.js';

function account(name: string): AccountConfig {
  return {
    name,
    email: `${name}@example.com`,
    username: `${name}@example.com`,
    password: 'x',
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
  };
}

function config(defaultAccount?: string): AppConfig {
  return {
    settings: { rateLimit: 10, readOnly: false, saveToSent: true, defaultAccount },
    accounts: [account('first'), account('second')],
  } as unknown as AppConfig;
}

describe('createMailConnections', () => {
  // The server and `mailoo scheduler check` both build their manager here, so a call
  // without an account must reach the configured default in either process.
  it('should resolve a call without an account to default_account', () => {
    expect(createMailConnections(config('second')).connections.getAccount().name).toBe('second');
    expect(createMailServices(config('second')).connections.getAccount().name).toBe('second');
  });

  it('should refuse a call without an account when two accounts have no default', () => {
    expect(() => createMailConnections(config()).connections.getAccount()).toThrow(
      'Available accounts: first (first@example.com), second (second@example.com)',
    );
  });
});
