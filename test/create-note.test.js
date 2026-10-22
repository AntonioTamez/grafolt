import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Vault } from '../src/vault.js';
import { createServer } from '../server.js';

async function makeVault(files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'grafolt-new-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return { root, vault: await new Vault(root).index() };
}

test('a new note without a name is Untitled, then Untitled 1, Untitled 2', async () => {
  const { root, vault } = await makeVault();
  assert.equal(await vault.createNote(), 'Untitled.md');
  assert.equal(await vault.createNote(), 'Untitled 1.md');
  assert.equal(await vault.createNote(), 'Untitled 2.md');
  assert.equal(await readFile(path.join(root, 'Untitled.md'), 'utf8'), '');
  await rm(root, { recursive: true });
});

test('name collisions are case-insensitive and never overwrite an existing note', async () => {
  const { root, vault } = await makeVault({ 'untitled.md': 'keep me', 'A.md': 'original' });
  assert.equal(await vault.createNote({ name: 'UNTITLED' }), 'UNTITLED 1.md');
  assert.equal(await vault.createNote({ name: 'a' }), 'a 1.md');
  assert.equal(await readFile(path.join(root, 'A.md'), 'utf8'), 'original');
  await rm(root, { recursive: true });
});

test('a name with folders creates the missing folders and does not double the extension', async () => {
  const { root, vault } = await makeVault();
  assert.equal(await vault.createNote({ name: 'Projects/Ideas.md' }), 'Projects/Ideas.md');
  assert.equal(await vault.createNote({ name: '  /Projects//Ideas/ ' }), 'Projects/Ideas 1.md');
  assert.ok((await stat(path.join(root, 'Projects'))).isDirectory());
  await rm(root, { recursive: true });
});

test('creating a note for an unresolved link resolves that link', async () => {
  const { root, vault } = await makeVault({ 'A.md': 'see [[Missing]]' });
  assert.deepEqual(vault.metadata.unresolvedLinks['A.md'], { Missing: 1 });
  await vault.createNote({ name: 'Missing' });
  assert.deepEqual(vault.metadata.unresolvedLinks['A.md'], {});
  assert.deepEqual(vault.metadata.getBacklinksForFile('Missing.md'), [{ source: 'A.md', count: 1 }]);
  await rm(root, { recursive: true });
});

test('invalid names are rejected and nothing is written', async () => {
  const { root, vault } = await makeVault();
  for (const name of ['a:b', 'what?', 'x.', '../escape', 'a/../b', 'q"uote', '.hidden/note', 'CON']) {
    await assert.rejects(() => vault.createNote({ name }), /./, name);
  }
  assert.deepEqual([...vault.metadata.files], []);
  await rm(root, { recursive: true });
});

test('newFileLocation "current" puts the note next to the active note', async () => {
  const { root, vault } = await makeVault({
    '.grafolt/app.json': JSON.stringify({ newFileLocation: 'current' }),
    'Guides/Intro.md': '',
  });
  assert.equal(await vault.createNote({ activePath: 'Guides/Intro.md' }), 'Guides/Untitled.md');
  assert.equal(await vault.createNote({ activePath: 'Guides/Intro.md', name: 'Deep/Note' }), 'Guides/Deep/Note.md');
  assert.equal(await vault.createNote(), 'Untitled.md');
  await rm(root, { recursive: true });
});

test('newFileLocation "folder" uses the configured folder, falling back to the root if it is missing', async () => {
  const { root, vault } = await makeVault({
    '.grafolt/app.json': JSON.stringify({ newFileLocation: 'folder', newFileFolderPath: '/Inbox/' }),
    'Inbox/old.md': '',
  });
  assert.equal(await vault.createNote(), 'Inbox/Untitled.md');
  await rm(path.join(root, 'Inbox'), { recursive: true });
  assert.equal(await vault.createNote(), 'Untitled.md');
  await rm(root, { recursive: true });
});

test('a malformed config falls back to the vault root', async () => {
  const { root, vault } = await makeVault({ '.grafolt/app.json': '{ not json', 'Sub/x.md': '' });
  assert.equal(await vault.createNote({ activePath: 'Sub/x.md' }), 'Untitled.md');
  await rm(root, { recursive: true });
});

test('concurrent creations get distinct paths', async () => {
  const { root, vault } = await makeVault();
  const paths = await Promise.all(Array.from({ length: 6 }, () => vault.createNote()));
  assert.equal(new Set(paths).size, 6);
  assert.deepEqual([...vault.metadata.files].sort(), [...paths].sort());
  await rm(root, { recursive: true });
});

test('POST /api/create returns the new path and rejects invalid names', async () => {
  const { root, vault } = await makeVault({ 'Untitled.md': 'x' });
  const server = createServer(vault).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/create`, { method: 'POST', body: JSON.stringify(body) });

  const ok = await post({});
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { path: 'Untitled 1.md' });
  assert.equal((await post({ name: 'bad:name' })).status, 400);
  assert.equal((await fetch(`${base}/api/create`)).status, 404);
  assert.equal(await readFile(path.join(root, 'Untitled.md'), 'utf8'), 'x');

  server.close();
  await rm(root, { recursive: true });
});
