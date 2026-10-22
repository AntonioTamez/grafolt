import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Vault } from '../src/vault.js';
import { createServer } from '../server.js';

const configFile = () => path.join(app.getPath('userData'), 'config.json');
let win = null;
let vault = null;
let server = null;

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await fs.mkdir(path.dirname(configFile()), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(config));
}

async function pickVault() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open a folder as vault',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
}

/** Start the vault server on a random loopback port and return its origin. */
async function startVault(root) {
  vault?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  vault = await new Vault(root).index();
  vault.watch();
  server = createServer(vault);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`grafolt: ${vault.root} -> ${origin}`);
  return origin;
}

async function openVault(root) {
  const origin = await startVault(root);
  await saveConfig({ vault: root });
  if (!win) return createWindow(origin, root);
  win.setTitle(`Grafolt - ${path.basename(root)}`);
  await win.loadURL(origin);
}

function createWindow(origin, root) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: `Grafolt - ${path.basename(root)}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // The UI only talks to its own loopback origin; anything else opens in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => { win = null; });
  if (process.env.GRAFOLT_SMOKE) {
    // `npm run smoke`: report what the renderer actually drew, then exit.
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const report = await win.webContents.executeJavaScript(`({
        files: document.querySelectorAll('#files li').length,
        title: document.getElementById('title').textContent,
        wikilinks: document.querySelectorAll('#preview a.wikilink').length,
        callouts: document.querySelectorAll('#preview .callout').length,
        backlinks: document.querySelectorAll('#backlinks li').length,
      })`);
      console.log(`grafolt-smoke: ${JSON.stringify(report)}`);
      app.quit();
    }, 1500));
  }
  return win.loadURL(origin);
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Vault',
      submenu: [
        {
          label: 'Open vault...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const root = await pickVault();
            if (root) await openVault(root);
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
  ]));
}

app.whenReady().then(async () => {
  buildMenu();
  const { vault: saved } = await loadConfig();
  let root = process.env.GRAFOLT_VAULT || saved;
  if (root) {
    try { await fs.access(root); } catch { root = null; }
  }
  root ||= await pickVault();
  if (!root) return app.quit();
  await openVault(root);
});

app.on('window-all-closed', () => {
  vault?.close();
  server?.close();
  app.quit();
});
