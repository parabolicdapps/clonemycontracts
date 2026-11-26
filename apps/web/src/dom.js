/** Tiny DOM helpers. Text always goes through textContent / text nodes: no innerHTML anywhere. */

export const $ = (id) => document.getElementById(id);

/**
 * h('p', {class: 'x', 'aria-label': 'y', onclick: fn, hidden: true}, 'text', childNode, ...)
 */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function setChildren(node, ...children) {
  node.replaceChildren();
  append(node, children);
}

export const code = (text, cls) => h('code', { class: cls }, text);

const liveStatus = () => $('live-status');
export function announce(message) {
  const el = liveStatus();
  if (!el) return;
  el.textContent = '';
  window.requestAnimationFrame(() => { el.textContent = message; });
}

export function show(el, visible = true) { el.hidden = !visible; }

export function showError(el, message) {
  el.textContent = message ?? '';
  el.hidden = !message;
}

export function badge(text, kind = '') { return h('span', { class: `badge ${kind}`.trim() }, text); }

export function focusHeading(el) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** Copy to clipboard with the select-fallback of the product site. */
export async function copyText(text, button, codeEl) {
  const original = button.textContent;
  const restore = () => window.setTimeout(() => { button.textContent = original; }, 1800);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      announce('Command copied to clipboard.');
    } else if (codeEl) {
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      button.textContent = 'Selected: press Ctrl or Cmd C';
      announce('Command selected; press Control or Command C to copy.');
    } else {
      button.textContent = 'Select manually';
    }
  } catch {
    button.textContent = 'Select manually';
    announce('Unable to copy automatically.');
  }
  restore();
}

const SHELL_SAFE = /^[\w.:/@+=,-]+$/;
export const shellQuote = (s) => (SHELL_SAFE.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);
