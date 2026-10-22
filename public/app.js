import { render } from '/markdown.js';

const $ = (id) => document.getElementById(id);
const state = { files: [], current: null, editing: false, saveTimer: null, pendingSave: null, sim: null };

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
};
const bare = (p) => p.replace(/\.md$/i, '').toLowerCase();
const resolveLocal = (link) => {
  const want = bare(link);
  return state.files.some((f) => bare(f) === want || (!want.includes('/') && bare(f).split('/').pop() === want));
};
const findFile = (link) => {
  const want = bare(link);
  return state.files.find((f) => bare(f) === want || (!want.includes('/') && bare(f).split('/').pop() === want));
};

async function refreshFiles() {
  state.files = await api('/api/files');
  $('files').innerHTML = '';
  for (const f of state.files) {
    const li = document.createElement('li');
    li.textContent = f.replace(/\.md$/i, '');
    li.className = f === state.current ? 'active' : '';
    li.onclick = () => open(f);
    $('files').append(li);
  }
}

async function refreshSide() {
  if (!state.current) return;
  const backs = await api(`/api/backlinks?path=${encodeURIComponent(state.current)}`);
  $('backlinks').innerHTML = backs.length ? '' : '<li>No backlinks</li>';
  for (const b of backs) {
    const li = document.createElement('li');
    li.textContent = `${b.source.replace(/\.md$/i, '')} (${b.count})`;
    li.onclick = () => open(b.source);
    $('backlinks').append(li);
  }
  const graph = await api('/api/graph');
  const missing = graph.edges.filter((e) => e.source === state.current && e.target.startsWith('?'));
  $('outgoing').innerHTML = missing.length ? '' : '<li>None</li>';
  for (const e of missing) {
    const li = document.createElement('li');
    li.textContent = e.target.slice(1);
    li.onclick = () => createNote(e.target.slice(1));
    $('outgoing').append(li);
  }
}

function showPreview(content) {
  $('preview').innerHTML = render(content, resolveLocal);
  for (const a of $('preview').querySelectorAll('a.wikilink')) {
    a.onclick = () => {
      const dest = findFile(a.dataset.link);
      dest ? open(dest) : createNote(a.dataset.link);
    };
  }
}

// A save always targets the path its text was typed into, and runs before any navigation or rename.
async function flushSave() {
  clearTimeout(state.saveTimer);
  const pending = state.pendingSave;
  if (!pending) return;
  state.pendingSave = null;
  await api(`/api/file?path=${encodeURIComponent(pending.path)}`, {
    method: 'PUT',
    body: JSON.stringify({ content: pending.content }),
  });
}

async function open(path, { edit = false } = {}) {
  await flushSave();
  if (edit) {
    state.editing = true;
    $('toggle').textContent = 'Preview';
  }
  setView('note');
  state.current = path;
  const { content } = await api(`/api/file?path=${encodeURIComponent(path)}`);
  $('title').textContent = path.replace(/\.md$/i, '');
  $('editor').value = content;
  showPreview(content);
  await refreshFiles();
  await refreshSide();
  if (edit) $('editor').focus();
}

// The server picks a free name ("Untitled", "Untitled 1", ...) and the folder per the vault settings.
async function createNote(name) {
  try {
    const { path } = await api('/api/create', {
      method: 'POST',
      body: JSON.stringify({ name, activePath: state.current }),
    });
    await open(path, { edit: true });
  } catch (err) {
    alert(err.message);
  }
}

function setView(view) {
  const isGraph = view === 'graph';
  $('graph').hidden = !isGraph;
  $('preview').hidden = isGraph || state.editing;
  $('editor').hidden = isGraph || !state.editing;
  if (!isGraph) state.sim?.stop();
}

$('toggle').onclick = () => {
  state.editing = !state.editing;
  $('toggle').textContent = state.editing ? 'Preview' : 'Edit';
  if (!state.editing) showPreview($('editor').value);
  setView('note');
};
$('editor').oninput = () => {
  state.pendingSave = { path: state.current, content: $('editor').value };
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    flushSave().then(refreshFiles).then(refreshSide).catch((err) => alert(err.message));
  }, 400);
};
$('new').onclick = () => createNote();

// Rename (and move, when the name has folders). Links are only rewritten after the user agrees.
function startRename() {
  if (!state.current) return;
  const input = $('title-input');
  input.value = state.current.replace(/\.md$/i, '');
  $('title').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

function endRename() {
  $('title-input').hidden = true;
  $('title').hidden = false;
}

function askUpdateLinks({ links, files }) {
  const dialog = $('confirm');
  $('confirm-text').textContent = `${links} link${links === 1 ? '' : 's'} in ${files} note${files === 1 ? '' : 's'} point to this note. Update them?`;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
    dialog.showModal();
  });
}

async function commitRename() {
  const to = $('title-input').value.trim();
  endRename();
  const from = state.current;
  if (!from || !to || to === from.replace(/\.md$/i, '')) return;
  try {
    await flushSave();
    const impact = await api(`/api/rename-impact?path=${encodeURIComponent(from)}`);
    let updateLinks = true;
    if (impact.links > 0) {
      const choice = await askUpdateLinks(impact);
      if (choice === 'cancel') return;
      updateLinks = choice === 'update';
    }
    const result = await api('/api/rename', { method: 'POST', body: JSON.stringify({ from, to, updateLinks }) });
    await open(result.path);
    if (result.failed.length) alert(`These notes changed while renaming and were not updated:\n${result.failed.join('\n')}`);
  } catch (err) {
    alert(err.message);
  }
}

$('rename').onclick = startRename;
$('title').ondblclick = startRename;
$('title-input').onblur = endRename;
$('title-input').onkeydown = (ev) => {
  if (ev.key === 'Enter') commitRename();
  if (ev.key === 'Escape') endRename();
};
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'n') {
    ev.preventDefault();
    createNote();
  }
  if (ev.key === 'F2') {
    ev.preventDefault();
    startRename();
  }
});
$('graph-btn').onclick = async () => {
  setView('graph');
  startGraph(await api('/api/graph'));
};

// Force-directed layout with tunable forces
// (center, repel, link strength and distance), drawn on a plain canvas.
function startGraph({ nodes, edges }) {
  const canvas = $('graph');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const cfg = { centerStrength: 0.01, repelStrength: 900, linkStrength: 0.04, linkDistance: 90, decay: 0.85 };
  const byId = new Map(nodes.map((n, i) => [n.id, Object.assign(n, {
    x: canvas.width / 2 + Math.cos(i) * 120, y: canvas.height / 2 + Math.sin(i) * 120, vx: 0, vy: 0,
  })]));
  const links = edges.map((e) => [byId.get(e.source), byId.get(e.target)]).filter(([a, b]) => a && b);
  let alpha = 1;
  let running = true;
  state.sim = { stop: () => { running = false; } };

  const tick = () => {
    if (!running) return;
    for (const a of nodes) {
      a.vx += (canvas.width / 2 - a.x) * cfg.centerStrength;
      a.vy += (canvas.height / 2 - a.y) * cfg.centerStrength;
      for (const b of nodes) {
        if (a === b) continue;
        const dx = a.x - b.x; const dy = a.y - b.y;
        const d2 = Math.max(dx * dx + dy * dy, 25);
        a.vx += (dx / d2) * cfg.repelStrength * alpha;
        a.vy += (dy / d2) * cfg.repelStrength * alpha;
      }
    }
    for (const [a, b] of links) {
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - cfg.linkDistance) * cfg.linkStrength * alpha;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of nodes) { n.x += n.vx; n.y += n.vy; n.vx *= cfg.decay; n.vy *= cfg.decay; }
    alpha = Math.max(alpha * 0.99, 0.05);

    const css = getComputedStyle(document.body);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = css.getPropertyValue('--border');
    for (const [a, b] of links) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    for (const n of nodes) {
      ctx.fillStyle = n.exists ? css.getPropertyValue('--accent') : css.getPropertyValue('--muted');
      ctx.beginPath(); ctx.arc(n.x, n.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css.getPropertyValue('--text');
      ctx.fillText(n.label, n.x + 8, n.y + 4);
    }
    requestAnimationFrame(tick);
  };
  canvas.onclick = (ev) => {
    const r = canvas.getBoundingClientRect();
    const hit = nodes.find((n) => n.exists && Math.hypot(n.x - (ev.clientX - r.left), n.y - (ev.clientY - r.top)) < 10);
    if (hit) open(hit.id);
  };
  tick();
}

// Live updates: edits made outside the app (another editor, git pull) show up here.
new EventSource('/api/events').addEventListener('external', async (ev) => {
  await refreshFiles();
  if (JSON.parse(ev.data).file === state.current && !state.editing) open(state.current);
});

await refreshFiles();
if (state.files.length) open(state.files.find((f) => /start here/i.test(f)) || state.files[0]);
