// Small shared helpers: DOM builder, API calls, icons, toasts, dialogs, formatting.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;   // only for our own icon SVG strings
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export async function api(path, { method = 'GET', body, raw } = {}) {
  const r = await fetch(path, { method, headers: body && !raw ? { 'content-type': 'application/json' } : {}, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  if (!r.ok) { const e = new Error(data?.error || r.statusText); e.status = r.status; throw e; }
  return data;
}

const P = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  broom: '<path d="M19 3 11 11"/><path d="M5.5 13.5c2-2 5-2 7 0s2 5 0 7L4 21l.5-4.5"/><path d="m9 18 2-2"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="m17 9 4 6M21 9l-4 6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.4-1"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  zoomin: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6M11 8v6"/>',
  zoomout: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>',
  skipback: '<path d="M6 5v14M18 5 9 12l9 7z" fill="currentColor"/>',
  skipfwd: '<path d="M18 5v14M6 5l9 7-9 7z" fill="currentColor"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  cursor: '<path d="M5 3l14 7-6 2-2 6z"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  circle: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
  rect: '<rect x="4" y="5.5" width="16" height="13" rx="1.5"/>',
  pen: '<path d="M4 20c3-1 4-4 7-7l6-6a2.1 2.1 0 0 1 3 3l-6 6c-3 3-6 4-7 7"/><path d="M15 6l3 3"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  folderplus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  versions: '<rect x="4" y="7" width="12" height="13" rx="2"/><path d="M8 4h10a2 2 0 0 1 2 2v10"/>',
  frame: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>',
};
export function icon(name, cls = '') {
  return h('span', { class: 'ic ' + cls, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" ${P}>${ICONS[name] || ''}</svg>` });
}

let toastBox;
export function toast(msg, kind = '') {
  toastBox ??= document.body.appendChild(h('div', { class: 'toasts' }));
  const t = h('div', { class: 'toast ' + kind }, msg);
  toastBox.append(t);
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 3200);
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3700);
}

// A modal; returns { el, close }. content is a node or a function(close) → node.
export function modal(content, { wide = false, onClose } = {}) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') });
  box.append(typeof content === 'function' ? content(close) : content);
  back.append(box);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', esc);
  document.body.append(back);
  return { el: box, close };
}
export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    let done = false;
    const m = modal(close => h('div', {},
      h('h2', {}, title), text ? h('p', { class: 'muted' }, text) : null,
      h('div', { class: 'row end gap' },
        h('button', { class: 'btn ghost', onclick: () => { done = true; close(); res(false); } }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { done = true; close(); res(true); } }, okLabel))), { onClose: () => { if (!done) res(false); } });
    m.el.querySelector('.btn.primary, .btn.danger')?.focus();
  });
}

export function fmtTime(s, frac = true) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${(frac ? r.toFixed(1) : Math.floor(r).toString()).padStart(frac ? 4 : 2, '0')}`;
}
export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}
export function fmtAgo(ms) {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} days ago`;
  return new Date(ms).toLocaleDateString();
}
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// A small menu next to a button. items: { label, icon?, run, danger? } | 'sep' | { heading }
export function popMenu(anchor, items) {
  document.querySelector('.popmenu')?.remove();
  const r = anchor.getBoundingClientRect();
  const m = h('div', { class: 'popmenu' }, items.filter(Boolean).map(it => it === 'sep' ? h('hr') : it.heading ? h('div', { class: 'lbl' }, it.heading)
    : h('button', { class: it.danger ? 'danger' : '', onclick: e => { e.stopPropagation(); m.remove(); it.run(); } }, it.icon ? icon(it.icon) : null, it.label)));
  document.body.append(m);
  const w = m.offsetWidth;
  m.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  m.style.top = (r.bottom + 4 + m.offsetHeight > innerHeight ? Math.max(8, r.top - m.offsetHeight - 4) : r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } }), 0);
}
// A one-field dialog (instead of window.prompt): resolves the text or null.
export function askText(title, value = '', okLabel = 'OK') {
  return new Promise(res => {
    let done = false;
    const inp = h('input', { type: 'text', value });
    const finish = v => { done = true; m.close(); res(v); };
    const m = modal(close => h('div', {}, h('h2', {}, title), inp,
      h('div', { class: 'row end gap', style: { marginTop: '16px' } }, h('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => finish(inp.value.trim() || null) }, okLabel))),
      { onClose: () => { if (!done) res(null); } });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') finish(inp.value.trim() || null); });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
export const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
