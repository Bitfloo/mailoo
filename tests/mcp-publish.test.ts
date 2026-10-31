import {
  install,
  installStep,
  mcpHarness,
  npmNotShownYet,
  type Publisher,
  publish,
} from './mcp-harness.js';
import { harnessedStep, requireTools, runBlock } from './workflow-yaml.js';

requireTools(['bash', 'cat', 'cp', 'grep', 'mktemp', 'rm', 'sha256sum', 'tar']);

function retries(publisher: Publisher) {
  const { status, calls, pauses, elapsedSeconds } = publish(publisher);
  return { status, calls, pauses, elapsedSeconds };
}

describe('MCP Registry publish', () => {
  it('should exit 0 after one call when mcp-publisher succeeds', () => {
    const result = publish({ reply: 'unauthorized', status: 1, succeedsOn: 1 });
    expect({
      status: result.status,
      calls: result.calls,
      loginCalls: result.loginCalls,
      pauses: result.pauses,
      elapsedSeconds: result.elapsedSeconds,
    }).toEqual({
      status: 0,
      calls: 1,
      loginCalls: 1,
      pauses: [],
      elapsedSeconds: 0,
    });
  });

  it('should stop with the first login failure even without implicit shell errexit', () => {
    const command = runBlock(harnessedStep(mcpHarness, 'Publish to MCP Registry'));
    const result = publish(
      { reply: npmNotShownYet, status: 7, succeedsOn: 1, loginFailure: { onCall: 1, status: 17 } },
      `set +e\n${command}`,
    );
    expect({
      status: result.status,
      calls: result.calls,
      loginCalls: result.loginCalls,
      pauses: result.pauses,
      elapsedSeconds: result.elapsedSeconds,
    }).toEqual({ status: 17, calls: 0, loginCalls: 1, pauses: [], elapsedSeconds: 0 });
  });

  it('should return a renewal failure instead of retrying the previous npm 404', () => {
    const result = publish({
      reply: npmNotShownYet,
      status: 7,
      loginFailure: { onCall: 2, status: 23 },
    });
    expect({
      status: result.status,
      calls: result.calls,
      loginCalls: result.loginCalls,
      pauses: result.pauses,
      elapsedSeconds: result.elapsedSeconds,
    }).toEqual({ status: 23, calls: 1, loginCalls: 2, pauses: ['20'], elapsedSeconds: 20 });
  });

  it.each([
    { reply: 'unauthorized', status: 3 },
    { reply: 'server.json schema validation failed', status: 5 },
    { reply: 'upstream request timed out', status: 9 },
  ])('should exit with status $status immediately when the publisher reports $reply', (failure) => {
    expect(retries(failure)).toEqual({
      status: failure.status,
      calls: 1,
      pauses: [],
      elapsedSeconds: 0,
    });
  });

  it('should exit after one call when the registry 404s something other than the npm version', () => {
    // The step greps for the propagation message's fixed text, not the status, so this is not
    // retried.
    expect(retries({ reply: 'server.json not found (status: 404)', status: 1 })).toEqual({
      status: 1,
      calls: 1,
      pauses: [],
      elapsedSeconds: 0,
    });
  });

  it('should publish when npm becomes available after five minutes of scanning', () => {
    const result = publish({ reply: npmNotShownYet, status: 7, availableAfter: 5 * 60 });
    expect(result.status).toBe(0);
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(5 * 60);
  });

  it('should renew the five-minute registry token before every publish during a longer npm scan', () => {
    const result = publish({ reply: npmNotShownYet, status: 7, availableAfter: 10 * 60 });
    expect(result.status).toBe(0);
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(10 * 60);
    expect(result.loginCalls).toBe(result.calls);
    expect(result.loginArgs).toEqual(
      Array.from({ length: result.calls }, () => '[login][github-oidc]'),
    );
  });

  it('should fail within a fifteen-to-thirty-minute window when npm never shows the version', () => {
    const result = publish({ reply: npmNotShownYet, status: 7 });
    expect(result.status).toBe(7);
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(15 * 60);
    expect(result.elapsedSeconds).toBeLessThanOrEqual(30 * 60);
  });

  it('should retry when the npm message arrives on stderr', () => {
    expect(retries({ reply: npmNotShownYet, status: 7, stream: 'stderr', succeedsOn: 3 })).toEqual({
      status: 0,
      calls: 3,
      pauses: ['20', '20'],
      elapsedSeconds: 40,
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
    const result = publish({ reply: npmNotShownYet, status: 7, succeedsOn: 2 });
    const announcement = result.stderr.match(
      /^npm has not propagated this version yet \(attempt 1\/\d+\); retrying in (\d+)s\n$/,
    );
    expect(announcement?.[1]).toBe(result.pauses[0]);
    expect(result.elapsedSeconds).toBeGreaterThan(0);
  });

  it('should report exhaustion after the final propagation 404', () => {
    const result = publish({ reply: npmNotShownYet, status: 7 });
    const finalLine = result.stderr.trim().split('\n').at(-1);
    expect(finalLine).toBe(`npm has not shown this version after ${result.calls} attempts`);
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
