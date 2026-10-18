import { install, installStep, type Publisher, publish } from './mcp-harness.js';
import { requireTools } from './workflow-yaml.js';

requireTools(['bash', 'grep', 'sha256sum', 'tar']);

/** The exit status, the calls and each pause of one publish run. */
function retries(publisher: Publisher) {
  const { status, calls, pauses } = publish(publisher);
  return { status, calls, pauses };
}

describe('MCP Registry publish', () => {
  it('should exit 0 after one call when mcp-publisher succeeds', () => {
    expect(retries({ error: 'other', status: 1, succeedsOn: 1 })).toEqual({
      status: 0,
      calls: 1,
      pauses: [],
    });
  });

  it("should exit with the publisher's status after one call when the error is not npm's", () => {
    expect(retries({ error: 'other', status: 3 })).toEqual({ status: 3, calls: 1, pauses: [] });
  });

  it('should call mcp-publisher six times, 20 seconds apart, and fail when npm never shows the version', () => {
    expect(retries({ error: 'npm', status: 7 })).toEqual({
      status: 7,
      calls: 6,
      pauses: ['20', '20', '20', '20', '20'],
    });
  });

  it('should retry when the npm message arrives on stderr', () => {
    expect(retries({ error: 'npm', status: 7, stream: 'stderr', succeedsOn: 3 })).toEqual({
      status: 0,
      calls: 3,
      pauses: ['20', '20'],
    });
  });

  it('should call mcp-publisher with the publish command and no other argument', () => {
    // Another argument, such as --dry-run, or another command would register nothing.
    expect(publish({ error: 'npm', status: 7, succeedsOn: 3 }).args).toEqual([
      '[publish]',
      '[publish]',
      '[publish]',
    ]);
  });

  it("should print the registry's reply when a publish call fails", () => {
    // The reply is the only record of why the registry refused the server.json.
    expect(publish({ error: 'other', status: 3 }).stdout).toBe('Error: unauthorized\n');
  });

  it('should pin the mcp-publisher archive hash in the install step', () => {
    expect(installStep).not.toContain('releases/latest');
    expect(installStep).toMatch(/\b[0-9a-f]{64}\b/);
  });

  it('should stop the release when the mcp-publisher archive hash does not match', () => {
    expect(install('checked')).toEqual({ status: 1, extracted: false });
  });

  it('should extract mcp-publisher when the archive hash matches', () => {
    expect(install('shimmed')).toEqual({ status: 0, extracted: true });
  });
});
