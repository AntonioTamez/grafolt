import { EventEmitter } from 'node:events';
import { WIKILINK, stripFrontmatter } from './markdown.js';

export function parse(content) {
  const body = stripFrontmatter(content);
  const links = [];
  for (const m of body.matchAll(WIKILINK)) {
    if (m[1] === '!') continue; // embeds are not links
    const target = m[2].trim();
    if (target) links.push({ link: target, displayText: m[4] || target });
  }
  const tags = [...new Set([...body.matchAll(/(?:^|\s)#([\p{L}\d_/-]+)/gu)].map((m) => m[1]))];
  const headings = [...body.matchAll(/^(#{1,6})\s+(.*)$/gm)].map((m) => ({ level: m[1].length, heading: m[2].trim() }));
  return { links, tags, headings };
}

const basename = (p) => p.split('/').pop().replace(/\.md$/i, '');

/** Per-file parse results plus resolvedLinks/unresolvedLinks maps; backlinks are derived from them. */
export class MetadataCache extends EventEmitter {
  constructor() {
    super();
    this.files = new Set();
    this.cache = new Map();
    this.resolvedLinks = {};
    this.unresolvedLinks = {};
  }

  /** Exact path match first, then basename match preferring the closest folder to the source. */
  getFirstLinkpathDest(link, sourcePath = '') {
    const wanted = link.replace(/\.md$/i, '').toLowerCase();
    const candidates = [...this.files].filter((p) => {
      const bare = p.replace(/\.md$/i, '').toLowerCase();
      return bare === wanted || (!wanted.includes('/') && basename(p).toLowerCase() === wanted);
    });
    if (!candidates.length) return null;
    const dir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
    const near = (p) => (p.startsWith(dir) ? 0 : 1);
    return candidates.sort((a, b) => near(a) - near(b) || a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  }

  update(path, content) {
    this.files.add(path);
    this.cache.set(path, parse(content));
    this.resolveAll();
    this.emit('changed', path);
  }

  delete(path) {
    this.files.delete(path);
    this.cache.delete(path);
    this.resolveAll();
    this.emit('deleted', path);
  }

  resolveAll() {
    this.resolvedLinks = {};
    this.unresolvedLinks = {};
    for (const [path, meta] of this.cache) {
      const resolved = {};
      const unresolved = {};
      for (const { link } of meta.links) {
        const dest = this.getFirstLinkpathDest(link, path);
        if (dest) resolved[dest] = (resolved[dest] || 0) + 1;
        else unresolved[link] = (unresolved[link] || 0) + 1;
      }
      this.resolvedLinks[path] = resolved;
      this.unresolvedLinks[path] = unresolved;
    }
    this.emit('resolved');
  }

  getBacklinksForFile(path) {
    return Object.entries(this.resolvedLinks)
      .filter(([, targets]) => targets[path])
      .map(([source, targets]) => ({ source, count: targets[path] }));
  }

  graph() {
    const nodes = new Map();
    const edges = [];
    for (const p of this.files) nodes.set(p, { id: p, label: basename(p), exists: true });
    for (const [src, targets] of Object.entries(this.resolvedLinks)) {
      for (const dst of Object.keys(targets)) edges.push({ source: src, target: dst });
    }
    for (const [src, targets] of Object.entries(this.unresolvedLinks)) {
      for (const name of Object.keys(targets)) {
        const id = `?${name}`;
        if (!nodes.has(id)) nodes.set(id, { id, label: name, exists: false });
        edges.push({ source: src, target: id });
      }
    }
    return { nodes: [...nodes.values()], edges };
  }
}
