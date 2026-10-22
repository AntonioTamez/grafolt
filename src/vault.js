import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MetadataCache, parse, findRefs } from './metadata.js';

const toPosix = (p) => p.split(path.sep).join('/');

const DEFAULT_NOTE_NAME = 'Untitled';
const DEFAULT_CONFIG = { newFileLocation: 'root', newFileFolderPath: '/' };
const FORBIDDEN_CHARS = /[*"\\<>:|?]/;
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Normalise a user-typed note name (collapse separators, trim slashes, NFC, drop a trailing .md)
 * and reject names that are unsafe or invisible to the vault.
 * Returns '' when nothing is left, which callers treat as "use the default name".
 */
export function sanitizeNoteName(name) {
  if (typeof name !== 'string') throw new Error('Note name must be a string');
  const clean = name.trim().replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '').normalize('NFC').replace(/\.md$/i, '');
  for (const segment of clean ? clean.split('/') : []) {
    if (FORBIDDEN_CHARS.test(segment)) throw new Error('Note names cannot contain any of: * " \\ / < > : | ?');
    if (segment.startsWith('.')) throw new Error('Note and folder names cannot start with a dot');
    if (/[. ]$/.test(segment)) throw new Error('Note and folder names cannot end with a dot or a space');
    if (RESERVED_NAMES.test(segment)) throw new Error(`"${segment}" is a reserved name`);
  }
  return clean;
}

/**
 * Rewrite each reference in place using its exact offsets. A path-style link keeps a path (and a
 * trailing .md); a bare-name link gets the shortest text that still identifies the note.
 * Alias, #subpath and the embed marker are preserved.
 */
function applyRefEdits(content, refs, target, shortest) {
  const bare = target.replace(/\.md$/i, '');
  let out = content;
  for (const ref of [...refs].sort((a, b) => b.start - a.start)) {
    const link = `${ref.link.includes('/') ? bare : shortest}${/\.md$/i.test(ref.link) ? '.md' : ''}`;
    const alias = ref.alias === undefined ? '' : `|${ref.alias}`;
    out = `${out.slice(0, ref.start)}${ref.embed ? '!' : ''}[[${link}${ref.sub}${alias}]]${out.slice(ref.end)}`;
  }
  return out;
}

/** A vault is just a folder: the markdown files on disk are the only source of truth. */
export class Vault extends EventEmitter {
  constructor(root) {
    super();
    this.root = path.resolve(root);
    this.metadata = new MetadataCache();
    this.timers = new Map();
    this.reserved = new Set(); // paths chosen by in-flight createNote calls
    this.queue = Promise.resolve(); // serialises operations that rewrite several files
  }

  serialize(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async exists(rel) {
    try {
      await fs.access(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  /** How many links (and in how many notes) would need rewriting if this note were renamed. */
  linksAffectedBy(rel) {
    const refs = this.metadata.referencesTo(rel);
    return { links: refs.reduce((sum, r) => sum + r.count, 0), files: refs.length };
  }

  /** Rename or move a note and, unless told otherwise, rewrite every link and embed that pointed to it. */
  renameNote(from, to, { updateLinks = true } = {}) {
    return this.serialize(() => this.doRename(from, to, updateLinks !== false));
  }

  async doRename(from, to, updateLinks) {
    if (!this.metadata.files.has(from)) throw new Error('Note not found');
    const clean = sanitizeNoteName(to);
    if (!clean) throw new Error('Note name cannot be empty');
    const target = `${clean}.md`;
    if (target === from) return { path: from, updated: 0, failed: [] };
    const sameFile = target.toLowerCase() === from.toLowerCase(); // case-only renames are legitimate
    const known = [...this.metadata.files].some((p) => p !== from && p.toLowerCase() === target.toLowerCase());
    if (known || (!sameFile && (await this.exists(target)))) throw new Error('A note with that name already exists');

    // Plan the edits against the pre-rename state, from fresh disk content (never stale offsets).
    const plan = new Map();
    if (updateLinks) {
      const sources = new Set([from, ...this.metadata.referencesTo(from).map((r) => r.source)]);
      for (const source of sources) {
        const content = await this.read(source);
        const refs = findRefs(content).filter((ref) => this.metadata.getFirstLinkpathDest(ref.link, source) === from);
        if (refs.length) plan.set(source, { content, refs });
      }
    }

    const full = this.abs(target);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.rename(this.abs(from), full);
    this.metadata.move(from, target);

    const failed = [];
    let updated = 0;
    const shortest = this.metadata.fileToLinktext(target);
    for (const [source, { content, refs }] of plan) {
      const where = source === from ? target : source;
      try {
        const next = applyRefEdits(content, refs, target, shortest);
        if (next === content) continue;
        // A note edited since it was planned would get corrupt offsets: skip it and report it.
        if ((await fs.readFile(this.abs(where), 'utf8')) !== content) throw new Error('changed on disk');
        await fs.writeFile(this.abs(where), next, 'utf8');
        this.metadata.cache.set(where, parse(next));
        updated += 1;
      } catch {
        failed.push(where);
      }
    }
    this.metadata.resolveAll();
    this.metadata.emit('changed', target);
    return { path: target, updated, failed };
  }

  /** Per-vault settings from .grafolt/app.json; anything missing or malformed falls back to defaults. */
  async config() {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.root, '.grafolt', 'app.json'), 'utf8'));
      const location = ['root', 'current', 'folder'].includes(raw.newFileLocation) ? raw.newFileLocation : 'root';
      const folder = typeof raw.newFileFolderPath === 'string' ? raw.newFileFolderPath : '/';
      return { newFileLocation: location, newFileFolderPath: folder };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  async isFolder(rel) {
    try {
      return (await fs.stat(this.abs(`${rel}/_.md`).replace(/_\.md$/, ''))).isDirectory();
    } catch {
      return false;
    }
  }

  /** Folder where a new note goes, per the newFileLocation setting ('' is the vault root). */
  async newFileParent(activePath) {
    const { newFileLocation, newFileFolderPath } = await this.config();
    if (newFileLocation === 'folder') {
      const folder = newFileFolderPath.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
      if (folder && !folder.split('/').some((s) => s.startsWith('.')) && (await this.isFolder(folder))) return folder;
    } else if (newFileLocation === 'current' && typeof activePath === 'string' && activePath.includes('/')) {
      const folder = activePath.slice(0, activePath.lastIndexOf('/'));
      try {
        this.abs(`${folder}/_.md`);
        if (await this.isFolder(folder)) return folder;
      } catch { /* an active path outside the vault falls back to the root */ }
    }
    return '';
  }

  /** First free path for `base`: "Untitled.md", then "Untitled 1.md", "Untitled 2.md"... (case-insensitive). */
  getAvailablePath(base) {
    const taken = new Set([...this.metadata.files, ...this.reserved].map((p) => p.toLowerCase()));
    let rel = `${base}.md`;
    for (let n = 1; taken.has(rel.toLowerCase()); n += 1) rel = `${base} ${n}.md`;
    return rel;
  }

  /** Create an empty note and return its vault-relative path. Never overwrites an existing note. */
  async createNote({ name, activePath } = {}) {
    const clean = name === undefined || name === null ? '' : sanitizeNoteName(name);
    const parent = await this.newFileParent(activePath);
    const base = `${parent ? `${parent}/` : ''}${clean || DEFAULT_NOTE_NAME}`;
    let rel;
    for (;;) {
      rel = this.getAvailablePath(base);
      this.reserved.add(rel); // no await between choosing and reserving, so concurrent calls diverge
      try {
        const full = this.abs(rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, '', { flag: 'wx' });
        break;
      } catch (err) {
        if (err.code === 'EEXIST') continue; // on disk but not indexed yet: keep it reserved, try the next name
        this.reserved.delete(rel);
        throw err;
      }
    }
    this.metadata.update(rel, '');
    this.reserved.delete(rel);
    return rel;
  }

  /** Resolve a vault-relative path, refusing anything outside the root or non-markdown. */
  abs(rel) {
    if (typeof rel !== 'string' || !/\.md$/i.test(rel)) throw new Error('Only .md paths are allowed');
    const full = path.resolve(this.root, rel);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Path escapes the vault');
    return full;
  }

  async list(dir = this.root) {
    const out = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // dot-folders hold config (.grafolt), not notes
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await this.list(full)));
      else if (/\.md$/i.test(entry.name)) out.push(toPosix(path.relative(this.root, full)));
    }
    return out.sort();
  }

  async index() {
    const files = await this.list();
    for (const rel of files) {
      this.metadata.files.add(rel);
      this.metadata.cache.set(rel, parse(await this.read(rel)));
    }
    this.metadata.resolveAll();
    return this;
  }

  read(rel) { return fs.readFile(this.abs(rel), 'utf8'); }

  async write(rel, content) {
    const full = this.abs(rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    this.metadata.update(rel, content);
  }

  async remove(rel) {
    await fs.unlink(this.abs(rel));
    this.metadata.delete(rel);
  }

  /** Pick up edits made outside the app (another editor, git pull, sync). */
  watch() {
    this.watcher = watch(this.root, { recursive: true, persistent: false }, (_evt, name) => {
      if (!name || !/\.md$/i.test(name) || name.split(/[\\/]/).some((s) => s.startsWith('.'))) return;
      const rel = toPosix(name);
      clearTimeout(this.timers.get(rel));
      this.timers.set(rel, setTimeout(async () => {
        try {
          this.metadata.update(rel, await this.read(rel));
        } catch {
          if (this.metadata.files.has(rel)) this.metadata.delete(rel);
        }
        this.emit('external', rel);
      }, 60));
    });
    return this;
  }

  close() { this.watcher?.close(); }
}
