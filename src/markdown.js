// Minimal markdown renderer shared by the server tests and the browser.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const WIKILINK = /(!?)\[\[([^\]|#^]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

// Code spans are literal: only the text between them gets emphasis, links and tags.
function inline(text, resolve) {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : inlineText(part, resolve)))
    .join('');
}

function inlineText(text, resolve) {
  let out = esc(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/(^|\s)#([\p{L}\d_/-]+)/gu, '$1<span class="tag">#$2</span>');
  out = out.replace(WIKILINK, (_m, _bang, target, _sub, alias) => {
    const name = target.trim();
    const exists = resolve ? resolve(name) : true;
    return `<a class="wikilink${exists ? '' : ' unresolved'}" data-link="${name}">${alias || target}</a>`;
  });
  return out;
}

export function stripFrontmatter(src) {
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? src.slice(m[0].length) : src;
}

export function render(src, resolve) {
  const lines = stripFrontmatter(src).split(/\r?\n/);
  const html = [];
  let list = null;
  let code = null;
  let quote = null;

  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  const closeQuote = () => {
    if (!quote) return;
    const first = quote[0].match(/^\[!(\w+)\][-+]?\s*(.*)$/);
    const body = (first ? quote.slice(1) : quote).map((l) => inline(l, resolve)).join('<br>');
    html.push(first
      ? `<div class="callout callout-${first[1].toLowerCase()}"><div class="callout-title">${esc(first[2] || first[1])}</div>${body}</div>`
      : `<blockquote>${body}</blockquote>`);
    quote = null;
  };

  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) {
        html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { closeList(); closeQuote(); code = []; continue; }

    const q = line.match(/^>\s?(.*)$/);
    if (q) { closeList(); (quote ||= []).push(q[1]); continue; }
    closeQuote();

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); html.push(`<h${h[1].length}>${inline(h[2], resolve)}</h${h[1].length}>`); continue; }
    if (/^---+$/.test(line.trim())) { closeList(); html.push('<hr>'); continue; }

    const li = line.match(/^\s*([-*]|\d+\.)\s+(?:\[( |x)\]\s+)?(.*)$/);
    if (li) {
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== tag) { closeList(); html.push(`<${tag}>`); list = tag; }
      const box = li[2] === undefined ? '' : `<input type="checkbox" disabled${li[2] === 'x' ? ' checked' : ''}> `;
      html.push(`<li>${box}${inline(li[3], resolve)}</li>`);
      continue;
    }

    closeList();
    if (line.trim()) html.push(`<p>${inline(line, resolve)}</p>`);
  }
  if (code !== null) html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  closeList();
  closeQuote();
  return html.join('\n');
}
