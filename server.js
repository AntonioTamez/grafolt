import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './src/vault.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

export function createServer(vault) {
  const clients = new Set();
  const push = (event, data) => {
    for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  vault.metadata.on('resolved', () => push('graph', {}));
  vault.on('external', (file) => push('external', { file }));

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    return data;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/files') {
        const key = (p) => p.replace(/\.md$/i, '');
        const byName = (a, b) => key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: 'base' });
        return json(res, 200, [...vault.metadata.files].sort(byName));
      }
      if (url.pathname === '/api/graph') return json(res, 200, vault.metadata.graph());
      if (url.pathname === '/api/backlinks') {
        return json(res, 200, vault.metadata.getBacklinksForFile(url.searchParams.get('path')));
      }
      if (url.pathname === '/api/resolve') {
        const dest = vault.metadata.getFirstLinkpathDest(url.searchParams.get('link'), url.searchParams.get('from') || '');
        return json(res, 200, { path: dest });
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('retry: 1000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/api/create' && req.method === 'POST') {
        const { name, activePath } = JSON.parse((await readBody(req)) || '{}');
        return json(res, 200, { path: await vault.createNote({ name, activePath }) });
      }
      if (url.pathname === '/api/rename-impact') {
        return json(res, 200, vault.linksAffectedBy(url.searchParams.get('path')));
      }
      if (url.pathname === '/api/rename' && req.method === 'POST') {
        const { from, to, updateLinks } = JSON.parse((await readBody(req)) || '{}');
        return json(res, 200, await vault.renameNote(from, to, { updateLinks }));
      }
      if (url.pathname === '/api/file') {
        const rel = url.searchParams.get('path');
        if (req.method === 'GET') return json(res, 200, { path: rel, content: await vault.read(rel) });
        if (req.method === 'PUT') {
          await vault.write(rel, JSON.parse(await readBody(req)).content);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          await vault.remove(rel);
          return json(res, 200, { ok: true });
        }
      }
      if (url.pathname === '/markdown.js') {
        const body = await fs.readFile(path.join(here, 'src', 'markdown.js'));
        res.writeHead(200, { 'content-type': MIME['.js'] });
        return res.end(body);
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(here, 'public', name);
      if (!file.startsWith(path.join(here, 'public') + path.sep)) return json(res, 403, { error: 'forbidden' });
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      json(res, err.code === 'ENOENT' ? 404 : 400, { error: err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || path.join(here, 'vault');
  const port = Number(process.env.PORT) || 3000;
  const vault = await new Vault(root).index();
  vault.watch();
  // Bound to loopback only: the vault is private local data.
  createServer(vault).listen(port, '127.0.0.1', () => {
    console.log(`grafolt: vault ${vault.root} -> http://127.0.0.1:${port}`);
  });
}
