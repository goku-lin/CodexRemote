const renderedHtml = new WeakMap();
const renderedNodes = new WeakMap();
const renderedParts = new WeakMap();

function key(node) {
  if (node.nodeType !== 1) return null;
  return node.getAttribute('data-node-key') || node.getAttribute('data-detail-key')
    || node.getAttribute('data-turn-id') || node.getAttribute('data-session')
    || node.getAttribute('data-project') || node.getAttribute('data-device') || node.id || null;
}

function compatible(a, b) {
  return a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);
}

function syncNode(current, next) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  const signature = key(next) ? next.outerHTML : null;
  if (signature && renderedNodes.get(current) === signature) return;
  // The browser owns disclosure state. It must survive content updates.
  const userAttribute = name => current.tagName === 'DETAILS' && name === 'open';
  for (const attribute of [...current.attributes]) {
    if (!userAttribute(attribute.name) && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (!userAttribute(attribute.name) && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  syncChildren(current, next);
  if (signature) renderedNodes.set(current, signature);
}

function syncChildren(current, next) {
  const oldChildren = [...current.childNodes];
  const keyed = new Map(oldChildren.filter(node => key(node)).map(node => [key(node), node]));
  const kept = new Set();
  let cursor = current.firstChild;
  for (const child of next.childNodes) {
    const childKey = key(child);
    let existing = childKey ? keyed.get(childKey) : cursor;
    if (!existing || kept.has(existing) || !compatible(existing, child) || (!childKey && key(existing))) existing = null;
    const node = existing || child.cloneNode(true);
    if (existing) syncNode(node, child);
    else if (childKey) renderedNodes.set(node, child.outerHTML);
    if (node !== cursor) current.insertBefore(node, cursor);
    kept.add(node);
    cursor = node.nextSibling;
  }
  for (const node of oldChildren) if (!kept.has(node)) node.remove();
}

// Identical input performs no DOM writes. Changed input retains keyed rows,
// focused controls, scroll containers and open <details> elements.
export function syncHtml(element, html) {
  if (renderedHtml.get(element) === html) return false;
  const template = element.ownerDocument.createElement('template');
  template.innerHTML = html;
  syncChildren(element, template.content);
  renderedParts.delete(element);
  renderedHtml.set(element, html);
  return true;
}

// Each part owns one root element. Unchanged parts retain their DOM without
// parsing a new template; changed parts use the same focus/disclosure-safe diff.
export function syncHtmlParts(element, parts) {
  const previous = renderedParts.get(element) || new Map();
  const nextParts = new Map(), kept = new Set(), oldChildren = [...element.childNodes];
  let cursor = element.firstChild, changed = false;
  for (const part of parts) {
    if (!part.html) continue;
    if (nextParts.has(part.key)) throw new Error('Duplicate HTML part key');
    const old = previous.get(part.key);
    let node = old?.node.parentNode === element ? old.node : null;
    if (!node || old.html !== part.html) {
      const template = element.ownerDocument.createElement('template');
      template.innerHTML = part.html;
      const next = template.content.firstChild;
      if (!next || next.nodeType !== 1 || template.content.childNodes.length !== 1) throw new Error('HTML part must contain one root element');
      if (node && compatible(node, next)) syncNode(node, next);
      else {
        node = next;
        if (key(node)) renderedNodes.set(node, part.html);
      }
      changed = true;
    }
    if (node !== cursor) { element.insertBefore(node, cursor); changed = true; }
    kept.add(node);
    cursor = node.nextSibling;
    nextParts.set(part.key, {html: part.html, node});
  }
  for (const node of oldChildren) if (!kept.has(node)) { node.remove(); changed = true; }
  renderedParts.set(element, nextParts);
  renderedHtml.delete(element);
  return changed;
}
