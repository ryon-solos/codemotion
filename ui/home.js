// Home: two actions (a new video, clean up), then folders and projects.
import { api, askText, confirmBox, fmtAgo, fmtBytes, fmtTime, h, icon, modal, popMenu, toast } from './lib.js';

const svg = s => h('div', { class: 'art', html: s });

// Flat illustrations: what each action does, animated quietly.
const ART_NEW = `<svg viewBox="0 0 560 200" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
  <rect width="560" height="200" fill="#151517"/>
  <g transform="translate(34 22)">
    <rect width="250" height="128" rx="8" fill="#0c0c0e" stroke="#2a2a2f"/>
    <rect x="14" y="78" width="222" height="36" rx="3" fill="#1d1d22"/>
    <rect x="26" y="88" width="110" height="9" rx="2" fill="#f2f2f3"/>
    <rect x="26" y="101" width="70" height="6" rx="2" fill="#64646c"/>
    <circle cx="190" cy="44" r="22" fill="#2a3b5c"/><rect x="40" y="28" width="90" height="34" rx="4" fill="#3a3260"/>
    <path class="draw" d="M24 84 C 20 70, 60 64, 110 68 S 152 92, 140 104 S 60 120, 30 108 S 18 92, 24 84" fill="none" stroke="#ff5f2e" stroke-width="3" stroke-linecap="round"/>
    <circle cx="140" cy="104" r="5" fill="#ff5f2e" class="bubble"/>
  </g>
  <g class="bubble" transform="translate(312 30)">
    <rect width="214" height="66" rx="12" fill="#1b1b1e" stroke="#2e2e33"/>
    <circle cx="22" cy="22" r="8" fill="#ff5f2e"/><text x="19" y="26" font-size="10" font-weight="700" fill="#fff" font-family="system-ui">1</text>
    <rect x="38" y="16" width="120" height="7" rx="3" fill="#9b9ba3"/><rect x="38" y="28" width="80" height="6" rx="3" fill="#64646c"/>
    <rect x="16" y="44" width="54" height="12" rx="6" fill="#ff5f2e" opacity=".9"/><text x="24" y="53" font-size="8.5" fill="#fff" font-family="system-ui">0:03.40</text>
    <g transform="translate(180 50)"><circle class="dot" cx="0" cy="0" r="2.6" fill="#9b9ba3"/><circle class="dot" cx="9" cy="0" r="2.6" fill="#9b9ba3"/><circle class="dot" cx="18" cy="0" r="2.6" fill="#9b9ba3"/></g>
  </g>
  <g transform="translate(34 160)">
    <rect width="492" height="13" rx="3" fill="#1b1b1e"/>
    <rect x="0" y="0" width="160" height="13" rx="3" fill="#3d5682"/><rect x="164" y="0" width="120" height="13" rx="3" fill="#3d5682"/>
    <rect x="0" y="17" width="492" height="9" rx="3" fill="#1b1b1e"/><rect x="40" y="17" width="210" height="9" rx="3" fill="#2e5c47"/>
    <rect x="70" y="-17" width="140" height="13" rx="3" fill="#574b8f"/>
    <g class="pl" style="--run: 470px"><rect x="10" y="-22" width="2" height="52" fill="#ff5f2e"/></g>
  </g>
</svg>`;

const ART_CLEAN = `<svg viewBox="0 0 480 200" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
  <rect width="480" height="200" fill="#151517"/>
  <g transform="translate(40 30)">
    ${Array.from({ length: 18 }, (_, i) => { const x = (i % 6) * 42, y = Math.floor(i / 6) * 34, c = ['#2a3b5c', '#3a3260', '#1f3b2e', '#2e2e33'][i % 4];
      return `<rect class="blk" style="--d:${(i % 6) * 90 + Math.floor(i / 6) * 60}ms" x="${x}" y="${y}" width="34" height="26" rx="5" fill="${c}"/>`; }).join('')}
  </g>
  <g transform="translate(330 38)">
    <rect width="112" height="86" rx="12" fill="#1b1b1e" stroke="#2e2e33"/>
    <text x="14" y="26" font-size="11" fill="#9b9ba3" font-family="system-ui">Used space</text>
    <rect x="14" y="40" width="84" height="8" rx="4" fill="#2e2e33"/><rect class="meter" x="14" y="40" width="84" height="8" rx="4" fill="#ff5f2e"/>
    <text x="14" y="70" font-size="12" font-weight="600" fill="#3ecf8e" font-family="system-ui">✓ lighter</text>
  </g>
</svg>`;

export async function renderHome(root) {
  const state = await api('/api/state');
  const view = { folder: sessionStorage.getItem('cm-folder') || null };
  const chip = h('span', { class: 'agent-chip off' }, h('i'), 'Looking for agents…');
  const badge = h('span', { class: 'badge', hidden: true });
  const grid = h('div', { class: 'projects' });
  const crumbs = h('div', { class: 'crumbs' });
  const connectBar = h('div');
  let d = 0; const rv = el => { el.classList.add('reveal'); el.style.setProperty('--d', (d += 70) + 'ms'); return el; };

  root.append(h('div', { class: 'home' },
    rv(h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), h('b', {}, 'Code Motion'), chip,
      h('button', { class: 'icon-btn', title: 'Settings', onclick: () => openSettings(state, refreshAgents) }, icon('settings')))),
    rv(h('div', { class: 'hello' }, h('h1', {}, 'Review videos your agent makes.'),
      h('p', {}, 'Ask Claude Code, OpenCode or Codex for a video in its own chat and it opens here. Watch it without rendering, mark what to change on the exact frame, and send it back.'))),
    connectBar,
    missingTools(state),
    h('div', { class: 'hero' },
      rv(h('button', { class: 'hero-card new', onclick: () => newVideo(state, view.folder) }, svg(ART_NEW),
        h('div', { class: 'txt' }, h('h3', {}, 'Edit a new video', h('span', { class: 'go' }, icon('arrow'))), h('p', {}, 'Bring in videos to cut and combine, or start a film for your agent to write.')))),
      rv(h('button', { class: 'hero-card clean', onclick: () => cleanUp(() => refreshClean()) }, svg(ART_CLEAN), badge,
        h('div', { class: 'txt' }, h('h3', {}, 'Clean up', h('span', { class: 'go' }, icon('arrow'))), h('p', {}, 'Clear caches, temporary files and unused dependencies. Keeps the computer light.'))))),
    rv(h('div', { class: 'section-head' }, crumbs, h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost sm', onclick: async () => { const n = await askText('New folder', '', 'Create'); if (n) { try { await api('/api/folders', { method: 'POST', body: { name: n } }); refresh(); } catch (e) { toast(e.message, 'error'); } } } }, icon('folderplus'), 'New folder'))),
    rv(grid)));

  async function refresh() {
    const [list, folders] = await Promise.all([api('/api/projects'), api('/api/folders')]);
    if (view.folder && !folders.some(f => f.id === view.folder)) view.folder = null;
    const cur = folders.find(f => f.id === view.folder);
    crumbs.replaceChildren(...[cur ? h('a', { onclick: () => go(null) }, 'Projects') : h('span', {}, 'Projects'), cur ? h('span', { class: 'faint' }, '/') : null, cur ? h('span', {}, cur.name) : null].filter(Boolean));
    const items = [];
    if (!cur) for (const f of folders) items.push(folderCard(f, list.filter(p => p.folder === f.id), go, refresh));
    for (const p of list.filter(p => (p.folder || null) === (view.folder || null) || (!cur && p.folder && !folders.some(f => f.id === p.folder)))) items.push(card(p, folders, refresh));
    grid.replaceChildren(...(items.length ? items : [h('div', { class: 'empty', style: { gridColumn: '1/-1' } }, cur ? 'This folder is empty. Move projects here from their ⋯ menu.' : ['No projects yet. Ask your coding agent for a video, or press ', h('b', {}, 'Edit a new video'), '.'])]));
  }
  function go(fid) { view.folder = fid; fid ? sessionStorage.setItem('cm-folder', fid) : sessionStorage.removeItem('cm-folder'); refresh(); }
  async function refreshClean() {
    try { const items = await api('/api/clean'); const n = items.filter(i => i.checked).reduce((s, i) => s + i.size, 0); badge.hidden = false; badge.textContent = n > 1024 * 1024 ? fmtBytes(n) + ' to free' : 'Nothing to free'; } catch { }
  }
  async function refreshAgents() {
    const list = await api('/api/connect').catch(() => []);
    const ready = list.filter(a => a.signedIn !== false), conn = list.filter(a => a.connected);
    chip.classList.toggle('off', !list.length);
    chip.replaceChildren(h('i'), !list.length ? 'No coding agent found' : conn.length ? `Connected: ${conn.map(a => a.name).join(', ')}` : `${(ready.length ? ready : list).map(a => a.name).join(' · ')} found`);
    connectBar.replaceChildren();
    if (list.length && !conn.length) connectBar.append(h('div', { class: 'job reveal', style: { marginBottom: '22px' } }, icon('plug'),
      h('span', { class: 'grow' }, `Connect ${list.map(a => a.name).join(' / ')} so it can make and fix videos here from its own chat.`),
      h('button', { class: 'btn primary sm', onclick: () => openSettings(state, refreshAgents) }, 'Connect')));
  }

  // a coding agent asked to show a project
  const es = new EventSource('/api/events');
  es.addEventListener('show', ev => { const d = JSON.parse(ev.data); location.hash = '#/edit/' + encodeURIComponent(d.id) + (d.time != null ? '?t=' + d.time : ''); });
  await refresh();
  setTimeout(refreshAgents, 120);
  setTimeout(refreshClean, 400);
  return () => es.close();
}

function missingTools(state) {
  const miss = [];
  if (!state.tools.ffmpeg) miss.push('ffmpeg (sudo apt install ffmpeg)');
  if (!state.tools.browser) miss.push('Google Chrome or Chromium (for exporting code scenes)');
  if (!miss.length) return null;
  return h('div', { class: 'job', style: { borderColor: 'rgba(245,177,76,.4)', marginBottom: '22px' } }, icon('settings'), h('span', {}, 'Missing on this computer: ', miss.join(', ')));
}

function folderCard(f, projects, go, refresh) {
  return h('div', { class: 'fcard', onclick: () => go(f.id) },
    h('div', { class: 'fic' }, icon('folder')), h('div', {}, h('b', {}, f.name), h('br'), h('span', {}, `${projects.length} video${projects.length === 1 ? '' : 's'}`)),
    h('button', { class: 'icon-btn menu', title: 'More', onclick: e => { e.stopPropagation(); popMenu(e.currentTarget, [
      { label: 'Rename folder', icon: 'pen', run: async () => { const n = await askText('Rename folder', f.name, 'Rename'); if (n) { await api(`/api/folders/${f.id}`, { method: 'PATCH', body: { name: n } }); refresh(); } } },
      { label: 'Delete folder (keeps the videos)', icon: 'trash', danger: true, run: async () => { if (await confirmBox(`Delete the folder “${f.name}”?`, 'The videos in it stay; they move back to Projects.', 'Delete folder', true)) { await api(`/api/folders/${f.id}`, { method: 'DELETE' }); refresh(); } } },
    ]); } }, icon('more')));
}

function card(p, folders, refresh) {
  const cover = h('div', { class: 'cover' }, icon('film', 'lg'));
  const src = p.cover?.file ? `/api/projects/${encodeURIComponent(p.id)}/cover?v=${p.cover.v}` : p.cover ? `/api/projects/${encodeURIComponent(p.id)}/thumb?src=${encodeURIComponent(p.cover.src)}&at=${p.cover.at}` : null;
  if (src) { const img = h('img', { alt: '', src }); img.onload = () => cover.replaceChildren(img); }
  const pills = h('div', { class: 'pills' }, p.notes ? h('span', { class: 'pill notes' }, `${p.notes} note${p.notes > 1 ? 's' : ''}`) : null, p.agent ? h('span', { class: 'pill' }, { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' }[p.agent] || p.agent) : null);
  const menuBtn = h('button', { class: 'icon-btn menu', title: 'More', onclick: e => { e.stopPropagation(); projectMenu(e.currentTarget, p, folders, refresh); } }, icon('more'));
  return h('div', { class: 'pcard', onclick: () => location.hash = '#/edit/' + encodeURIComponent(p.id) }, cover, pills, menuBtn,
    h('div', { class: 'meta' }, h('b', {}, p.name),
      h('span', {}, [p.duration ? fmtTime(p.duration, false) : 'Empty', p.exports ? `${p.exports} export${p.exports > 1 ? 's' : ''}` : null, fmtAgo(p.updated)].filter(Boolean).join(' · '))));
}

export async function openAgentChat(id) {
  try { const r = await api(`/api/projects/${encodeURIComponent(id)}/open-chat`, { method: 'POST' }); toast(`Opening the ${r.agent} chat in ${r.where}…`, 'ok'); }
  catch (e) { toast(e.message, 'error'); }
}

function projectMenu(anchor, p, folders, refresh) {
  const pid = encodeURIComponent(p.id);
  popMenu(anchor, [
    { label: 'Open', icon: 'film', run: () => { location.hash = '#/edit/' + pid; } },
    { label: 'Open the chat in your coding agent', icon: 'external', run: () => openAgentChat(p.id) },
    { label: 'Show in file manager', icon: 'folder', run: () => api(`/api/projects/${pid}/reveal`, { method: 'POST' }) },
    'sep',
    { label: 'Move to folder…', icon: 'folderplus', run: () => setTimeout(() => popMenu(anchor, [
      { heading: 'Move to' },
      ...folders.filter(f => f.id !== p.folder).map(f => ({ label: f.name, icon: 'folder', run: async () => { await api(`/api/projects/${pid}/folder`, { method: 'POST', body: { folder: f.id } }); toast(`Moved to ${f.name}`, 'ok'); refresh(); } })),
      p.folder ? { label: 'No folder', icon: 'close', run: async () => { await api(`/api/projects/${pid}/folder`, { method: 'POST', body: { folder: null } }); refresh(); } } : null,
      { label: 'New folder…', icon: 'plus', run: async () => { const n = await askText('New folder', '', 'Create'); if (!n) return; const f = await api('/api/folders', { method: 'POST', body: { name: n } }); await api(`/api/projects/${pid}/folder`, { method: 'POST', body: { folder: f.id } }); toast(`Moved to ${f.name}`, 'ok'); refresh(); } },
    ]), 0) },
    { label: 'Rename', icon: 'pen', run: async () => { const name = await askText('Rename project', p.name, 'Rename'); if (name) { await api(`/api/projects/${pid}`, { method: 'PATCH', body: { name } }); refresh(); } } },
    { label: 'Move to Trash', icon: 'trash', danger: true, run: async () => {
      if (!await confirmBox(`Move “${p.name}” to the Trash?`, 'The project folder goes to the Trash; you can restore it from there. Videos you added from other folders stay where they are.', 'Move to Trash', true)) return;
      try { await api(`/api/projects/${pid}`, { method: 'DELETE' }); toast('Moved to the Trash', 'ok'); refresh(); } catch (e) { toast(e.message, 'error'); }
    } },
  ]);
}

// ---------- new video
function newVideo(state, folder) {
  const files = [];
  let kind = 'edit', size = '1920x1080';
  const list = h('ul', { class: 'filelist' });
  const nameIn = h('input', { type: 'text', placeholder: 'My video' });
  const drawList = () => list.replaceChildren(...files.map(f => h('li', {}, '• ', f.name)));
  const fileIn = h('input', { type: 'file', multiple: true, accept: 'video/*,audio/*,image/*', style: { display: 'none' }, onchange: () => { for (const f of fileIn.files) files.push({ file: f, name: f.name }); drawList(); } });
  const zone = h('div', { class: 'dropzone' }, icon('upload'), h('div', {}, 'Drop videos, sounds or pictures here'),
    h('div', { class: 'row gap', style: { justifyContent: 'center', marginTop: '10px' } },
      h('button', { class: 'btn sm', onclick: async () => {
        if (!state.tools.picker) return fileIn.click();
        const r = await api('/api/pick-preview', { method: 'POST' }).catch(() => null);
        if (r?.fallback || !r) return fileIn.click();
        for (const p of r.files) files.push({ path: p, name: p.split('/').pop() }); drawList();
      } }, icon('folder'), 'Choose files…')), list, fileIn);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); for (const f of e.dataTransfer.files) files.push({ file: f, name: f.name }); drawList(); });
  const filmNote = h('p', { class: 'hint', style: { margin: '6px 0 0' } }, 'A full-frame film written as code goes on the timeline. Ask your coding agent (in its own chat, or the chat in the editor) to write it; you watch it here live.');
  const zoneWrap = h('label', { class: 'field' }, h('span', {}, 'Videos to edit (you can add more later)'), zone);
  const seg = h('div', { class: 'seg' });
  const drawSeg = () => { seg.replaceChildren(...[['edit', 'Edit videos'], ['film', 'Film made in code']].map(([k, l]) => h('button', { class: kind === k ? 'on' : '', onclick: () => { kind = k; drawSeg(); zoneWrap.hidden = kind !== 'edit'; filmNote.hidden = kind !== 'film'; } }, l))); };
  drawSeg(); filmNote.hidden = true;
  const sizeSeg = h('div', { class: 'seg' });
  const drawSize = () => sizeSeg.replaceChildren(...[['1920x1080', '16:9'], ['1080x1920', '9:16'], ['1080x1080', '1:1']].map(([k, l]) => h('button', { class: size === k ? 'on' : '', onclick: () => { size = k; drawSize(); } }, l)));
  drawSize();

  const go = h('button', { class: 'btn primary' }, 'Create');
  modal(close => {
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Creating…';
      try {
        const name = nameIn.value.trim() || (files[0]?.name.replace(/\.[^.]+$/, '') ?? 'New video');
        const [w, hh] = size.split('x').map(Number);
        const { id } = await api('/api/projects', { method: 'POST', body: { name, folder, film: kind === 'film', width: w, height: hh } });
        const pid = encodeURIComponent(id);
        if (kind === 'edit') {
          const paths = files.filter(f => f.path).map(f => f.path);
          if (paths.length) await api(`/api/projects/${pid}/import`, { method: 'POST', body: { files: paths, place: true } });
          for (const f of files.filter(f => f.file)) { go.textContent = `Copying ${f.name}…`; await api(`/api/projects/${pid}/upload?place=1&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f.file, raw: true }); }
        }
        close(); location.hash = '#/edit/' + pid;
      } catch (e) { toast(e.message, 'error'); go.disabled = false; go.textContent = 'Create'; }
    };
    return h('div', {},
      h('h2', {}, 'Edit a new video'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), nameIn),
      h('div', { class: 'row gap', style: { margin: '12px 0', flexWrap: 'wrap' } }, seg, h('span', { class: 'grow' }), sizeSeg),
      zoneWrap, filmNote,
      h('div', { class: 'row end gap', style: { marginTop: '16px' } }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'), go));
  });
  setTimeout(() => nameIn.focus(), 30);
}

// ---------- settings
export async function openSettings(state, after) {
  const body = h('div', {}, h('p', { class: 'muted' }, icon('spin', 'spin'), ' Loading…'));
  const m = modal(body, { wide: true, onClose: () => after?.() });
  const draw = async () => {
    const [agents, st] = await Promise.all([api('/api/connect'), api('/api/state')]);
    const cfg = st.config;
    const save = async patch => { try { await api('/api/config', { method: 'POST', body: patch }); toast('Saved', 'ok'); draw(); } catch (e) { toast(e.message, 'error'); } };
    const agentRow = a => h('div', { class: 'set-row' },
      h('div', { class: 'lab' }, h('b', {}, a.name), h('span', {}, a.connected ? 'Its own chat can make videos here (Code Motion tools and skill installed). Start a new chat to load them.' : a.stale ? 'Its Code Motion entry points to an old or moved copy. Reconnect to fix it.' : 'Not connected: its chats do not know Code Motion yet.')),
      a.signedIn === false ? h('button', { class: 'btn sm', onclick: async () => { await api(`/api/agents/${a.id}/signin`, { method: 'POST' }).catch(e => toast(e.message, 'error')); toast('Sign in in the terminal that opened'); } }, 'Sign in') : null,
      a.connected ? [h('span', { class: 'ok-txt' }, icon('check'), 'Connected'), h('button', { class: 'btn sm ghost', onclick: async () => { await api(`/api/connect/${a.id}`, { method: 'DELETE' }).catch(e => toast(e.message, 'error')); draw(); } }, 'Disconnect')]
        : h('button', { class: 'btn sm primary', onclick: async e => { e.currentTarget.disabled = true; try { await api(`/api/connect/${a.id}`, { method: 'POST' }); toast(`${a.name} connected. Start a new chat there to use it.`, 'ok'); } catch (err) { toast(err.message, 'error'); } draw(); } }, a.stale ? 'Reconnect' : 'Connect'));
    const seg = (val, opts, onPick) => h('div', { class: 'seg' }, opts.map(([k, l]) => h('button', { class: String(val) === String(k) ? 'on' : '', onclick: () => onPick(k) }, l)));
    const wsIn = h('input', { type: 'text', value: cfg.workspace });
    body.replaceChildren(
      h('h2', {}, 'Settings'),
      h('div', { class: 'set-h' }, 'Coding agents'),
      ...(agents.length ? agents.map(agentRow) : [h('p', { class: 'muted' }, 'No coding agent found. Install Claude Code, OpenCode or Codex; Code Motion finds it by itself.')]),
      h('div', { class: 'set-h' }, 'Chat in the editor'),
      h('div', { class: 'set-row' }, h('div', { class: 'lab' }, h('b', {}, 'What the agent may do'), h('span', {}, 'Edits only: change files in the project and run media tools. Full: no permission checks.')),
        seg(cfg.agentAccess, [['edits', 'Edits only'], ['full', 'Full access']], v => save({ agentAccess: v }))),
      h('div', { class: 'set-h' }, 'Export'),
      h('div', { class: 'set-row' }, h('div', { class: 'lab' }, h('b', {}, 'Quality'), h('span', {}, 'Higher quality makes bigger files.')),
        seg(cfg.exportQuality || 'standard', [['small', 'Small'], ['standard', 'Standard'], ['high', 'High']], v => save({ exportQuality: v }))),
      h('div', { class: 'set-row' }, h('div', { class: 'lab' }, h('b', {}, 'Processor use'), h('span', {}, 'Fewer threads keep the computer smoother while exporting.')),
        seg(cfg.exportThreads, [[2, '2'], [4, '4'], [8, '8']], v => save({ exportThreads: +v }))),
      h('div', { class: 'set-h' }, 'Storage'),
      h('div', { class: 'set-row' }, h('div', { class: 'lab' }, h('b', {}, 'Projects folder'), h('span', {}, 'Where new projects are kept.')), h('div', { style: { width: '300px' } }, wsIn),
        h('button', { class: 'btn sm', onclick: () => save({ workspace: wsIn.value.trim() }) }, 'Save')),
      h('div', { class: 'set-row' }, h('div', { class: 'lab' }, h('b', {}, 'Stop when idle'), h('span', {}, 'The background server stops this long after the last window closes.')),
        seg(cfg.idleMinutes, [[3, '3 min'], [15, '15 min'], [0, 'Never']], v => save({ idleMinutes: +v }))),
      h('div', { class: 'row end', style: { marginTop: '16px' } }, h('button', { class: 'btn', onclick: m.close }, 'Done')));
  };
  draw();
}

// ---------- clean up
export async function cleanUp(after) {
  const body = h('div', {}, h('p', { class: 'muted' }, icon('spin', 'spin'), ' Looking for things to clean…'));
  const m = modal(body, { wide: true });
  let items;
  try { items = await api('/api/clean'); } catch (e) { body.replaceChildren(h('p', {}, e.message)); return; }
  const checked = new Set(items.filter(i => i.checked).map(i => i.id));
  const total = h('b', {});
  const go = h('button', { class: 'btn primary' });
  const upd = () => { const n = items.filter(i => checked.has(i.id)).reduce((s, i) => s + i.size, 0); total.textContent = fmtBytes(n); go.disabled = !checked.size; go.textContent = checked.size ? `Clean ${fmtBytes(n)}` : 'Nothing selected'; };
  const groups = {};
  for (const it of items) (groups[it.group] ||= []).push(it);
  const listEl = h('div', { class: 'clean-list' }, Object.entries(groups).map(([g, arr]) => [
    h('div', { class: 'clean-group' }, g),
    arr.map(it => {
      const cb = h('input', { type: 'checkbox', checked: checked.has(it.id), onchange: () => { cb.checked ? checked.add(it.id) : checked.delete(it.id); upd(); } });
      return h('label', { class: 'clean-item' }, cb, h('div', { class: 'grow' }, h('div', {}, it.label, ' ', h('span', { class: 'tag' }, it.action === 'delete' ? 'delete' : 'to Trash')), h('div', { class: 'why' }, it.why)), h('span', { class: 'size' }, fmtBytes(it.size)));
    })]));
  go.onclick = async () => {
    go.disabled = true; go.textContent = 'Cleaning…';
    try {
      const r = await api('/api/clean', { method: 'POST', body: { ids: [...checked] } });
      const parts = [];
      if (r.freed) parts.push(`${fmtBytes(r.freed)} freed`);
      if (r.trashed) parts.push(`${fmtBytes(r.trashed)} moved to the Trash`);
      toast(parts.join(', ') || 'Done', 'ok');
      if (r.errors.length) toast(r.errors[0], 'error');
      m.close(); after?.();
    } catch (e) { toast(e.message, 'error'); upd(); }
  };
  if (!items.length) body.replaceChildren(h('h2', {}, 'Clean up'), h('p', { class: 'muted' }, 'Everything is already clean.'), h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: m.close }, 'Close')));
  else body.replaceChildren(h('h2', {}, 'Clean up'),
    h('p', { class: 'muted' }, 'Caches are deleted (Code Motion rebuilds them when needed). Files inside your projects go to the Trash, so you can restore them.'),
    listEl, h('div', { class: 'row gap' }, h('span', { class: 'muted' }, 'Selected: ', total), h('span', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'), go));
  upd();
}
