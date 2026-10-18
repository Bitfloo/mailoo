/**
 * Setup the config loader suites share, so each one starts from the same
 * cleared MCP_EMAIL_* environment and its own temp directory.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MINIMAL_TOML = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

/** writeFile follows the umask, usually 0644, which warns on load. */
export async function writeOwnerOnly(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, 'utf-8');
  await fs.chmod(filePath, 0o600);
}

export function permissionBits(mode: number): number {
  return mode % 0o1000;
}

/** Set in this shell, plus the ones the suites set themselves. */
const MCP_ENV_KEYS = [
  ...new Set([
    ...Object.keys(process.env).filter((k) => k.startsWith('MCP_EMAIL_')),
    'MCP_EMAIL_ADDRESS',
    'MCP_EMAIL_PASSWORD',
    'MCP_EMAIL_IMAP_HOST',
    'MCP_EMAIL_SMTP_HOST',
    'MCP_EMAIL_READ_ONLY',
    'MCP_EMAIL_ACCOUNT_NAME',
    'MCP_EMAIL_TOOLSET',
    'MCP_EMAIL_DEFAULT_ACCOUNT',
  ]),
];

/**
 * A fresh temp directory for each test, with MCP_EMAIL_* cleared: loadConfig
 * reads an account from the environment before it reads the file.
 */
export function useConfigSandbox(): { readonly dir: string } {
  const sandbox = { dir: '' };
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    sandbox.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-test-'));
    MCP_ENV_KEYS.forEach((key) => {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(sandbox.dir, { recursive: true, force: true });
    Object.entries(savedEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  return sandbox;
}
