// Projects: one folder per project in the workspace, its edit in project.json.
//   project.json   the timeline (tracks + clips), size, fps, the media bin
//   media/         files copied in (files picked from disk are used where they are, nothing copied)
//   scenes/<name>/ motion graphics written as code (index.html with window.renderOut(t))
//   exports/       finished videos
//   .cm/           Code Motion's own small files (chat history)
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, readJson, workspace, writeJson } from './env.js';
import { kindOf, probe } from './media.js';
import { moveToTrash } from './trash.js';

export const PROJECT_FILE = 'project.json';

export function slugify(name) {
  return String(name || 'video').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 48) || 'video';
}
export function projectDir(id) {
  if (!/^[\w.-]+$/.test(id) || id.startsWith('.')) throw httpError(400, 'Bad project id');
  return path.join(workspace(), id);
}
export function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

export function emptyProject(name) {
  const now = new Date().toISOString();
  return {
    app: 'codemotion', version: 1, name, created: now, updated: now, rev: 1,
    width: 1920, height: 1080, fps: 30,
    tracks: [
      { id: 'v2', kind: 'video', name: 'Video 2' },
      { id: 'v1', kind: 'video', name: 'Video 1' },
      { id: 'a1', kind: 'audio', name: 'Audio 1' },
      { id: 'a2', kind: 'audio', name: 'Audio 2' },
    ],
    clips: [],
    media: [],
  };
}

// Keep whatever an agent or a person wrote usable: fill defaults, drop clips that make no sense.
export function normalize(p) {
  const d = emptyProject(p?.name || 'Untitled');
  const out = { ...d, ...p };
  out.width = Math.max(16, Math.round(+out.width || 1920)); out.height = Math.max(16, Math.round(+out.height || 1080));
  out.fps = Math.min(120, Math.max(1, +out.fps || 30));
  out.tracks = Array.isArray(out.tracks) && out.tracks.length ? out.tracks.filter(t => t && t.id && (t.kind === 'video' || t.kind === 'audio')) : d.tracks;
  const trackIds = new Set(out.tracks.map(t => t.id));
  const seen = new Set();
  out.clips = (Array.isArray(out.clips) ? out.clips : []).filter(c => c && c.src && trackIds.has(c.track)).map((c, i) => {
    let id = String(c.id || 'c' + i); while (seen.has(id)) id += 'x'; seen.add(id);
    const start = Math.max(0, +c.start || 0), inP = Math.max(0, +c.in || 0);
    let outP = +c.out; if (!(outP > inP)) outP = inP + (+c.duration > 0 ? +c.duration : 5);
    return { ...c, id, start: round(start), in: round(inP), out: round(outP), volume: c.volume == null ? 1 : Math.max(0, Math.min(4, +c.volume)), muted: !!c.muted, type: c.type || typeFromSrc(c.src) };
  });
  out.media = Array.isArray(out.media) ? out.media.filter(m => m && m.src) : [];
  return out;
}
const round = x => Math.round(x * 1000) / 1000;
function typeFromSrc(src) { return /^scenes\//.test(src) ? 'scene' : kindOf(src) || 'video'; }

export function listProjects() {
  const ws = workspace(), res = [];
  for (const e of fs.readdirSync(ws, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const f = path.join(ws, e.name, PROJECT_FILE);
    const p = readJson(f);
    if (!p) continue;
    let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch { }
    const clips = Array.isArray(p.clips) ? p.clips : [];
    const duration = clips.reduce((m, c) => Math.max(m, (+c.start || 0) + ((+c.out || 0) - (+c.in || 0))), 0);
    const coverFile = path.join(ws, e.name, '.cm', 'cover.jpg');
    let cover = null;
    if (fs.existsSync(coverFile)) cover = { file: true, v: Math.round(fs.statSync(coverFile).mtimeMs) };
    else { const c = clips.find(c => c.type === 'video' || c.type === 'image' || (!c.type && kindOf(c.src) === 'video')); if (c) cover = { src: c.src, at: +c.in || 0 }; }
    let exports = 0; try { exports = fs.readdirSync(path.join(ws, e.name, 'exports')).filter(x => x.endsWith('.mp4') && !x.endsWith('.part.mp4')).length; } catch { }
    const notes = (readJson(path.join(ws, e.name, '.cm', 'notes.json'), { notes: [] }).notes || []).filter(n => n.status !== 'fixed').length;
    const origin = readJson(path.join(ws, e.name, '.cm', 'origin.json'), null);
    res.push({ id: e.name, name: p.name || e.name, folder: p.folder || null, updated: mtime, duration: round(duration), clips: clips.length, cover, exports, notes, agent: origin?.agent || null, width: p.width, height: p.height });
  }
  return res.sort((a, b) => b.updated - a.updated);
}

// ---- folders (groups of projects): names in <workspace>/.codemotion.json, membership in each project.json
const metaFile = () => path.join(workspace(), '.codemotion.json');
export function listFolders() { return readJson(metaFile(), { folders: [] }).folders || []; }
export function addFolder(name) {
  name = String(name || '').trim().slice(0, 60); if (!name) throw httpError(400, 'Give the folder a name');
  const folders = listFolders();
  let id = slugify(name), i = 2; while (folders.some(f => f.id === id)) id = `${slugify(name)}-${i++}`;
  folders.push({ id, name }); writeJson(metaFile(), { folders });
  return { id, name };
}
export function renameFolder(fid, name) {
  const folders = listFolders(), f = folders.find(x => x.id === fid); if (!f) throw httpError(404, 'Folder not found');
  f.name = String(name || '').trim().slice(0, 60) || f.name; writeJson(metaFile(), { folders }); return f;
}
export function deleteFolder(fid) {   // the projects stay; they just leave the folder
  writeJson(metaFile(), { folders: listFolders().filter(f => f.id !== fid) });
  for (const p of listProjects()) if (p.folder === fid) setFolder(p.id, null);
}
export function setFolder(id, fid) {
  if (fid && !listFolders().some(f => f.id === fid)) throw httpError(404, 'Folder not found');
  const p = loadProject(id); p.folder = fid || null; return saveProject(id, p);
}

export function createProject(name, { folder = null, film = false, width, height, fps } = {}) {
  name = String(name || '').trim() || 'New video';
  const ws = workspace();
  let id = slugify(name), i = 2;
  while (fs.existsSync(path.join(ws, id))) id = `${slugify(name)}-${i++}`;
  const dir = path.join(ws, id);
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scenes'), { recursive: true });
  const p = emptyProject(name);
  if (folder && listFolders().some(f => f.id === folder)) p.folder = folder;
  if (width > 0 && height > 0) { p.width = Math.round(width); p.height = Math.round(height); }
  if (fps > 0) p.fps = +fps;
  writeJson(path.join(dir, PROJECT_FILE), p);
  writeAgentGuide(dir);
  if (film) {   // a full-frame film written as code, already on the timeline
    const src = newScene(id, 'Film', 'film');
    const q = loadProject(id);
    q.clips.push({ id: 'film', track: 'v1', type: 'scene', src, start: 0, in: 0, out: 10, name: 'Film' });
    saveProject(id, q);
  }
  return id;
}

// The project that lives in a folder (or contains it): lets agents say "this folder".
export function findProject(ref) {
  if (!ref) return null;
  const ws = workspace();
  if (/^[\w.-]+$/.test(ref) && fs.existsSync(path.join(ws, ref, PROJECT_FILE))) return ref;
  let d = path.resolve(String(ref));
  while (d.startsWith(ws + path.sep)) {
    if (path.dirname(d) === ws && fs.existsSync(path.join(d, PROJECT_FILE))) return path.basename(d);
    d = path.dirname(d);
  }
  const byName = listProjects().find(p => p.name.toLowerCase() === String(ref).toLowerCase());
  return byName ? byName.id : null;
}

// Every project folder explains itself to any coding agent opened in it (Claude Code, Codex, OpenCode...).
export function writeAgentGuide(dir) {
  const guide = fs.readFileSync(path.join(APP_DIR, 'server', 'agent-guide.md'), 'utf8');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const target = path.join(dir, f);
    if (!fs.existsSync(target)) fs.writeFileSync(target, guide);
  }
}

// `version` is the file's modification stamp, never stored: it changes with every write, also with an agent's
// edit that leaves `rev` alone, so the editor notices agent changes and never saves over one it has not seen.
const fileVersion = f => { try { return String(fs.statSync(f).mtimeMs); } catch { return null; } };

export function loadProject(id) {
  const f = path.join(projectDir(id), PROJECT_FILE);
  const p = readJson(f);
  if (!p) throw httpError(404, 'Project not found');
  const out = normalize(p); out.version = fileVersion(f);
  return out;
}

export function saveProject(id, data, baseVersion) {
  const f = path.join(projectDir(id), PROJECT_FILE);
  const cur = readJson(f);
  if (!cur) throw httpError(404, 'Project not found');
  if (baseVersion != null && String(baseVersion) !== fileVersion(f)) throw httpError(409, 'The project changed meanwhile');
  const next = normalize({ ...data, rev: (+cur.rev || 0) + 1, updated: new Date().toISOString(), created: cur.created });
  delete next.version;
  writeJson(f, next);
  next.version = fileVersion(f);
  return next;
}

export function renameProject(id, name) {
  const p = loadProject(id);
  p.name = String(name || '').trim() || p.name;
  return saveProject(id, p);
}

export function trashProject(id) {
  const r = moveToTrash(projectDir(id));
  if (!r.ok) throw httpError(500, r.error);
  return r;
}

// A path a project may use: inside the project folder, or a file the project points to.
export function resolveSrc(id, src) {
  const dir = projectDir(id);
  const abs = path.isAbsolute(src) ? path.normalize(src) : path.resolve(dir, src);
  return abs;
}
export function isAllowed(id, abs) {
  const dir = projectDir(id) + path.sep;
  if (abs.startsWith(dir)) return true;
  const p = loadProject(id);
  return p.media.some(m => path.resolve(m.src) === abs) || p.clips.some(c => path.isAbsolute(c.src) && path.resolve(c.src) === abs);
}

// The bin: files under media/, files picked from elsewhere, and the code scenes.
export async function listMedia(id) {
  const dir = projectDir(id), p = loadProject(id), items = [], seen = new Set();
  const add = async (src, abs, name) => {
    if (seen.has(abs)) return; seen.add(abs);
    if (!fs.existsSync(abs)) { items.push({ src, name, kind: kindOf(abs), missing: true }); return; }
    const info = await probe(abs);
    items.push({ src, name, ...info });
  };
  try {
    for (const f of fs.readdirSync(path.join(dir, 'media')).sort()) {
      if (f.startsWith('.') || !kindOf(f)) continue;
      await add('media/' + f, path.join(dir, 'media', f), f);
    }
  } catch { }
  for (const m of p.media) await add(m.src, resolveSrc(id, m.src), m.name || path.basename(m.src));
  for (const s of listScenes(id)) items.push(s);
  return items;
}

export function listScenes(id) {
  const dir = path.join(projectDir(id), 'scenes'), res = [];
  let names = []; try { names = fs.readdirSync(dir); } catch { }
  for (const n of names.sort()) {
    const page = path.join(dir, n, 'index.html');
    if (!fs.existsSync(page)) continue;
    const meta = readJson(path.join(dir, n, 'scene.json'), {});
    res.push({ src: `scenes/${n}`, name: meta.name || n, kind: 'scene', duration: +meta.duration > 0 ? +meta.duration : 5, transparent: meta.transparent !== false, hasAudio: false, hasVideo: true });
  }
  return res;
}

export function addExternalMedia(id, files) {
  const p = loadProject(id);
  const known = new Set(p.media.map(m => path.resolve(m.src)));
  const dir = projectDir(id) + path.sep;
  for (const f of files) {
    const abs = path.resolve(f);
    if (!kindOf(abs) || !fs.existsSync(abs)) continue;
    if (abs.startsWith(dir) || known.has(abs)) continue;
    p.media.push({ src: abs, name: path.basename(abs) }); known.add(abs);
  }
  return saveProject(id, p);
}

// Save an uploaded file stream into media/ under a free name.
export function uploadTarget(id, name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ()]/g, '_');
  if (!kindOf(base)) throw httpError(400, 'Not a video, audio or image file');
  const mdir = path.join(projectDir(id), 'media'); fs.mkdirSync(mdir, { recursive: true });
  let target = path.join(mdir, base), i = 2;
  const ext = path.extname(base), stem = base.slice(0, -ext.length);
  while (fs.existsSync(target)) target = path.join(mdir, `${stem} (${i++})${ext}`);
  return target;
}

export function newScene(id, name, template = 'scene') {
  const dir = path.join(projectDir(id), 'scenes');
  let slug = slugify(name || 'title'), i = 2;
  while (fs.existsSync(path.join(dir, slug))) slug = `${slugify(name || 'title')}-${i++}`;
  const target = path.join(dir, slug);
  fs.mkdirSync(target, { recursive: true });
  const tpl = path.join(APP_DIR, 'templates', template === 'film' ? 'film' : 'scene');
  for (const f of fs.readdirSync(tpl)) fs.copyFileSync(path.join(tpl, f), path.join(target, f));
  const meta = readJson(path.join(target, 'scene.json'), {}); meta.name = name || slug;
  const p = loadProject(id);
  try { const html = path.join(target, 'index.html'); fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replaceAll('width="1920" height="1080"', `width="${p.width}" height="${p.height}"`)); } catch { }
  writeJson(path.join(target, 'scene.json'), meta);
  return `scenes/${slug}`;
}
