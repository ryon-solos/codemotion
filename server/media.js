// Media facts and small derived files (probe, thumbnail, waveform, browser-friendly proxy).
// Everything derived goes to the cache folder, is made only when the UI asks, one ffmpeg at a time, at low priority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CACHE_DIR, getTools, politeSpawnArgs, readJson, writeJson } from './env.js';

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac']);
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export function kindOf(file) {
  const e = path.extname(file).toLowerCase();
  return VIDEO_EXT.has(e) ? 'video' : AUDIO_EXT.has(e) ? 'audio' : IMAGE_EXT.has(e) ? 'image' : null;
}

// one queue for every ffmpeg/ffprobe job made for the UI, so browsing never loads the machine
const queue = []; let running = 0; const MAX = 1;
function enqueue(fn) {
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
function pump() {
  while (running < MAX && queue.length) {
    const { fn, resolve, reject } = queue.shift(); running++;
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { running--; pump(); });
  }
}
export function run(cmd, args, { polite = true, timeout = 120000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const [c, a] = polite ? politeSpawnArgs(cmd, args) : [cmd, args];
    const p = spawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { if (err.length < 200) err.push(d); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0) resolve(binary ? buf : buf.toString('utf8'));
      else reject(new Error(Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' ') || `${path.basename(cmd)} exited ${code}`));
    });
  });
}

function keyFor(file, extra = '') {
  const st = fs.statSync(file);
  return crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}|${extra}`).digest('hex').slice(0, 20);
}

// ---- probe (cached by path + size + mtime)
const probeFile = () => path.join(CACHE_DIR, 'probe.json');
let probeCache = null;
export async function probe(file) {
  probeCache ??= readJson(probeFile(), {});
  const k = keyFor(file);
  if (probeCache[k]) return probeCache[k];
  const kind = kindOf(file);
  const t = getTools();
  let info = { kind, duration: kind === 'image' ? 5 : 0, width: 0, height: 0, hasAudio: kind === 'audio', hasVideo: kind !== 'audio', vcodec: null, acodec: null, fps: 30 };
  if (t.ffprobe) {
    try {
      const j = JSON.parse(await enqueue(() => run(t.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30000 })));
      const v = j.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic), a = j.streams?.find(s => s.codec_type === 'audio');
      const dur = parseFloat(j.format?.duration) || parseFloat(v?.duration) || parseFloat(a?.duration) || 0;
      const [fn, fd] = String(v?.avg_frame_rate || v?.r_frame_rate || '30/1').split('/').map(Number);
      info = {
        kind, duration: kind === 'image' ? 5 : +dur.toFixed(3),
        width: v?.width || 0, height: v?.height || 0,
        hasVideo: !!v && kind !== 'audio', hasAudio: !!a,
        vcodec: v?.codec_name || null, acodec: a?.codec_name || null,
        fps: fd ? Math.round((fn / fd) * 100) / 100 || 30 : 30,
      };
    } catch (e) { info.error = e.message; }
  }
  probeCache[k] = info;
  saveProbeSoon();
  return info;
}
let probeTimer = null;
function saveProbeSoon() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => { try { writeJson(probeFile(), probeCache); } catch { } }, 1500);
}

// Can Chrome play it as is? If not, the preview uses a small proxy (the export always uses the original).
const OK_V = new Set(['h264', 'vp8', 'vp9', 'av1']), OK_A = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le']);
export function needsProxy(info) {
  if (info.kind !== 'video') return false;
  if (info.vcodec && !OK_V.has(info.vcodec)) return true;
  if (info.acodec && !OK_A.has(info.acodec)) return true;
  return false;
}

const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p); return p;
}

export async function proxy(file) {
  const out = path.join(CACHE_DIR, 'proxy', keyFor(file) + '.mp4');
  if (fs.existsSync(out)) return out;
  return once(out, () => enqueue(async () => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = out + '.part.mp4';
    await run(getTools().ffmpeg, ['-y', '-v', 'error', '-i', file, '-vf', 'scale=-2:540', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-threads', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp], { timeout: 3600000 });
    fs.renameSync(tmp, out); return out;
  }));
}

export async function thumbnail(file, at = 0) {
  const kind = kindOf(file);
  if (kind === 'audio') return null;
  const out = path.join(CACHE_DIR, 'thumbs', keyFor(file, String(Math.round(at * 10))) + '.jpg');
  if (fs.existsSync(out)) return out;
  return once(out, () => enqueue(async () => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const args = ['-y', '-v', 'error'];
    if (kind === 'video' && at > 0) args.push('-ss', String(at));
    args.push('-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', out);
    await run(getTools().ffmpeg, args, { timeout: 30000 });
    return out;
  }));
}

// film strip: 24 small frames side by side, spread over the whole file (the timeline shows the part a clip uses)
export const STRIP_N = 24;
export async function strip(file) {
  if (kindOf(file) !== 'video') return thumbnail(file, 0);
  const out = path.join(CACHE_DIR, 'strips', keyFor(file) + '.jpg');
  if (fs.existsSync(out)) return out;
  const info = await probe(file);
  return once(out, () => enqueue(async () => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const dur = Math.max(0.5, info.duration || 1);
    await run(getTools().ffmpeg, ['-y', '-v', 'error', '-skip_frame', 'nokey', '-i', file, '-vf', `fps=${STRIP_N}/${dur.toFixed(3)},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=${STRIP_N}x1`, '-frames:v', '1', '-q:v', '6', out], { timeout: 120000 })
      .catch(() => run(getTools().ffmpeg, ['-y', '-v', 'error', '-i', file, '-vf', `fps=${STRIP_N}/${dur.toFixed(3)},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=${STRIP_N}x1`, '-frames:v', '1', '-q:v', '6', out], { timeout: 300000 }));
    return out;
  }));
}

// waveform: 50 peaks per second, 0..255
export async function peaks(file) {
  const out = path.join(CACHE_DIR, 'peaks', keyFor(file) + '.json');
  const c = readJson(out);
  if (c) return c;
  return once(out, () => enqueue(async () => {
    const rate = 2000, per = 40;   // 2000 samples/s, 40 per peak → 50 peaks/s
    const buf = await run(getTools().ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { binary: true, timeout: 600000 });
    const n = Math.floor(buf.length / 2), res = [];
    for (let i = 0; i < n; i += per) {
      let m = 0;
      for (let j = i; j < Math.min(n, i + per); j++) { const v = Math.abs(buf.readInt16LE(j * 2)); if (v > m) m = v; }
      res.push(Math.min(255, Math.round(Math.sqrt(m / 32768) * 255)));
    }
    const data = { perSecond: rate / per, peaks: res };
    writeJson(out, data);
    return data;
  }));
}
