// The side chat: finds the coding agents installed on this computer and runs them inside the project folder.
// No MCP registration and no setup: the agent reads the project's CLAUDE.md / AGENTS.md, edits project.json and
// scenes/, and the editor shows each change as the file watcher sees it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IS_WIN, getConfig, readJson, which, writeJson } from './env.js';
import { projectDir, writeAgentGuide } from './projects.js';

const HOME = os.homedir();
const exists = f => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
const newest = dirs => dirs.filter(exists).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;

// Claude Code may be on PATH, in its own installer folders, or bundled inside the Claude desktop app.
function bundledClaude() {
  const roots = [path.join(HOME, '.config/Claude/claude-code'), path.join(HOME, 'Library/Application Support/Claude/claude-code'),
    path.join(process.env.APPDATA || '', 'Claude/claude-code')];
  const found = [];
  for (const r of roots) {
    let vers = []; try { vers = fs.readdirSync(r); } catch { continue; }
    for (const v of vers) {
      let subs = []; try { subs = fs.readdirSync(path.join(r, v)); } catch { continue; }
      for (const s of subs) found.push(path.join(r, v, s, IS_WIN ? 'claude.exe' : 'claude'));
    }
  }
  return newest(found);
}
const FINDERS = {
  claude: () => (/claude(\.exe)?$/.test(process.env.CLAUDE_CODE_EXECPATH || '') && exists(process.env.CLAUDE_CODE_EXECPATH) ? process.env.CLAUDE_CODE_EXECPATH : null) || which('claude') || newest([path.join(HOME, '.local/bin/claude'), path.join(HOME, '.claude/local/claude'), path.join(HOME, '.npm-global/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']) || bundledClaude(),
  codex: () => which('codex') || newest([path.join(HOME, '.local/bin/codex'), path.join(HOME, '.npm-global/bin/codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex']),
  opencode: () => which('opencode') || newest([path.join(HOME, '.opencode/bin/opencode'), path.join(HOME, '.local/bin/opencode'), '/usr/local/bin/opencode', '/opt/homebrew/bin/opencode']),
};
export const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

let detected = null, detectedAt = 0;
export function detectAgents(force = false) {
  if (!force && detected && Date.now() - detectedAt < 60000) return detected;
  const prev = new Map((detected || []).map(a => [a.id, a]));
  detected = Object.entries(FINDERS).map(([id, find]) => ({ id, name: AGENT_NAMES[id], path: find(), signedIn: prev.get(id)?.signedIn ?? null })).filter(a => a.path);
  detectedAt = Date.now();
  return detected;
}
// Is the agent signed in for command-line use? (Claude Code bundled in the desktop app is not, until `auth login`.)
function runQuiet(cmd, args, timeout = 15000) {
  return new Promise(resolve => {
    let out = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, out }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out }); });
  });
}
export async function checkSignIn(force = false) {
  const list = detectAgents(force);
  await Promise.all(list.map(async a => {
    if (a.signedIn === true && !force) return;
    if (a.id === 'claude') { const r = await runQuiet(a.path, ['auth', 'status']); try { a.signedIn = !!JSON.parse(r.out.slice(r.out.indexOf('{'))).loggedIn; } catch { a.signedIn = r.code === 0 ? null : false; } }
    else if (a.id === 'codex') { const r = await runQuiet(a.path, ['login', 'status']); a.signedIn = r.code === 0; }
    else a.signedIn = true;   // OpenCode keeps its own provider settings
  }));
  return list;
}
// Open a terminal running the agent's sign-in, once; the user signs in there in the browser.
export function openSignIn(id) {
  const a = detectAgents().find(x => x.id === id); if (!a) throw Object.assign(new Error('Agent not found'), { status: 404 });
  const args = a.id === 'claude' ? ['auth', 'login'] : a.id === 'codex' ? ['login'] : ['auth', 'login'];
  const line = [a.path, ...args].map(s => `'${s.replace(/'/g, `'\\''`)}'`).join(' ');
  if (process.platform === 'darwin') { spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref(); return { ok: true }; }
  if (IS_WIN) { spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', a.path, ...args], { detached: true, stdio: 'ignore' }).unref(); return { ok: true }; }
  const shell = `${line}; echo; echo 'You can close this window and go back to Code Motion.'; read -r _`;
  for (const [term, pre] of [['gnome-terminal', ['--']], ['ptyxis', ['--']], ['kgx', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['kitty', []], ['alacritty', ['-e']], ['wezterm', ['start', '--']], ['tilix', ['-e']], ['x-terminal-emulator', ['-e']], ['xterm', ['-e']]]) {
    const bin = which(term); if (!bin) continue;
    spawn(bin, [...pre, 'bash', '-c', shell], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }
  throw Object.assign(new Error(`No terminal found. Run this once in a terminal: ${line}`), { status: 500 });
}
export function pickAgent(wanted) {
  const list = detectAgents();
  const pref = wanted && wanted !== 'auto' ? wanted : getConfig().agent;
  return list.find(a => a.id === pref) || list.find(a => a.signedIn !== false) || list[0] || null;
}

// ---- chat history (in the project's .cm folder)
const chatFile = id => path.join(projectDir(id), '.cm', 'chat.json');
export function loadChat(id) {
  const c = readJson(chatFile(id), null) || { sessions: {}, messages: [] };
  c.running = running.has(id);
  return c;
}
function saveChat(id, c) {
  const { running: _, ...rest } = c;
  rest.messages = rest.messages.slice(-200);
  writeJson(chatFile(id), rest);
}
export function clearChat(id) { if (running.has(id)) stopChat(id); writeJson(chatFile(id), { sessions: {}, messages: [] }); }

const running = new Map();   // project id → { proc, agent }
let emit = () => { };
export function onChat(fn) { emit = fn; }
export function isRunning(id) { return running.has(id); }
export function anyRunning() { return running.size > 0; }

const SYSTEM = `You are working inside Code Motion, a local video editor. The user sees this project's preview and timeline beside this chat; every file you save appears there within a second. Read CLAUDE.md / AGENTS.md in this folder for the project format. Work only inside this project folder; do not explore parent folders. Edit project.json and scenes/ directly. The user usually sends review notes: each has the exact time, frame, pixel position and a picture of the frame with the spot marked in red; open the pictures before changing anything. Do not export or render the final video (the user presses Export). Keep answers short: say what changed and where on the timeline.`;

// opts: { context, agent, model, display (what the chat shows instead of the full prompt), notes (note ids) }
export function sendChat(id, text, opts = {}) {
  const { context = {}, agent: agentId, model, display, notes } = opts;
  if (running.has(id)) throw Object.assign(new Error('The agent is still working on the last message'), { status: 409 });
  const agent = pickAgent(agentId);
  if (!agent) throw Object.assign(new Error('No coding agent found. Install Claude Code, Codex or OpenCode.'), { status: 404 });
  const dir = projectDir(id);
  writeAgentGuide(dir);
  fs.mkdirSync(path.join(dir, '.cm', 'tmp'), { recursive: true });
  const chat = loadChat(id);
  chat.messages.push({ role: 'user', text: String(display || text), notes: notes || undefined, time: Date.now() });
  const reply = { role: 'agent', agent: agent.id, model: model || undefined, parts: [], time: Date.now(), status: 'working' };
  chat.messages.push(reply);
  saveChat(id, chat);

  const ctx = [];
  if (context.playhead != null) ctx.push(`playhead at ${(+context.playhead).toFixed(2)} s`);
  if (context.selected) ctx.push(`selected clip: ${context.selected}`);
  const prompt = (ctx.length ? `[Code Motion: ${ctx.join('; ')}]\n` : '') + text;

  const session = chat.sessions?.[agent.id];
  const { cmd, args } = commandFor(agent, prompt, session, model);
  const proc = spawn(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN, env: { ...process.env, CODEMOTION: '1' } });
  running.set(id, { proc, agent });
  const push = () => emit(id, { type: 'update', message: reply, running: true });
  emit(id, { type: 'start', messages: chat.messages, running: true });

  let buf = '', errText = '', saveTimer = null;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveChat(id, chat), 800); };
  const handle = line => {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    const changed = PARSERS[agent.id](ev, reply, chat, dir);
    if (changed) { push(); saveSoon(); }
  };
  proc.stdout.on('data', d => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) if (l.trim()) handle(l); });
  proc.stderr.on('data', d => { errText = (errText + d).slice(-3000); });
  proc.on('error', e => { errText += e.message; });
  proc.on('close', code => {
    if (buf.trim()) handle(buf);
    clearTimeout(saveTimer);
    running.delete(id);
    if (reply.status === 'working') reply.status = reply.stopped ? 'stopped' : code === 0 ? 'done' : 'error';
    if (reply.status === 'error' && !reply.parts.some(p => p.kind === 'text')) reply.parts.push({ kind: 'error', text: cleanError(errText) || `The agent stopped (exit ${code}).` });
    finishText(reply);
    saveChat(id, chat);
    emit(id, { type: 'done', message: reply, running: false });
  });
  return { ok: true, agent: agent.id };
}

export function stopChat(id) {
  const r = running.get(id); if (!r) return false;
  const msgs = loadChat(id).messages; const last = msgs[msgs.length - 1];
  if (last) last.stopped = true;
  try { IS_WIN ? r.proc.kill() : process.kill(-r.proc.pid, 'SIGTERM'); } catch { }
  setTimeout(() => { try { IS_WIN ? r.proc.kill('SIGKILL') : process.kill(-r.proc.pid, 'SIGKILL'); } catch { } }, 3000);
  return true;
}

function cleanError(t) { return String(t || '').split('\n').filter(l => l.trim()).slice(-3).join('\n').slice(0, 600); }

function commandFor(agent, prompt, session, model) {
  const full = getConfig().agentAccess === 'full';
  const m = model && model !== 'default' ? String(model) : null;
  if (agent.id === 'claude') {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--append-system-prompt', SYSTEM];
    if (m) args.push('--model', m);
    if (full) args.push('--permission-mode', 'bypassPermissions');
    else args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite',
      'Bash(ffprobe:*)', 'Bash(ffmpeg:*)', 'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(cat:*)', 'Bash(node:*)', 'Bash(python3:*)', 'WebSearch', 'WebFetch');
    if (session) args.push('--resume', session);
    return { cmd: agent.path, args };
  }
  if (agent.id === 'codex') {
    const args = ['exec', '--json', '--skip-git-repo-check', full ? '--dangerously-bypass-approvals-and-sandbox' : '--full-auto'];
    if (m) args.push('-m', m);
    if (session) args.push('resume', session);
    args.push(`${SYSTEM}\n\n${prompt}`);
    return { cmd: agent.path, args };
  }
  const args = ['run', '--format', 'json', '--auto'];
  if (m) args.push('-m', m);
  if (session) args.push('--session', session);
  args.push(`${SYSTEM}\n\n${prompt}`);
  return { cmd: agent.path, args };
}

// ---- turning each agent's event stream into chat parts: { kind: 'text' | 'tool' | 'error', text }
const rel = (dir, f) => f ? (path.isAbsolute(f) ? path.relative(dir, f) || f : f) : '';
function addText(reply, text, streaming) {
  const last = reply.parts[reply.parts.length - 1];
  if (last && last.kind === 'text' && last.streaming) { last.text = streaming ? last.text + text : text; if (!streaming) delete last.streaming; }
  else reply.parts.push(streaming ? { kind: 'text', text, streaming: true } : { kind: 'text', text });
}
function finishText(reply) { for (const p of reply.parts) delete p.streaming; }
function addTool(reply, text) { finishText(reply); reply.parts.push({ kind: 'tool', text }); }

function claudeTool(name, input = {}, dir) {
  const f = rel(dir, input.file_path || input.path || input.notebook_path);
  switch (name) {
    case 'Edit': case 'MultiEdit': return `Edited ${f}`;
    case 'Write': return `Wrote ${f}`;
    case 'Read': return `Read ${f}`;
    case 'Bash': return `Ran ${String(input.command || '').split('\n')[0].slice(0, 80)}`;
    case 'Glob': case 'Grep': return `Searched ${input.pattern || ''}`.trim();
    case 'TodoWrite': return 'Updated its plan';
    case 'WebSearch': return `Searched the web: ${input.query || ''}`;
    case 'WebFetch': return `Opened ${input.url || 'a page'}`;
    default: return name;
  }
}

const PARSERS = {
  claude(ev, reply, chat, dir) {
    if (ev.session_id && chat.sessions.claude !== ev.session_id) { chat.sessions.claude = ev.session_id; }
    if (ev.type === 'stream_event') {
      const d = ev.event?.delta;
      if (ev.event?.type === 'content_block_delta' && d?.type === 'text_delta') { addText(reply, d.text, true); return true; }
      return false;
    }
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text) addText(reply, b.text, false);
        else if (b.type === 'tool_use') addTool(reply, claudeTool(b.name, b.input, dir));
      }
      return true;
    }
    if (ev.type === 'result') {
      if (ev.is_error) {
        reply.status = 'error';
        const msg = String(ev.result || '').slice(0, 600);
        if (/not logged in|\/login|authenticat/i.test(msg)) { reply.parts = reply.parts.filter(p => p.kind !== 'text'); reply.parts.push({ kind: 'signin', text: 'Claude Code is installed but not signed in for Code Motion yet.' }); }
        else if (msg && !reply.parts.some(p => p.text === msg)) reply.parts.push({ kind: 'error', text: msg });
      }
      else reply.status = 'done';
      if (ev.total_cost_usd != null) reply.cost = ev.total_cost_usd;
      return true;
    }
    return false;
  },
  codex(ev, reply, chat) {
    if (ev.type === 'thread.started' && ev.thread_id) { chat.sessions.codex = ev.thread_id; return false; }
    if (ev.type === 'item.completed' && ev.item) {
      const it = ev.item;
      if (it.type === 'agent_message' && it.text) addText(reply, it.text, false);
      else if (it.type === 'command_execution') addTool(reply, `Ran ${String(it.command || '').slice(0, 80)}`);
      else if (it.type === 'file_change') for (const c of it.changes || []) addTool(reply, `Edited ${c.path}`);
      else return false;
      return true;
    }
    if (ev.type === 'turn.completed') { reply.status = 'done'; return true; }
    if (ev.type === 'error' || ev.type === 'turn.failed') { reply.status = 'error'; reply.parts.push({ kind: 'error', text: String(ev.message || ev.error?.message || 'Error') }); return true; }
    return false;
  },
  opencode(ev, reply, chat) {
    const sid = ev.sessionID || ev.part?.sessionID || ev.properties?.sessionID;
    if (sid) chat.sessions.opencode = sid;
    const part = ev.part || ev.properties?.part;
    if (!part) { if (ev.type === 'error') { reply.status = 'error'; reply.parts.push({ kind: 'error', text: String(ev.error?.data?.message || ev.error?.message || ev.message || 'Error') }); return true; } return false; }
    if (part.type === 'text' && part.text) { addText(reply, part.text, false); return true; }
    if (part.type === 'tool' || part.tool) {
      if (part.state?.status && part.state.status !== 'completed' && part.state.status !== 'error') return false;   // one line per tool, when it ends
      const input = part.state?.input || {};
      const f = input.filePath || input.path || '';
      const name = part.tool || 'tool';
      addTool(reply, /edit|write|patch/i.test(name) ? `Edited ${path.basename(f) || f}` : /read/i.test(name) ? `Read ${path.basename(f)}` : /bash|shell/i.test(name) ? `Ran ${String(input.command || input.cmd || '').split('\n')[0].slice(0, 80) || 'a command'}` : /glob|grep|list|search/i.test(name) ? `Searched ${input.pattern || input.path || ''}`.trim() : /todo/i.test(name) ? 'Updated its plan' : /fetch/i.test(name) ? `Opened ${input.url || 'a page'}` : name);
      return true;
    }
    return false;
  },
};

// ---- models per agent (for the chat's model menu)
const modelCache = new Map();
export async function listModels(id) {
  const a = detectAgents().find(x => x.id === id); if (!a) return [];
  if (a.id === 'claude') return [{ id: 'default', name: 'Default' }, { id: 'fable', name: 'Fable' }, { id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }];
  if (a.id === 'codex') return [{ id: 'default', name: 'Default' }, { id: 'gpt-5-codex', name: 'GPT-5 Codex' }, { id: 'gpt-5', name: 'GPT-5' }];
  const c = modelCache.get(id); if (c && Date.now() - c.at < 600000) return c.list;
  const r = await runQuiet(a.path, ['models'], 20000);
  const list = [{ id: 'default', name: 'Default' }, ...r.out.split('\n').map(l => l.trim()).filter(l => /^[\w.-]+\/[\w.:@-]+$/.test(l)).map(l => ({ id: l, name: l }))];
  modelCache.set(id, { at: Date.now(), list });
  return list;
}

// ---- "Open the chat in the coding agent": the conversation that made or last edited this project
// Claude Code keeps sessions in ~/.claude/projects/<folder-slug>/<session>.jsonl; the newest one that mentions the
// project folder is the one. OpenCode lists its sessions per folder. Only file names and a text search are used.
const slug = d => d.replace(/[^a-zA-Z0-9]/g, '-');
function newestClaudeSession(cwd, needle) {
  const base = path.join(HOME, '.claude', 'projects');
  const dirs = cwd ? [path.join(base, slug(cwd))] : [];
  try { if (needle) for (const d of fs.readdirSync(base)) dirs.push(path.join(base, d)); } catch { }
  const cands = [];
  for (const d of [...new Set(dirs)]) {
    let files = []; try { files = fs.readdirSync(d).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) { try { const st = fs.statSync(path.join(d, f)); if (Date.now() - st.mtimeMs < 60 * 86400000) cands.push({ file: path.join(d, f), mtime: st.mtimeMs, cwdMatch: d === path.join(base, slug(cwd || '')) }); } catch { } }
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  for (const c of cands.slice(0, 200)) {
    if (!needle) return path.basename(c.file, '.jsonl');
    try {
      const fd = fs.openSync(c.file, 'r'), st = fs.fstatSync(fd), len = Math.min(st.size, 8 * 1024 * 1024);
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      if (buf.includes(needle)) return path.basename(c.file, '.jsonl');
    } catch { }
  }
  return null;
}
function inTerminal(cwd, cmd, args) {
  const line = `cd '${cwd.replace(/'/g, `'\\''`)}' && ` + [cmd, ...args].map(s => `'${String(s).replace(/'/g, `'\\''`)}'`).join(' ');
  if (process.platform === 'darwin') { spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref(); return true; }
  for (const [term, pre] of [['gnome-terminal', ['--']], ['ptyxis', ['--']], ['kgx', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['kitty', []], ['alacritty', ['-e']], ['tilix', ['-e']], ['x-terminal-emulator', ['-e']], ['xterm', ['-e']]]) {
    const bin = which(term); if (!bin) continue;
    spawn(bin, [...pre, 'bash', '-c', `${line}; exec bash`], { detached: true, stdio: 'ignore' }).unref(); return true;
  }
  return false;
}
export async function openAgentChat(id) {
  const dir = projectDir(id);
  const origin = readJson(path.join(dir, '.cm', 'origin.json'), null);
  const chat = loadChat(id);
  const list = detectAgents();
  const order = [origin?.agent, ...Object.keys(chat.sessions || {}), 'claude', 'opencode', 'codex'].filter(Boolean);
  for (const aid of [...new Set(order)]) {
    const a = list.find(x => x.id === aid); if (!a) continue;
    if (a.id === 'claude') {
      const sid = (origin?.agent === 'claude' && newestClaudeSession(origin.cwd, dir)) || newestClaudeSession(null, dir) || chat.sessions?.claude;
      if (!sid) continue;
      const desktop = fs.existsSync('/usr/lib/claude-desktop') || fs.existsSync(path.join(HOME, '.config/Claude')) || fs.existsSync('/Applications/Claude.app');
      const cwd = origin?.agent === 'claude' && origin.cwd && fs.existsSync(origin.cwd) ? origin.cwd : dir;
      if (desktop) { spawn(a.path, ['--desktop', '--resume', sid], { cwd, detached: true, stdio: 'ignore' }).unref(); return { ok: true, agent: a.name, where: 'Claude desktop app', session: sid }; }
      if (inTerminal(cwd, a.path, ['--resume', sid])) return { ok: true, agent: a.name, where: 'a terminal', session: sid };
    } else if (a.id === 'opencode') {
      const cwd = origin?.agent === 'opencode' && origin.cwd && fs.existsSync(origin.cwd) ? origin.cwd : dir;
      let sid = cwd === dir ? chat.sessions?.opencode : null;
      if (!sid) { const r = await runQuiet(a.path, ['session', 'list', '--format', 'json'], 15000); try { const j = JSON.parse(r.out.slice(r.out.indexOf('['))); sid = (j[0] || {}).id; } catch { } }
      if (inTerminal(cwd, a.path, sid ? ['-s', sid] : [])) return { ok: true, agent: a.name, where: 'a terminal', session: sid || null };
    } else if (a.id === 'codex') {
      const cwd = origin?.cwd && fs.existsSync(origin.cwd) ? origin.cwd : dir;
      const sid = chat.sessions?.codex;
      if (inTerminal(cwd, a.path, sid ? ['resume', sid] : ['resume', '--last'])) return { ok: true, agent: a.name, where: 'a terminal', session: sid || null };
    }
  }
  throw Object.assign(new Error('No conversation found for this project yet. Ask your coding agent to make a video, or use the chat in the editor.'), { status: 404 });
}
