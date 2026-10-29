import fs from 'node:fs/promises';
import path from 'node:path';

import { confirm, note, select } from '@clack/prompts';

import { useInstallHome } from '../test-support/cli-wizard.js';
import { permissionBits } from '../test-support/config-sandbox.js';
import runInstallCommand from './install-commands.js';

// The terminal UI is the only boundary replaced: answers pick Cursor and npx.
// Clack reports Ctrl-C as a symbol, which isCancel recognises.
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
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

const CURSOR_CONFIG_REGISTERED = `{
  "mcpServers": {
    "other": { "command": "other-server", "args": ["--stdio"] },
    "mailoo": { "command": "npx", "args": ["@bitfloo/mailoo", "stdio"] }
  }
}
`;

describe('mailoo install', () => {
  const sandbox = useInstallHome();

  // Reading an unparseable file as {} and writing it back replaced the
  // user's whole MCP config with the mailoo entry alone.
  it('should leave a client config that is not valid JSON byte-identical', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG_WITH_COMMENT);

    await runInstallCommand().catch(() => undefined);

    expect(await fs.readFile(sandbox.cursorConfig, 'utf-8')).toBe(CURSOR_CONFIG_WITH_COMMENT);
  });

  it('should reject naming the client config when it is not valid JSON', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG_WITH_COMMENT);

    await expect(runInstallCommand()).rejects.toThrow(`${sandbox.cursorConfig} is not valid JSON`);
  });

  it('should keep the file content out of the rejection when the config is not valid JSON', async () => {
    await fs.writeFile(
      sandbox.cursorConfig,
      '{ "mcpServers": { "x": { "env": { "KEY": "sk-secret" ',
    );

    await expect(runInstallCommand()).rejects.not.toThrow(/sk-secret/);
  });

  it('should reject a client config that is a JSON array', async () => {
    await fs.writeFile(sandbox.cursorConfig, '[]\n');

    await expect(runInstallCommand()).rejects.toThrow(`${sandbox.cursorConfig} is not valid JSON`);
  });

  it('should reject a client config that is the JSON literal null', async () => {
    await fs.writeFile(sandbox.cursorConfig, 'null\n');

    await expect(runInstallCommand()).rejects.toThrow(`${sandbox.cursorConfig} is not valid JSON`);
  });

  // root bypasses file permission bits
  it.skipIf(process.getuid?.() === 0)(
    'should reject with EACCES when the client config cannot be read',
    async () => {
      await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG);
      await fs.chmod(sandbox.cursorConfig, 0o000);

      await expect(runInstallCommand()).rejects.toMatchObject({ code: 'EACCES' });
    },
  );

  // root bypasses file permission bits
  it.skipIf(process.getuid?.() === 0)(
    'should leave a client config it cannot read byte-identical',
    async () => {
      await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG);
      await fs.chmod(sandbox.cursorConfig, 0o000);

      await runInstallCommand().catch(() => undefined);

      await fs.chmod(sandbox.cursorConfig, 0o600);
      expect(await fs.readFile(sandbox.cursorConfig, 'utf-8')).toBe(CURSOR_CONFIG);
    },
  );

  it('should add the mailoo entry and keep other servers when the config is valid JSON', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG);

    await runInstallCommand();

    expect(JSON.parse(await fs.readFile(sandbox.cursorConfig, 'utf-8'))).toEqual({
      mcpServers: {
        other: { command: 'other-server', args: ['--stdio'] },
        mailoo: { command: 'npx', args: ['-y', '@bitfloo/mailoo@latest', 'stdio'] },
      },
    });
  });

  // The node entry points at the script install ran from, Vitest's own here; pinned.
  it.each([
    ['pnpm', { command: 'pnpm', args: ['dlx', '@bitfloo/mailoo', 'stdio'] }],
    ['global', { command: 'mailoo', args: ['stdio'] }],
    ['node', { command: process.execPath, args: ['/opt/mailoo/dist/main.js', 'stdio'] }],
  ])('should write the %s launch entry', async (transport, entry) => {
    vi.mocked(select).mockResolvedValueOnce(transport);
    const script = process.argv[1];
    process.argv[1] = '/opt/mailoo/dist/main.js';
    try {
      await runInstallCommand();
    } finally {
      process.argv[1] = script;
    }

    expect(JSON.parse(await fs.readFile(sandbox.cursorConfig, 'utf-8')).mcpServers.mailoo).toEqual(
      entry,
    );
  });

  it('should write the client config with mode 0600 when it was 0644', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG);
    await fs.chmod(sandbox.cursorConfig, 0o644);

    await runInstallCommand();

    expect(permissionBits((await fs.stat(sandbox.cursorConfig)).mode)).toBe(0o600);
  });

  it('should create the client config when only its directory exists', async () => {
    await runInstallCommand();

    expect(JSON.parse(await fs.readFile(sandbox.cursorConfig, 'utf-8'))).toEqual({
      mcpServers: { mailoo: { command: 'npx', args: ['-y', expect.any(String), 'stdio'] } },
    });
  });

  it('should print the npx @latest entry to add by hand when no client is detected', async () => {
    await fs.rm(path.join(sandbox.home, '.cursor'), { recursive: true });
    vi.mocked(note).mockClear();

    await runInstallCommand();

    const printed = vi
      .mocked(note)
      .mock.calls.map(([message]) => String(message))
      .find((message) => message.includes('mcpServers'));
    expect(JSON.parse(printed ?? '{}')).toEqual({
      mcpServers: { mailoo: { command: 'npx', args: ['-y', '@bitfloo/mailoo@latest', 'stdio'] } },
    });
  });

  it('should register into a client config file that is empty', async () => {
    await fs.writeFile(sandbox.cursorConfig, '');

    await runInstallCommand();

    expect(
      Object.keys(JSON.parse(await fs.readFile(sandbox.cursorConfig, 'utf-8')).mcpServers),
    ).toEqual(['mailoo']);
  });

  it('should register into a client config file that holds only whitespace', async () => {
    await fs.writeFile(sandbox.cursorConfig, '\n  \n');

    await runInstallCommand();

    expect(
      Object.keys(JSON.parse(await fs.readFile(sandbox.cursorConfig, 'utf-8')).mcpServers),
    ).toEqual(['mailoo']);
  });

  // An in-place truncate-and-write keeps the inode; a crash mid-write left a
  // truncated client config.
  it('should replace the client config by rename instead of rewriting it in place', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG);
    const before = (await fs.stat(sandbox.cursorConfig)).ino;

    await runInstallCommand();

    expect((await fs.stat(sandbox.cursorConfig)).ino).not.toBe(before);
  });

  it('should keep a symlinked client config a symlink and update its target', async () => {
    const target = path.join(sandbox.home, 'dotfiles-mcp.json');
    await fs.writeFile(target, CURSOR_CONFIG);
    await fs.symlink(target, sandbox.cursorConfig);

    await runInstallCommand();

    expect({
      link: (await fs.lstat(sandbox.cursorConfig)).isSymbolicLink(),
      servers: Object.keys(JSON.parse(await fs.readFile(target, 'utf-8')).mcpServers),
    }).toEqual({ link: true, servers: ['other', 'mailoo'] });
  });

  it('should remove only the mailoo entry and keep other servers on remove', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG_REGISTERED);

    await runInstallCommand('remove');

    expect(JSON.parse(await fs.readFile(sandbox.cursorConfig, 'utf-8'))).toEqual({
      mcpServers: { other: { command: 'other-server', args: ['--stdio'] } },
    });
  });

  it('should drop the empty servers key when mailoo was the only server on remove', async () => {
    await fs.writeFile(
      sandbox.cursorConfig,
      '{ "mcpServers": { "mailoo": { "command": "npx", "args": ["@bitfloo/mailoo", "stdio"] } } }\n',
    );

    await runInstallCommand('remove');

    expect(JSON.parse(await fs.readFile(sandbox.cursorConfig, 'utf-8'))).toEqual({});
  });

  it.each([
    ['declined', false],
    ['cancelled with Ctrl-C', Symbol('clack:cancel')],
  ])(
    'should leave the client config byte-identical when the remove confirmation is %s',
    async (_, reply) => {
      await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG_REGISTERED);
      // The real cancel value is clack's own unique symbol; the mock checks any symbol.
      vi.mocked(confirm).mockResolvedValueOnce(reply as Awaited<ReturnType<typeof confirm>>);

      await runInstallCommand('remove');

      expect(await fs.readFile(sandbox.cursorConfig, 'utf-8')).toBe(CURSOR_CONFIG_REGISTERED);
    },
  );

  // Read as {}, an unparseable file looked like "nothing registered" and the
  // command ended quietly instead of saying the file needs fixing.
  it('should reject naming the client config on remove when it is not valid JSON', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG_WITH_COMMENT);

    await expect(runInstallCommand('remove')).rejects.toThrow(
      `${sandbox.cursorConfig} is not valid JSON`,
    );
  });

  it('should print "registered (npx @bitfloo/mailoo stdio)" for Cursor in status when mailoo is registered', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG_REGISTERED);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runInstallCommand('status');

    expect(stdout.mock.calls.flat().join('\n')).toContain(
      `Cursor — registered (npx @bitfloo/mailoo stdio)\n     ${sandbox.cursorConfig}`,
    );
    stdout.mockRestore();
  });

  it('should print "not registered" for Cursor in status when the config has only other servers', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runInstallCommand('status');

    expect(stdout.mock.calls.flat().join('\n')).toContain(
      `Cursor — not registered\n     ${sandbox.cursorConfig}`,
    );
    stdout.mockRestore();
  });

  it('should print "config not found" for a client whose config file is missing in status', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runInstallCommand('status');

    expect(stdout.mock.calls.flat().join('\n')).toContain('Cursor — config not found');
    stdout.mockRestore();
  });

  it('should print "No supported MCP clients detected" in status when no client config exists', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runInstallCommand('status');

    expect(stdout.mock.calls.flat().join('\n')).toContain('No supported MCP clients detected.');
    stdout.mockRestore();
  });

  it('should not print "No supported MCP clients detected" in status when one client config exists', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runInstallCommand('status');

    expect(stdout.mock.calls.flat().join('\n')).not.toContain('No supported MCP clients detected');
    stdout.mockRestore();
  });

  it('should report a client config that is not valid JSON in status', async () => {
    await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG_WITH_COMMENT);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runInstallCommand('status');

    expect(stdout.mock.calls.flat().join('\n')).toContain(
      `Cursor — config is not valid JSON\n     ${sandbox.cursorConfig}`,
    );
    stdout.mockRestore();
  });

  // Only a parse failure is reported in the table; an unreadable file read as
  // "not valid JSON" would send the user to fix content that is fine.
  // root bypasses file permission bits
  it.skipIf(process.getuid?.() === 0)(
    'should reject with EACCES in status when the client config cannot be read',
    async () => {
      await fs.writeFile(sandbox.cursorConfig, CURSOR_CONFIG);
      await fs.chmod(sandbox.cursorConfig, 0o000);
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await expect(runInstallCommand('status')).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        stdout.mockRestore();
      }
    },
  );
});
