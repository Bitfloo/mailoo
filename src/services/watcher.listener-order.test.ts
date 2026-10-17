import { ImapFlow } from 'imapflow';

import { tearDownWatchers, watch } from '../test-support/watcher-harness.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(tearDownWatchers);

describe('WatcherService with the installed imapflow', () => {
  it('should bind its error, close and exists listeners before it calls connect', async () => {
    const on = vi.spyOn(ImapFlow.prototype, 'on');
    // Refused before any socket opens, so the spec needs no server.
    const connect = vi
      .spyOn(ImapFlow.prototype, 'connect')
      .mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { watcher } = watch();
    await watcher.start();
    const connectOrder = connect.mock.invocationCallOrder[0];
    const boundBeforeConnect = on.mock.calls
      .filter((_call, index) => on.mock.invocationCallOrder[index] < connectOrder)
      .map(([event]) => event);
    expect(boundBeforeConnect).toEqual(expect.arrayContaining(['error', 'close', 'exists']));
  });
});
