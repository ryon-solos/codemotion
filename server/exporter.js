// Export: code scenes are drawn frame by frame in headless Chrome (cached), then one ffmpeg call lays every track
// together. One export at a time, at low priority, with a limited number of threads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CACHE_DIR, getConfig, getTools, politeSpawnArgs } from './env.js';
import { loadProject, projectDir, resolveSrc, slugify } from './projects.js';
import { probe } from './media.js';
import { openBrowser } from './cdp.js';

const jobs = []; let current = null; let listener = () => { };
export function onJob(fn) { listener = fn; }
const emit = j => listener(publicJob(j));
const publicJob = j => ({ id: j.id, project: j.project, status: j.status, progress: j.progress, message: j.message, file: j.file, error: j.error, started: j.started, finished: j.finished });
export function listJobs() { return jobs.slice(-20).map(publicJob); }
export function busy() { return jobs.some(j => j.status === 'queued' || j.status === 'running'); }

export function startExport(projectId, baseUrl) {
  if (jobs.some(j => j.project === projectId && (j.status === 'queued' || j.status === 'running'))) throw Object.assign(new Error('This project is already exporting'), { status: 409 });
  const job = { id: 'j' + Date.now().toString(36), project: projectId, status: 'queued', progress: 0, message: 'Waiting', baseUrl, procs: new Set(), started: Date.now() };
  jobs.push(job); emit(job); pump();
  return publicJob(job);
}
export function cancelJob(id) {
  const j = jobs.find(x => x.id === id);
  if (!j || (j.status !== 'queued' && j.status !== 'running')) return false;
  j.cancelled = true; j.status = 'cancelled'; j.message = 'Stopped';
  for (const p of j.procs) { try { p.kill('SIGKILL'); } catch { } }
  j.closeBrowser?.();
  emit(j); return true;
}

async function pump() {
  if (current) return;
  const job = jobs.find(j => j.status === 'queued');
  if (!job) return;
  current = job; job.status = 'running'; emit(job);
  try {
    await runExport(job);
    if (!job.cancelled) { job.status = 'done'; job.progress = 1; job.message = 'Saved ' + path.basename(job.file); }
  } catch (e) {
    if (!job.cancelled) { job.status = 'failed'; job.error = e.message; job.message = 'Export failed'; }
  }
  job.finished = Date.now(); emit(job); current = null;
  if (job.tmpOut) fs.rm(job.tmpOut, { force: true }, () => { });
  pump();
}

async function runExport(job) {
  const p = loadProject(job.project), dir = projectDir(job.project);
  const total = timelineEnd(p);
  if (total <= 0) throw new Error('The timeline is empty');
  const hiddenTracks = new Set(p.tracks.filter(t => t.hidden).map(t => t.id)), mutedTracks = new Set(p.tracks.filter(t => t.muted).map(t => t.id));

  // 1. scenes → cached transparent videos
  const sceneClips = p.clips.filter(c => c.type === 'scene' && !hiddenTracks.has(c.track));
  const sceneFiles = new Map();
  const scenes = [...new Set(sceneClips.map(c => c.src))];
  for (let i = 0; i < scenes.length; i++) {
    if (job.cancelled) return;
    job.message = `Drawing scene ${i + 1} of ${scenes.length}`; emit(job);
    sceneFiles.set(scenes[i], await renderScene(job, p, scenes[i], frac => { job.progress = 0.4 * (i + frac) / scenes.length; emit(job); }));
  }

  // 2. one ffmpeg graph
  job.message = 'Encoding'; emit(job);
  const { args } = await buildCommand(p, job.project, sceneFiles, { hiddenTracks, mutedTracks, total });
  const outDir = path.join(dir, 'exports'); fs.mkdirSync(outDir, { recursive: true });
  let n = 1; const base = slugify(p.name);
  while (fs.existsSync(path.join(outDir, `${base}_v${n}.mp4`))) n++;
  const out = path.join(outDir, `${base}_v${n}.mp4`), tmp = out.replace(/\.mp4$/, '.part.mp4');
  job.tmpOut = tmp;
  const threads = String(getConfig().exportThreads || 2);
  const full = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String({ small: 26, standard: 20, high: 16 }[getConfig().exportQuality] || 20), '-pix_fmt', 'yuv420p', '-threads', threads, '-filter_threads', threads,
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', String(total), tmp];
  await ffmpeg(job, full, sec => { job.progress = (sceneClips.length ? 0.4 : 0) + (sceneClips.length ? 0.6 : 1) * Math.min(1, sec / total); emit(job); });
  if (job.cancelled) return;
  fs.renameSync(tmp, out); job.tmpOut = null;
  job.file = path.relative(dir, out);
}

export function timelineEnd(p) {
  return p.clips.reduce((m, c) => Math.max(m, c.start + (c.out - c.in)), 0);
}

export async function buildCommand(p, projectId, sceneFiles, { hiddenTracks = new Set(), mutedTracks = new Set(), total = timelineEnd(p) } = {}) {
  const W = p.width, H = p.height, fps = p.fps, args = [], f = [], audio = [];
  let n = 0;
  const input = (file, pre = []) => { args.push(...pre, '-i', file); return n++; };
  f.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${total.toFixed(3)},format=yuv420p[base]`);
  let cur = 'base', k = 0;
  const videoTracks = p.tracks.filter(t => t.kind === 'video' && !hiddenTracks.has(t.id)).reverse();   // bottom first
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,format=rgba,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
  for (const t of videoTracks) {
    for (const c of p.clips.filter(c => c.track === t.id).sort((a, b) => a.start - b.start)) {
      const dur = c.out - c.in, end = c.start + dur;
      let label;
      if (c.type === 'image') {
        const i = input(resolveSrc(projectId, c.src), ['-loop', '1', '-framerate', String(fps), '-t', dur.toFixed(3)]);
        label = `[${i}:v]fps=${fps},${fit}`;
      } else if (c.type === 'scene') {
        const file = sceneFiles.get(c.src); if (!file) continue;
        const i = input(file);
        label = `[${i}:v]trim=start=${c.in}:end=${c.out},setpts=PTS-STARTPTS,fps=${fps},${fit}`;
      } else if (c.type === 'video') {
        const file = resolveSrc(projectId, c.src); if (!fs.existsSync(file)) continue;
        const info = await probe(file);
        const i = input(file);
        if (info.hasVideo) label = `[${i}:v]trim=start=${c.in}:end=${c.out},setpts=PTS-STARTPTS,fps=${fps},${fit}`;
        if (info.hasAudio && !c.muted && c.volume > 0 && !mutedTracks.has(c.track)) audio.push({ i, c });
      }
      if (!label) continue;
      f.push(`${label},setpts=PTS+${c.start.toFixed(3)}/TB[v${k}]`);
      f.push(`[${cur}][v${k}]overlay=eof_action=pass:enable='between(t,${c.start.toFixed(3)},${end.toFixed(3)})'[o${k}]`);
      cur = `o${k}`; k++;
    }
  }
  for (const c of p.clips.filter(c => c.type === 'audio' && !c.muted && c.volume > 0 && !mutedTracks.has(c.track))) {
    const file = resolveSrc(projectId, c.src); if (!fs.existsSync(file)) continue;
    audio.push({ i: input(file), c });
  }
  f.push(`[${cur}]format=yuv420p[vout]`);
  if (audio.length) {
    const labels = audio.map(({ i, c }, j) => {
      const ms = Math.round(c.start * 1000);
      f.push(`[${i}:a]atrim=start=${c.in}:end=${c.out},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${c.volume}${ms ? `,adelay=${ms}:all=1` : ''}[a${j}]`);
      return `[a${j}]`;
    });
    f.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(3)}[aout]`);
  } else {
    const i = input(`anullsrc=r=48000:cl=stereo`, ['-f', 'lavfi', '-t', total.toFixed(3)]);
    f.push(`[${i}:a]anull[aout]`);
  }
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-r', String(fps));
  return { args };
}

function ffmpeg(job, args, onTime) {
  return new Promise((resolve, reject) => {
    const [cmd, a] = politeSpawnArgs(getTools().ffmpeg, args);
    const p = spawn(cmd, a, { stdio: ['pipe', 'pipe', 'pipe'] });
    job.procs.add(p);
    let err = '', buf = '';
    p.stdout.on('data', d => {
      buf += d; const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) { const m = /^out_time_us=(\d+)/.exec(l); if (m) onTime(+m[1] / 1e6); }
    });
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', code => { job.procs.delete(p); code === 0 || job.cancelled ? resolve() : reject(new Error(err.trim().split('\n').slice(-2).join(' ') || 'ffmpeg failed')); });
  });
}

// ---- scenes
function sceneKey(dir, p) {
  const h = crypto.createHash('sha1').update(`${p.width}x${p.height}@${p.fps}`);
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { const s = fs.statSync(f); h.update(`${f}|${s.size}|${s.mtimeMs}`); } } };
  walk(dir);
  return h.digest('hex').slice(0, 20);
}
export function sceneCacheDir() { return path.join(CACHE_DIR, 'scenes'); }

async function renderScene(job, p, src, onProgress) {
  const dir = resolveSrc(job.project, src);
  const out = path.join(sceneCacheDir(), sceneKey(dir, p) + '.mov');
  if (fs.existsSync(out)) { onProgress(1); return out; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')); } catch { }
  const dur = +meta.duration > 0 ? +meta.duration : 5, frames = Math.max(1, Math.round(dur * p.fps));
  const { page, close } = await openBrowser();
  job.closeBrowser = close;
  const tmp = out + '.part.mov';
  try {
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: p.width, height: p.height, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await page.send('Page.navigate', { url: `${job.baseUrl}/p/${encodeURIComponent(job.project)}/files/${src}/index.html` });
    let ready = false;
    for (let i = 0; i < 300 && !ready; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { ready = await page.eval('window.READY === true || (typeof window.renderOut === "function" && document.readyState === "complete" && (window.__cmWait = (window.__cmWait || 0) + 1) > 50)', 5000); } catch { }
    }
    if (!(await page.eval('typeof window.renderOut === "function"'))) throw new Error(`Scene ${src} has no window.renderOut(t)`);
    const [cmd, a] = politeSpawnArgs(getTools().ffmpeg, ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(p.fps), '-c:v', 'png', '-i', '-', '-c:v', 'png', '-pix_fmt', 'rgba', '-threads', '2', tmp]);
    const ff = spawn(cmd, a, { stdio: ['pipe', 'ignore', 'pipe'] });
    job.procs.add(ff);
    let err = ''; ff.stderr.on('data', d => { err = (err + d).slice(-2000); });
    const done = new Promise((res, rej) => ff.on('close', c => { job.procs.delete(ff); c === 0 ? res() : rej(new Error(err || 'Scene encode failed')); }));
    for (let fr = 0; fr < frames; fr++) {
      if (job.cancelled) { ff.kill('SIGKILL'); throw new Error('cancelled'); }
      await page.eval(`window.renderOut(${(fr / p.fps).toFixed(6)}); 0`);
      const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const buf = Buffer.from(shot.data, 'base64');
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (fr % 10 === 0) onProgress(fr / frames);
    }
    ff.stdin.end();
    await done;
    fs.renameSync(tmp, out);
    onProgress(1);
    return out;
  } finally {
    close(); job.closeBrowser = null;
    fs.rm(tmp, { force: true }, () => { });
  }
}
