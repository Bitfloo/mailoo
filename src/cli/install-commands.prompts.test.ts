import fs from 'node:fs/promises';
import path from 'node:path';

import {
  promptPattern,
  promptRoster,
  resetWizard,
  useInstallHome,
} from '../test-support/cli-wizard.js';
import runInstallCommand from './install-commands.js';

const { wizard } = await vi.hoisted(async () => {
  const { newWizardState } = await import('../test-support/cli-wizard.js');
  return { wizard: newWizardState() };
});

// The terminal UI is the only boundary replaced: the answers pick Cursor and npx.
vi.mock('@clack/prompts', async () => {
  const { clackPromptsMock } = await import('../test-support/cli-wizard.js');
  return clackPromptsMock(wizard, {
    'Which MCP clients should mailoo be registered with?': ['cursor'],
    'How should the MCP client launch mailoo?': 'npx',
    'Unregister mailoo from which clients?': ['cursor'],
    'Remove mailoo from 1 client(s)?': true,
  });
});

const OTHER_ONLY = `{
  "mcpServers": {
    "other": { "command": "other-server", "args": ["--stdio"] }
  }
}
`;

const REGISTERED = `{
  "mcpServers": {
    "other": { "command": "other-server", "args": ["--stdio"] },
    "mailoo": { "command": "npx", "args": ["@bitfloo/mailoo", "stdio"] }
  }
}
`;

/** One row per prompt in install-commands.ts: [prompt, subcommand, both configs]. */
const CANCEL_ROWS = [
  ['Which MCP clients should mailoo be registered with?', undefined, OTHER_ONLY],
  ['How should the MCP client launch mailoo?', undefined, OTHER_ONLY],
  ['Unregister mailoo from which clients?', 'remove', REGISTERED],
  ['Remove mailoo from * client(s)?', 'remove', REGISTERED],
] as const;

const PICKS = [
  { picked: 'cursor', other: 'windsurf' },
  { picked: 'windsurf', other: 'cursor' },
] as const;

type Client = (typeof PICKS)[number]['picked'];

describe('mailoo install with Cursor and Windsurf both present', () => {
  const sandbox = useInstallHome();

  function configOf(client: Client): string {
    return client === 'cursor'
      ? sandbox.cursorConfig
      : path.join(sandbox.home, '.codeium', 'windsurf', 'mcp_config.json');
  }

  async function writeBoth(content: string): Promise<void> {
    await fs.mkdir(path.dirname(configOf('windsurf')), { recursive: true });
    await fs.writeFile(configOf('cursor'), content);
    await fs.writeFile(configOf('windsurf'), content);
  }

  async function readBoth(): Promise<Record<Client, string>> {
    return {
      cursor: await fs.readFile(configOf('cursor'), 'utf-8'),
      windsurf: await fs.readFile(configOf('windsurf'), 'utf-8'),
    };
  }

  afterEach(() => {
    resetWizard(wizard);
    vi.restoreAllMocks();
  });

  // A prompt added without a row here would ship without a Ctrl-C check.
  it('should have a Ctrl-C row for every prompt in install-commands.ts', async () => {
    const source = await fs.readFile(new URL('./install-commands.ts', import.meta.url), 'utf-8');

    expect(CANCEL_ROWS.map(([prompt]) => prompt).sort()).toEqual(promptRoster(source).sort());
  });

  it.each(CANCEL_ROWS)(
    'should stop at "%s" on Ctrl-C, resolve quietly and leave both client configs byte-identical',
    async (prompt, subcommand, config) => {
      await writeBoth(config);
      wizard.cancelAt.add(prompt);
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const outcome = await runInstallCommand(subcommand).then(
        () => 'resolved',
        (err: unknown) => err,
      );

      expect({
        outcome,
        lastPrompt: wizard.asked.at(-1)?.message,
        errors: stderr.mock.calls,
        configs: await readBoth(),
      }).toEqual({
        outcome: 'resolved',
        lastPrompt: expect.stringMatching(promptPattern(prompt)),
        errors: [],
        configs: { cursor: config, windsurf: config },
      });
    },
  );

  it.each(PICKS)(
    'should register mailoo with $picked and leave $other byte-identical when only $picked is picked',
    async ({ picked, other }) => {
      await writeBoth(OTHER_ONLY);
      wizard.overrides.set('Which MCP clients should mailoo be registered with?', [picked]);

      await runInstallCommand();

      const configs = await readBoth();
      expect({
        picked: Object.keys(JSON.parse(configs[picked]).mcpServers),
        other: configs[other],
      }).toEqual({ picked: ['other', 'mailoo'], other: OTHER_ONLY });
    },
  );

  it.each(PICKS)(
    'should unregister mailoo from $picked and leave $other byte-identical when only $picked is picked',
    async ({ picked, other }) => {
      await writeBoth(REGISTERED);
      wizard.overrides.set('Unregister mailoo from which clients?', [picked]);

      await runInstallCommand('remove');

      const configs = await readBoth();
      expect({
        picked: Object.keys(JSON.parse(configs[picked]).mcpServers),
        other: configs[other],
      }).toEqual({ picked: ['other'], other: REGISTERED });
    },
  );
});
