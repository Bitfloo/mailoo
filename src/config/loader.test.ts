import fs from 'node:fs/promises';
import path from 'node:path';

import { ZodError } from 'zod';

import {
  MINIMAL_TOML,
  permissionBits,
  useConfigSandbox,
  writeOwnerOnly,
} from '../test-support/config-sandbox.js';
import type { AppConfig } from '../types/index.js';
import { configExists, generateTemplate, loadConfig, loadRawConfig } from './loader.js';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('Config Loader', () => {
  const sandbox = useConfigSandbox();

  // -------------------------------------------------------------------------
  // loadConfig from TOML file
  // -------------------------------------------------------------------------

  describe('loadConfig from TOML file', () => {
    it.each([
      { label: '0600', mode: 0o600, warningLines: 0, claim: 'no warning line' },
      { label: '0640', mode: 0o640, warningLines: 1, claim: 'one warning' },
      { label: '0604', mode: 0o604, warningLines: 1, claim: 'one warning' },
    ])('should log $claim when the config mode is $label', async ({ mode, warningLines }) => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
      await fs.chmod(configPath, mode);

      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await loadConfig(configPath);

        const warnings = stderr.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('warning'));
        expect(warnings).toHaveLength(warningLines);
      } finally {
        stderr.mockRestore();
      }
    });

    describe('group-readable config file', () => {
      let configPath: string;

      beforeEach(async () => {
        configPath = path.join(sandbox.dir, 'config.toml');
        await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
        await fs.chmod(configPath, 0o644);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      });

      it('should name chmod 600 and the path in the warning', async () => {
        await loadConfig(configPath);

        expect(
          vi
            .mocked(process.stderr.write)
            .mock.calls.map((call) => String(call[0]))
            .filter((line) => line.includes('warning')),
        ).toEqual([expect.stringContaining(`chmod 600 ${configPath}`)]);
      });

      it('should leave the file mode unchanged when it warns', async () => {
        await loadConfig(configPath);

        expect(permissionBits((await fs.stat(configPath)).mode)).toBe(0o644);
      });

      it('should still load the accounts when it warns', async () => {
        const config = await loadConfig(configPath);

        expect(config.accounts[0].email).toBe('test@example.com');
      });
    });

    it('should load config when the file is a symlink', async () => {
      const real = path.join(sandbox.dir, 'real.toml');
      await fs.writeFile(real, MINIMAL_TOML, 'utf-8');
      await fs.chmod(real, 0o600);
      const link = path.join(sandbox.dir, 'link.toml');
      await fs.symlink('real.toml', link);

      const config = await loadConfig(link);

      expect(config.accounts[0].email).toBe('test@example.com');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(link)).toBe('real.toml');
    });

    it('should load config when its directory is a symlink', async () => {
      const realDir = path.join(sandbox.dir, 'real-dir');
      await fs.mkdir(realDir);
      const realFile = path.join(realDir, 'config.toml');
      await fs.writeFile(realFile, MINIMAL_TOML, 'utf-8');
      await fs.chmod(realFile, 0o644);
      const linkDir = path.join(sandbox.dir, 'linked-dir');
      await fs.symlink('real-dir', linkDir);

      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const config = await loadConfig(path.join(linkDir, 'config.toml'));

        expect(config.accounts[0].email).toBe('test@example.com');
        expect((await fs.lstat(linkDir)).isSymbolicLink()).toBe(true);
        expect(permissionBits((await fs.stat(realFile)).mode)).toBe(0o644);
      } finally {
        stderr.mockRestore();
      }
    });

    it('loads a valid TOML config file', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML);

      const config = await loadConfig(configPath);

      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0].name).toBe('test');
      expect(config.accounts[0].email).toBe('test@example.com');
      expect(config.accounts[0].imap.host).toBe('imap.example.com');
      expect(config.accounts[0].smtp.host).toBe('smtp.example.com');
    });

    describe.each([
      ['imap', 'IMAP'],
      ['smtp', 'SMTP'],
    ])('with a blank %s host', (table, label) => {
      // JSON escapes are TOML escapes, so the file holds the whitespace the row names.
      it.each([
        ['only spaces', '   '],
        ['a tab', '\t'],
        ['mixed blanks', ' \t\n '],
        ['CRLF', '\r\n'],
        ['a no-break space', '\u00a0'],
      ])('should refuse a config file whose host is %s, naming the field', async (_name, host) => {
        const configPath = path.join(sandbox.dir, 'config.toml');
        await writeOwnerOnly(
          configPath,
          MINIMAL_TOML.replace(`host = "${table}.example.com"`, `host = ${JSON.stringify(host)}`),
        );

        const refused = await loadConfig(configPath).catch((error: unknown) => {
          if (!(error instanceof ZodError)) throw error;
          return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
        });

        expect(refused).toEqual([`accounts.0.${table}.host: ${label} host is required`]);
      });
    });

    // The blank check reads the trimmed host; the host itself is used as written.
    it.each([
      ['padded', ' imap.example.com ', ' smtp.example.com '],
      ['one-character', 'a', 'a'],
      ['padded one-character', ' a ', ' a '],
    ])(
      'should keep %s IMAP and SMTP hosts from the config file as written',
      async (_kind, imapHost, smtpHost) => {
        const configPath = path.join(sandbox.dir, 'config.toml');
        await writeOwnerOnly(
          configPath,
          MINIMAL_TOML.replace('"imap.example.com"', JSON.stringify(imapHost)).replace(
            '"smtp.example.com"',
            JSON.stringify(smtpHost),
          ),
        );

        const { imap, smtp } = (await loadConfig(configPath)).accounts[0];

        expect([imap.host, smtp.host]).toEqual([imapHost, smtpHost]);
      },
    );

    it('throws when config file does not exist', async () => {
      const badPath = path.join(sandbox.dir, 'nonexistent.toml');
      await expect(loadConfig(badPath)).rejects.toThrow('No configuration found');
    });

    it('should reject a config path that contains a null byte before reading it', async () => {
      await expect(loadConfig(path.join(sandbox.dir, 'a\0b.toml'))).rejects.toThrow(
        'Config path is not valid',
      );
    });

    it('should treat a directory at the config path as no config file', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await fs.mkdir(configPath);

      await expect(loadConfig(configPath)).rejects.toThrow('No configuration found');
    });

    // root bypasses directory permission bits
    it.skipIf(process.getuid?.() === 0)(
      'should reject with EACCES instead of "No configuration found" when the config directory cannot be searched',
      async () => {
        const locked = path.join(sandbox.dir, 'locked');
        await fs.mkdir(locked);
        await writeOwnerOnly(path.join(locked, 'config.toml'), MINIMAL_TOML);
        await fs.chmod(locked, 0o000);
        try {
          await expect(loadConfig(path.join(locked, 'config.toml'))).rejects.toMatchObject({
            code: 'EACCES',
          });
        } finally {
          await fs.chmod(locked, 0o700);
        }
      },
    );

    // root bypasses file permission bits
    it.skipIf(process.getuid?.() === 0)(
      'should reject with EACCES when the config file exists but cannot be read',
      async () => {
        const configPath = path.join(sandbox.dir, 'config.toml');
        await writeOwnerOnly(configPath, MINIMAL_TOML);
        await fs.chmod(configPath, 0o000);

        await expect(loadConfig(configPath)).rejects.toMatchObject({ code: 'EACCES' });
      },
    );

    it('should name the path when loadRawConfig finds no config file', async () => {
      const badPath = path.join(sandbox.dir, 'nonexistent.toml');

      await expect(loadRawConfig(badPath)).rejects.toThrow(`No config file found at: ${badPath}`);
    });

    // A typo used to read as "No configuration found" and point at setup,
    // which can overwrite the file the user only needed to fix.
    it('should name the file, line and column when the TOML has a syntax error', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, `${MINIMAL_TOML}\n[accounts.smtp\n`);

      await expect(loadConfig(configPath)).rejects.toThrow(
        new RegExp(
          `^Config file ${escapeRegExp(configPath)} is not valid TOML \\(line 13, column \\d+\\): `,
        ),
      );
    });

    it('should not point at setup when the TOML has a syntax error', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, `${MINIMAL_TOML}\n[accounts.smtp\n`);

      await expect(loadConfig(configPath)).rejects.not.toThrow(/No configuration found|setup/);
    });

    it('should keep the offending line text out of the TOML syntax error', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML.replace('"secret"', '"hunter2'));

      await expect(loadConfig(configPath)).rejects.not.toThrow(/hunter2/);
    });

    it('should name the file when loadRawConfig meets a TOML syntax error', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, `${MINIMAL_TOML}\n[accounts.smtp\n`);

      await expect(loadRawConfig(configPath)).rejects.toThrow(`Config file ${configPath}`);
    });

    describe('defaults for optional fields', () => {
      let config: AppConfig;

      beforeEach(async () => {
        const configPath = path.join(sandbox.dir, 'config.toml');
        await writeOwnerOnly(configPath, MINIMAL_TOML);
        config = await loadConfig(configPath);
      });

      it('should apply the IMAP defaults when the account sets only the host', () => {
        const { port, tls, verifySsl } = config.accounts[0].imap;

        expect({ port, tls, verifySsl }).toEqual({ port: 993, tls: true, verifySsl: true });
      });

      it('should apply the SMTP and pool defaults when the account sets only the host', () => {
        const { smtp } = config.accounts[0];

        expect({
          port: smtp.port,
          poolEnabled: smtp.pool?.enabled,
          maxConnections: smtp.pool?.maxConnections,
        }).toEqual({ port: 465, poolEnabled: true, maxConnections: 1 });
      });

      it('should apply the settings defaults when the file has no [settings] table', () => {
        const { settings } = config;

        expect({
          rateLimit: settings.rateLimit,
          readOnly: settings.readOnly,
          watcherEnabled: settings.watcher.enabled,
          watcherFolders: settings.watcher.folders,
          onNewEmail: settings.hooks.onNewEmail,
          preset: settings.hooks.preset,
          allowPrivateWebhooks: settings.hooks.alerts.allowPrivateWebhooks,
          systemOneEnabled: settings.systemOne.enabled,
          autoMove: settings.systemOne.autoMove,
          autoFlag: settings.systemOne.autoFlag,
          includeBody: settings.systemOne.includeBody,
          isCriticalMin: settings.systemOne.thresholds.isCriticalMin,
          injectionHigh: settings.systemOne.thresholds.injectionHigh,
        }).toEqual({
          rateLimit: 10,
          readOnly: false,
          watcherEnabled: false,
          watcherFolders: ['INBOX'],
          onNewEmail: 'notify',
          preset: 'priority-focus',
          allowPrivateWebhooks: false,
          systemOneEnabled: false,
          autoMove: false,
          autoFlag: false,
          includeBody: false,
          isCriticalMin: 0.85,
          injectionHigh: 0.75,
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // configExists
  // -------------------------------------------------------------------------

  describe('configExists', () => {
    it('returns true for existing file', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      expect(await configExists(configPath)).toBe(true);
    });

    it('returns false for non-existing file', async () => {
      const badPath = path.join(sandbox.dir, 'nope.toml');

      expect(await configExists(badPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // generateTemplate
  // -------------------------------------------------------------------------

  describe('generateTemplate', () => {
    it('returns valid TOML template string', () => {
      const template = generateTemplate();

      expect(typeof template).toBe('string');
      expect(template).toContain('[[accounts]]');
      expect(template).toContain('[accounts.imap]');
      expect(template).toContain('[accounts.smtp]');
      expect(template).toContain('[settings]');
      expect(template).toContain('rate_limit');
      expect(template).toContain('[settings.system_one]');
      expect(template).not.toContain('TYPESAFE_API_KEY =');
    });
  });
});
