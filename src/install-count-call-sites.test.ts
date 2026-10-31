/**
 * Where the install count may run. The child-process tests drive the paths a
 * start can reach; these read the source, so a call placed on a path they do
 * not drive (a CLI verb, a branch, an early line) still fails, including one made
 * through an alias or through recordInstall.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const MAIN = path.join(SRC, 'main.ts');
const INSTALL_COUNT_MODULE = path.join(SRC, 'services', 'install-count.ts');

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (found: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

function isNoteInstallCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'noteInstall'
  );
}

async function mainSource(): Promise<ts.SourceFile> {
  return parse(MAIN, await readFile(MAIN, 'utf8'));
}

function functionNamed(source: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
}

interface ModuleLoad {
  node: ts.Node;
  specifier: string;
}

/** Modules a source file imports, re-exports or loads dynamically by a literal specifier. */
function moduleLoads(source: ts.SourceFile): ModuleLoad[] {
  const found: ModuleLoad[] = [];
  walk(source, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push({ node, specifier: node.moduleSpecifier.text });
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ node, specifier: node.arguments[0].text });
    }
  });
  return found;
}

function loadsInstallCount(file: string, specifier: string): boolean {
  return (
    specifier.startsWith('.') &&
    path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')) === INSTALL_COUNT_MODULE
  );
}

async function productionSources(): Promise<string[]> {
  const entries = await readdir(SRC, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(
      (file) =>
        !file.endsWith('.test.ts') &&
        !file.includes(`${path.sep}test-support${path.sep}`) &&
        !file.includes(`${path.sep}__integration__${path.sep}`),
    );
}

describe('install count call sites', () => {
  it('should call noteInstall exactly twice in the server entry', async () => {
    const calls: ts.Node[] = [];
    walk(await mainSource(), (node) => {
      if (isNoteInstallCall(node)) calls.push(node);
    });
    expect(calls).toHaveLength(2);
  });

  it.each(['runServer', 'runHttpServer'])(
    'should make the noteInstall call the last statement of %s',
    async (name) => {
      const body = functionNamed(await mainSource(), name)?.body;
      const last = body?.statements.at(-1);
      const call =
        last !== undefined &&
        ts.isExpressionStatement(last) &&
        ts.isAwaitExpression(last.expression)
          ? last.expression.expression
          : undefined;
      expect(call !== undefined && isNoteInstallCall(call)).toBe(true);
    },
  );

  it('should be imported only by the server entry', async () => {
    const importers: string[] = [];
    await Promise.all(
      (await productionSources()).map(async (file) => {
        const source = parse(file, await readFile(file, 'utf8'));
        const loadsIt = moduleLoads(source).some(({ specifier }) =>
          loadsInstallCount(file, specifier),
        );
        if (loadsIt) importers.push(path.relative(SRC, file));
      }),
    );
    expect(importers).toEqual(['main.ts']);
  });

  it('should bind only noteInstall, under its own name, from the install count module', async () => {
    const loads = moduleLoads(await mainSource())
      .filter(({ specifier }) => loadsInstallCount(MAIN, specifier))
      .map(({ node }) => {
        const shown = ts.isImportDeclaration(node) ? node.importClause : node;
        return shown?.getText().replace(/\s+/g, ' ');
      });
    expect(loads).toEqual(['{ noteInstall }']);
  });

  it('should use noteInstall in the server entry only as the function a call invokes', async () => {
    const source = await mainSource();
    const stray: number[] = [];
    walk(source, (node) => {
      if (!ts.isIdentifier(node) || node.text !== 'noteInstall') return;
      if (ts.isImportSpecifier(node.parent)) return;
      if (ts.isCallExpression(node.parent) && node.parent.expression === node) return;
      stray.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    });
    expect(stray).toEqual([]);
  });
});
