# Grafolt

A local-first markdown note app. Your notes are plain `.md` files in a folder you own, linked together with `[[wikilinks]]`, with automatic backlinks and an interactive graph view.

Grafolt runs as a desktop app (Electron) or as a local web server. It has no runtime dependencies beyond Node.js and Electron.

> Grafolt is an independent open source project. It is not affiliated with or endorsed by any other note-taking product.

## Features

- **Plain-folder vaults.** A vault is any folder of `.md` files. There is no database and no proprietary format; you can open, copy, sync, or version the folder with any tool.
- **Wikilinks.** `[[Note]]`, `[[Folder/Note]]`, and `[[Note|alias]]`. Links to notes that do not exist yet are shown muted, and clicking one creates the note.
- **Backlinks.** A panel lists every note that links to the open note, with link counts.
- **Graph view.** A force-directed graph of all notes and links, including notes that are referenced but do not exist yet. Click a node to open it.
- **Live updates.** Edits made outside the app (another editor, `git pull`, a sync client) are picked up automatically.
- **Markdown rendering.** Headings, emphasis, highlights, inline code, fenced code blocks, ordered and unordered lists, task lists, blockquotes, callouts (`> [!NOTE]`), tags (`#tag`), horizontal rules, and YAML frontmatter.
- **Private by design.** The server binds to `127.0.0.1` only, and the desktop window runs with `contextIsolation` and `sandbox` enabled and Node integration disabled.

## Getting started

### Requirements

- Node.js 24 or newer (developed and tested on Node 24)
- npm

### Install and run

```bash
git clone https://github.com/AntonioTamez/grafolt.git
cd grafolt
npm install
npm start
```

On first launch Grafolt asks you to choose a folder to use as a vault. Your choice is remembered; use **Vault > Open vault...** (`Ctrl+O`) to switch vaults.

A small sample vault is included under [`vault/`](vault/) if you want something to explore.

### Run as a web server instead

```bash
npm run serve                 # serves ./vault at http://127.0.0.1:3000
node server.js "D:\notes"     # serve any folder
PORT=4000 npm run serve       # custom port
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Launch the Electron desktop app |
| `npm run serve` | Run the web server without Electron |
| `npm test` | Run the test suite (Node's built-in test runner) |
| `npm run package` | Build a portable Windows x64 folder in `dist/` with `@electron/packager` |
| `npm run dist` | Build a Windows x64 NSIS installer in `release/` with `electron-builder` |

The installer is named `Grafolt-Setup-<version>.exe`. It is a per-user install (no administrator rights needed) and lets the user choose the install directory.

> **Unsigned builds.** Installers produced by `npm run dist` are not code-signed, so Windows SmartScreen will show an "Unknown publisher" warning. Signing requires your own code-signing certificate.

## How it works

```
 Markdown files on disk  (the only source of truth)
          |
          v
   Vault  ---- fs.watch ---->  re-reads changed files
          |
          v
   MetadataCache   parses each note: links, tags, headings
          |         resolvedLinks / unresolvedLinks maps
          |         backlinks = resolvedLinks inverted
          v
   HTTP API + SSE  ---->  UI (editor, preview, backlinks, graph)
```

- **`src/vault.js`** reads and writes notes, indexes the folder, and watches for external changes. Paths are validated: only `.md` files are accepted and anything that resolves outside the vault root is rejected. Dot-folders are ignored.
- **`src/metadata.js`** holds the `MetadataCache`. Link resolution tries an exact path match first, then a case-insensitive basename match, preferring the candidate closest to the linking note.
- **`src/markdown.js`** is a small renderer shared by the server tests and the browser.
- **`server.js`** exposes the API and pushes change events to the UI over Server-Sent Events.
- **`electron/main.js`** starts the server on a random loopback port, remembers the selected vault, and opens the window.
- **`public/`** is the UI: plain HTML, CSS, and ES modules, with the graph drawn on a canvas.

### HTTP API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/files` | List all note paths |
| `GET` | `/api/file?path=` | Read a note |
| `PUT` | `/api/file?path=` | Create or overwrite a note (`{"content": "..."}`) |
| `DELETE` | `/api/file?path=` | Delete a note |
| `GET` | `/api/backlinks?path=` | Notes that link to the given note |
| `GET` | `/api/resolve?link=&from=` | Resolve a link text to a note path |
| `GET` | `/api/graph` | Nodes and edges for the graph view |
| `GET` | `/api/events` | Server-Sent Events stream (`graph`, `external`) |

The API has no authentication because it is only reachable from the local machine. Do not expose it on a network interface.

## Project structure

```
electron/main.js     Desktop shell: window, vault picker, config
server.js            HTTP API and static file server
src/vault.js         Filesystem access, indexing, watching
src/metadata.js      Link parsing and resolution, backlinks, graph data
src/markdown.js      Markdown renderer
public/              Browser UI
test/                Automated tests
vault/               Sample vault
```

## Testing

```bash
npm test
```

The suite covers link parsing, link resolution (resolved, unresolved, case-insensitive), backlink updates on write and delete, path-traversal rejection, the filesystem watcher, markdown rendering, and the HTTP API.

The Electron app also has a smoke mode that reports what the renderer drew, then exits:

```bash
# bash
GRAFOLT_SMOKE=1 GRAFOLT_VAULT="/path/to/vault" npx electron .
# PowerShell
$env:GRAFOLT_SMOKE=1; $env:GRAFOLT_VAULT="C:\path\to\vault"; npx electron .
```

`GRAFOLT_VAULT` also overrides the saved vault for a normal launch.

## Current limitations

- No plugins, themes, or custom hotkeys.
- Embeds (`![[Note]]`) are not rendered, and they are not counted as links.
- Rename and move are not exposed in the UI, and links are not rewritten on rename.
- The markdown renderer covers the common subset listed above; it is not a full CommonMark implementation (no tables, footnotes, or math).
- Installers are built for Windows x64 only, and the UI has not been tested on macOS or Linux.
- The graph is laid out on the main thread, so very large vaults will be slow.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before submitting a change, and use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

## License

Released under the [MIT License](LICENSE).
