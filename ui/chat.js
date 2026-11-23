// The side chat with the coding agent. Messages stream in over the editor's event connection.
import { api, h, icon, toast } from './lib.js';

export function createChat(root, ed) {
  const log = h('div', { class: 'chat-log' });
  const input = h('textarea', { rows: 1, placeholder: 'Mark a spot on the frame, or describe a change…' });
  const sendBtn = h('button', { class: 'icon-btn send', title: 'Send (Enter)' }, icon('send'));
  const ctx = h('div', { class: 'chat-ctx' });
  const agentSel = h('select', { title: 'Which coding agent answers' });
  const modelSel = h('select', { title: 'Model' });
  const head = h('div', { class: 'chat-head' }, icon('chat'), h('b', { class: 'grow' }, 'Fix with AI'), agentSel, modelSel,
    h('button', { class: 'icon-btn', title: 'Start a new conversation', onclick: async () => { await api(`/api/projects/${encodeURIComponent(ed.id)}/chat`, { method: 'DELETE' }); state.messages = []; state.running = false; draw(); } }, icon('plus')),
    h('button', { class: 'icon-btn', title: 'Hide the chat', onclick: () => ed.toggleChat(false) }, icon('close')));
  const notice = h('div', { class: 'chat-notice', hidden: true });
  root.append(head, log, h('div', { class: 'chat-input' }, notice, h('div', { class: 'chat-box' }, input, sendBtn), ctx));

  const state = { messages: [], running: false, agents: [] };
  const current = () => state.agents.find(a => a.id === agentSel.value) || state.agents[0];

  // one-time sign-in for agents that are installed but not signed in on the command line
  let signinTimer = null;
  async function signIn(agentId) {
    try { await api(`/api/agents/${agentId}/signin`, { method: 'POST' }); }
    catch (e) { return toast(e.message, 'error'); }
    toast('A terminal opened: sign in there (your browser opens), then come back here.');
    clearInterval(signinTimer);
    let tries = 0;
    signinTimer = setInterval(async () => {
      if (++tries > 45) return clearInterval(signinTimer);
      const agents = await api('/api/agents?recheck=1').catch(() => null);
      const a = agents?.find(x => x.id === agentId);
      if (a?.signedIn) { clearInterval(signinTimer); state.agents = agents; toast(`${a.name} is signed in`, 'ok'); draw(); }
    }, 4000);
  }
  function drawNotice() {
    const a = current();
    notice.hidden = !(a && a.signedIn === false);
    if (!notice.hidden) notice.replaceChildren(h('span', { class: 'grow' }, `${a.name} needs a one-time sign-in to work from Code Motion.`), h('button', { class: 'btn sm primary', onclick: () => signIn(a.id) }, 'Sign in'));
  }

  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } e.stopPropagation(); });
  sendBtn.onclick = () => state.running ? stop() : send();

  async function load() {
    const [chat, agents] = await Promise.all([api(`/api/projects/${encodeURIComponent(ed.id)}/chat`), api('/api/agents')]);
    state.messages = chat.messages; state.running = chat.running; state.agents = agents;
    const pref = localStorage.getItem('cm-agent');
    agentSel.replaceChildren(...agents.map(a => h('option', { value: a.id, selected: a.id === pref }, a.name)));
    if (!agents.length) agentSel.replaceChildren(h('option', {}, 'none found'));
    if (!pref || !agents.some(a => a.id === pref)) { const ok = agents.find(a => a.signedIn !== false); if (ok) agentSel.value = ok.id; }
    agentSel.onchange = () => { localStorage.setItem('cm-agent', agentSel.value); loadModels(); draw(); };
    loadModels();
    draw();
  }
  async function loadModels() {
    const a = current(); if (!a) { modelSel.hidden = true; return; }
    const list = await api(`/api/agents/${a.id}/models`).catch(() => []);
    const pref = localStorage.getItem('cm-model:' + a.id) || 'default';
    modelSel.replaceChildren(...list.map(m => h('option', { value: m.id, selected: m.id === pref }, m.name.replace(/^opencode\//, ''))));
    modelSel.hidden = list.length < 2;
    modelSel.onchange = () => localStorage.setItem('cm-model:' + a.id, modelSel.value);
  }
  const model = () => modelSel.hidden ? undefined : modelSel.value;
  // notes marked on frames → one chat turn with exact time, frame, place and pictures
  async function sendNotes(ids, extra) {
    if (state.running) return toast('The agent is still working; send the notes when it is done.');
    if (!state.agents.length) return toast('No coding agent found. Install Claude Code, Codex or OpenCode.', 'error');
    if (current()?.signedIn === false) { drawNotice(); return toast(`Sign in to ${current().name} first (button above the message box).`); }
    if (ed.chatHidden()) ed.toggleChat(true);
    try { await ed.flushSave(); await api(`/api/projects/${encodeURIComponent(ed.id)}/notes/send`, { method: 'POST', body: { ids, target: 'chat', agent: agentSel.value, model: model(), extra } }); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function send(textArg) {
    const text = (textArg ?? input.value).trim();
    if (!text || state.running) return;
    if (!state.agents.length) return toast('No coding agent found. Install Claude Code, Codex or OpenCode.', 'error');
    if (current()?.signedIn === false) { drawNotice(); input.value = text; return toast(`Sign in to ${current().name} first (button above the message box).`); }
    input.value = ''; input.style.height = 'auto';
    try {
      await ed.flushSave();
      await api(`/api/projects/${encodeURIComponent(ed.id)}/chat`, { method: 'POST', body: { text, context: ed.chatContext(), agent: agentSel.value, model: model() } });
    } catch (e) { toast(e.message, 'error'); input.value = text; }
  }
  async function stop() { await api(`/api/projects/${encodeURIComponent(ed.id)}/chat/stop`, { method: 'POST' }).catch(() => { }); }

  // events from the server
  function onEvent(ev) {
    if (ev.type === 'start') { state.messages = ev.messages; state.running = true; }
    else if (ev.type === 'update' || ev.type === 'done') {
      const i = state.messages.length - 1;
      if (i >= 0 && state.messages[i].role === 'agent') state.messages[i] = ev.message; else state.messages.push(ev.message);
      state.running = ev.running;
    }
    draw();
  }

  function draw() {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    if (!state.messages.length) {
      log.replaceChildren(h('div', { class: 'chat-empty' },
        h('div', { style: { fontSize: '15px', color: 'var(--text)', marginBottom: '4px' } }, !state.agents.length ? 'No coding agent found' : current()?.signedIn === false ? `${current().name} found` : `${current()?.name} is connected`),
        h('div', {}, state.agents.length ? 'This chat fixes what you mark. Make or change whole videos in your agent\'s own chat.' : 'Install Claude Code, Codex or OpenCode; Code Motion finds it by itself.'),
        state.agents.length ? h('div', { class: 'how' },
          h('div', {}, icon('pin'), h('span', {}, 'Pause where something is wrong and pick a tool under the preview: point, circle, box or draw.')),
          h('div', {}, icon('pen'), h('span', {}, 'Write what should change. The note keeps the exact frame, time and position.')),
          h('div', {}, icon('send'), h('span', {}, 'Press Add & fix. The agent gets a marked picture of the frame and edits the code; the preview updates by itself.'))) : null));
    } else {
      log.replaceChildren(...state.messages.map(m => m.role === 'user' ? userMsg(m) : agentMsg(m)));
    }
    sendBtn.replaceChildren(icon(state.running ? 'stop' : 'send'));
    sendBtn.title = state.running ? 'Stop the agent' : 'Send (Enter)';
    if (atBottom || state.running) log.scrollTop = log.scrollHeight;
    drawNotice(); updateCtx();
  }
  function userMsg(m) {
    const notes = (m.notes || []).map(id => ed.notes().find(n => n.id === id)).filter(Boolean);
    return h('div', { class: 'msg-u' }, m.text, notes.length ? h('div', { class: 'nthumbs' }, notes.map(n => n.close || n.image ? h('img', { src: `/api/projects/${encodeURIComponent(ed.id)}/file?path=${encodeURIComponent(n.close || n.image)}`, title: `#${n.n} ${n.text}`, onclick: () => ed.focusNote(n.id), style: { cursor: 'pointer' } }) : null)) : null);
  }
  function agentMsg(m) {
    const name = state.agents.find(a => a.id === m.agent)?.name || { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }[m.agent] || 'Agent';
    // consecutive tool steps fold into one line: "Edited project.json · 12 steps"
    const groups = [];
    for (const p of m.parts || []) { if (p.kind === 'tool' && groups.at(-1)?.kind === 'tools') groups.at(-1).items.push(p.text); else groups.push(p.kind === 'tool' ? { kind: 'tools', items: [p.text] } : p); }
    const parts = groups.map(p => p.kind === 'tools' ? toolGroup(p.items)
      : p.kind === 'error' ? h('div', { class: 'err' }, p.text)
      : p.kind === 'signin' ? h('div', { class: 'chat-notice' }, h('span', { class: 'grow' }, p.text), h('button', { class: 'btn sm primary', onclick: () => signIn(m.agent) }, 'Sign in'))
      : h('div', { class: 'txt' }, richText(p.text)));
    const working = m.status === 'working';
    return h('div', { class: 'msg-a' }, h('div', { class: 'who' }, name, m.model && m.model !== 'default' ? ` · ${String(m.model).replace(/^opencode\//, '')}` : '', m.status === 'stopped' ? ' · stopped' : '', m.cost ? h('span', { class: 'faint' }, ` · $${m.cost.toFixed(3)}`) : null),
      parts, working ? h('div', { class: 'typing' }, h('i'), h('i'), h('i')) : null);
  }
  function toolGroup(items) {
    const edits = [...new Set(items.filter(t => /^(Edited|Wrote) /.test(t)).map(t => t.replace(/^(Edited|Wrote) /, '')))];
    const label = (edits.length ? `Edited ${edits.slice(0, 3).join(', ')}${edits.length > 3 ? ` +${edits.length - 3}` : ''}` : items.at(-1)) + (items.length > 1 ? ` · ${items.length} steps` : '');
    if (items.length === 1) return h('div', { class: 'tool', title: items[0] }, icon(edits.length ? 'code' : 'spark'), label);
    return h('details', { class: 'tools' }, h('summary', { class: 'tool' }, icon(edits.length ? 'code' : 'spark'), label), h('div', { class: 'tool-list' }, items.map(t => h('div', {}, t))));
  }
  // `code` and **bold** only; everything else stays plain text (no HTML from the agent)
  function richText(s) {
    const out = []; const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g; let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      out.push(m[0][0] === '`' ? h('code', {}, m[0].slice(1, -1)) : h('b', {}, m[0].slice(2, -2)));
      last = m.index + m[0].length;
    }
    out.push(s.slice(last)); return out;
  }
  function updateCtx() {
    const c = ed.chatContext();
    ctx.textContent = state.running ? 'The agent is working… changes appear live.' : `The agent will know: playhead ${(+c.playhead).toFixed(1)} s${c.selected ? ', selected ' + c.selected.split(' (')[0] : ''}`;
  }

  load();
  return { onEvent, updateCtx, sendNotes, redraw: draw, get running() { return state.running; }, focus: () => input.focus(), prefill: t => { input.value = t; input.focus(); } };
}
