import fs from 'node:fs/promises';
import path from 'node:path';

import {
  MINIMAL_TOML,
  permissionBits,
  useConfigSandbox,
  writeOwnerOnly,
} from '../test-support/config-sandbox.js';
import { loadConfig, saveConfig } from './loader.js';

const RAW_CONFIG = {
  accounts: [
    {
      name: 'saved-test',
      email: 'saved@example.com',
      password: 'saved-pass',
      imap: { host: 'imap.saved.example.com' },
      smtp: { host: 'smtp.saved.example.com' },
    },
  ],
} as unknown as Parameters<typeof saveConfig>[0];

describe('saveConfig', () => {
  const sandbox = useConfigSandbox();

  it('saves config as TOML and can be re-read', async () => {
    const configPath = path.join(sandbox.dir, 'saved.toml');

    await saveConfig(RAW_CONFIG, configPath);

    const reloaded = await loadConfig(configPath);
    expect(reloaded.accounts[0].name).toBe('saved-test');
    expect(reloaded.accounts[0].email).toBe('saved@example.com');
    expect(reloaded.accounts[0].imap.host).toBe('imap.saved.example.com');
  });

  it('writes the file as owner-only and the parent directory as owner-only', async () => {
    const dir = path.join(sandbox.dir, 'cfg');
    const configPath = path.join(dir, 'config.toml');

    await saveConfig(RAW_CONFIG, configPath);

    expect(permissionBits((await fs.stat(configPath)).mode)).toBe(0o600);
    expect(permissionBits((await fs.stat(dir)).mode)).toBe(0o700);
  });

  it('should keep a symlinked config file and update its target', async () => {
    const store = path.join(sandbox.dir, 'store');
    await fs.mkdir(store);
    const target = path.join(store, 'target.toml');
    await fs.writeFile(target, 'original');
    const linkDir = path.join(sandbox.dir, 'links');
    await fs.mkdir(linkDir);
    const configPath = path.join(linkDir, 'config.toml');
    const linkText = path.relative(linkDir, target);
    await fs.symlink(linkText, configPath);
    // The link's directory cannot hold a temp file. The write has to
    // rename inside the directory that contains the target.
    await fs.chmod(linkDir, 0o555);
    const inodeBefore = (await fs.stat(target)).ino;

    try {
      await saveConfig(RAW_CONFIG, configPath);

      expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(configPath)).toBe(linkText);
      expect(await fs.readFile(target, 'utf-8')).toContain('saved-test');
      expect(permissionBits((await fs.stat(target)).mode)).toBe(0o600);
      expect((await fs.stat(target)).ino).not.toBe(inodeBefore);
      expect(permissionBits((await fs.stat(linkDir)).mode)).toBe(0o555);
      expect((await fs.readdir(store)).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      await fs.chmod(linkDir, 0o700);
    }
  });

  it('should write through a symlinked directory without replacing the link', async () => {
    const realDir = path.join(sandbox.dir, 'real');
    await fs.mkdir(realDir, { mode: 0o755 });
    await fs.chmod(realDir, 0o755);
    const link = path.join(sandbox.dir, 'linked');
    await fs.symlink('real', link);

    await saveConfig(RAW_CONFIG, path.join(link, 'config.toml'));

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(link)).toBe('real');
    expect(permissionBits((await fs.stat(realDir)).mode)).toBe(0o755);
    const written = path.join(realDir, 'config.toml');
    expect(permissionBits((await fs.stat(written)).mode)).toBe(0o600);
    expect(await fs.readFile(written, 'utf-8')).toContain('saved-test');
  });

  it('should leave the mode of an existing directory unchanged', async () => {
    const dir = path.join(sandbox.dir, 'cfg');
    await fs.mkdir(dir, { mode: 0o755 });
    await fs.chmod(dir, 0o755);

    await saveConfig(RAW_CONFIG, path.join(dir, 'config.toml'));

    expect(permissionBits((await fs.stat(dir)).mode)).toBe(0o755);
    expect(permissionBits((await fs.stat(path.join(dir, 'config.toml'))).mode)).toBe(0o600);
  });

  it('rejects a config path that contains a null byte', async () => {
    await expect(saveConfig(RAW_CONFIG, 'bad\0.toml')).rejects.toThrow(/not valid/);
  });

  describe('temp file', () => {
    function staleTempPath(): string {
      return path.join(sandbox.dir, `.config.toml.${process.pid}.tmp`);
    }

    // The temp file holds the whole config, passwords included.
    it('should leave no temp file behind when replacing the config fails', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML);
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(
        Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }),
      );

      const outcome = await saveConfig(RAW_CONFIG, configPath).then(
        () => 'saved',
        (error: Error) => error.message,
      );

      expect({ outcome, entries: await fs.readdir(sandbox.dir) }).toEqual({
        outcome: 'cross-device link not permitted',
        entries: ['config.toml'],
      });
    });

    it('should save over a stale temp file left by an earlier process with the same pid', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await fs.writeFile(staleTempPath(), 'stale');

      await saveConfig(RAW_CONFIG, configPath);

      expect(await fs.readFile(configPath, 'utf-8')).toContain('saved-test');
    });

    it('should remove a stale temp symlink without writing to its target', async () => {
      const decoy = path.join(sandbox.dir, 'decoy.txt');
      await fs.writeFile(decoy, 'decoy');
      await fs.symlink(decoy, staleTempPath());

      await saveConfig(RAW_CONFIG, path.join(sandbox.dir, 'config.toml'));

      expect(await fs.readFile(decoy, 'utf-8')).toBe('decoy');
    });
  });
});
