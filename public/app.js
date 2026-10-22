import { render } from '/markdown.js';
import { mountGraph } from '/graph.js';

const $ = (id) => document.getElementById(id);
const state = { files: [], current: null, editing: false, saveTimer: null, pendingSave: null, graph: null };

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
  if (!isGraph && state.graph) {
    state.graph.stop();
    state.graph = null;
  }
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
  await flushSave(); // the graph reflects what is on disk
  setView('graph');
  state.graph?.stop();
  state.graph = mountGraph($('graph'), await api('/api/graph'), { onOpen: (id) => open(id) });
};

// Live updates: edits made outside the app (another editor, git pull) show up here.
new EventSource('/api/events').addEventListener('external', async (ev) => {
  await refreshFiles();
  if (JSON.parse(ev.data).file === state.current && !state.editing) open(state.current);
});

await refreshFiles();
if (state.files.length) open(state.files.find((f) => /start here/i.test(f)) || state.files[0]);
