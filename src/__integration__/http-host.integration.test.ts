/**
 * What the HTTP host does outside any one session: whether read_only keeps
 * the process-wide mail writers off, and its answers on paths that are not
 * the MCP endpoint.
 */

import fs from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import HooksService from '../services/hooks.service.js';
import { send } from '../test-support/http-transport-harness.js';
import { startHost, testConfig } from './helpers/http-host.js';

// The integration config already reads only, so a host that ignored
// read_only in HTTP mode would have looked the same to every other suite.
describe('HTTP host read_only', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function writersAfterBoot(readOnly: boolean): Promise<Record<string, boolean>> {
    const config = testConfig();
    config.settings.readOnly = readOnly;
    const hooksStart = vi.spyOn(HooksService.prototype, 'start');
    const running = await startHost({ now: 1_000 }, 5_000, config);
    const checkAndSend = vi.spyOn(running.host.scheduler, 'checkAndSend');
    const client = new Client({ name: 'mailoo-read-only', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );
      await running.host.ready;
      return {
        hooksStarted: hooksStart.mock.calls.length > 0,
        schedulerRan: checkAndSend.mock.calls.length > 0,
      };
    } finally {
      await client.close().catch(() => undefined);
      await running.stop();
    }
  }

  it('should not arm the scheduler or start the hooks when settings.readOnly is true', async () => {
    expect(await writersAfterBoot(true)).toEqual({ hooksStarted: false, schedulerRan: false });
  });

  it('should arm the scheduler and start the hooks when settings.readOnly is false', async () => {
    expect(await writersAfterBoot(false)).toEqual({ hooksStarted: true, schedulerRan: true });
  });
});

describe('HTTP host routes', () => {
  async function ask(method: string, path: string, headers: Record<string, string> = {}) {
    const running = await startHost({ now: 1_000 }, 5_000);
    try {
      const host = `127.0.0.1:${running.port}`;
      return await send(running.port, { host, ...headers }, { method, path });
    } finally {
      await running.stop();
    }
  }

  it('should answer 404 for an unknown path', async () => {
    const res = await ask('GET', '/other');

    expect({ status: res.status, body: res.body }).toEqual({ status: 404, body: 'Not Found' });
  });

  it('should answer 405 with Allow GET for POST /health', async () => {
    const res = await ask('POST', '/health', { 'content-type': 'application/json' });

    expect({ status: res.status, allow: res.headers.allow }).toEqual({ status: 405, allow: 'GET' });
  });

  it('should answer /health with ok and the package version', async () => {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    const res = await ask('GET', '/health');

    expect({ status: res.status, body: JSON.parse(res.body) }).toEqual({
      status: 200,
      body: { ok: true, version: pkg.version },
    });
  });
});
