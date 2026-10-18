import { SCHEDULER_INTERVAL_MS } from '../services/scheduler.service.js';
import { buildCronLine, buildLaunchdPlist } from './scheduler-install.js';

describe('scheduler install commands', () => {
  it('should start the launchd agent on the interval the server checks the queue at', () => {
    const plist = buildLaunchdPlist('/usr/bin/node', '/opt/mailoo/main.js');
    const seconds = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1];
    expect(Number(seconds) * 1000).toBe(SCHEDULER_INTERVAL_MS);
  });

  it('should run the crontab line on the interval the server checks the queue at', () => {
    const line = buildCronLine('/usr/bin/node', '/opt/mailoo/main.js');
    // Cron counts whole minutes, so only a `*/N` minute step can carry the interval.
    const minutes = /^\*\/(\d+) \* \* \* \* /.exec(line)?.[1];
    expect(Number(minutes) * 60_000).toBe(SCHEDULER_INTERVAL_MS);
  });

  it('should quote the node and CLI paths in the crontab command', () => {
    const line = buildCronLine('/usr/bin/node', "/opt/it's/main.js");
    expect(line.split(' ').slice(5).join(' ')).toBe(
      "'/usr/bin/node' '/opt/it'\\''s/main.js' scheduler check # mailoo scheduler",
    );
  });
});
