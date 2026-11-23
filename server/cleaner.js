// "Clean up": everything that only takes space. Code Motion's own caches are deleted (they rebuild when needed);
// anything inside a project goes to the Trash, so it can be restored. The user sees the list and ticks what goes.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, workspace } from './env.js';
import { kindOf } from './media.js';
import { moveToTrash } from './trash.js';
import { readJson } from './env.js';

const DAY = 86400000;

async function sizeOf(p, budget = { n: 0 }) {
  let st; try { st = await fs.promises.lstat(p); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0, list = [];
  try { list = await fs.promises.readdir(p); } catch { return 0; }
  for (const e of list) {
    if (++budget.n % 300 === 0) await new Promise(r => setImmediate(r));   // never block the server
    total += await sizeOf(path.join(p, e), budget);
  }
  return total;
}
const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

export async function scan({ busy = () => false } = {}) {
  const items = [];
  const add = async (o) => { const size = o.size ?? await sizeOf(o.path); if (size > 0) items.push({ ...o, size }); };

  // 1. Code Motion's caches
  const caches = { thumbs: 'Timeline thumbnails', strips: 'Timeline film strips', peaks: 'Sound waveforms', proxy: 'Preview copies of videos Chrome cannot play', scenes: 'Drawn motion-graphics scenes (export cache)' };
  for (const [d, label] of Object.entries(caches)) await add({ id: 'cache:' + d, path: path.join(CACHE_DIR, d), group: 'Cache', label, why: 'Rebuilt automatically when needed', action: 'delete', checked: true });
  try { for (const e of fs.readdirSync(CACHE_DIR)) if (e.startsWith('chrome-profile-')) await add({ id: 'cache:' + e, path: path.join(CACHE_DIR, e), group: 'Cache', label: 'Leftover browser profile', why: 'Left by a stopped export', action: 'delete', checked: !busy() }); } catch { }
  await add({ id: 'cache:probe', path: path.join(CACHE_DIR, 'probe.json'), group: 'Cache', label: 'Media info cache', why: 'Rebuilt automatically', action: 'delete', checked: false });

  // 2. inside projects
  let ws; try { ws = workspace(); } catch { return items; }
  for (const e of fs.readdirSync(ws, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(ws, e.name), p = readJson(path.join(dir, 'project.json'));
    if (!p) continue;
    const name = p.name || e.name;
    await add({ id: `tmp:${e.name}`, path: path.join(dir, '.cm', 'tmp'), group: name, label: 'Temporary files', why: 'Scratch files from the agent', action: 'trash', checked: true });
    try {
      for (const f of fs.readdirSync(path.join(dir, 'exports'))) if (/\.part\.mp4$/.test(f)) await add({ id: `part:${e.name}/${f}`, path: path.join(dir, 'exports', f), group: name, label: 'Unfinished export ' + f, why: 'Left by a stopped export', action: 'trash', checked: !busy() });
    } catch { }
    // older exports: keep the newest
    try {
      const ex = fs.readdirSync(path.join(dir, 'exports')).filter(f => /\.mp4$/.test(f) && !/\.part\.mp4$/.test(f)).map(f => path.join(dir, 'exports', f)).sort((a, b) => mtime(b) - mtime(a));
      for (const f of ex.slice(1)) await add({ id: `oldexport:${e.name}/${path.basename(f)}`, path: f, group: name, label: 'Older export ' + path.basename(f), why: 'A newer export of this project exists', action: 'trash', checked: false });
    } catch { }
    // dependencies the agent installed and nobody touched for a week
    for (const nm of findNodeModules(dir)) {
      if (Date.now() - mtime(nm) > 7 * DAY) await add({ id: `deps:${path.relative(ws, nm)}`, path: nm, group: name, label: 'Installed dependencies (' + path.relative(dir, nm) + ')', why: 'Not changed for 7 days; reinstall with npm install', action: 'trash', checked: true });
    }
    // media files in media/ that no clip uses
    const used = new Set((p.clips || []).map(c => path.resolve(dir, c.src)));
    try {
      for (const f of fs.readdirSync(path.join(dir, 'media'))) {
        const abs = path.join(dir, 'media', f);
        if (!kindOf(f) || used.has(abs)) continue;
        await add({ id: `unused:${e.name}/${f}`, path: abs, group: name, label: 'Unused media ' + f, why: 'Not on the timeline', action: 'trash', checked: false });
      }
    } catch { }
  }
  return items;
}

function findNodeModules(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    if (!e.isDirectory() || e.name === '.git' || e.name === '.cm' || e.name === 'exports') continue;
    const p = path.join(dir, e.name);
    if (e.name === 'node_modules') out.push(p); else findNodeModules(p, depth + 1, out);
  }
  return out;
}

export async function clean(ids, opts = {}) {
  const all = await scan(opts), byId = new Map(all.map(i => [i.id, i]));
  let freed = 0, trashed = 0; const errors = [];
  for (const id of ids) {
    const it = byId.get(id); if (!it) continue;
    if (it.action === 'delete') {
      if (!path.resolve(it.path).startsWith(path.resolve(CACHE_DIR) + path.sep)) { errors.push(`${it.label}: not a cache`); continue; }
      try { await fs.promises.rm(it.path, { recursive: true, force: true }); freed += it.size; } catch (e) { errors.push(`${it.label}: ${e.message}`); }
    } else {
      const r = moveToTrash(it.path);
      if (r.ok) trashed += it.size; else errors.push(`${it.label}: ${r.error}`);
    }
  }
  return { freed, trashed, errors };
}
