// Reversible removal: the desktop Trash / Recycle Bin. Never a silent permanent delete for user files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { IS_LINUX, IS_MAC, IS_WIN, getTools } from './env.js';

export function moveToTrash(target) {
  if (!fs.existsSync(target)) return { ok: true, missing: true };
  const t = getTools();
  if (IS_LINUX) {
    if (t.gio && spawnSync(t.gio, ['trash', target], { timeout: 60000 }).status === 0) return { ok: true };
    if (t.trashPut && spawnSync(t.trashPut, [target], { timeout: 60000 }).status === 0) return { ok: true };
    return freedesktopTrash(target);
  }
  if (IS_MAC) {
    const r = spawnSync('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(path.resolve(target))}`], { timeout: 60000 });
    return r.status === 0 ? { ok: true } : { ok: false, error: 'Finder refused to move it to the Trash' };
  }
  if (IS_WIN) {
    const isDir = fs.statSync(target).isDirectory();
    const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${isDir ? 'DeleteDirectory' : 'DeleteFile'}($env:CM_TARGET,'OnlyErrorDialogs','SendToRecycleBin')`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, CM_TARGET: target }, timeout: 120000 });
    return r.status === 0 ? { ok: true } : { ok: false, error: 'The Recycle Bin refused it' };
  }
  return { ok: false, error: 'No Trash on this system' };
}

// Home-filesystem freedesktop Trash, written by hand (restorable from the file manager).
function freedesktopTrash(target) {
  try {
    const base = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'Trash');
    if (fs.statSync(target).dev !== fs.statSync(os.homedir()).dev) return { ok: false, error: 'Not on the home drive; no safe Trash' };
    fs.mkdirSync(path.join(base, 'files'), { recursive: true }); fs.mkdirSync(path.join(base, 'info'), { recursive: true });
    let name = path.basename(target), i = 1;
    while (fs.existsSync(path.join(base, 'files', name))) name = `${path.basename(target)}.${i++}`;
    const info = `[Trash Info]\nPath=${encodeURI(path.resolve(target))}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`;
    fs.writeFileSync(path.join(base, 'info', name + '.trashinfo'), info);
    fs.renameSync(target, path.join(base, 'files', name));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
