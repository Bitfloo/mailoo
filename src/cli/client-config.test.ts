import { isRegistered } from './client-config.js';

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
