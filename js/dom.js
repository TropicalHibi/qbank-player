// DOM helpers: element builder, modal dialogs, lightbox, toasts, clipboard, downloads.
// Text always goes in via textContent; `html` is ONLY used with output of renderMarkdownLite
// (which escapes its input first).

let uid = 0;
export const nextId = (p = 'id') => `${p}-${++uid}`;

/**
 * el('button', {class: 'btn', text: 'Go', attrs: {type: 'button'}, on: {click: fn}}, child1, child2)
 * Props: class, text, html (trusted renderer output only), attrs, dataset, on, hidden, and
 * a few direct properties (id, type, title, disabled, value, href, htmlFor, tabIndex).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'attrs') for (const [a, av] of Object.entries(v)) av != null && av !== false && node.setAttribute(a, av === true ? '' : String(av));
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else node[k] = v;
  }
  append(node, children);
  return node;
}

/** Like node.replaceChildren(), but skips null/false (replaceChildren would render them as text). */
export function setChildren(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const isDialogOpen = () => !!document.querySelector('dialog[open]');

/**
 * In-page modal (no alert/confirm/prompt). Resolves with the clicked action's value,
 * or `dismissValue` on Esc / backdrop click.
 * @param {{title: string, body?: string|Node|Node[], actions?: {label: string, value: any, variant?: string}[], dismissValue?: any}} o
 */
export function showModal({ title, body, actions = [{ label: 'OK', value: true, variant: 'primary' }], dismissValue = null }) {
  return new Promise((resolve) => {
    const titleId = nextId('modal-title');
    const prevFocus = document.activeElement;
    let result = dismissValue;
    const buttons = actions.map((a) =>
      el('button', {
        class: ['btn', a.variant && `btn-${a.variant}`],
        type: 'button',
        text: a.label,
        on: {
          click: () => {
            result = a.value;
            dlg.close();
          },
        },
      })
    );
    const dlg = el(
      'dialog',
      { class: 'modal', attrs: { 'aria-labelledby': titleId } },
      el(
        'div',
        { class: 'modal-inner' },
        el('h2', { id: titleId, class: 'modal-title', text: title }),
        body == null ? null : el('div', { class: 'modal-body' }, typeof body === 'string' ? el('p', { text: body }) : body),
        el('div', { class: 'modal-actions' }, buttons)
      )
    );
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close(); // backdrop
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
    const primary = buttons[actions.findIndex((a) => a.variant === 'primary')] || buttons[buttons.length - 1];
    primary?.focus();
  });
}

export function openLightbox(src, alt) {
  const img = el('img', { src, alt: alt || '' });
  const close = el('button', { class: 'btn lightbox-close', type: 'button', text: '✕', attrs: { 'aria-label': 'Close image' } });
  const dlg = el('dialog', { class: 'lightbox', attrs: { 'aria-label': 'Enlarged image' } }, close, img);
  const prevFocus = document.activeElement;
  dlg.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
  });
  document.body.append(dlg);
  dlg.showModal();
  close.focus();
}

let toastTimer;
export function toast(message) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast', class: 'toast', attrs: { role: 'status', 'aria-live': 'polite' } });
    document.body.append(t);
  }
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/** Polite screen-reader announcement via a shared live region. */
export function announce(message) {
  let r = document.getElementById('sr-live');
  if (!r) {
    r = el('div', { id: 'sr-live', class: 'sr-only', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });
    document.body.append(r);
  }
  r.textContent = '';
  // Next frame so repeated identical messages are still announced.
  requestAnimationFrame(() => (r.textContent = message));
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = el('textarea', { value: text, attrs: { readonly: true, 'aria-hidden': 'true' }, class: 'offscreen' });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copy, then flash "Copied ✓" on the button (or a failure message). */
export async function copyWithFeedback(button, text, idleLabel) {
  const ok = await copyText(text);
  const label = idleLabel ?? button.dataset.label ?? button.textContent;
  button.dataset.label = label;
  button.textContent = ok ? 'Copied ✓' : 'Copy failed';
  button.classList.toggle('is-copied', ok);
  toast(ok ? 'Copied to clipboard' : 'Could not access the clipboard; select the text and copy it manually.');
  clearTimeout(button._copyTimer);
  button._copyTimer = setTimeout(() => {
    button.textContent = label;
    button.classList.remove('is-copied');
  }, 2000);
  return ok;
}

export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, attrs: { download: filename }, class: 'offscreen' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
