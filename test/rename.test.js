import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Vault } from '../src/vault.js';
import { parse, findRefs } from '../src/metadata.js';
import { render } from '../src/markdown.js';
import { createServer } from '../server.js';

async function makeVault(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'grafolt-ren-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return { root, vault: await new Vault(root).index() };
}
const read = (root, rel) => readFile(path.join(root, rel), 'utf8');
const exists = (root, rel) => access(path.join(root, rel)).then(() => true, () => false);

test('findRefs reports exact offsets for links and embeds, and ignores code', () => {
  const src = '---\nk: v\n---\nA [[One#H|alias]] ![[Two]] `[[Inline]]`\n```\n[[Fenced]]\n```\n[[Three]]';
  const refs = findRefs(src);
  assert.deepEqual(refs.map((r) => [r.embed, r.link, r.sub, r.alias]), [
    [false, 'One', '#H', 'alias'],
    [true, 'Two', '', undefined],
    [false, 'Three', '', undefined],
  ]);
  for (const r of refs) assert.equal(src.slice(r.start, r.end), r.raw);
});

test('parse keeps embeds apart from links and ignores tags and headings inside code', () => {
  const m = parse('# Real\n[[L]] ![[E]]\n```sh\n# not a heading #nottag\n```\nuse `#alsonot` and #yes');
  assert.deepEqual(m.links, [{ link: 'L', displayText: 'L' }]);
  assert.deepEqual(m.embeds, [{ link: 'E' }]);
  assert.deepEqual(m.headings, [{ level: 1, heading: 'Real' }]);
  assert.deepEqual(m.tags, ['yes']);
});

test('render does not turn wikilinks inside inline code into links', () => {
  const html = render('see `[[Not a link]]` and [[Real]]');
  assert.match(html, /<code>\[\[Not a link\]\]<\/code>/);
  assert.match(html, /data-link="Real"/);
  assert.equal((html.match(/class="wikilink/g) || []).length, 1);
});

test('renaming moves the file and rewrites links, aliases, subpaths and embeds', async () => {
  const { root, vault } = await makeVault({
    'Old.md': 'body',
    'Other.md': 'a [[Old]] b [[Old|shown]] c [[Old#Heading]] d ![[Old]] e [[Keep]]',
    'Keep.md': '',
  });
  const result = await vault.renameNote('Old.md', 'New');
  assert.deepEqual(result, { path: 'New.md', updated: 1, failed: [] });
  assert.equal(await exists(root, 'Old.md'), false);
  assert.equal(await read(root, 'New.md'), 'body');
  assert.equal(await read(root, 'Other.md'), 'a [[New]] b [[New|shown]] c [[New#Heading]] d ![[New]] e [[Keep]]');
  assert.deepEqual([...vault.metadata.files].sort(), ['Keep.md', 'New.md', 'Other.md']);
  assert.deepEqual(vault.metadata.getBacklinksForFile('New.md'), [{ source: 'Other.md', count: 3 }]);
  assert.deepEqual(vault.metadata.unresolvedLinks['Other.md'], {});
  await rm(root, { recursive: true });
});

test('links inside code are left untouched', async () => {
  const { root, vault } = await makeVault({ 'Old.md': '', 'N.md': '[[Old]] `[[Old]]`\n```\n[[Old]]\n```' });
  await vault.renameNote('Old.md', 'New');
  assert.equal(await read(root, 'N.md'), '[[New]] `[[Old]]`\n```\n[[Old]]\n```');
  await rm(root, { recursive: true });
});

test('path-style links keep their style; basename links go back to a path when the name turns ambiguous', async () => {
  const { root, vault } = await makeVault({
    'Guides/Old.md': '',
    'Other/Taken.md': '',
    'N.md': '[[Guides/Old]] [[Old]] [[Guides/Old.md]]',
  });
  await vault.renameNote('Guides/Old.md', 'Guides/Taken');
  assert.equal(await read(root, 'N.md'), '[[Guides/Taken]] [[Guides/Taken]] [[Guides/Taken.md]]');
  await rm(root, { recursive: true });
});

test('moving into a folder creates it and keeps unique basename links short', async () => {
  const { root, vault } = await makeVault({ 'Old.md': 'x', 'N.md': '[[Old]]' });
  assert.equal((await vault.renameNote('Old.md', 'Archive/2026/Old')).path, 'Archive/2026/Old.md');
  assert.equal(await read(root, 'N.md'), '[[Old]]');
  assert.deepEqual(vault.metadata.getBacklinksForFile('Archive/2026/Old.md'), [{ source: 'N.md', count: 1 }]);
  await rm(root, { recursive: true });
});

test('links inside the renamed note that point to itself are updated', async () => {
  const { root, vault } = await makeVault({ 'Old.md': 'I am [[Old]]', 'Z.md': '[[Old]]' });
  await vault.renameNote('Old.md', 'New');
  assert.equal(await read(root, 'New.md'), 'I am [[New]]');
  await rm(root, { recursive: true });
});

test('only links that resolve to the renamed note are rewritten', async () => {
  const { root, vault } = await makeVault({
    'A/Old.md': '',
    'B/Old.md': '',
    'B/Linker.md': '[[Old]]',
    'A/Linker.md': '[[Old]]',
  });
  await vault.renameNote('A/Old.md', 'A/New');
  assert.equal(await read(root, 'A/Linker.md'), '[[New]]');
  assert.equal(await read(root, 'B/Linker.md'), '[[Old]]');
  await rm(root, { recursive: true });
});

test('updateLinks: false renames the file only and the old links become unresolved', async () => {
  const { root, vault } = await makeVault({ 'Old.md': '', 'N.md': '[[Old]]' });
  const result = await vault.renameNote('Old.md', 'New', { updateLinks: false });
  assert.equal(result.updated, 0);
  assert.equal(await read(root, 'N.md'), '[[Old]]');
  assert.deepEqual(vault.metadata.unresolvedLinks['N.md'], { Old: 1 });
  await rm(root, { recursive: true });
});

test('linksAffectedBy counts links and embeds per note', async () => {
  const { root, vault } = await makeVault({ 'Old.md': '', 'N.md': '[[Old]] ![[Old]]', 'M.md': '[[Old|x]]', 'Q.md': '[[Nope]]' });
  assert.deepEqual(vault.linksAffectedBy('Old.md'), { links: 3, files: 2 });
  await rm(root, { recursive: true });
});

test('rename refuses unknown notes, existing targets and invalid names, and changes nothing', async () => {
  const { root, vault } = await makeVault({ 'Old.md': 'keep', 'Taken.md': 'mine' });
  await assert.rejects(() => vault.renameNote('Nope.md', 'X'), /not found/i);
  await assert.rejects(() => vault.renameNote('Old.md', 'taken'), /already exists/i);
  await assert.rejects(() => vault.renameNote('Old.md', 'bad:name'), /cannot contain/);
  await assert.rejects(() => vault.renameNote('Old.md', '../out'), /dot/);
  await assert.rejects(() => vault.renameNote('Old.md', '  '), /empty/i);
  assert.equal(await read(root, 'Old.md'), 'keep');
  assert.equal(await read(root, 'Taken.md'), 'mine');
  assert.deepEqual((await vault.renameNote('Old.md', 'Old')), { path: 'Old.md', updated: 0, failed: [] });
  await rm(root, { recursive: true });
});

test('a case-only rename is allowed and rewrites links', async () => {
  const { root, vault } = await makeVault({ 'old.md': '', 'N.md': '[[old]]' });
  assert.equal((await vault.renameNote('old.md', 'Old')).path, 'Old.md');
  assert.equal(await read(root, 'N.md'), '[[Old]]');
  assert.deepEqual([...vault.metadata.files].sort(), ['N.md', 'Old.md']);
  await rm(root, { recursive: true });
});

test('concurrent renames are serialised and keep links consistent', async () => {
  const { root, vault } = await makeVault({ 'A.md': '', 'N.md': '[[A]]' });
  const [first, second] = await Promise.allSettled([vault.renameNote('A.md', 'B'), vault.renameNote('B.md', 'C')]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'fulfilled');
  assert.equal(await read(root, 'N.md'), '[[C]]');
  assert.deepEqual([...vault.metadata.files].sort(), ['C.md', 'N.md']);
  await rm(root, { recursive: true });
});

test('HTTP: rename-impact and rename endpoints', async () => {
  const { root, vault } = await makeVault({ 'Old.md': '', 'N.md': '[[Old]]' });
  const server = createServer(vault).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/rename`, { method: 'POST', body: JSON.stringify(body) });

  assert.deepEqual(await (await fetch(`${base}/api/rename-impact?path=Old.md`)).json(), { links: 1, files: 1 });
  const ok = await post({ from: 'Old.md', to: 'New' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { path: 'New.md', updated: 1, failed: [] });
  assert.equal(await read(root, 'N.md'), '[[New]]');
  assert.equal((await post({ from: 'New.md', to: 'bad:name' })).status, 400);
  assert.equal((await post({ from: 'Missing.md', to: 'X' })).status, 400);

  server.close();
  await rm(root, { recursive: true });
});
