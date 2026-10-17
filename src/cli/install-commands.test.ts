import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import runInstallCommand from './install-commands.js';

// The terminal UI is the only boundary replaced: answers pick Cursor and npx.
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: () => false,
  confirm: vi.fn(async () => true),
  multiselect: vi.fn(async () => ['cursor']),
  select: vi.fn(async () => 'npx'),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

/** Real-world shape: Cursor accepts comments, JSON.parse does not. */
const CURSOR_CONFIG_WITH_COMMENT = `{
  // personal servers
  "mcpServers": {
    "other": { "command": "other-server", "args": ["--stdio"] }
  }
}
`;

const CURSOR_CONFIG = `{
  "mcpServers": {
    "other": { "command": "other-server", "args": ["--stdio"] }
  }
}
`;

describe('mailoo install', () => {
  let home: string;
  let cursorConfig: string;
  let ttyDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-install-'));
    await fs.mkdir(path.join(home, '.cursor'));
    cursorConfig = path.join(home, '.cursor', 'mcp.json');
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
    vi.stubEnv('APPDATA', path.join(home, 'AppData'));
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(async () => {
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  // Reading an unparseable file as {} and writing it back replaced the
  // user's whole MCP config with the mailoo entry alone.
  it('should leave a client config that is not valid JSON byte-identical', async () => {
    await fs.writeFile(cursorConfig, CURSOR_CONFIG_WITH_COMMENT);

    await runInstallCommand().catch(() => undefined);

    expect(await fs.readFile(cursorConfig, 'utf-8')).toBe(CURSOR_CONFIG_WITH_COMMENT);
  });

  it('should reject naming the client config when it is not valid JSON', async () => {
    await fs.writeFile(cursorConfig, CURSOR_CONFIG_WITH_COMMENT);

    await expect(runInstallCommand()).rejects.toThrow(`${cursorConfig} is not valid JSON`);
  });

  it('should keep the file content out of the rejection when the config is not valid JSON', async () => {
    await fs.writeFile(cursorConfig, '{ "mcpServers": { "x": { "env": { "KEY": "sk-secret" ');

    await expect(runInstallCommand()).rejects.not.toThrow(/sk-secret/);
  });

  it('should reject a client config that is a JSON array', async () => {
    await fs.writeFile(cursorConfig, '[]\n');

    await expect(runInstallCommand()).rejects.toThrow(`${cursorConfig} is not valid JSON`);
  });

  it('should add the mailoo entry and keep other servers when the config is valid JSON', async () => {
    await fs.writeFile(cursorConfig, CURSOR_CONFIG);

    await runInstallCommand();

    expect(JSON.parse(await fs.readFile(cursorConfig, 'utf-8'))).toEqual({
      mcpServers: {
        other: { command: 'other-server', args: ['--stdio'] },
        mailoo: { command: 'npx', args: [expect.any(String), 'stdio'] },
      },
    });
  });

  it('should create the client config when only its directory exists', async () => {
    await runInstallCommand();

    expect(JSON.parse(await fs.readFile(cursorConfig, 'utf-8'))).toEqual({
      mcpServers: { mailoo: { command: 'npx', args: [expect.any(String), 'stdio'] } },
    });
  });

  it('should register into a client config file that is empty', async () => {
    await fs.writeFile(cursorConfig, '');

    await runInstallCommand();

    expect(Object.keys(JSON.parse(await fs.readFile(cursorConfig, 'utf-8')).mcpServers)).toEqual([
      'mailoo',
    ]);
  });

  // An in-place truncate-and-write keeps the inode; a crash mid-write left a
  // truncated client config.
  it('should replace the client config by rename instead of rewriting it in place', async () => {
    await fs.writeFile(cursorConfig, CURSOR_CONFIG);
    const before = (await fs.stat(cursorConfig)).ino;

    await runInstallCommand();

    expect((await fs.stat(cursorConfig)).ino).not.toBe(before);
  });

  it('should keep a symlinked client config a symlink and update its target', async () => {
    const target = path.join(home, 'dotfiles-mcp.json');
    await fs.writeFile(target, CURSOR_CONFIG);
    await fs.symlink(target, cursorConfig);

    await runInstallCommand();

    expect({
      link: (await fs.lstat(cursorConfig)).isSymbolicLink(),
      servers: Object.keys(JSON.parse(await fs.readFile(target, 'utf-8')).mcpServers),
    }).toEqual({ link: true, servers: ['other', 'mailoo'] });
  });

  it('should leave a client config that is not valid JSON byte-identical on remove', async () => {
    await fs.writeFile(cursorConfig, CURSOR_CONFIG_WITH_COMMENT);

    await runInstallCommand('remove').catch(() => undefined);

    expect(await fs.readFile(cursorConfig, 'utf-8')).toBe(CURSOR_CONFIG_WITH_COMMENT);
  });

  it('should report a client config that is not valid JSON in status', async () => {
    await fs.writeFile(cursorConfig, CURSOR_CONFIG_WITH_COMMENT);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runInstallCommand('status');

    expect(stdout.mock.calls.flat().join('\n')).toContain(
      `Cursor — config is not valid JSON\n     ${cursorConfig}`,
    );
    stdout.mockRestore();
  });
});
