/**
 * MCP client installation subcommands.
 *
 * Manages registering / unregistering the Mailoo server with MCP host
 * applications such as Claude Desktop, VS Code, Cursor, and Windsurf.
 *
 * - install          — interactive wizard to register with detected MCP clients
 * - install status   — show which clients are configured
 * - install remove   — interactively unregister from MCP clients
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
} from '@clack/prompts';

import {
  ClientConfigParseError,
  fileExists,
  getClients,
  isRegistered,
  MCP_SERVER_KEY,
  readJsonFile,
  writeJsonFile,
} from './client-config.js';
import ensureInteractive from './guard.js';

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

type Transport = 'npx' | 'pnpm' | 'global' | 'node';

interface ServerEntry {
  command: string;
  args: string[];
}

const esmRequire = createRequire(import.meta.url);
const pkg = esmRequire('../../package.json') as { name: string; bin?: Record<string, string> };
const PKG_NPM = pkg.name;
// npx checks a dist-tag against the registry on every start. A bare name runs any copy installed
// globally or in the client's working directory, however old.
const PKG_NPX_SPEC = `${PKG_NPM}@latest`;
const PKG_BIN = Object.keys(pkg.bin ?? { mailoo: true })[0] ?? 'mailoo';

function buildServerEntry(transport: Transport): ServerEntry {
  switch (transport) {
    case 'npx':
      return { command: 'npx', args: ['-y', PKG_NPX_SPEC, 'stdio'] };
    case 'pnpm':
      return { command: 'pnpm', args: ['dlx', PKG_NPM, 'stdio'] };
    case 'global':
      return { command: PKG_BIN, args: ['stdio'] };
    case 'node': {
      const mainJs = path.resolve(process.argv[1] ?? 'dist/main.js');
      return { command: process.execPath, args: [mainJs, 'stdio'] };
    }
    default:
      return { command: 'npx', args: ['-y', PKG_NPX_SPEC, 'stdio'] };
  }
}

export function manualClientConfig(): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: buildServerEntry('npx') } }, null, 2);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runInstall(): Promise<void> {
  ensureInteractive();
  intro('mailoo › Install MCP Server');

  const clients = getClients();

  // Detect which clients exist on the system (parallel checks)
  const detected = await Promise.all(
    clients.map(async (client) => {
      const exists = await fileExists(client.configPath);
      const dirExists = await fileExists(path.dirname(client.configPath));
      let registered = false;
      if (exists) {
        const cfg = await readJsonFile(client.configPath);
        registered = isRegistered(cfg, client.serversKey);
      }
      return { ...client, exists: exists || dirExists, registered };
    }),
  );

  const available = detected.filter((c) => c.exists);
  if (available.length === 0) {
    log.warn('No supported MCP clients detected on this system.');
    log.info('Supported clients: Claude Desktop, Cursor, Windsurf');
    note(manualClientConfig(), 'Manual configuration — add this to your MCP client config');
    outro('Done.');
    return;
  }

  // Show detected clients
  const alreadyDone = available.filter((c) => c.registered);
  if (alreadyDone.length > 0) {
    log.info(`Already configured: ${alreadyDone.map((c) => c.name).join(', ')}`);
  }

  // Let user pick which clients to install
  const choices = available.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.registered ? 'already configured — will update' : undefined,
  }));

  const selectedIds = await multiselect({
    message: 'Which MCP clients should mailoo be registered with?',
    options: choices,
    initialValues: available.filter((c) => !c.registered).map((c) => c.id),
    required: true,
  });
  if (isCancel(selectedIds)) {
    cancel('Cancelled.');
    return;
  }

  // Ask for transport preference
  const transport = await select<Transport>({
    message: 'How should the MCP client launch mailoo?',
    options: [
      {
        value: 'npx' as Transport,
        label: 'npx (auto-downloads, always latest)',
        hint: 'recommended for most users',
      },
      {
        value: 'pnpm' as Transport,
        label: 'pnpm dlx (auto-downloads via pnpm)',
      },
      {
        value: 'global' as Transport,
        label: 'Global install (mailoo on PATH)',
        hint: `requires: npm i -g ${PKG_NPM}`,
      },
      {
        value: 'node' as Transport,
        label: 'Direct node (current dist/main.js)',
        hint: 'dev / local clone',
      },
    ],
  });
  if (isCancel(transport)) {
    cancel('Cancelled.');
    return;
  }

  const serverEntry = buildServerEntry(transport);
  const selected = available.filter((c) => selectedIds.includes(c.id));

  // Write to each selected client (sequential — each read-modify-write must complete)
  await selected.reduce(async (prev, client) => {
    await prev;
    const existing = await readJsonFile(client.configPath);
    const servers = (existing[client.serversKey] as Record<string, unknown>) ?? {};
    servers[MCP_SERVER_KEY] = serverEntry;
    existing[client.serversKey] = servers;

    await writeJsonFile(client.configPath, existing);
    log.success(`${client.name} — registered (${client.configPath})`);
  }, Promise.resolve());

  // Show what was written
  note(
    JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: serverEntry } }, null, 2),
    'Server entry written to selected clients',
  );

  // Restart hint
  const clientNames = selected.map((c) => c.name).join(', ');
  log.info(`Restart ${clientNames} for the changes to take effect.`);
  outro('Installation complete!');
}

async function runRemove(): Promise<void> {
  ensureInteractive();
  intro('mailoo › Remove MCP Server');

  const clients = getClients();

  // Find clients that have mailoo registered (parallel checks)
  const withStatus = await Promise.all(
    clients.map(async (client) => {
      const exists = await fileExists(client.configPath);
      if (!exists) return { ...client, registered: false };
      const cfg = await readJsonFile(client.configPath);
      return { ...client, registered: isRegistered(cfg, client.serversKey) };
    }),
  );
  const registered = withStatus.filter((c) => c.registered);

  if (registered.length === 0) {
    log.info('mailoo is not registered with any detected MCP clients.');
    outro('Nothing to remove.');
    return;
  }

  const selectedIds = await multiselect({
    message: 'Unregister mailoo from which clients?',
    options: registered.map((c) => ({
      value: c.id,
      label: c.name,
      hint: c.configPath,
    })),
    initialValues: registered.map((c) => c.id),
    required: true,
  });
  if (isCancel(selectedIds)) {
    cancel('Cancelled.');
    return;
  }

  const shouldRemove = await confirm({
    message: `Remove mailoo from ${selectedIds.length} client(s)?`,
    initialValue: false,
  });
  if (isCancel(shouldRemove) || !shouldRemove) {
    cancel('Cancelled.');
    return;
  }

  const selected = registered.filter((c) => selectedIds.includes(c.id));

  // Sequential removal — each client's config must be read, modified, written
  await selected.reduce(async (prev, client) => {
    await prev;
    const cfg = await readJsonFile(client.configPath);
    const servers = cfg[client.serversKey] as Record<string, unknown> | undefined;
    if (servers && MCP_SERVER_KEY in servers) {
      delete servers[MCP_SERVER_KEY];
      if (Object.keys(servers).length === 0) {
        delete cfg[client.serversKey];
      }
    }
    await writeJsonFile(client.configPath, cfg);
    log.success(`${client.name} — unregistered`);
  }, Promise.resolve());

  const clientNames = selected.map((c) => c.name).join(', ');
  log.info(`Restart ${clientNames} for the changes to take effect.`);
  outro('Removal complete.');
}

async function runStatus(): Promise<void> {
  const clients = getClients();

  console.log('MCP Client Installation Status\n');

  const lines = await Promise.all(
    clients.map(async (client) => {
      const exists = await fileExists(client.configPath);
      if (!exists) {
        return `  ❌ ${client.name} — config not found`;
      }

      let cfg: Record<string, unknown>;
      try {
        cfg = await readJsonFile(client.configPath);
      } catch (error) {
        if (!(error instanceof ClientConfigParseError)) throw error;
        return `  ⚠️  ${client.name} — config is not valid JSON\n     ${client.configPath}`;
      }
      if (isRegistered(cfg, client.serversKey)) {
        const servers = cfg[client.serversKey] as Record<string, unknown>;
        const entry = servers[MCP_SERVER_KEY] as ServerEntry | undefined;
        const cmd = entry ? `${entry.command} ${entry.args.join(' ')}` : 'unknown';
        return `  ✅ ${client.name} — registered (${cmd})\n     ${client.configPath}`;
      }

      return `  ⚠️  ${client.name} — not registered\n     ${client.configPath}`;
    }),
  );

  const anyFound = lines.some((l) => !l.includes('config not found'));
  for (const line of lines) console.log(line); // eslint-disable-line no-restricted-syntax

  if (!anyFound) {
    console.log('\n  No supported MCP clients detected.');
    console.log('  Supported: Claude Desktop, Cursor, Windsurf');
  }
}

// ---------------------------------------------------------------------------
// Usage & router
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`Usage: mailoo install [subcommand]

Subcommands:
  (default)   Register mailoo with detected MCP clients
  status      Show registration status for all detected clients
  remove      Unregister mailoo from MCP clients
`);
}

export default async function runInstallCommand(subcommand?: string): Promise<void> {
  switch (subcommand) {
    case undefined:
    case 'add':
      await runInstall();
      break;
    case 'status':
      await runStatus();
      break;
    case 'remove':
    case 'uninstall':
      await runRemove();
      break;
    case 'help':
    case '--help':
      printUsage();
      break;
    default:
      console.error(`Unknown install command: ${subcommand}\n`);
      printUsage();
  }
}
