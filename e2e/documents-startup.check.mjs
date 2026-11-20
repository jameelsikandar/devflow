// Static regression check only: no Playwright, Next, Prisma or environment loading.
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const directory = dirname(fileURLToPath(import.meta.url));

const root = resolve(directory, '..');
assert.equal(process.cwd(), root, 'Run this check from the reviewed snapshot root.');
const filename = resolve(directory, 'documents.config.ts');
const source = ts.createSourceFile(
  filename,
  readFileSync(filename, 'utf8'),
  ts.ScriptTarget.Latest,
);
let server;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'webServer')
    server = node.initializer;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(server && ts.isObjectLiteralExpression(server), 'Expected explicit webServer options.');
const property = (name) =>
  server.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === name)
    ?.initializer;
assert.equal(
  property('cwd')?.getText(source),
  'process.cwd()',
  'Explicit snapshot cwd is required.',
);
assert.equal(property('reuseExistingServer')?.getText(source), 'false');
const command = property('command');
assert.ok(command && ts.isStringLiteral(command), 'Expected a literal startup command.');
assert.equal(
  command.text,
  'node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3101',
);
const executable = resolve(root, command.text.split(' ')[1]);
accessSync(executable, constants.R_OK);
assert.ok(statSync(executable).isFile(), 'Installed Next.js CLI must be a readable file.');
assert.notEqual(executable, resolve(directory, command.text.split(' ')[1]));
console.log('PASS: explicit snapshot cwd and readable installed Next.js CLI; no server launched.');
