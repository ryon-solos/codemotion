#!/usr/bin/env node
// Code Motion tools for coding agents (Claude Code, OpenCode, Codex): a tiny MCP server over stdio, no packages.
// The agent makes the video in its own chat; Code Motion shows it live, the user marks notes on frames,
// and the agent gets them back here. Everything goes through the local Code Motion server (started when needed).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_DIR, CACHE_DIR, getConfig } from './env.js';

const PORT = getConfig().port, BASE = `http://127.0.0.1:${PORT}`;
let client = 'unknown';
const AGENT_OF = name => /claude/i.test(name) ? 'claude' : /opencode/i.test(name) ? 'opencode' : /codex/i.test(name) ? 'codex' : name;

// ---------- talking to the Code Motion server
async function up() {
  try { const r = await fetch(BASE + '/api/ping'); if (r.ok) return; } catch { }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const log = fs.openSync(path.join(CACHE_DIR, 'server.log'), 'a');
  spawn(process.execPath, [path.join(APP_DIR, 'server', 'main.js')], { detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 100)); try { if ((await fetch(BASE + '/api/ping')).ok) return; } catch { } }
  throw new Error('Code Motion did not start; see ' + path.join(CACHE_DIR, 'server.log'));
}
async function api(p, method = 'GET', body) {
  await up();
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(600000) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(d?.error || r.statusText);
  return d;
}
async function resolveProject(ref) {
  const r = await api('/api/find?ref=' + encodeURIComponent(ref || process.cwd()));
  if (!r.id) throw new Error(ref ? `No Code Motion project "${ref}". Create one with codemotion_new.` : 'This folder is not a Code Motion project: pass "project" (its name or folder), or create one with codemotion_new.');
  return r.id;
}
const origin = id => api(`/api/projects/${encodeURIComponent(id)}/origin`, 'POST', { agent: AGENT_OF(client), cwd: process.cwd() }).catch(() => { });

// ---------- tools
const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d }), num = d => ({ type: 'number', description: d });
const TOOLS = [
  { name: 'codemotion_new', description: 'Create a new video project in Code Motion and open it in the live preview. kind "film" (default) starts a full-frame film written as code in scenes/film/index.html (window.renderOut(t)); kind "edit" starts an empty timeline for editing existing videos (then codemotion_import). Returns the folder and what to edit.',
    inputSchema: S({ name: str('Project name'), kind: { type: 'string', enum: ['film', 'edit'] }, duration: num('Film length in seconds (film only, default 10)'), width: num('Frame width, default 1920'), height: num('Frame height, default 1080 (1920 for vertical with width 1080)'), fps: num('Frames per second, default 30'), folder: str('Optional Code Motion folder name to group it in') }, ['name']) },
  { name: 'codemotion_open', description: 'Open a project in Code Motion (live preview, no render) so the user can watch it and leave notes on frames. Call it after building or changing a film.',
    inputSchema: S({ project: str('Project name, id or folder (default: the current folder)'), time: num('Optional second to show') }) },
  { name: 'codemotion_import', description: 'Add existing video, audio or image files (absolute paths) to a project; with place (default true) they go one after another on the timeline.',
    inputSchema: S({ project: str('Project name, id or folder'), files: { type: 'array', items: { type: 'string' } }, place: { type: 'boolean' } }, ['files']) },
  { name: 'codemotion_project', description: 'Facts about a project: folder, size, fps, timeline clips, scenes, open notes, exports.',
    inputSchema: S({ project: str('Project name, id or folder (default: the current folder)') }) },
  { name: 'codemotion_wait', description: 'Wait for the user instead of ending your turn: returns as soon as they send review notes from Code Motion (exact frame, time, marked position, pictures). "Nothing yet" means call it again.',
    inputSchema: S({ project: str('Project name, id or folder'), seconds: num('How long to wait (default about 5 minutes)') }) },
  { name: 'codemotion_notes', description: 'All open review notes of a project with their exact time, frame, marked pixel area, what is on screen, and the paths of the marked frame pictures.',
    inputSchema: S({ project: str('Project name, id or folder') }) },
  { name: 'codemotion_note_done', description: 'Mark a review note fixed after changing the code, with a one-sentence reply the user sees.',
    inputSchema: S({ project: str('Project name, id or folder'), id: str('Note id'), reply: str('What changed, one sentence') }, ['id', 'reply']) },
  { name: 'codemotion_export', description: 'Export the project to MP4 (only when the user asks for the final video). Waits until it is done and returns the file.',
    inputSchema: S({ project: str('Project name, id or folder') }) },
];

const GUIDE = `Film rules: scenes/<name>/index.html draws on one canvas the size of the project; window.renderOut(t) draws second t synchronously as a pure function of t (no Date.now(), no state between frames, no unseeded random); set window.READY = true when fonts/images are loaded; scenes/<name>/scene.json holds {"duration": seconds} — keep the timeline clip in project.json equally long. Code Motion reloads the preview on every save. Full format: CLAUDE.md in the project folder.`;

async function call(name, a = {}) {
  if (name === 'codemotion_new') {
    const r = await api('/api/projects', 'POST', { name: a.name, film: a.kind !== 'edit', width: a.width, height: a.height, fps: a.fps, folderName: a.folder, duration: a.duration });
    await origin(r.id);
    await api('/api/open', 'POST', { id: r.id });
    const p = await api(`/api/projects/${r.id}`);
    return `Created "${p.name}" at ${r.dir} (${p.width}×${p.height}, ${p.fps} fps) and opened it in Code Motion's live preview.\n` +
      (a.kind !== 'edit' ? `Write the film in ${path.join(r.dir, 'scenes/film/index.html')} (it is on the timeline, ${a.duration || 10} s). ${GUIDE}\n` : 'Add videos with codemotion_import, then arrange clips in project.json or let the user edit by hand.\n') +
      'When it plays, tell the user it is open in Code Motion, then call codemotion_wait for their notes. Do not export unless asked.';
  }
  const id = await resolveProject(a.project);
  const pid = encodeURIComponent(id);
  if (name === 'codemotion_open') { await origin(id); await api('/api/open', 'POST', { id, time: a.time }); return `Opened "${id}" in Code Motion. Tell the user to watch it there and mark notes on frames; then call codemotion_wait.`; }
  if (name === 'codemotion_import') { await origin(id); await api(`/api/projects/${pid}/import`, 'POST', { files: a.files || [], place: a.place !== false }); return `Added ${(a.files || []).length} file(s) to "${id}".`; }
  if (name === 'codemotion_project') {
    const [p, notes, ex] = await Promise.all([api(`/api/projects/${pid}`), api(`/api/projects/${pid}/notes`), api(`/api/projects/${pid}/exports`)]);
    const dir = (await api('/api/find?ref=' + pid)).dir;
    return [`"${p.name}" — folder ${dir}, ${p.width}×${p.height}, ${p.fps} fps`,
      'Tracks (top covers bottom): ' + p.tracks.map(t => `${t.id} ${t.name}`).join(', '),
      'Clips:', ...p.clips.map(c => `  ${c.id} ${c.type} "${c.name || c.src}" (${c.src}) track ${c.track}, ${c.start.toFixed(2)}–${(c.start + c.out - c.in).toFixed(2)} s, source ${c.in}–${c.out}`),
      `Open notes: ${notes.filter(n => n.status !== 'fixed').length}`, `Exports: ${ex.map(e => e.file).join(', ') || 'none'}`, GUIDE].join('\n');
  }
  if (name === 'codemotion_notes') {
    const notes = (await api(`/api/projects/${pid}/notes`)).filter(n => n.status !== 'fixed');
    if (!notes.length) return 'No open notes.';
    const r = await api(`/api/projects/${pid}/notes/send`, 'POST', { ids: notes.map(n => n.id), target: 'read' });
    return r.prompt;
  }
  if (name === 'codemotion_note_done') { await api(`/api/projects/${pid}/notes/${encodeURIComponent(a.id)}`, 'PATCH', { status: 'fixed', reply: a.reply || 'Fixed' }); return 'Marked fixed.'; }
  if (name === 'codemotion_wait') {
    await origin(id);
    const limit = Math.min(540, +a.seconds || (/codex|unknown/.test(AGENT_OF(client)) ? 50 : 300));
    const end = Date.now() + limit * 1000;
    while (Date.now() < end) {
      const r = await api(`/api/projects/${pid}/wait?timeout=${Math.min(90, Math.ceil((end - Date.now()) / 1000))}`);
      if (r.prompt) return r.prompt;
    }
    return 'Nothing from the user yet; call codemotion_wait again.';
  }
  if (name === 'codemotion_export') {
    const j = await api(`/api/projects/${pid}/export`, 'POST');
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const cur = (await api('/api/jobs')).find(x => x.id === j.id);
      if (!cur || cur.status === 'done') return `Exported: ${cur?.file ? path.join((await api('/api/find?ref=' + pid)).dir, cur.file) : 'done'}`;
      if (cur.status === 'failed' || cur.status === 'cancelled') throw new Error(cur.error || 'Export stopped');
    }
  }
  throw new Error('Unknown tool ' + name);
}

// ---------- MCP over stdio (newline-delimited JSON-RPC)
const out = m => process.stdout.write(JSON.stringify(m) + '\n');
async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    client = params?.clientInfo?.name || 'unknown';
    return out({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codemotion', version: '1.0.0' },
      instructions: 'Code Motion is the user\'s local video review tool. Make videos as code in a Code Motion project (codemotion_new), open them for review (codemotion_open), wait for frame-accurate notes (codemotion_wait), fix them in code. Never render repeatedly: the preview plays the code live; export only on request.' } });
  }
  if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return out({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try { const text = await call(params.name, params.arguments || {}); out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }); }
    catch (e) { out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } }); }
    return;
  }
  if (id != null && !method?.startsWith('notifications/')) out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}
let buf = '';
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { handle(JSON.parse(line)); } catch { } } }
});
process.stdin.on('end', () => process.exit(0));
