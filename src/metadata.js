import { EventEmitter } from 'node:events';
import { WIKILINK, stripFrontmatter } from './markdown.js';

/**
 * Blank out fenced code (and optionally inline code) with spaces of the same length, so offsets
 * survive: wikilinks, tags and headings inside code are literal text, not references.
 */
function maskCode(text, { inline = true } = {}) {
  let fence = null;
  return text.split('\n').map((line) => {
    const blank = ' '.repeat(line.length);
    if (fence) {
      const close = line.match(/^\s*(```+|~~~+)\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return blank;
    }
    const open = line.match(/^\s*(```+|~~~+)/);
    if (open) {
      fence = open[1];
      return blank;
    }
    return inline ? line.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length)) : line;
  }).join('\n');
}

/** Every wikilink and embed outside code, with exact offsets in the full content (frontmatter included). */
export function findRefs(content) {
  const body = stripFrontmatter(content);
  const offset = content.length - body.length;
  const refs = [];
  for (const m of maskCode(body).matchAll(WIKILINK)) {
    const link = m[2].trim();
    if (!link) continue;
    const start = offset + m.index;
    const end = start + m[0].length;
    refs.push({ embed: m[1] === '!', link, sub: m[3] || '', alias: m[4], raw: content.slice(start, end), start, end });
  }
  return refs;
}

export function parse(content) {
  const body = stripFrontmatter(content);
  const refs = findRefs(content);
  const links = refs.filter((r) => !r.embed).map((r) => ({ link: r.link, displayText: r.alias || r.link }));
  const embeds = refs.filter((r) => r.embed).map((r) => ({ link: r.link }));
  const tags = [...new Set([...maskCode(body).matchAll(/(?:^|\s)#([\p{L}\d_/-]+)/gu)].map((m) => m[1]))];
  const headings = [...maskCode(body, { inline: false }).matchAll(/^(#{1,6})\s+(.*)$/gm)]
    .map((m) => ({ level: m[1].length, heading: m[2].trim() }));
  return { links, embeds, tags, headings };
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

  /** Notes whose links or embeds currently resolve to `path`, with how many each has. */
  referencesTo(path) {
    const out = [];
    for (const [source, meta] of this.cache) {
      const count = [...meta.links, ...meta.embeds].filter((r) => this.getFirstLinkpathDest(r.link, source) === path).length;
      if (count) out.push({ source, count });
    }
    return out;
  }

  /** "Shortest" link text for a note: its basename if no other note shares it, else its full path. */
  fileToLinktext(path) {
    const bare = path.replace(/\.md$/i, '');
    const base = bare.split('/').pop();
    const sameName = [...this.files].filter((p) => basename(p).toLowerCase() === base.toLowerCase());
    return sameName.length === 1 ? base : bare;
  }

  /** Move a cache entry to a new path without resolving links; the caller resolves once when done. */
  move(from, to) {
    this.files.delete(from);
    this.files.add(to);
    this.cache.set(to, this.cache.get(from));
    this.cache.delete(from);
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
