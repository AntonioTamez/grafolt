// Renders build/icon.svg into build/icon.png and a multi-size build/icon.ico.
// Run with Electron so no extra image dependency is needed: `npx electron scripts/build-icons.cjs`
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// One window is reused: creating a new window after destroying the previous one fails to load here.
let win = null;

async function capture(size, background) {
  if (!win) {
    win = new BrowserWindow({ width: 512, height: 512, show: false, useContentSize: true });
    await win.loadURL('about:blank');
  }
  win.setContentSize(size, size);
  const html = `<style>html,body{margin:0;overflow:hidden;background:${background}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
  await win.webContents.executeJavaScript(`document.documentElement.innerHTML = ${JSON.stringify(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.resize({ width: size, height: size }).toBitmap(); // BGRA
}

/**
 * Transparent windows are unreliable on some GPUs, so the alpha channel is recovered from two
 * opaque renders: over white and over black, alpha = 1 - (white - black) / 255.
 */
async function render(size) {
  const onWhite = await capture(size, '#fff');
  const onBlack = await capture(size, '#000');
  const out = Buffer.alloc(onWhite.length);
  for (let i = 0; i < out.length; i += 4) {
    const diff = ((onWhite[i] - onBlack[i]) + (onWhite[i + 1] - onBlack[i + 1]) + (onWhite[i + 2] - onBlack[i + 2])) / 3;
    const alpha = Math.min(1, Math.max(0, 1 - diff / 255));
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = alpha > 0 ? Math.min(255, Math.round(onBlack[i + c] / alpha)) : 0;
    }
    out[i + 3] = Math.round(alpha * 255);
  }
  return nativeImage.createFromBitmap(out, { width: size, height: size }).toPNG();
}

/** ICO container whose entries are PNG images (supported by Windows Vista and later). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = entries.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  const entries = [];
  for (const size of ICO_SIZES) entries.push({ size, png: await render(size) });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), await render(512));
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(entries));
  console.log(`icons: wrote build/icon.png and build/icon.ico (${ICO_SIZES.join(', ')})`);
  app.quit();
});
