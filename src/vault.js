import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MetadataCache, parse } from './metadata.js';

const toPosix = (p) => p.split(path.sep).join('/');

/** A vault is just a folder: the markdown files on disk are the only source of truth. */
export class Vault extends EventEmitter {
  constructor(root) {
    super();
    this.root = path.resolve(root);
    this.metadata = new MetadataCache();
    this.timers = new Map();
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
