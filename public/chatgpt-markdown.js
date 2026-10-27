const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));

function inline(value) {
  let source = String(value ?? '').replace(/:chatgpt-content-reference\{[^}]*\}/g, '');
  const tokens = [];
  const token = html => { const id = `\u0000CG${tokens.length}\u0000`; tokens.push(html); return id; };
  source = source.replace(/`([^`\n]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`));
  source = source.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/)[^\s)]+)\)/g, (_, label, href) => token(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`));
  source = source.replace(/\[([^\]]+)\]\([^\s)]+\)/g, '$1');
  let html = escapeHtml(source);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  return html.replace(/\u0000CG(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

function cells(line) {
  const values = []; let current = ''; let ticks = 0; let hasPipe = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '\\' && line[index + 1] === '|') { current += '|'; index++; continue; }
    if (char === '`') { ticks = ticks ? 0 : 1; current += char; continue; }
    if (char === '|' && !ticks) { values.push(current.trim()); current = ''; hasPipe = true; continue; }
    current += char;
  }
  values.push(current.trim());
  if (line.trim().startsWith('|')) values.shift();
  if (line.trim().endsWith('|') && !line.trim().endsWith('\\|')) values.pop();
  return hasPipe ? values : null;
}

function listItem(line) {
  const match = line.match(/^(\s*)(?:(\d{1,9})[.)]|[-*+])[ \t]+(.+)$/);
  if (!match) return null;
  return { indent: match[1].replace(/\t/g, '    ').length, ordered: Boolean(match[2]), start: Number(match[2] || 1), text: match[3] };
}

function renderList(lines, start) {
  const first = listItem(lines[start]); const items = []; let index = start;
  while (index < lines.length) {
    const item = listItem(lines[index]);
    if (!item || item.indent !== first.indent || item.ordered !== first.ordered) break;
    items.push(item.text); index++;
    while (index < lines.length && lines[index].trim() && !listItem(lines[index])) {
      const indent = (lines[index].match(/^\s*/) || [''])[0].replace(/\t/g, '    ').length;
      if (indent <= first.indent) break;
      items.at(-1) += `\n${lines[index].trim()}`; index++;
    }
    while (index < lines.length && !lines[index].trim()) {
      if (listItem(lines[index + 1] || '')?.indent === first.indent) break;
      index++;
    }
  }
  const tag = first.ordered ? 'ol' : 'ul';
  const startAttr = first.ordered && first.start !== 1 ? ` start="${first.start}"` : '';
  return { html: `<${tag}${startAttr}>${items.map(item => `<li>${inline(item).replace(/\n/g, '<br>')}</li>`).join('')}</${tag}>`, next: index };
}

export function renderChatgptMarkdown(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = []; const paragraph = []; let code = null;
  const flush = () => { if (paragraph.length) { html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph.length = 0; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flush();
      if (code) { html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) { flush(); html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
    const header = cells(line), separator = cells(lines[index + 1] || '');
    if (header?.length && separator?.length === header.length && separator.every(cell => /^:?-{2,}:?$/.test(cell))) {
      flush(); const align = separator.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const row = (values, tag) => `<tr>${header.map((_, column) => `<${tag} style="text-align:${align[column]}">${inline(values[column] || '')}</${tag}>`).join('')}</tr>`;
      html.push(`<div class="markdown-table" tabindex="0" role="region" aria-label="表格"><table><thead>${row(header, 'th')}</thead><tbody>`); index++;
      while (index + 1 < lines.length && cells(lines[index + 1])) { html.push(row(cells(lines[++index]), 'td')); }
      html.push('</tbody></table></div>'); continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (listItem(line)) { flush(); const list = renderList(lines, index); html.push(list.html); index = list.next - 1; continue; }
    if (/^\s*>/.test(line)) { flush(); html.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`); continue; }
    paragraph.push(line);
  }
  if (code) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flush();
  return html.join('') || '<p></p>';
}
