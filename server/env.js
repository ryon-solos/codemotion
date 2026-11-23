// Where things live and which tools this computer has. Linux first (XDG folders), macOS and Windows best effort.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const APP_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const IS_LINUX = process.platform === 'linux', IS_MAC = process.platform === 'darwin', IS_WIN = process.platform === 'win32';
const HOME = os.homedir();

function xdg(name, fallback) {
  if (process.env[name]) return process.env[name];
  return path.join(HOME, fallback);
}
function userDir(kind, fallback) {
  if (IS_LINUX) { try { const r = spawnSync('xdg-user-dir', [kind], { encoding: 'utf8', timeout: 2000 }); const d = r.stdout?.trim(); if (d && d !== HOME) return d; } catch { } }
  return path.join(HOME, fallback);
}

export const CONFIG_DIR = process.env.CODEMOTION_CONFIG_DIR || (IS_WIN ? path.join(process.env.APPDATA || HOME, 'CodeMotion') : IS_MAC ? path.join(HOME, 'Library/Application Support/CodeMotion') : path.join(xdg('XDG_CONFIG_HOME', '.config'), 'codemotion'));
export const CACHE_DIR = process.env.CODEMOTION_CACHE_DIR || (IS_WIN ? path.join(process.env.LOCALAPPDATA || HOME, 'CodeMotion', 'cache') : IS_MAC ? path.join(HOME, 'Library/Caches/CodeMotion') : path.join(xdg('XDG_CACHE_HOME', '.cache'), 'codemotion'));
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  port: 7790,
  workspace: process.env.CODEMOTION_WORKSPACE || path.join(userDir('VIDEOS', 'Videos'), 'CodeMotion'),
  agent: 'auto',            // auto | claude | codex | opencode
  agentAccess: 'edits',     // edits: file edits + safe media commands; full: no permission checks
  exportThreads: Math.max(2, Math.floor(os.cpus().length / 2)),
  idleMinutes: 3,
  exportQuality: 'standard',   // small | standard | high
};

let config = null;
export function getConfig() {
  if (config) return config;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { }
  config = { ...DEFAULTS, ...saved };
  if (process.env.CODEMOTION_PORT) config.port = +process.env.CODEMOTION_PORT;
  if (process.env.CODEMOTION_WORKSPACE) config.workspace = process.env.CODEMOTION_WORKSPACE;
  return config;
}
export function setConfig(patch) {
  const allowed = ['workspace', 'agent', 'agentAccess', 'exportThreads', 'idleMinutes', 'exportQuality'];
  const c = getConfig();
  for (const k of allowed) if (k in patch) c[k] = patch[k];
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const toSave = {}; for (const k of allowed) toSave[k] = c[k];
  writeJson(CONFIG_FILE, toSave);
  return c;
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ---- tools
function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of IS_WIN ? ['.exe', '.cmd', ''] : ['']) {
      const f = path.join(dir, name + ext);
      try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { }
    }
  }
  return null;
}
export const which = onPath;

let tools = null;
export function getTools() {
  if (tools) return tools;
  tools = {
    ffmpeg: process.env.FFMPEG || onPath('ffmpeg'),
    ffprobe: process.env.FFPROBE || onPath('ffprobe'),
    browser: findBrowser(),
    zenity: IS_LINUX ? onPath('zenity') : null,
    kdialog: IS_LINUX ? onPath('kdialog') : null,
    gio: IS_LINUX ? onPath('gio') : null,
    trashPut: IS_LINUX ? onPath('trash-put') : null,
    nice: !IS_WIN ? onPath('nice') : null,
    ionice: IS_LINUX ? onPath('ionice') : null,
    notify: IS_LINUX ? onPath('notify-send') : null,
  };
  return tools;
}

function findBrowser() {
  const c = [process.env.CODEMOTION_BROWSER];
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) c.push(onPath(n));
  if (IS_MAC) for (const n of ['Google Chrome', 'Microsoft Edge', 'Chromium']) c.push(`/Applications/${n}.app/Contents/MacOS/${n}`);
  if (IS_WIN) c.push('C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  for (const f of c) {
    if (!f) continue;
    try {
      const real = fs.realpathSync(f);
      if (/[\\/](snap|flatpak)[\\/]/.test(real)) continue;   // wrappers cannot be driven headless reliably
      fs.accessSync(real, fs.constants.X_OK);
      return f;
    } catch { }
  }
  return null;
}

// Run heavy work politely: low CPU and disk priority on Linux/macOS.
export function politeSpawnArgs(cmd, args) {
  const t = getTools();
  if (IS_WIN) return [cmd, args];
  if (t.ionice && t.nice) return [t.ionice, ['-c', '3', t.nice, '-n', '12', cmd, ...args]];
  if (t.nice) return [t.nice, ['-n', '12', cmd, ...args]];
  return [cmd, args];
}

export function workspace() {
  const w = getConfig().workspace;
  fs.mkdirSync(w, { recursive: true });
  return w;
}
