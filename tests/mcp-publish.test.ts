import { install, installStep, npmNotShownYet, type Publisher, publish } from './mcp-harness.js';
import { requireTools, runBlock } from './workflow-yaml.js';

requireTools(['bash', 'cat', 'cp', 'grep', 'mktemp', 'rm', 'sha256sum', 'tar']);

function retries(publisher: Publisher) {
  const { status, calls, pauses } = publish(publisher);
  return { status, calls, pauses };
}

describe('MCP Registry publish', () => {
  it('should exit 0 after one call when mcp-publisher succeeds', () => {
    expect(retries({ reply: 'unauthorized', status: 1, succeedsOn: 1 })).toEqual({
      status: 0,
      calls: 1,
      pauses: [],
    });
  });

  it("should exit with the publisher's status after one call when the error is not npm's", () => {
    expect(retries({ reply: 'unauthorized', status: 3 })).toEqual({
      status: 3,
      calls: 1,
      pauses: [],
    });
  });

  it('should exit after one call when the registry 404s something other than the npm version', () => {
    // The step greps for the propagation message's fixed text, not the status, so this is not
    // retried.
    expect(retries({ reply: 'server.json not found (status: 404)', status: 1 })).toEqual({
      status: 1,
      calls: 1,
      pauses: [],
    });
  });

  it('should call mcp-publisher six times, 20 seconds apart, and fail when npm never shows the version', () => {
    expect(retries({ reply: npmNotShownYet, status: 7 })).toEqual({
      status: 7,
      calls: 6,
      pauses: ['20', '20', '20', '20', '20'],
    });
  });

  it('should retry when the npm message arrives on stderr', () => {
    expect(retries({ reply: npmNotShownYet, status: 7, stream: 'stderr', succeedsOn: 3 })).toEqual({
      status: 0,
      calls: 3,
      pauses: ['20', '20'],
    });
  });

  it('should call mcp-publisher with the publish command and no other argument', () => {
    // Another argument, such as --dry-run, or another command would register nothing.
    expect(publish({ reply: npmNotShownYet, status: 7, succeedsOn: 3 }).args).toEqual([
      '[publish]',
      '[publish]',
      '[publish]',
    ]);
  });

  it('should say on stderr that it retries, and in how long, after a propagation 404', () => {
    expect(publish({ reply: npmNotShownYet, status: 7, succeedsOn: 2 }).stderr).toBe(
      'npm has not propagated this version yet (attempt 1/6); retrying in 20s\n',
    );
  });

  it('should say on stderr that it gave up after the last of six propagation 404s', () => {
    const lines = publish({ reply: npmNotShownYet, status: 7 }).stderr.split('\n');
    expect(lines.slice(-2)).toEqual(['npm has not shown this version after 6 attempts', '']);
  });

  it('should keep the registry reply in one temp file and remove it when the step ends', () => {
    // A fixed path would be shared by every job on a runner, and a file left behind outlives it.
    expect(publish({ reply: 'unauthorized', status: 3 }).temps).toEqual({ made: 1, left: 0 });
  });

  it("should print the registry's reply when a publish call fails", () => {
    // The reply is the only record of why the registry refused the server.json.
    expect(publish({ reply: 'unauthorized', status: 3 }).stdout).toBe('Error: unauthorized\n');
  });

  it('should download, check and extract one pinned mcp-publisher archive', () => {
    const tag = 'v1.8.1';
    const archive = 'mcp-publisher_linux_amd64.tar.gz';
    // The archive's line in registry_1.8.1_checksums.txt, an asset of the v1.8.1 release of
    // github.com/modelcontextprotocol/registry, read with gh api.
    const sha256 = 'a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc';
    const url = `https://github.com/modelcontextprotocol/registry/releases/download/${tag}/${archive}`;
    expect(runBlock(installStep).split('\n')).toEqual([
      `curl -fsSL -o ${archive} "${url}"`,
      `echo "${sha256}  ${archive}" | sha256sum -c -`,
      `tar -xzf ${archive} mcp-publisher`,
    ]);
  });

  it('should stop the release when the mcp-publisher archive hash does not match', () => {
    expect(install('checked')).toEqual({ status: 1, extracted: false });
  });

  it('should extract mcp-publisher when the archive hash matches', () => {
    expect(install('shimmed')).toEqual({ status: 0, extracted: true });
  });
});
