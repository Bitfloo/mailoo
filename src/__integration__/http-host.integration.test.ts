/**
 * What the HTTP host does outside any one session: whether read_only keeps
 * the process-wide mail writers off.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import HooksService from '../services/hooks.service.js';
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
