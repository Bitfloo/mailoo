import { SCHEDULER_INTERVAL_MS } from '../services/scheduler.service.js';
import { buildCronLine, buildLaunchdPlist } from './scheduler-install.js';

// launchctl refuses a plist whose elements do not close in order, and install
// would still report the agent as installed.
function unclosedTags(xml: string): string[] {
  const open: string[] = [];
  const problems: string[] = [];
  // A self-closing tag such as <true/> does not match: it leaves nothing open.
  for (const [, slash, name] of xml.matchAll(/<(\/?)([A-Za-z]+)(?:\s[^>/]*)?>/g)) {
    if (slash === '') open.push(name);
    else if (open.pop() !== name) problems.push(`</${name}>`);
  }
  return [...problems, ...open.map((name) => `<${name}>`)];
}

describe('scheduler install commands', () => {
  it('should build a well-formed plist that logs both output streams', () => {
    const plist = buildLaunchdPlist('/usr/bin/node', '/opt/mailoo/main.js');
    const logPath = (key: string) =>
      new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];
    expect({
      unclosed: unclosedTags(plist),
      stdout: logPath('StandardOutPath'),
      stderr: logPath('StandardErrorPath'),
    }).toEqual({
      unclosed: [],
      stdout: '/tmp/mailoo-scheduler.log',
      stderr: '/tmp/mailoo-scheduler.log',
    });
  });

  it('should start the launchd agent on the interval the server checks the queue at', () => {
    const plist = buildLaunchdPlist('/usr/bin/node', '/opt/mailoo/main.js');
    const seconds = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1];
    expect(Number(seconds) * 1000).toBe(SCHEDULER_INTERVAL_MS);
  });

  it('should run `scheduler check` with the node and CLI paths it was given', () => {
    const plist = buildLaunchdPlist('/usr/bin/node', '/opt/mailoo/main.js');
    const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
    const args = [...(program ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
    const runAtLoad = /<key>RunAtLoad<\/key>\s*<(true|false)\/>/.exec(plist)?.[1];
    // A literal label: uninstall and status find an installed agent by it.
    expect({ args, label, runAtLoad }).toEqual({
      args: ['/usr/bin/node', '/opt/mailoo/main.js', 'scheduler', 'check'],
      label: 'com.bitfloo.mailoo.scheduler',
      runAtLoad: 'true',
    });
  });

  it('should run the crontab line on the interval the server checks the queue at', () => {
    const line = buildCronLine('/usr/bin/node', '/opt/mailoo/main.js');
    // A `*/N` minute step starts again at minute 0 every hour, so it keeps an even
    // interval only when N divides 60.
    const minutes = Number(/^\*\/(\d+) \* \* \* \* /.exec(line)?.[1]);
    expect({ ms: minutes * 60_000, dividesHour: 60 % minutes === 0 }).toEqual({
      ms: SCHEDULER_INTERVAL_MS,
      dividesHour: true,
    });
  });

  it('should quote the node and CLI paths in the crontab command', () => {
    const line = buildCronLine('/usr/bin/node', "/opt/it's/main.js");
    expect(line.split(' ').slice(5).join(' ')).toBe(
      "'/usr/bin/node' '/opt/it'\\''s/main.js' scheduler check # mailoo scheduler",
    );
  });
});
