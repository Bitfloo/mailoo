/**
 * The deprecated server.tool / server.resource / server.prompt overloads cannot
 * set a title. Clients only see a title when registration goes through
 * registerTool / registerResource / registerPrompt.
 */

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { TEMPLATES_DIR } from './config/xdg.js';
import buildCatalog from './test-support/mcp-catalog-harness.js';

const srcRoot = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(srcRoot, 'mcp-catalog.baseline.json');

type Kind = 'tool' | 'resource' | 'prompt';

interface DeclaredResource {
  name: string;
  uri: string;
  template: boolean;
}

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
}

interface ListedPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: unknown;
}

interface ListedResource {
  name: string;
  title?: string;
  description?: string;
  uri?: string;
  uriTemplate?: string;
}

interface LiveCatalog {
  tools: ListedTool[];
  prompts: ListedPrompt[];
  resources: ListedResource[];
}

function isHumanTitle(title: unknown): boolean {
  return (
    typeof title === 'string' && /^[A-Z]/.test(title) && /\s/.test(title) && !title.includes('_')
  );
}

function missingTitles(items: { name: string; title?: string }[]): string[] {
  return items.filter((item) => !isHumanTitle(item.title)).map((item) => item.name);
}

function callNeedles(kind: Kind): string[] {
  const register = `register${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`;
  return [`server.${register}(`, `server.${kind}(`];
}

async function walkTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walkTsFiles(full);
      if (entry.isFile() && entry.name.endsWith('.ts')) return [full];
      return [];
    }),
  );
  return nested.flat();
}

function skipWs(source: string, index: number): number {
  let cursor = index;
  while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  return cursor;
}

function readQuoted(source: string, index: number): { value: string; end: number } {
  const start = skipWs(source, index);
  const quote = source[start];
  if (quote !== "'" && quote !== '"') {
    throw new Error(`expected a quoted literal near ${source.slice(start, start + 40)}`);
  }
  let cursor = start + 1;
  let value = '';
  while (cursor < source.length && source[cursor] !== quote) {
    value += source[cursor];
    cursor += 1;
  }
  if (source[cursor] !== quote) throw new Error('unterminated string in a registration call');
  return { value, end: cursor + 1 };
}

async function sourceFiles(dirName: string): Promise<{ file: string; text: string }[]> {
  const files = await walkTsFiles(join(srcRoot, dirName));
  return Promise.all(
    files
      .filter((file) => !file.endsWith('.test.ts'))
      .map(async (file) => ({ file, text: await readFile(file, 'utf8') })),
  );
}

function scanCalls(texts: string[], kind: 'tool' | 'prompt'): { name: string }[];
function scanCalls(texts: string[], kind: 'resource'): DeclaredResource[];
function scanCalls(texts: string[], kind: Kind): ({ name: string } | DeclaredResource)[] {
  const found: ({ name: string } | DeclaredResource)[] = [];
  for (const text of texts) {
    for (const needle of callNeedles(kind)) {
      let from = 0;
      let at = text.indexOf(needle, from);
      while (at >= 0) {
        const name = readQuoted(text, at + needle.length);
        if (kind === 'resource') {
          let cursor = skipWs(text, name.end);
          if (text[cursor] !== ',') {
            throw new Error(`expected a comma after resource ${name.value}`);
          }
          cursor = skipWs(text, cursor + 1);
          const template = text.startsWith('new ResourceTemplate(', cursor);
          const uri = template
            ? readQuoted(text, cursor + 'new ResourceTemplate('.length).value
            : readQuoted(text, cursor).value;
          found.push({ name: name.value, uri, template });
        } else {
          found.push({ name: name.value });
        }
        from = at + needle.length;
        at = text.indexOf(needle, from);
      }
    }
  }
  return found;
}

async function deprecatedCallSites(): Promise<string[]> {
  const needles = (['tool', 'resource', 'prompt'] as const).map((kind) => `server.${kind}(`);
  const files = await walkTsFiles(srcRoot);
  const chunks = await Promise.all(
    files.map(async (file) => {
      const lines = (await readFile(file, 'utf8')).split('\n');
      const hits: string[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (needles.some((needle) => line.includes(needle))) {
          hits.push(`${file.slice(srcRoot.length + 1)}:${index + 1}`);
        }
      }
      return hits;
    }),
  );
  return chunks.flat();
}

// list_templates interpolates TEMPLATES_DIR, which is this machine's config
// directory. A committed catalog must not record that path.
function scrubMachinePaths(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.split(TEMPLATES_DIR).join('<templates-dir>').split(os.homedir()).join('<home>');
  }
  if (Array.isArray(value)) return value.map((item) => scrubMachinePaths(item));
  if (value !== null && typeof value === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      scrubbed[key] = scrubMachinePaths(child);
    }
    return scrubbed;
  }
  return value;
}

const require = createRequire(import.meta.url);

// File snapshots compare bytes. The formatter keeps short arrays on one line,
// so the string has to be formatted the same way or an update rewrites every
// array and the next format check writes it back.
async function formatCatalogJson(raw: string): Promise<string> {
  const biome = require.resolve('@biomejs/biome/bin/biome');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [biome, 'format', '--stdin-file-path=mcp-catalog.baseline.json'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8') || 'could not format the catalog baseline',
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.end(raw);
  });
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// List order (tools, prompts, resources) is not API. Concrete URIs and
// templates come from separate list calls, so each is sorted on its own key.
function toContract(live: LiveCatalog): unknown {
  const resources = live.resources.map((resource) => ({
    name: resource.name,
    description: resource.description ?? null,
    uri: resource.uri ?? null,
    uriTemplate: resource.uriTemplate ?? null,
  }));
  const concrete = resources
    .filter((resource) => resource.uriTemplate === null)
    .sort((left, right) => compareText(left.uri ?? '', right.uri ?? ''));
  const templates = resources
    .filter((resource) => resource.uriTemplate !== null)
    .sort((left, right) => compareText(left.uriTemplate ?? '', right.uriTemplate ?? ''));
  return scrubMachinePaths({
    tools: live.tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations ?? null,
      }))
      .sort((left, right) => compareText(left.name, right.name)),
    prompts: live.prompts
      .map((prompt) => ({
        name: prompt.name,
        description: prompt.description ?? null,
        arguments: prompt.arguments ?? null,
      }))
      .sort((left, right) => compareText(left.name, right.name)),
    resources: [...concrete, ...templates],
  });
}

const configurationDocPath = join(srcRoot, '..', 'docs', 'configuration.md');
const READ_ONLY_ROSTER_LEAD = 'The registered tools are exactly:';

// The configuration page copies the read_only roster. Nothing else binds that copy.
function documentedReadOnlyToolNames(markdown: string): string[] {
  const at = markdown.indexOf(READ_ONLY_ROSTER_LEAD);
  if (at < 0) {
    throw new Error(`docs/configuration.md is missing ${JSON.stringify(READ_ONLY_ROSTER_LEAD)}`);
  }
  const rest = markdown.slice(at + READ_ONLY_ROSTER_LEAD.length).replace(/^\s+/, '');
  const paragraphEnd = rest.search(/\n[ \t]*\n/);
  const heading = rest.search(/^#{1,6}\s/m);
  const ends = [paragraphEnd, heading].filter((index) => index >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return [...rest.slice(0, end).matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
}

function contractToolNames(live: LiveCatalog): string[] {
  const contract = toContract(live) as { tools: { name: string }[] };
  return contract.tools.map((tool) => tool.name);
}

async function listedReadOnlyToolNames(): Promise<string[]> {
  const server = buildCatalog({ readOnly: true, accounts: [] });
  const client = new Client({ name: 'mailoo-read-only-docs', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const listed = await client.listTools();
    if (listed.nextCursor) throw new Error('tools/list paginated; the test would drop a page');
    return contractToolNames({ tools: listed.tools, prompts: [], resources: [] });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function collectLive(): Promise<LiveCatalog> {
  const server = buildCatalog({ readOnly: false, accounts: ['work'] });
  const client = new Client({ name: 'mailoo-catalog', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const listedTools = await client.listTools();
    const listedPrompts = await client.listPrompts();
    const listedResources = await client.listResources();
    const listedTemplates = await client.listResourceTemplates();
    if (
      listedTools.nextCursor ||
      listedPrompts.nextCursor ||
      listedResources.nextCursor ||
      listedTemplates.nextCursor
    ) {
      throw new Error('catalog listing paginated; the test would drop a page');
    }
    const resourceTexts = (await sourceFiles('resources')).map((entry) => entry.text);
    const staticUris = new Set(
      scanCalls(resourceTexts, 'resource')
        .filter((resource) => !resource.template)
        .map((resource) => resource.uri),
    );
    const staticResources = listedResources.resources.filter((resource) =>
      staticUris.has(resource.uri),
    );
    return {
      tools: listedTools.tools,
      prompts: listedPrompts.prompts,
      resources: [
        ...staticResources,
        ...listedTemplates.resourceTemplates.map((resource) => ({
          name: resource.name,
          title: resource.title,
          description: resource.description,
          uriTemplate: resource.uriTemplate,
        })),
      ],
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe('deprecated MCP registration methods', () => {
  it('should not appear under src', async () => {
    expect(await deprecatedCallSites()).toEqual([]);
  });
});

describe('MCP registration catalog', () => {
  let live: LiveCatalog;
  let toolSources: string[];
  let resourceSources: string[];
  let promptSources: string[];

  beforeAll(async () => {
    [live, toolSources, resourceSources, promptSources] = await Promise.all([
      collectLive(),
      sourceFiles('tools').then((files) => files.map((file) => file.text)),
      sourceFiles('resources').then((files) => files.map((file) => file.text)),
      sourceFiles('prompts').then((files) => files.map((file) => file.text)),
    ]);
  });

  it('should expose a human-readable title for every tool declared in src/tools', () => {
    expect(live.tools.map((tool) => tool.name).sort()).toEqual(
      scanCalls(toolSources, 'tool')
        .map((call) => call.name)
        .sort(),
    );
    expect(missingTitles(live.tools)).toEqual([]);
  });

  it('should expose a human-readable title for every prompt declared in src/prompts', () => {
    expect(live.prompts.map((prompt) => prompt.name).sort()).toEqual(
      scanCalls(promptSources, 'prompt')
        .map((call) => call.name)
        .sort(),
    );
    expect(missingTitles(live.prompts)).toEqual([]);
  });

  it('should expose a human-readable title and the same URI for every resource declared in src/resources', () => {
    const declared = scanCalls(resourceSources, 'resource');
    const byName = new Map(live.resources.map((resource) => [resource.name, resource]));
    expect([...byName.keys()].sort()).toEqual(declared.map((resource) => resource.name).sort());
    expect(missingTitles(live.resources)).toEqual([]);
    for (const resource of declared) {
      const listed = byName.get(resource.name);
      const uri = resource.template ? listed?.uriTemplate : listed?.uri;
      expect(uri).toBe(resource.uri);
    }
  });

  it('should not record a home directory path in the catalog baseline', async () => {
    const text = await readFile(baselinePath, 'utf8');
    expect(text).not.toMatch(/\/Users\/|\/home\//);
  });

  it('should keep listed names, descriptions, input schemas, and URIs identical to the captured catalog', async () => {
    await expect(
      await formatCatalogJson(`${JSON.stringify(toContract(live), null, 2)}\n`),
    ).toMatchFileSnapshot('./mcp-catalog.baseline.json');
  });
});

describe('read_only roster in configuration.md', () => {
  it('should name the same tools the read_only catalog registers', async () => {
    const documented = documentedReadOnlyToolNames(
      await readFile(configurationDocPath, 'utf8'),
    ).sort(compareText);
    expect(documented).toEqual(await listedReadOnlyToolNames());
  });
});
