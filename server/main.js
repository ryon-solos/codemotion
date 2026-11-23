// Code Motion server: loopback only, JSON API + server-sent events + the UI. No dependencies.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_DIR, CACHE_DIR, IS_LINUX, IS_MAC, IS_WIN, getConfig, getTools, setConfig, which, workspace } from './env.js';
import * as P from './projects.js';
import { kindOf, needsProxy, peaks, probe, proxy, thumbnail } from './media.js';
import * as X from './exporter.js';
import * as A from './agent.js';
import * as C from './cleaner.js';
import * as N from './notes.js';
import * as K from './connect.js';
import { strip } from './media.js';
import { readJson, writeJson } from './env.js';

const cfg = getConfig();
const PORT = cfg.port, HOST = '127.0.0.1';
const UI = path.join(APP_DIR, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.glsl': 'text/plain', '.txt': 'text/plain' };

// ---------- server-sent events
const clients = new Set();   // { res, project }
function send(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(type, data, project) { for (const c of clients) if (!project || c.project === project) send(c.res, type, data); }
X.onJob(j => broadcast('job', j));
A.onChat((project, ev) => broadcast('chat', ev, project));

// ---------- watching the open project (only while an editor window shows it)
const watchers = new Map();   // project → { w, count, timer, pending }
function watchProject(id) {
  const cur = watchers.get(id);
  if (cur) { cur.count++; return; }
  let dir; try { dir = P.projectDir(id); } catch { return; }
  const entry = { count: 1, timer: null, pending: new Set(), w: null };
  try {
    entry.w = fs.watch(dir, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const f = String(file).split(path.sep).join('/');
      if (process.env.CODEMOTION_DEBUG) console.log('watch', id, JSON.stringify(f));
      if (f === '.cm/notes.json') { entry.pending.add('notes'); clearTimeout(entry.timer); entry.timer = setTimeout(() => flush(id, entry), 250); return; }
      if (/^(\.cm|exports|node_modules)\//.test(f) || /(^|\/)node_modules\//.test(f) || /\.(tmp|part\.mp4|swp)$|~$/.test(f)) return;
      if (f === 'project.json') entry.pending.add('project');
      else if (f.startsWith('scenes/')) entry.pending.add('scene:' + f.split('/')[1]);
      else if (f.startsWith('media/')) entry.pending.add('media');
      else return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => flush(id, entry), 250);
    });
  } catch { }
  // safety net: recursive watching on Linux can go quiet after new sub-folders appear; a stat of two files is cheap
  const stamp = f => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } };
  entry.seen = { project: stamp('project.json'), notes: stamp('.cm/notes.json') };
  entry.poll = setInterval(() => {
    const now = { project: stamp('project.json'), notes: stamp('.cm/notes.json') };
    let any = false;
    for (const k of ['project', 'notes']) if (now[k] !== entry.seen[k]) { entry.seen[k] = now[k]; entry.pending.add(k); any = true; }
    if (any) { clearTimeout(entry.timer); entry.timer = setTimeout(() => flush(id, entry), 50); }
  }, 2500);
  watchers.set(id, entry);
}
function flush(id, entry) {
  const kinds = [...entry.pending]; entry.pending.clear();
  try { const d = P.projectDir(id); entry.seen = { project: fs.statSync(path.join(d, 'project.json')).mtimeMs, notes: (() => { try { return fs.statSync(path.join(d, '.cm/notes.json')).mtimeMs; } catch { return 0; } })() }; } catch { }
  for (const k of kinds) {
    if (k === 'project') { try { const p = P.loadProject(id); broadcast('project', { version: p.version, project: p }, id); } catch { } }
    else if (k === 'media') broadcast('media', {}, id);
    else if (k === 'notes') { try { broadcast('notes', { notes: N.loadNotes(id) }, id); } catch { } }
    else broadcast('scene', { name: k.slice(6), src: 'scenes/' + k.slice(6) }, id);
  }
  if (kinds.some(k => k.startsWith('scene:'))) broadcast('media', {}, id);
}
function unwatchProject(id) {
  const e = watchers.get(id); if (!e) return;
  if (--e.count > 0) return;
  try { e.w?.close(); } catch { }
  clearTimeout(e.timer); clearInterval(e.poll); watchers.delete(id);
}

// ---------- idle exit: nothing open, nothing running → the server goes away (the launcher starts it again)
let lastActive = Date.now();
setInterval(() => {
  if (clients.size || X.busy() || A.anyRunning() || [...waiters.values()].some(w => w.size)) { lastActive = Date.now(); return; }
  const mins = +getConfig().idleMinutes;
  if (mins > 0 && Date.now() - lastActive > mins * 60000) { console.log('Code Motion: idle, stopping.'); process.exit(0); }
}, 15000).unref();

// ---------- helpers
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req, limit = 2e6) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw P.httpError(413, 'Too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}
function serveFile(req, res, file, { cache = false } = {}) {
  let st; try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'Not found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'Not found' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache ? 'max-age=3600' : 'no-cache', 'last-modified': st.mtime.toUTCString() };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] ? +range[1] : st.size - +range[2], end = range[1] && range[2] ? +range[2] : st.size - 1;
    if (!range[1]) end = st.size - 1;
    if (start >= st.size || start < 0 || end < start) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
function openPath(target, reveal = false) {
  if (IS_LINUX) spawn('xdg-open', [reveal ? path.dirname(target) : target], { detached: true, stdio: 'ignore' }).unref();
  else if (IS_MAC) spawn('open', reveal ? ['-R', target] : [target], { detached: true, stdio: 'ignore' }).unref();
  else spawn('explorer.exe', reveal ? ['/select,', target] : [target], { detached: true, stdio: 'ignore' }).unref();
}
function openAppWindow(url) {
  if (process.env.CODEMOTION_NO_WINDOW) return;
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
    const bin = which(b); if (bin) { spawn(bin, [`--app=${url}`, '--class=CodeMotion'], { detached: true, stdio: 'ignore' }).unref(); return; }
  }
  openPath(url);
}
// The system file dialog (async: the server keeps answering while it is open). null = no dialog on this system.
let picking = null;
function pickFiles() {
  if (picking) return picking;
  const t = getTools();
  const filter = '*.mp4 *.mov *.mkv *.webm *.m4v *.avi *.mp3 *.wav *.m4a *.aac *.ogg *.opus *.flac *.png *.jpg *.jpeg *.webp *.gif';
  let cmd, args;
  if (t.zenity) { cmd = t.zenity; args = ['--file-selection', '--multiple', '--separator=\n', '--title=Add videos, sounds or pictures', `--file-filter=Media | ${filter}`, '--file-filter=All files | *']; }
  else if (t.kdialog) { cmd = t.kdialog; args = ['--getopenfilename', '--multiple', '--separate-output', process.env.HOME || '/', filter]; }
  else if (IS_MAC) { cmd = 'osascript'; args = ['-e', 'set fs to choose file with multiple selections allowed', '-e', 'set out to ""', '-e', 'repeat with f in fs', '-e', 'set out to out & POSIX path of f & linefeed', '-e', 'end repeat', '-e', 'out']; }
  else return Promise.resolve(null);   // the UI falls back to the browser's file input
  picking = new Promise(resolve => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', code => resolve(code === 0 ? out.split('\n').map(s => s.trim()).filter(Boolean) : []));
  }).finally(() => { picking = null; });
  return picking;
}
async function placeOnTimeline(id, srcs) {
  const p = P.loadProject(id);
  const ends = {};
  for (const c of p.clips) ends[c.track] = Math.max(ends[c.track] || 0, c.start + c.out - c.in);
  const vTrack = (p.tracks.filter(t => t.kind === 'video').pop() || {}).id, aTrack = (p.tracks.find(t => t.kind === 'audio') || {}).id;
  let n = Date.now();
  for (const src of srcs) {
    const abs = P.resolveSrc(id, src), kind = kindOf(abs); if (!kind) continue;
    const info = await probe(abs);
    const track = kind === 'audio' ? aTrack : vTrack; if (!track) continue;
    const dur = info.duration || 5;
    p.clips.push({ id: 'c' + (n++).toString(36), track, type: kind, src, start: ends[track] || 0, in: 0, out: dur, volume: 1, muted: false, name: path.basename(abs) });
    ends[track] = (ends[track] || 0) + dur;
  }
  return P.saveProject(id, p);
}

// ---------- routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/ping', (req, res) => json(res, 200, { ok: true, app: 'codemotion' }));
route('GET', '/api/state', (req, res) => {
  const t = getTools();
  json(res, 200, { config: getConfig(), workspace: workspace(), cacheDir: CACHE_DIR, platform: process.platform,
    tools: { ffmpeg: !!t.ffmpeg, ffprobe: !!t.ffprobe, browser: !!t.browser, picker: !!(t.zenity || t.kdialog || IS_MAC) },
    agents: A.detectAgents(true).map(a => ({ id: a.id, name: a.name, path: a.path })), jobs: X.listJobs() });
});
route('POST', '/api/config', async (req, res) => json(res, 200, setConfig(await body(req))));

route('GET', '/api/projects', (req, res) => json(res, 200, P.listProjects()));
route('POST', '/api/projects', async (req, res) => {
  const b = await body(req);
  let folder = b.folder || null;
  if (!folder && b.folderName) { const f = P.listFolders().find(x => x.name.toLowerCase() === String(b.folderName).toLowerCase()) || P.addFolder(b.folderName); folder = f.id; }
  const id = P.createProject(b.name, { folder, film: !!b.film, width: +b.width, height: +b.height, fps: +b.fps });
  if (b.film && +b.duration > 0) {   // film length: scene.json and the clip together
    const dir = P.projectDir(id), sj = path.join(dir, 'scenes', 'film', 'scene.json');
    const meta = readJson(sj, {}); meta.duration = +b.duration; writeJson(sj, meta);
    const p = P.loadProject(id); const c = p.clips.find(x => x.id === 'film'); if (c) c.out = +b.duration; P.saveProject(id, p);
  }
  json(res, 200, { id, dir: P.projectDir(id) });
});
route('GET', '/api/find', (req, res, m, url) => { const id = P.findProject(url.searchParams.get('ref')); json(res, 200, id ? { id, dir: P.projectDir(id) } : { id: null }); });
// show a project in the open window, or open a window on it
route('POST', '/api/open', async (req, res) => {
  const b = await body(req); P.loadProject(b.id);
  const windows = [...clients].length;
  broadcast('show', { id: b.id, time: b.time ?? null });
  if (!windows) openAppWindow(`http://${HOST}:${PORT}/#/edit/${encodeURIComponent(b.id)}`);
  json(res, 200, { ok: true, window: windows ? 'existing' : 'new' });
});
route('POST', '/api/projects/:id/origin', async (req, res, m) => {
  const b = await body(req);
  writeJson(path.join(P.projectDir(m.id), '.cm', 'origin.json'), { agent: String(b.agent || ''), cwd: String(b.cwd || ''), time: Date.now() });
  json(res, 200, { ok: true });
});
route('POST', '/api/projects/:id/cover', async (req, res, m) => {
  const b = await body(req, 4e6); const mm = /^data:image\/jpeg;base64,(.+)$/.exec(b.image || '');
  if (!mm) return json(res, 400, { error: 'Bad image' });
  fs.mkdirSync(path.join(P.projectDir(m.id), '.cm'), { recursive: true });
  fs.writeFileSync(path.join(P.projectDir(m.id), '.cm', 'cover.jpg'), Buffer.from(mm[1], 'base64'));
  json(res, 200, { ok: true });
});
route('GET', '/api/projects/:id/cover', (req, res, m) => serveFile(req, res, path.join(P.projectDir(m.id), '.cm', 'cover.jpg')));
route('POST', '/api/projects/:id/open-chat', async (req, res, m) => json(res, 200, await A.openAgentChat(m.id)));

// folders
route('GET', '/api/folders', (req, res) => json(res, 200, P.listFolders()));
route('POST', '/api/folders', async (req, res) => { const b = await body(req); json(res, 200, P.addFolder(b.name)); });
route('PATCH', '/api/folders/:fid', async (req, res, m) => { const b = await body(req); json(res, 200, P.renameFolder(m.fid, b.name)); });
route('DELETE', '/api/folders/:fid', (req, res, m) => { P.deleteFolder(m.fid); json(res, 200, { ok: true }); });
route('POST', '/api/projects/:id/folder', async (req, res, m) => { const b = await body(req); json(res, 200, P.setFolder(m.id, b.folder || null)); });

// notes and the agent inbox
const waiters = new Map();   // project → Set(resolve)
const inboxFile = id => path.join(P.projectDir(id), '.cm', 'inbox.json');
function waitingCount(id) { return waiters.get(id)?.size || 0; }
route('GET', '/api/projects/:id/notes', (req, res, m) => json(res, 200, N.loadNotes(m.id)));
route('POST', '/api/projects/:id/notes', async (req, res, m) => { const n = N.addNote(m.id, await body(req, 40e6)); json(res, 200, n); });
route('PATCH', '/api/projects/:id/notes/:nid', async (req, res, m) => json(res, 200, N.updateNote(m.id, m.nid, await body(req))));
route('DELETE', '/api/projects/:id/notes/:nid', (req, res, m) => json(res, 200, { ok: N.deleteNote(m.id, m.nid) }));
route('POST', '/api/projects/:id/notes/send', async (req, res, m) => {
  const b = await body(req); const ids = (b.ids || []).map(String);
  const prompt = N.notesPrompt(m.id, ids) + (b.extra ? `\n\nAlso from the user: ${b.extra}` : '');
  if (b.target === 'read') { N.markSent(m.id, ids); return json(res, 200, { prompt }); }
  if (b.target === 'agent') {   // the agent waiting in its own chat (codemotion_wait)
    N.markSent(m.id, ids);
    const set = waiters.get(m.id);
    if (set?.size) { for (const r of set) r({ prompt }); set.clear(); }
    else writeJson(inboxFile(m.id), { prompt, ids, time: Date.now() });
    broadcast('waiting', { count: waitingCount(m.id) }, m.id);
    return json(res, 200, { ok: true, delivered: !!set?.size });
  }
  const notes = N.loadNotes(m.id).filter(n => ids.includes(n.id));
  const display = `${notes.length === 1 ? 'Fix note' : `Fix ${notes.length} notes`}: ${notes.map(n => `#${n.n} ${n.text || '(mark)'}`).join(' · ')}${b.extra ? `\n${b.extra}` : ''}`;
  const r = A.sendChat(m.id, prompt, { display, notes: ids, agent: b.agent, model: b.model });
  N.markSent(m.id, ids);
  json(res, 200, r);
});
route('GET', '/api/projects/:id/wait', (req, res, m, url) => {
  P.loadProject(m.id);
  const pending = readJson(inboxFile(m.id), null);
  if (pending?.prompt) { fs.rmSync(inboxFile(m.id), { force: true }); return json(res, 200, { prompt: pending.prompt }); }
  const timeout = Math.min(100, Math.max(1, +url.searchParams.get('timeout') || 60)) * 1000;
  let set = waiters.get(m.id); if (!set) waiters.set(m.id, set = new Set());
  let done = false;
  const finish = v => { if (done) return; done = true; clearTimeout(timer); set.delete(finish); broadcast('waiting', { count: waitingCount(m.id) }, m.id); if (!res.writableEnded) json(res, 200, v); };
  const timer = setTimeout(() => finish({ prompt: null }), timeout);
  set.add(finish); broadcast('waiting', { count: waitingCount(m.id) }, m.id);
  req.on('close', () => { if (!done) { done = true; clearTimeout(timer); set.delete(finish); setTimeout(() => broadcast('waiting', { count: waitingCount(m.id) }, m.id), 2500); } });
  lastActive = Date.now();
});
route('GET', '/api/projects/:id/waiting', (req, res, m) => json(res, 200, { count: waitingCount(m.id) }));
route('GET', '/api/projects/:id/strip', async (req, res, m, url) => {
  const abs = P.resolveSrc(m.id, url.searchParams.get('src') || '');
  if (!P.isAllowed(m.id, abs) || !fs.existsSync(abs)) return json(res, 404, { error: 'Not found' });
  const f = await strip(abs); f ? serveFile(req, res, f, { cache: true }) : json(res, 404, { error: 'No picture' });
});
route('GET', '/api/projects/:id/file', (req, res, m, url) => {   // note pictures and other files inside the project
  const dir = P.projectDir(m.id), f = path.resolve(dir, url.searchParams.get('path') || '');
  if (!f.startsWith(dir + path.sep)) return json(res, 403, { error: 'Not allowed' });
  serveFile(req, res, f);
});

// agent connection for the agents' own chats
route('GET', '/api/connect', async (req, res) => { await A.checkSignIn(); json(res, 200, await K.status()); });
route('POST', '/api/connect/:agent', async (req, res, m) => json(res, 200, await K.connect(m.agent)));
route('DELETE', '/api/connect/:agent', async (req, res, m) => json(res, 200, await K.disconnect(m.agent)));
route('GET', '/api/agents/:agent/models', async (req, res, m) => json(res, 200, await A.listModels(m.agent)));
route('GET', '/api/projects/:id', (req, res, m) => json(res, 200, P.loadProject(m.id)));
route('PUT', '/api/projects/:id', async (req, res, m) => { const b = await body(req, 20e6); json(res, 200, P.saveProject(m.id, b.project, b.baseVersion)); });
route('PATCH', '/api/projects/:id', async (req, res, m) => { const b = await body(req); json(res, 200, P.renameProject(m.id, b.name)); });
route('DELETE', '/api/projects/:id', (req, res, m) => { if (A.isRunning(m.id)) A.stopChat(m.id); json(res, 200, P.trashProject(m.id)); });
route('POST', '/api/projects/:id/reveal', (req, res, m) => { openPath(path.join(P.projectDir(m.id), 'project.json'), true); json(res, 200, { ok: true }); });

route('GET', '/api/projects/:id/media', async (req, res, m) => {
  const items = await P.listMedia(m.id);
  for (const it of items) it.needsProxy = needsProxy(it);
  json(res, 200, items);
});
route('POST', '/api/projects/:id/pick', async (req, res, m) => {
  const b = await body(req);
  const files = await pickFiles();
  if (files === null) return json(res, 200, { fallback: true });
  if (!files.length) return json(res, 200, { files: [] });
  P.addExternalMedia(m.id, files);
  if (b.place) await placeOnTimeline(m.id, files);
  broadcast('media', {}, m.id);
  json(res, 200, { files });
});
// the native picker before a project exists (the "Edit a new video" dialog)
route('POST', '/api/pick-preview', async (req, res) => { const files = await pickFiles(); json(res, 200, files === null ? { fallback: true } : { files }); });
route('POST', '/api/projects/:id/import', async (req, res, m) => {
  const b = await body(req); const files = (b.files || []).filter(f => typeof f === 'string');
  P.addExternalMedia(m.id, files);
  if (b.place) await placeOnTimeline(m.id, files.map(f => path.resolve(f)));
  broadcast('media', {}, m.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/projects/:id/place',async (req, res, m) => { const b = await body(req); json(res, 200, await placeOnTimeline(m.id, b.srcs || [])); });
route('POST', '/api/projects/:id/upload', async (req, res, m, url) => {
  const target = P.uploadTarget(m.id, url.searchParams.get('name'));
  const tmp = target + '.uploading';
  await new Promise((resolve, reject) => { const w = fs.createWriteStream(tmp); req.pipe(w); w.on('finish', resolve); w.on('error', reject); req.on('error', reject); });
  fs.renameSync(tmp, target);
  const src = 'media/' + path.basename(target);
  if (url.searchParams.get('place') === '1') await placeOnTimeline(m.id, [src]);
  json(res, 200, { src });
});
route('POST', '/api/projects/:id/scenes', async (req, res, m) => { const b = await body(req); json(res, 200, { src: P.newScene(m.id, b.name) }); });

route('GET', '/api/projects/:id/thumb', async (req, res, m, url) => {
  const abs = P.resolveSrc(m.id, url.searchParams.get('src') || '');
  if (!P.isAllowed(m.id, abs) || !fs.existsSync(abs)) return json(res, 404, { error: 'Not found' });
  const f = await thumbnail(abs, +url.searchParams.get('at') || 0);
  f ? serveFile(req, res, f, { cache: true }) : json(res, 404, { error: 'No picture' });
});
route('GET', '/api/projects/:id/peaks', async (req, res, m, url) => {
  const abs = P.resolveSrc(m.id, url.searchParams.get('src') || '');
  if (!P.isAllowed(m.id, abs) || !fs.existsSync(abs)) return json(res, 404, { error: 'Not found' });
  json(res, 200, await peaks(abs));
});
// what the preview should load for a file: the file itself, or a proxy once it is made
route('GET', '/api/projects/:id/preview-src', async (req, res, m, url) => {
  const src = url.searchParams.get('src') || '', abs = P.resolveSrc(m.id, src);
  if (!P.isAllowed(m.id, abs) || !fs.existsSync(abs)) return json(res, 404, { error: 'Missing file' });
  const info = await probe(abs);
  const direct = `/p/${encodeURIComponent(m.id)}/media?src=${encodeURIComponent(src)}`;
  if (!needsProxy(info)) return json(res, 200, { ready: true, url: direct });
  const pending = proxy(abs);
  const done = await Promise.race([pending.then(() => true), new Promise(r => setTimeout(() => r(false), 300))]);
  if (!done) pending.then(() => broadcast('media', { proxyReady: src }, m.id), () => { });
  json(res, 200, { ready: done, url: direct + '&proxy=1' });
});
route('GET', '/p/:id/media', async (req, res, m, url) => {
  const abs = P.resolveSrc(m.id, url.searchParams.get('src') || '');
  if (!P.isAllowed(m.id, abs)) return json(res, 403, { error: 'Not allowed' });
  if (url.searchParams.get('proxy') === '1') return serveFile(req, res, await proxy(abs));
  serveFile(req, res, abs);
});

route('POST', '/api/projects/:id/export', (req, res, m) => json(res, 200, X.startExport(m.id, `http://${HOST}:${PORT}`)));
route('GET', '/api/jobs', (req, res) => json(res, 200, X.listJobs()));
route('POST', '/api/jobs/:job/cancel', (req, res, m) => json(res, 200, { ok: X.cancelJob(m.job) }));
route('POST', '/api/projects/:id/open-export', async (req, res, m) => {
  const b = await body(req); const f = path.resolve(P.projectDir(m.id), String(b.file || ''));
  if (!f.startsWith(path.join(P.projectDir(m.id), 'exports') + path.sep) || !fs.existsSync(f)) return json(res, 404, { error: 'Not found' });
  openPath(f, !!b.reveal); json(res, 200, { ok: true });
});
route('GET', '/api/projects/:id/exports', (req, res, m) => {
  const d = path.join(P.projectDir(m.id), 'exports'); let list = [];
  try { list = fs.readdirSync(d).filter(f => f.endsWith('.mp4') && !f.endsWith('.part.mp4')).map(f => { const s = fs.statSync(path.join(d, f)); return { file: 'exports/' + f, size: s.size, time: s.mtimeMs }; }).sort((a, b) => b.time - a.time); } catch { }
  json(res, 200, list);
});

route('GET', '/api/agents', async (req, res, m, url) => json(res, 200, await A.checkSignIn(url.searchParams.get('recheck') === '1')));
route('POST', '/api/agents/:agent/signin', (req, res, m) => json(res, 200, A.openSignIn(m.agent)));
route('GET', '/api/projects/:id/chat', (req, res, m) => json(res, 200, A.loadChat(m.id)));
route('POST', '/api/projects/:id/chat', async (req, res, m) => { const b = await body(req); json(res, 200, A.sendChat(m.id, b.text, { context: b.context, agent: b.agent, model: b.model })); });
route('POST', '/api/projects/:id/chat/stop', (req, res, m) => json(res, 200, { ok: A.stopChat(m.id) }));
route('DELETE', '/api/projects/:id/chat', (req, res, m) => { A.clearChat(m.id); json(res, 200, { ok: true }); });

route('GET', '/api/clean', async (req, res) => json(res, 200, await C.scan({ busy: X.busy })));
route('POST', '/api/clean', async (req, res) => {
  if (X.busy()) return json(res, 409, { error: 'Wait until the export has finished.' });
  const b = await body(req); json(res, 200, await C.clean(b.ids || [], { busy: X.busy }));
});

route('GET', '/api/events', (req, res, m, url) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const c = { res, project: url.searchParams.get('project') || null };
  clients.add(c); if (c.project) watchProject(c.project);
  send(res, 'hello', { jobs: X.listJobs() });
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); if (c.project) unwatchProject(c.project); lastActive = Date.now(); });
});

// ---------- the server
const isLoopbackHost = h => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h || '');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: 'Forbidden host' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request refused' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && !isLoopbackHost(new URL(req.headers.origin).host)) return json(res, 403, { error: 'Foreign origin' });

    // project files (scene pages and what they load)
    const pf = /^\/p\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
    if (pf && req.method === 'GET') {
      const dir = P.projectDir(decodeURIComponent(pf[1]));
      const f = path.resolve(dir, decodeURIComponent(pf[2]));
      if (!f.startsWith(dir + path.sep)) return json(res, 403, { error: 'Not allowed' });
      return serveFile(req, res, f);
    }
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.re.exec(url.pathname); if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      return await r.fn(req, res, params, url);
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown API' });
    // the UI
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const f = path.resolve(UI, rel);
    if (!f.startsWith(UI + path.sep) || !fs.existsSync(f)) return serveFile(req, res, path.join(UI, 'index.html'));
    serveFile(req, res, f);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.message || String(e) });
    else res.end();
    if (!e.status) console.error(e);
  }
});
server.requestTimeout = 0;
server.listen(PORT, HOST, () => {
  console.log(`Code Motion on http://${HOST}:${PORT}  (workspace ${workspace()})`);
  // Keep the agents' connection pointing at this copy (after a move or an update). Test servers never touch it.
  if (!process.env.CODEMOTION_NO_WINDOW && !process.env.CODEMOTION_NO_REPAIR)
    setTimeout(() => K.repair().then(f => f.length && console.log('Reconnected:', f.join(', ')), () => { }), 5000).unref();
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use (another Code Motion is probably running).` : e.message); process.exit(1); });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { for (const id of watchers.keys()) unwatchProject(id); process.exit(0); });
