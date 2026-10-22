import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Vault } from '../src/vault.js';
import { parse } from '../src/metadata.js';
import { render } from '../src/markdown.js';
import { createServer } from '../server.js';

async function makeVault() {
  const root = await mkdtemp(path.join(tmpdir(), 'grafolt-'));
  await mkdir(path.join(root, 'Guides'));
  await mkdir(path.join(root, '.grafolt'));
  await writeFile(path.join(root, 'A.md'), 'See [[B]] and [[Missing]] and [[Guides/C|alias]] #tag\n![[Embed]]');
  await writeFile(path.join(root, 'B.md'), 'Back to [[a]]');
  await writeFile(path.join(root, 'Guides', 'C.md'), '# Heading\n');
  await writeFile(path.join(root, '.grafolt', 'hidden.md'), 'ignored');
  return { root, vault: await new Vault(root).index() };
}

test('parse extracts links, tags and headings but not embeds', () => {
  const m = parse('---\nx: [[Frontmatter]]\n---\n# H\n[[One|alias]] ![[Embed]] #t');
  assert.deepEqual(m.links, [{ link: 'One', displayText: 'alias' }]);
  assert.deepEqual(m.tags, ['t']);
  assert.deepEqual(m.headings, [{ level: 1, heading: 'H' }]);
});

test('index resolves, leaves unresolved and ignores dot-folders', async () => {
  const { root, vault } = await makeVault();
  const mc = vault.metadata;
  assert.deepEqual([...mc.files].sort(), ['A.md', 'B.md', 'Guides/C.md']);
  assert.deepEqual(mc.resolvedLinks['A.md'], { 'B.md': 1, 'Guides/C.md': 1 });
  assert.deepEqual(mc.unresolvedLinks['A.md'], { Missing: 1 });
  assert.deepEqual(mc.getBacklinksForFile('A.md'), [{ source: 'B.md', count: 1 }]); // case-insensitive
  await rm(root, { recursive: true });
});

test('writing a note updates backlinks; deleting makes the link unresolved', async () => {
  const { root, vault } = await makeVault();
  await vault.write('D.md', 'to [[B]]');
  assert.equal(vault.metadata.getBacklinksForFile('B.md').length, 2);
  await vault.remove('B.md');
  assert.deepEqual(vault.metadata.unresolvedLinks['D.md'], { B: 1 });
  await rm(root, { recursive: true });
});

test('vault refuses paths outside the root and non-markdown files', async () => {
  const { root, vault } = await makeVault();
  assert.throws(() => vault.abs('../escape.md'), /escapes/);
  assert.throws(() => vault.abs('secret.txt'), /Only .md/);
  await rm(root, { recursive: true });
});

test('render marks unresolved links, callouts and tasks', () => {
  const html = render('> [!NOTE] Hi\n> body\n\n- [x] done\n\n[[Nope]] [[Yes|y]]', (n) => n === 'Yes');
  assert.match(html, /callout-note/);
  assert.match(html, /<input type="checkbox" disabled checked>/);
  assert.match(html, /class="wikilink unresolved" data-link="Nope"/);
  assert.match(html, /class="wikilink" data-link="Yes">y</);
});

test('external edits are picked up by the watcher', async () => {
  const { root, vault } = await makeVault();
  vault.watch();
  const seen = new Promise((resolve) => vault.once('external', resolve));
  await writeFile(path.join(root, 'New.md'), 'hello [[A]]');
  assert.equal(await seen, 'New.md');
  assert.ok(vault.metadata.files.has('New.md'));
  vault.close();
  await rm(root, { recursive: true });
});

test('HTTP API serves files, backlinks and graph, and rejects traversal', async () => {
  const { root, vault } = await makeVault();
  const server = createServer(vault).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();

  assert.deepEqual(await get('/api/files'), ['A.md', 'B.md', 'Guides/C.md']);
  assert.deepEqual(await get('/api/backlinks?path=B.md'), [{ source: 'A.md', count: 1 }]);
  const g = await get('/api/graph');
  assert.ok(g.nodes.some((n) => n.id === '?Missing' && !n.exists));
  const bad = await fetch(`${base}/api/file?path=${encodeURIComponent('../x.md')}`);
  assert.equal(bad.status, 400);
  const trav = await fetch(`${base}/..%2fserver.js`);
  assert.notEqual(trav.status, 200);

  server.close();
  await rm(root, { recursive: true });
});
