import os from 'node:os';

import { getClients, isRegistered } from './client-config.js';

const OTHER_SERVER = { command: 'other-server', args: ['--stdio'] };
const MAILOO_SERVER = { command: 'npx', args: ['@bitfloo/mailoo', 'stdio'] };

// install, remove and status all branch on this answer.
describe('isRegistered', () => {
  it('should return false when the servers key holds only other servers', () => {
    expect(isRegistered({ mcpServers: { other: OTHER_SERVER } }, 'mcpServers')).toBe(false);
  });

  it('should return true when the servers key holds the mailoo entry', () => {
    expect(
      isRegistered({ mcpServers: { other: OTHER_SERVER, mailoo: MAILOO_SERVER } }, 'mcpServers'),
    ).toBe(true);
  });

  it('should return false when the config has no servers key', () => {
    expect(isRegistered({}, 'mcpServers')).toBe(false);
  });
});

// A wrong path installs mailoo where the client never reads it.
describe('getClients', () => {
  const home = '/home/mailoo-test';

  beforeEach(() => {
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    vi.stubEnv('APPDATA', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['cursor', 'darwin', `${home}/.cursor/mcp.json`],
    ['windsurf', 'darwin', `${home}/.codeium/windsurf/mcp_config.json`],
    ['claude', 'darwin', `${home}/Library/Application Support/Claude/claude_desktop_config.json`],
    ['claude', 'linux', `${home}/.config/Claude/claude_desktop_config.json`],
    ['claude', 'win32', `${home}/AppData/Roaming/Claude/claude_desktop_config.json`],
  ] as const)('should resolve the %s config path under HOME on %s', (id, platform, expected) => {
    vi.spyOn(os, 'platform').mockReturnValue(platform);

    expect(getClients().find((client) => client.id === id)?.configPath).toBe(expected);
  });
});
