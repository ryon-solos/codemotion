// The editor: media list + clip settings (left), preview (middle), AI chat (right), timeline (bottom).
import { api, askText, clamp, confirmBox, fmtAgo, fmtBytes, fmtTime, h, icon, modal, popMenu, toast, uid } from './lib.js';
import { createPlayer } from './player.js';
import { createTimeline } from './timeline.js';
import { createChat } from './chat.js';
import { createAnnotator, TOOLS } from './annotate.js';
import { openAgentChat } from './home.js';

export async function renderEditor(root, id, startTime = null) {
  let project;
  try { project = await api(`/api/projects/${encodeURIComponent(id)}`); }
  catch (e) { root.append(h('div', { class: 'home' }, h('h2', {}, 'This project could not be opened'), h('p', { class: 'muted' }, e.message), h('a', { href: '#/' }, '← Back home'))); return; }
  const pid = encodeURIComponent(id);

  const S = { project, version: project.version, sel: null, zoom: 60, snap: true, flash: new Set(), media: [], history: [], future: [], dragKind: null, saving: false, dirty: false, side: 'media', notes: [], noteSel: new Set(), waiting: 0, focusNote: null };

  // ---------- layout
  const titleIn = h('input', { class: 'title', type: 'text', value: project.name, title: 'Rename' });
  const saveState = h('span', { class: 'save-state' }, 'Saved');
  const undoBtn = h('button', { class: 'icon-btn', title: 'Undo (Ctrl+Z)', onclick: () => undo() }, icon('undo'));
  const redoBtn = h('button', { class: 'icon-btn', title: 'Redo (Ctrl+Shift+Z)', onclick: () => redo() }, icon('redo'));
  const chatBtn = h('button', { class: 'icon-btn on', title: 'Show or hide the AI chat', onclick: () => toggleChat() }, icon('chat'));
  const exportBtn = h('button', { class: 'btn primary', onclick: () => openExport() }, icon('export'), 'Export');
  const waitPill = h('span', { class: 'wait-pill', title: 'An agent chat is waiting for your notes (codemotion_wait). Send notes to it from the Notes tab.' }, h('i'), 'Agent waiting for notes');
  const moreBtn = h('button', { class: 'icon-btn', title: 'Project', onclick: e => projectMenu(e.currentTarget) }, icon('more'));
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'icon-btn', title: 'Home', onclick: () => { location.hash = '#/'; } }, icon('back')),
    h('img', { src: '/icon.svg', alt: '', style: { width: '22px', height: '22px', margin: '0 4px' } }),
    titleIn, saveState, h('span', { class: 'grow' }), waitPill, h('span', { class: 'sep' }),
    undoBtn, redoBtn, h('span', { class: 'sep' }), chatBtn, moreBtn, h('span', { class: 'sep' }), exportBtn);

  const tabMedia = h('button', { class: 'on', onclick: () => setSide('media') }, 'Media');
  const noteCount = h('span', { class: 'count', hidden: true });
  const tabNotes = h('button', { onclick: () => setSide('notes') }, 'Notes', noteCount);
  const tabClip = h('button', { onclick: () => setSide('clip') }, 'Clip');
  const sideBody = h('div', { class: 'side-body' });
  const side = h('div', { class: 'side' }, h('div', { class: 'side-tabs' }, tabMedia, tabNotes, tabClip), sideBody);

  const screen = h('div', { class: 'screen' });
  const viewport = h('div', { class: 'viewport' }, screen);
  const playBtn = h('button', { class: 'icon-btn play', title: 'Play / pause (Space)', onclick: () => player.toggle() }, icon('play'));
  const timecode = h('span', { class: 'timecode' });
  const stage = h('div', { class: 'stage' }, viewport, h('div', { class: 'transport' },
    h('button', { class: 'icon-btn', title: 'Go to start (Home)', onclick: () => seek(0) }, icon('skipback')),
    playBtn,
    h('button', { class: 'icon-btn', title: 'Go to end (End)', onclick: () => seek(player.duration()) }, icon('skipfwd')),
    timecode, h('span', { class: 'grow' }),
    h('div', { class: 'tools', title: 'Mark the frame and comment' }, h('span', { class: 'lbl' }, 'Mark'),
      toolBtns = TOOLS.map(([t, ic, title]) => h('button', { class: 'icon-btn', title, onclick: () => annot.setTool(t) }, icon(ic))))));
  var toolBtns;
  const chatEl = h('div', { class: 'chat' });
  const main = h('div', { class: 'main' }, side, stage, chatEl);
  const resizer = h('div', { class: 'resizer', title: 'Drag to resize the timeline' });
  const tlRoot = h('div', { style: { minHeight: 0, display: 'flex', flexDirection: 'column' } });
  const editor = h('div', { class: 'editor' }, topbar, main, resizer, tlRoot);
  root.append(editor);
  const savedTl = +localStorage.getItem('cm-tl-h'); if (savedTl) editor.style.setProperty('--tl-h', savedTl + 'px');
  if (localStorage.getItem('cm-chat') === '0') { main.classList.add('no-chat'); chatBtn.classList.remove('on'); }

  // ---------- editor API shared with the timeline and the chat
  const ed = {
    id, S,
    project: () => S.project,
    time: () => player.time,
    playing: () => player.playing,
    seek: t => seek(t),
    select: cid => { S.sel = cid; drawAll(); if (cid && S.side === 'clip') drawSide(); },
    preview: draft => { S.project = draft; timeline.render(); player.refresh(); },
    commitFrom: (before, label) => { pushHistory(before, label); scheduleSave(); drawAll(); },
    sourceDuration: c => sourceDuration(c),
    split, removeSelected, addClip, uploadFiles, addTrack, removeTrack, updateTrack,
    flushSave, toggleChat, chatHidden: () => main.classList.contains('no-chat'),
    pause: () => { player.pause(); playIcon(); },
    capture: s => player.capture(s), onScreen: t => player.onScreen(t),
    notes: () => S.notes,
    focusNote: nid => focusNote(nid),
    noteAdded: n => { S.notes.push(n); S.noteSel.add(n.id); drawNotesUi(); },
    sendNotes: (ids, extra) => sendNotes(ids, extra),
    onToolChange: t => toolBtns.forEach((b, i) => b.classList.toggle('on', TOOLS[i][0] === t)),
    chatContext: () => {
      const c = S.project.clips.find(x => x.id === S.sel);
      return { playhead: +player.time.toFixed(2), selected: c ? `${c.id} (${c.name || c.src}, ${trackName(c.track)}, ${c.start.toFixed(2)}–${(c.start + c.out - c.in).toFixed(2)} s on the timeline)` : null };
    },
  };
  const trackName = tid => S.project.tracks.find(t => t.id === tid)?.name || tid;

  const player = createPlayer(screen, {
    projectId: id, getProject: () => S.project,
    onTime: () => { timecodeDraw(); timeline.movePlayhead(); annot.render(); },
    onEnd: () => playIcon(),
    previewUrl: async src => { try { return await api(`/api/projects/${pid}/preview-src?src=${encodeURIComponent(src)}`); } catch { return null; } },
  });
  const timeline = createTimeline(tlRoot, ed);
  const chat = createChat(chatEl, ed);
  const annot = createAnnotator(screen, ed);

  // ---------- edits, undo, save
  function pushHistory(before, label) {
    S.history.push({ project: before, label }); if (S.history.length > 200) S.history.shift();
    S.future = []; updateUndo();
  }
  function commit(label, fn) {
    const before = structuredClone(S.project);
    const draft = structuredClone(S.project);
    if (fn(draft) === false) return;
    S.project = draft; pushHistory(before, label); scheduleSave(); drawAll();
  }
  function undo() {
    const e = S.history.pop(); if (!e) return;
    S.future.push({ project: S.project, label: e.label }); S.project = e.project;
    scheduleSave(); drawAll(); updateUndo(); toast('Undid: ' + e.label);
  }
  function redo() {
    const e = S.future.pop(); if (!e) return;
    S.history.push({ project: S.project, label: e.label }); S.project = e.project;
    scheduleSave(); drawAll(); updateUndo(); toast('Redid: ' + e.label);
  }
  function updateUndo() {
    undoBtn.disabled = !S.history.length; redoBtn.disabled = !S.future.length;
    undoBtn.title = S.history.length ? `Undo ${S.history.at(-1).label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  }
  let saveTimer = null, savePromise = null;
  function scheduleSave() { S.dirty = true; saveState.textContent = 'Saving…'; clearTimeout(saveTimer); saveTimer = setTimeout(save, 450); }
  async function save() {
    clearTimeout(saveTimer);
    if (savePromise) { await savePromise; if (!S.dirty) return; }
    if (!S.dirty) return;
    S.dirty = false;
    savePromise = (async () => {
      try {
        const saved = await api(`/api/projects/${pid}`, { method: 'PUT', body: { project: S.project, baseVersion: S.version } });
        S.version = saved.version; S.project.rev = saved.rev; S.project.version = saved.version; saveState.textContent = 'Saved';
      } catch (e) {
        if (e.status === 409) {   // the agent saved meanwhile: take its version, keep ours in Undo
          const latest = await api(`/api/projects/${pid}`);
          pushHistory(S.project, 'Your last change'); S.project = latest; S.version = latest.version; drawAll();
          saveState.textContent = 'Saved'; toast('The agent changed the project at the same time. Its version is shown; Undo brings yours back.');
        } else { saveState.textContent = 'Not saved'; S.dirty = true; toast('Could not save: ' + e.message, 'error'); }
      }
    })();
    await savePromise; savePromise = null;
  }
  async function flushSave() { if (S.dirty || savePromise) await save(); }

  // changes made outside this window (the agent, another editor, a hand edit of project.json)
  function external(next) {
    if (next.version === S.version) return;
    if (S.dirty || savePromise) { return; }   // our own save is on its way; the 409 path handles a real clash
    const same = JSON.stringify(strip(next)) === JSON.stringify(strip(S.project));
    if (same) { S.version = next.version; S.project.version = next.version; S.project.rev = next.rev; return; }
    const before = S.project, oldClips = new Map(before.clips.map(c => [c.id, JSON.stringify(c)]));
    const changed = next.clips.filter(c => oldClips.get(c.id) !== JSON.stringify(c)).map(c => c.id);
    pushHistory(before, 'Agent change');
    S.project = next; S.version = next.version;
    S.flash = new Set(changed); setTimeout(() => { S.flash.clear(); }, 1700);
    if (titleIn !== document.activeElement) titleIn.value = next.name;
    drawAll(); timeline.fitIfNeeded(); loadMedia();
    const removed = before.clips.length - next.clips.filter(c => oldClips.has(c.id)).length;
    toast(`Updated: ${[changed.length && `${changed.length} clip${changed.length > 1 ? 's' : ''} changed`, removed > 0 && `${removed} removed`].filter(Boolean).join(', ') || 'project settings changed'}`, 'ok');
  }
  const strip = p => ({ ...p, rev: 0, updated: 0, version: 0 });

  // ---------- operations
  function sourceDuration(c) {
    if (c.type === 'image') return null;
    const m = S.media.find(x => x.src === c.src);
    return m?.duration || null;
  }
  function addClip(src, { track, time } = {}) {
    const m = S.media.find(x => x.src === src); if (!m) return;
    const kind = m.kind;
    commit('Add clip', p => {
      const tk = p.tracks.find(t => t.id === track && (t.kind === 'audio') === (kind === 'audio'))
        || (kind === 'audio' ? p.tracks.find(t => t.kind === 'audio') : [...p.tracks].reverse().find(t => t.kind === 'video'));
      if (!tk) return false;
      const len = m.duration || 5;
      const c = { id: uid(), track: tk.id, type: kind, src, start: Math.max(0, time ?? player.time), in: 0, out: len, volume: 1, muted: false, name: m.name };
      p.clips.push(c); S.sel = c.id;
    });
    timeline.fitIfNeeded();
  }
  function split() {
    const t = player.time, p = S.project;
    const covers = c => t > c.start + 0.05 && t < c.start + c.out - c.in - 0.05;
    let target = p.clips.find(c => c.id === S.sel && covers(c));
    if (!target) { const order = p.tracks.map(tr => tr.id); target = p.clips.filter(covers).sort((a, b) => order.indexOf(a.track) - order.indexOf(b.track))[0]; }
    if (!target) return toast('Move the playhead over a clip to split it');
    commit('Split clip', d => {
      const c = d.clips.find(x => x.id === target.id), cut = c.in + (t - c.start);
      const right = { ...c, id: uid(), start: t, in: c.type === 'image' ? 0 : cut, out: c.type === 'image' ? c.out - (t - c.start) : c.out };
      if (c.type === 'image') c.out = t - c.start; else c.out = cut;
      d.clips.push(right); S.sel = right.id;
    });
  }
  function removeSelected() {
    if (!S.sel) return toast('Click a clip first');
    commit('Delete clip', d => { d.clips = d.clips.filter(c => c.id !== S.sel); S.sel = null; });
  }
  function addTrack(kind) {
    commit(kind === 'video' ? 'Add video track' : 'Add audio track', d => {
      const n = d.tracks.filter(t => t.kind === kind).length + 1;
      let tid = (kind === 'video' ? 'v' : 'a') + n; while (d.tracks.some(t => t.id === tid)) tid += 'b';
      const tr = { id: tid, kind, name: `${kind === 'video' ? 'Video' : 'Audio'} ${n}` };
      if (kind === 'video') d.tracks.unshift(tr); else d.tracks.push(tr);
    });
  }
  function removeTrack(tid) { commit('Remove track', d => { d.tracks = d.tracks.filter(t => t.id !== tid); }); }
  function updateTrack(tid, patch) { commit('Track setting', d => { Object.assign(d.tracks.find(t => t.id === tid), patch); }); }
  function updateClip(cid, patch, label = 'Change clip') { commit(label, d => { Object.assign(d.clips.find(c => c.id === cid), patch); }); }

  async function uploadFiles(files, at) {
    const added = [];
    for (const f of files) {
      toast(`Adding ${f.name}…`);
      try { const r = await api(`/api/projects/${pid}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, raw: true }); added.push(r.src); }
      catch (e) { toast(`${f.name}: ${e.message}`, 'error'); }
    }
    await loadMedia();
    if (at) { let time = at.time; for (const src of added) { addClip(src, { track: at.track, time }); const m = S.media.find(x => x.src === src); time += m?.duration || 5; } }
    else if (added.length) toast(`${added.length} file${added.length > 1 ? 's' : ''} added: drag onto the timeline or press +`, 'ok');
  }
  async function pickFiles() {
    const r = await api(`/api/projects/${pid}/pick`, { method: 'POST', body: {} }).catch(e => (toast(e.message, 'error'), null));
    if (r?.fallback) return fileInput.click();
    if (r?.files?.length) { await loadMedia(); toast(`${r.files.length} file${r.files.length > 1 ? 's' : ''} added; drag them onto the timeline`, 'ok'); }
  }
  const fileInput = h('input', { type: 'file', multiple: true, accept: 'video/*,audio/*,image/*', style: { display: 'none' }, onchange: () => { uploadFiles([...fileInput.files]); fileInput.value = ''; } });
  root.append(fileInput);
  async function newScene() {
    const name = await askText('Name of the new motion-graphics scene', 'Title', 'Create');
    if (!name) return;
    const { src } = await api(`/api/projects/${pid}/scenes`, { method: 'POST', body: { name } });
    await loadMedia();
    const vt = S.project.tracks.find(t => t.kind === 'video');
    addClip(src, { track: vt?.id, time: player.time });
    chat.prefill(`Change the scene "${name}" (${src}) so that it `);
    if (main.classList.contains('no-chat')) toggleChat(true);
  }

  // ---------- side panel
  function setSide(which) { S.side = which; tabMedia.classList.toggle('on', which === 'media'); tabNotes.classList.toggle('on', which === 'notes'); tabClip.classList.toggle('on', which === 'clip'); drawSide(); }
  async function loadMedia() { try { S.media = await api(`/api/projects/${pid}/media`); } catch { } if (S.side === 'media') drawSide(); }
  function drawSide() { sideBody.replaceChildren(...(S.side === 'media' ? mediaPanel() : S.side === 'notes' ? notesPanel() : clipPanel())); }
  function mediaPanel() {
    const items = S.media.map(m => {
      const th = h('div', { class: 'th ' + (m.kind || '') }, icon(m.kind === 'audio' ? 'music' : m.kind === 'scene' ? 'code' : m.kind === 'image' ? 'image' : 'film'));
      if ((m.kind === 'video' || m.kind === 'image') && !m.missing) { const im = new Image(); im.onload = () => { th.style.backgroundImage = `url("${im.src}")`; th.replaceChildren(); }; im.src = `/api/projects/${pid}/thumb?src=${encodeURIComponent(m.src)}`; }
      const el = h('div', { class: 'bin-item' + (m.missing ? ' missing' : ''), title: m.src },
        th, h('div', { class: 'grow' }, h('div', { class: 'nm' }, m.name), h('div', { class: 'sub' }, m.missing ? 'File missing' : [m.kind === 'scene' ? 'Code scene' : m.kind, m.duration ? fmtTime(m.duration) : '', m.width ? `${m.width}×${m.height}` : ''].filter(Boolean).join(' · '))),
        m.missing ? null : h('button', { class: 'icon-btn add', title: 'Add at the playhead', onclick: e => { e.stopPropagation(); addClip(m.src); } }, icon('plus')));
      if (!m.missing) el.addEventListener('pointerdown', e => binDrag(e, m, th));
      el.addEventListener('dblclick', () => addClip(m.src));
      return el;
    });
    const drop = h('div', { class: 'dropzone', style: { marginTop: '10px', fontSize: '12.5px' } }, 'Drop files here to add them');
    drop.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); drop.classList.add('over'); } });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });
    return [
      h('div', { class: 'bin-actions' },
        h('button', { class: 'btn', onclick: pickFiles, title: 'Videos, sounds and pictures from this computer' }, icon('folder'), 'Add files'),
        h('button', { class: 'btn', onclick: newScene, title: 'Motion graphics written as code; your AI agent can change it' }, icon('code'), 'New scene')),
      ...(items.length ? items : [h('p', { class: 'hint' }, 'No media yet. Add videos, sounds or pictures, or create a code scene.')]),
      drop,
      h('p', { class: 'hint' }, 'Drag items onto the timeline, or press + to place them at the playhead.'),
    ];
  }
  // drag from the media list with the pointer (works everywhere, unlike browser drag and drop)
  function binDrag(e, m, th) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const x0 = e.clientX, y0 = e.clientY; let ghost = null;
    const move = ev => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!ghost) { ghost = h('div', { class: 'drag-ghost' }, th.cloneNode(true), m.name); ghost.firstChild.style.cssText += ';width:42px;height:24px'; document.body.append(ghost); document.body.style.cursor = 'grabbing'; }
      ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
      const onTrack = timeline.hover(ev.clientX, ev.clientY, m.kind);
      const r = screen.getBoundingClientRect(), onScreen = !onTrack && ev.clientX > r.left && ev.clientX < r.right && ev.clientY > r.top && ev.clientY < r.bottom;
      screen.classList.toggle('drop-over', onScreen);
    };
    const up = ev => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.style.cursor = ''; screen.classList.remove('drop-over');
      if (!ghost) return;
      ghost.remove();
      const at = timeline.dropAt(ev.clientX, ev.clientY, m.kind);
      if (at) return addClip(m.src, at);
      const r = screen.getBoundingClientRect();
      if (ev.clientX > r.left && ev.clientX < r.right && ev.clientY > r.top && ev.clientY < r.bottom) addClip(m.src, { time: player.time });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  // ---------- notes (marks on frames)
  async function loadNotes() { try { S.notes = await api(`/api/projects/${pid}/notes`); } catch { } drawNotesUi(); }
  function drawNotesUi() {
    const open = S.notes.filter(n => n.status === 'open' || n.status === 'reopened').length;
    noteCount.hidden = !open; noteCount.textContent = open;
    timeline.drawMarks(); annot.render();
    if (S.side === 'notes') drawSide();
  }
  function focusNote(nid) {
    const n = S.notes.find(x => x.id === nid); if (!n) return;
    S.focusNote = nid; player.pause(); seek(n.time); annot.focus(nid);
    if (S.side !== 'notes') setSide('notes'); else drawSide();
  }
  async function sendNotes(ids, extra) {
    if (!ids.length) return toast('Select notes first');
    await chat.sendNotes(ids, extra);
    await loadNotes();
  }
  async function sendToWaiting(ids) {
    try { await api(`/api/projects/${pid}/notes/send`, { method: 'POST', body: { ids, target: 'agent' } }); toast('Sent to the waiting agent chat', 'ok'); loadNotes(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function setNote(nid, patch) { try { await api(`/api/projects/${pid}/notes/${encodeURIComponent(nid)}`, { method: 'PATCH', body: patch }); loadNotes(); } catch (e) { toast(e.message, 'error'); } }
  function notesPanel() {
    if (!S.notes.length) return [h('div', { class: 'hint', style: { fontSize: '13px' } },
      h('p', {}, 'No notes yet.'), h('p', {}, 'Pause on the frame, pick ', icon('pin'), ' ', icon('circle'), ' ', icon('rect'), ' or ', icon('pen'), ' under the preview, mark the spot and write what should change.'),
      h('p', {}, 'Each note keeps the exact time, frame and position, with a picture, so the agent fixes the right thing.'))];
    const actionable = n => n.status === 'open' || n.status === 'reopened';
    for (const id of [...S.noteSel]) if (!S.notes.some(n => n.id === id && actionable(n))) S.noteSel.delete(id);
    if (!S.noteSel.size) S.notes.filter(actionable).forEach(n => S.noteSel.add(n.id));
    const items = [...S.notes].sort((a, b) => a.time - b.time).map(n => {
      const cb = h('input', { type: 'checkbox', checked: S.noteSel.has(n.id), onclick: e => e.stopPropagation(), onchange: () => { cb.checked ? S.noteSel.add(n.id) : S.noteSel.delete(n.id); drawSide(); } });
      const thumb = h('div', { class: 'th', style: n.close || n.image ? { backgroundImage: `url("/api/projects/${pid}/file?path=${encodeURIComponent(n.close || n.image)}")` } : {} });
      const menu = h('button', { class: 'icon-btn', style: { width: '26px', height: '26px' }, title: 'More', onclick: e => { e.stopPropagation(); popMenu(e.currentTarget, [
        n.status !== 'fixed' ? { label: 'Mark fixed', icon: 'check', run: () => setNote(n.id, { status: 'fixed' }) } : { label: 'Still there (reopen)', icon: 'undo', run: () => setNote(n.id, { status: 'reopened' }) },
        { label: 'Edit comment', icon: 'pen', run: async () => { const t = await askText('Comment', n.text, 'Save'); if (t != null) setNote(n.id, { text: t }); } },
        S.waiting ? { label: 'Send to the waiting agent chat', icon: 'external', run: () => sendToWaiting([n.id]) } : null,
        { label: 'Delete note', icon: 'trash', danger: true, run: async () => { await api(`/api/projects/${pid}/notes/${encodeURIComponent(n.id)}`, { method: 'DELETE' }); S.noteSel.delete(n.id); loadNotes(); } },
      ]); } }, icon('more'));
      return h('div', { class: 'note-item' + (S.focusNote === n.id ? ' cur' : ''), onclick: () => focusNote(n.id) },
        actionable(n) ? cb : h('span', { style: { width: '13px' } }), thumb,
        h('div', { class: 'grow' }, h('div', { class: 'tx' }, h('span', { class: 'num' }, `#${n.n} `), n.text || h('i', { class: 'faint' }, 'mark only')),
          h('div', { class: 'mt' }, fmtTime(n.time), `· f${n.frame}`, h('span', { class: 'st ' + n.status }, { open: 'open', sent: 'sent', fixed: 'fixed', reopened: 'still there' }[n.status] || n.status)),
          n.reply ? h('div', { class: 'reply' }, n.reply) : null),
        menu);
    });
    const sel = [...S.noteSel];
    return [...items, h('div', { class: 'notes-foot' },
      h('button', { class: 'btn accent', disabled: !sel.length || chat.running, style: { justifyContent: 'center' }, onclick: () => sendNotes(sel) }, icon('send'), sel.length ? `Fix ${sel.length} note${sel.length > 1 ? 's' : ''} with AI` : 'Select notes to fix'),
      S.waiting ? h('button', { class: 'btn', disabled: !sel.length, style: { justifyContent: 'center' }, onclick: () => sendToWaiting(sel) }, icon('external'), 'Send to the waiting agent chat') : null,
      h('div', { class: 'hint', style: { margin: '2px 0 0' } }, 'Fixed notes stay here; reopen one if it is still wrong.'))];
  }

  function clipPanel() {
    const c = S.project.clips.find(x => x.id === S.sel);
    if (!c) return [h('p', { class: 'hint' }, 'Click a clip on the timeline to change it here.')];
    const dur = c.out - c.in;
    const num = (label, val, onset, step = 0.1) => h('label', { class: 'field' }, h('span', {}, label),
      h('input', { type: 'number', step, value: +val.toFixed(2), onchange: e => onset(+e.target.value) }));
    const vol = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: c.volume ?? 1 });
    const volLabel = h('span', {}, `Volume ${Math.round((c.volume ?? 1) * 100)}%`);
    vol.oninput = () => { volLabel.textContent = `Volume ${Math.round(vol.value * 100)}%`; };
    vol.onchange = () => updateClip(c.id, { volume: +vol.value }, 'Volume');
    const hasSound = c.type === 'audio' || (c.type === 'video' && S.media.find(m => m.src === c.src)?.hasAudio !== false);
    return [h('div', { class: 'insp' },
      h('h3', {}, c.type === 'scene' ? 'Code scene' : c.type[0].toUpperCase() + c.type.slice(1)),
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', value: c.name || c.src.split('/').pop(), onchange: e => updateClip(c.id, { name: e.target.value }, 'Rename clip') })),
      h('div', { class: 'grid2' },
        num('Starts at (s)', c.start, v => updateClip(c.id, { start: Math.max(0, v) }, 'Move clip')),
        num('Length (s)', dur, v => updateClip(c.id, { out: c.in + clamp(v, 0.1, (sourceDuration(c) || 1e9) - c.in) }, 'Trim clip'))),
      c.type !== 'image' ? h('div', { class: 'grid2' }, num('Source from (s)', c.in, v => updateClip(c.id, { in: clamp(v, 0, c.out - 0.1) }, 'Trim clip')), h('span')) : null,
      hasSound && c.type !== 'scene' ? [h('label', { class: 'field' }, volLabel, vol),
        h('button', { class: 'btn sm', style: { width: '100%', justifyContent: 'center' }, onclick: () => updateClip(c.id, { muted: !c.muted }, c.muted ? 'Unmute clip' : 'Mute clip') }, icon(c.muted ? 'volume' : 'mute'), c.muted ? 'Turn sound on' : 'Remove sound')] : null,
      c.type === 'scene' ? h('button', { class: 'btn sm', style: { width: '100%', justifyContent: 'center', marginTop: '8px' }, onclick: () => { if (main.classList.contains('no-chat')) toggleChat(true); chat.prefill(`In the scene ${c.src}, `); } }, icon('spark'), 'Change it with AI') : null,
      h('div', { class: 'row gap', style: { marginTop: '14px' } },
        h('button', { class: 'btn sm grow', style: { justifyContent: 'center' }, onclick: () => { seek(c.start + 0.001); split(); } }, icon('scissors'), 'Split here'),
        h('button', { class: 'btn sm grow', style: { justifyContent: 'center', color: 'var(--bad)' }, onclick: removeSelected }, icon('trash'), 'Delete')),
      h('p', { class: 'hint' }, c.src))];
  }

  // ---------- drawing
  function drawAll() { timeline.render(); player.refresh(); timecodeDraw(); if (S.side === 'clip') drawSide(); chat.updateCtx(); annot.render(); }
  function timecodeDraw() { timecode.replaceChildren(h('b', {}, fmtTime(player.time)), ' / ', fmtTime(player.duration())); playIcon(); }
  function playIcon() { playBtn.replaceChildren(icon(player.playing ? 'pause' : 'play')); }
  function seek(t) { player.seek(t); annot.render(); }
  function fitScreen() {
    const r = viewport.getBoundingClientRect(), pad = 28;
    const k = Math.min((r.width - pad) / S.project.width, (r.height - pad) / S.project.height);
    screen.style.width = Math.max(10, S.project.width * k) + 'px'; screen.style.height = Math.max(10, S.project.height * k) + 'px';
    player.resize();
  }
  const ro = new ResizeObserver(fitScreen); ro.observe(viewport);
  function toggleChat(force) {
    const show = force ?? main.classList.contains('no-chat');
    main.classList.toggle('no-chat', !show); chatBtn.classList.toggle('on', show);
    localStorage.setItem('cm-chat', show ? '1' : '0');
    if (show) chat.focus();
    requestAnimationFrame(() => { fitScreen(); annot.render(); });
  }

  // timeline height
  resizer.addEventListener('pointerdown', e => {
    resizer.setPointerCapture(e.pointerId);
    const mv = ev => { const hgt = clamp(innerHeight - ev.clientY, 160, innerHeight - 240); editor.style.setProperty('--tl-h', hgt + 'px'); localStorage.setItem('cm-tl-h', hgt); };
    resizer.addEventListener('pointermove', mv);
    resizer.addEventListener('pointerup', () => resizer.removeEventListener('pointermove', mv), { once: true });
  });

  // drop files straight onto the preview
  screen.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files') || S.dragKind) { e.preventDefault(); screen.classList.add('drop-over'); } });
  screen.addEventListener('dragleave', () => screen.classList.remove('drop-over'));
  screen.addEventListener('drop', e => {
    e.preventDefault(); screen.classList.remove('drop-over');
    if (e.dataTransfer.files.length) return uploadFiles([...e.dataTransfer.files], { time: player.duration() });
    const src = e.dataTransfer.getData('text/cm-src'); if (src) addClip(src, { time: player.time });
  });

  titleIn.addEventListener('change', () => { const name = titleIn.value.trim(); if (name) commit('Rename project', d => { d.name = name; }); });
  titleIn.addEventListener('keydown', e => { if (e.key === 'Enter') titleIn.blur(); e.stopPropagation(); });

  // ---------- keyboard
  const onKey = e => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('.modal-back')) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const frame = 1 / S.project.fps;
    if (e.target.closest('.note-pop')) return;
    if (k === ' ') { e.preventDefault(); if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur(); player.toggle(); playIcon(); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 's') { e.preventDefault(); flushSave(); }
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); removeSelected(); }
    else if (k === 's' && !mod) split();
    else if (k === 'm' && S.sel) { const c = S.project.clips.find(x => x.id === S.sel); if (c) updateClip(c.id, { muted: !c.muted }, c.muted ? 'Unmute clip' : 'Mute clip'); }
    else if (k === 'arrowleft') { e.preventDefault(); seek(player.time - (e.shiftKey ? 1 : frame)); }
    else if (k === 'arrowright') { e.preventDefault(); seek(player.time + (e.shiftKey ? 1 : frame)); }
    else if (k === 'home') seek(0);
    else if (k === 'end') seek(player.duration());
    else if (k === 'escape') { if (!annot.cancel()) ed.select(null); }
    else if (!mod && { p: 'point', c: 'circle', r: 'rect', d: 'draw' }[k]) annot.setTool({ p: 'point', c: 'circle', r: 'rect', d: 'draw' }[k]);
    else if (!mod && k === 'n') setSide('notes');
  };
  document.addEventListener('keydown', onKey);

  // ---------- live updates
  const es = new EventSource(`/api/events?project=${pid}`);
  es.addEventListener('project', ev => external(JSON.parse(ev.data).project));
  es.addEventListener('notes', ev => { const before = new Map(S.notes.map(n => [n.id, n.status])); S.notes = JSON.parse(ev.data).notes; const fixed = S.notes.filter(n => n.status === 'fixed' && before.get(n.id) && before.get(n.id) !== 'fixed'); if (fixed.length) toast(`Fixed: ${fixed.map(n => '#' + n.n).join(', ')}`, 'ok'); drawNotesUi(); chat.redraw(); });
  es.addEventListener('waiting', ev => { S.waiting = JSON.parse(ev.data).count; waitPill.classList.toggle('on', S.waiting > 0); if (S.side === 'notes') drawSide(); });
  es.addEventListener('show', ev => { const d = JSON.parse(ev.data); if (d.id !== id) location.hash = '#/edit/' + encodeURIComponent(d.id) + (d.time != null ? '?t=' + d.time : ''); else if (d.time != null) seek(d.time); toast('Your agent opened this project', 'ok'); });
  es.addEventListener('media', ev => { const d = JSON.parse(ev.data); loadMedia().then(() => { if (d.proxyReady) player.refreshMedia(); }); });
  es.addEventListener('scene', ev => { const d = JSON.parse(ev.data); player.reloadScene(d.src); });
  es.addEventListener('chat', ev => chat.onEvent(JSON.parse(ev.data)));
  es.addEventListener('job', ev => onJob(JSON.parse(ev.data)));

  // ---------- export
  let jobView = null;
  function onJob(j) {
    if (j.project !== id) return;
    jobView?.(j);
    exportBtn.disabled = j.status === 'running' || j.status === 'queued';
    exportBtn.replaceChildren(icon('export'), j.status === 'running' ? `Exporting ${Math.round(j.progress * 100)}%` : 'Export');
    if (j.status === 'done') toast('Export finished: ' + j.file.split('/').pop(), 'ok');
    if (j.status === 'failed') toast('Export failed: ' + j.error, 'error');
  }
  async function openExport() {
    await flushSave();
    const total = player.duration();
    const list = h('div');
    const jobBox = h('div');
    let exportNow = null;
    const drawList = async () => {
      const ex = await api(`/api/projects/${pid}/exports`).catch(() => []);
      list.replaceChildren(...(ex.length ? [h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '14px 0 4px' } }, 'Earlier exports'), ...ex.map(x => h('div', { class: 'exp-row' }, icon('film'), h('span', { class: 'grow' }, x.file.split('/').pop()), h('span', { class: 'faint' }, fmtBytes(x.size)),
        h('button', { class: 'btn sm', onclick: () => api(`/api/projects/${pid}/open-export`, { method: 'POST', body: { file: x.file } }) }, 'Play'),
        h('button', { class: 'btn sm ghost', onclick: () => api(`/api/projects/${pid}/open-export`, { method: 'POST', body: { file: x.file, reveal: true } }) }, icon('folder'))))] : []));
    };
    const m = modal(close => {
      jobView = j => {
        if (exportNow) exportNow.disabled = j.status === 'running' || j.status === 'queued';
        if (j.status === 'running' || j.status === 'queued') jobBox.replaceChildren(h('div', { class: 'job' }, icon('spin', 'spin'), h('div', { class: 'grow' }, h('div', { style: { marginBottom: '6px' } }, j.message), h('div', { class: 'bar' }, h('i', { style: { width: Math.round(j.progress * 100) + '%' } }))),
          h('button', { class: 'btn sm', onclick: () => api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }) }, 'Stop')));
        else if (j.status === 'done') { jobBox.replaceChildren(h('div', { class: 'job', style: { borderColor: 'rgba(60,207,145,.4)' } }, icon('check'), h('span', { class: 'grow' }, 'Saved ', h('b', {}, j.file.split('/').pop())), h('button', { class: 'btn sm primary', onclick: () => api(`/api/projects/${pid}/open-export`, { method: 'POST', body: { file: j.file } }) }, 'Play'), h('button', { class: 'btn sm', onclick: () => api(`/api/projects/${pid}/open-export`, { method: 'POST', body: { file: j.file, reveal: true } }) }, 'Show in folder'))); drawList(); }
        else if (j.status === 'failed') jobBox.replaceChildren(h('div', { class: 'job', style: { borderColor: 'rgba(255,93,108,.45)' } }, h('span', { class: 'grow err', style: { color: 'var(--bad)' } }, j.error || 'Export failed')));
        else jobBox.replaceChildren();
      };
      return h('div', {},
        h('h2', {}, 'Export video'),
        h('p', { class: 'muted' }, `MP4 (H.264 + AAC), ${S.project.width}×${S.project.height}, ${S.project.fps} fps, ${fmtTime(total)} long. Saved in the project's exports folder. Runs at low priority so the computer stays usable.`),
        jobBox,
        h('div', { class: 'row end gap', style: { marginTop: '14px' } }, h('button', { class: 'btn ghost', onclick: close }, 'Close'),
          exportNow = h('button', { class: 'btn primary', disabled: !total || exportBtn.disabled, onclick: async () => { try { await flushSave(); onJob(await api(`/api/projects/${pid}/export`, { method: 'POST' })); } catch (e) { toast(e.message, 'error'); } } }, icon('export'), 'Export now')),
        list);
    }, { wide: true, onClose: () => { jobView = null; } });
    const jobs = await api('/api/jobs'); const mine = jobs.filter(j => j.project === id).pop();
    if (mine && (mine.status === 'running' || mine.status === 'queued')) jobView?.(mine);
    drawList();
    return m;
  }

  // ---------- project menu
  function projectMenu(anchor) {
    popMenu(anchor, [
      { label: 'Open the chat in your coding agent', icon: 'external', run: () => openAgentChat(id) },
      { label: 'Show in file manager', icon: 'folder', run: () => api(`/api/projects/${pid}/reveal`, { method: 'POST' }) },
      'sep',
      { label: 'Versions and exports', icon: 'versions', run: () => openExport() },
      { label: 'Project settings (size, frame rate)', icon: 'frame', run: () => projectSettings() },
    ]);
  }
  function projectSettings() {
    const p = S.project;
    let size = `${p.width}x${p.height}`, fps = p.fps;
    const body = h('div');
    const draw = () => body.replaceChildren(
      h('h2', {}, 'Project settings'),
      h('label', { class: 'field' }, h('span', {}, 'Frame size'), h('div', { class: 'seg' }, [['1920x1080', '1920×1080 (16:9)'], ['1080x1920', '1080×1920 (9:16)'], ['1080x1080', '1080×1080 (1:1)'], ['3840x2160', '4K']].map(([k, l]) => h('button', { class: size === k ? 'on' : '', onclick: () => { size = k; draw(); } }, l)))),
      h('label', { class: 'field' }, h('span', {}, 'Frame rate'), h('div', { class: 'seg' }, [24, 25, 30, 50, 60].map(f => h('button', { class: fps === f ? 'on' : '', onclick: () => { fps = f; draw(); } }, `${f} fps`)))),
      h('p', { class: 'hint' }, 'Code scenes draw at this size; ask the agent to adapt a scene after changing it.'),
      h('div', { class: 'row end gap' }, h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { const [w, hh] = size.split('x').map(Number); commit('Project settings', d => { d.width = w; d.height = hh; d.fps = fps; }); m.close(); fitScreen(); } }, 'Save')));
    const m = modal(body); draw();
  }

  // a picture of the film for its card on the home page
  let coverDone = false;
  function saveCover() {
    if (coverDone || !S.project.clips.length) return;
    try {
      const c = player.capture(0.25), g = c.getContext('2d'), px = g.getImageData(0, 0, c.width, c.height).data;
      let lit = 0; for (let i = 0; i < px.length; i += 400) lit += px[i] + px[i + 1] + px[i + 2];
      if (lit < 400) return;   // a black frame says nothing
      coverDone = true;
      api(`/api/projects/${pid}/cover`, { method: 'POST', body: { image: c.toDataURL('image/jpeg', 0.8) } }).catch(() => { });
    } catch { }
  }

  // ---------- start
  updateUndo();
  await Promise.all([loadMedia(), loadNotes()]);
  api(`/api/projects/${pid}/waiting`).then(r => { S.waiting = r.count; waitPill.classList.toggle('on', S.waiting > 0); }).catch(() => { });
  drawSide();
  requestAnimationFrame(() => { fitScreen(); timeline.fit(); drawAll(); if (startTime != null) seek(startTime); });
  setTimeout(saveCover, 2500);
  const jobs = await api('/api/jobs').catch(() => []); const running = jobs.filter(j => j.project === id && j.status === 'running').pop(); if (running) onJob(running);
  const beforeUnload = e => { if (S.dirty) { save(); e.preventDefault(); } };
  window.addEventListener('beforeunload', beforeUnload);

  return () => {
    flushSave(); saveCover();
    es.close(); player.destroy(); timeline.destroy(); annot.destroy(); ro.disconnect();
    document.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', beforeUnload);
    document.querySelector('.popmenu')?.remove();
  };
}
