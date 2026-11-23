// Code Motion setup: checks this computer, makes the projects folder, adds the app to the menu and connects the
// coding agent running the setup (or, from a plain terminal, every agent found). Safe to run again at any time.
//   node scripts/setup.mjs [--agents auto|all|none|claude,opencode,codex] [--desktop] [--no-menu] [--dry-run] [--uninstall]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_DIR, CONFIG_DIR, IS_LINUX, getConfig, getTools, workspace } from '../server/env.js';
import { detectAgents, AGENT_NAMES } from '../server/agent.js';
import * as K from '../server/connect.js';

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DRY = flag('--dry-run'), tty = process.stdout.isTTY;
const c = (n, s) => tty ? `\x1b[${n}m${s}\x1b[0m` : s;
const ok = s => console.log(`  ${c(32, '✓')} ${s}`), warn = s => console.log(`  ${c(33, '!')} ${s}`), bad = s => console.log(`  ${c(31, '✗')} ${s}`);
const head = s => console.log('\n' + c(1, s));
const HOME = os.homedir();
const APPS = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local/share'), 'applications');
const desktopDir = () => { try { return execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim() || path.join(HOME, 'Desktop'); } catch { return path.join(HOME, 'Desktop'); } };
let problems = 0, failed = 0;   // failed: an agent could not be connected, or the tool server does not start

for (const f of ['codemotion.sh', 'install.sh', 'setup.sh', 'bin/codemotion-mcp', 'bin/find-node.sh']) { try { fs.chmodSync(path.join(APP_DIR, f), 0o755); } catch { } }

if (flag('--uninstall')) {
  head('Removing Code Motion from this computer (projects and settings stay)');
  for (const s of await K.status()) if (s.connected || s.stale) { if (!DRY) await K.disconnect(s.id); ok(`${s.name}: disconnected`); }
  for (const f of [path.join(APPS, 'codemotion.desktop'), path.join(desktopDir(), 'codemotion.desktop')]) if (fs.existsSync(f)) { if (!DRY) fs.rmSync(f); ok('removed ' + f); }
  console.log(`\nYour projects stay in ${getConfig().workspace}, settings in ${CONFIG_DIR}. The program folder is ${APP_DIR}.`);
  process.exit(0);
}

console.log(c(1, 'Code Motion setup') + (DRY ? c(33, '  (dry run: nothing is changed)') : '') + `\n  ${APP_DIR}`);

// 1. what Code Motion needs
head('1. This computer');
const nodeMajor = +process.versions.node.split('.')[0];
nodeMajor >= 22 ? ok(`Node.js ${process.version}`) : (bad(`Node.js 22+ is needed (found ${process.version})`), problems++);
const T = getTools(), linuxHint = p => IS_LINUX ? ` (sudo apt install ${p}, dnf install ${p} or pacman -S ${p})` : process.platform === 'darwin' ? ` (brew install ${p})` : '';
T.ffmpeg && T.ffprobe ? ok('ffmpeg') : (bad('ffmpeg is missing: needed for previews of plain videos and for export' + linuxHint('ffmpeg')), problems++);
T.browser ? ok('browser: ' + path.basename(T.browser)) : (bad('Google Chrome or Chromium (a native package, not the Snap) is needed for the app window and export'), problems++);
if (IS_LINUX) T.zenity || T.kdialog ? ok('file picker') : warn('optional: zenity, for the system file picker' + linuxHint('zenity'));

// 2. folders
head('2. Folders');
if (!DRY) workspace();
ok('projects: ' + getConfig().workspace);
ok('settings: ' + CONFIG_DIR);

// 3. app menu
head('3. App menu');
if (flag('--no-menu') || !IS_LINUX) ok(IS_LINUX ? 'skipped (--no-menu)' : `start it with ${path.join(APP_DIR, 'codemotion.sh')}`);
else {
  const entry = `[Desktop Entry]\nType=Application\nName=Code Motion\nComment=Review and fix the videos your coding agent makes\nExec="${path.join(APP_DIR, 'codemotion.sh')}"\nIcon=${path.join(APP_DIR, 'ui/icon.svg')}\nTerminal=false\nCategories=AudioVideo;Video;AudioVideoEditing;\nStartupWMClass=CodeMotion\n`;
  if (!DRY) { fs.mkdirSync(APPS, { recursive: true }); fs.writeFileSync(path.join(APPS, 'codemotion.desktop'), entry, { mode: 0o755 }); }
  ok('added to the application menu');
  if (flag('--desktop')) {
    const f = path.join(desktopDir(), 'codemotion.desktop');
    if (!DRY) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, entry, { mode: 0o755 }); try { execFileSync('gio', ['set', f, 'metadata::trusted', 'true'], { stdio: 'ignore' }); } catch { } }
    ok('added to the Desktop');
  }
}

// 4. coding agents
head('4. Coding agents');
const found = detectAgents(true), running = K.runningAgent();
const want = opt('--agents', 'auto');
let pick;
if (want === 'none') pick = [];
else if (want === 'all') pick = found.map(a => a.id);
else if (want === 'auto') pick = running ? [running] : found.map(a => a.id);   // the agent doing the setup; from a terminal, all
else pick = want.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
if (running) ok(`running inside ${AGENT_NAMES[running]}: connecting it` + (want === 'auto' && found.length > 1 ? ` (add the others with --agents all)` : ''));
if (!found.length) warn('no coding agent found (Claude Code, OpenCode or Codex). Install one, then run setup again.');
const connected = [];
for (const id of pick) {
  const name = AGENT_NAMES[id] || id;
  if (!AGENT_NAMES[id]) { bad(`unknown agent "${id}" (use claude, opencode or codex)`); problems++; continue; }
  if (!found.some(a => a.id === id)) { bad(`${name} was not found on this computer`); problems++; continue; }
  if (DRY) { ok(`${name}: would add the codemotion tool server and skill`); continue; }
  try { await K.connect(id); connected.push(id); ok(`${name}: connected (tool server + skill)`); }
  catch (e) { bad(`${name}: ${e.message}`); problems++; failed++; }
}
// entries left by an older or moved copy are re-pointed here too
if (!DRY) for (const id of await K.repair()) if (!connected.includes(id)) { connected.push(id); ok(`${AGENT_NAMES[id]}: reconnected to this copy`); }
for (const s of await K.status()) if (!pick.includes(s.id) && !connected.includes(s.id)) console.log(`  ${c(2, '·')} ${s.name}: ${s.connected ? 'connected' : 'not connected (node scripts/setup.mjs --agents ' + s.id + ')'}`);

// 5. proof: start the tool server exactly as the agents will
head('5. Connection check');
const v = await K.verify();
v.ok ? ok(`the tool server answers with ${v.tools.length} tools (${v.tools.slice(0, 3).join(', ')}, …)`) : (bad('the tool server did not start: ' + v.error), problems++, failed++);

head(problems ? c(33, `Set up with ${problems} problem${problems > 1 ? 's' : ''} to fix (above).`) : c(32, 'Code Motion is ready.'));
if (connected.length) console.log(`Start a NEW chat in ${connected.map(id => AGENT_NAMES[id]).join(' or ')} (open chats don't see new tools) and ask for a video,\nfor example: "Make a 10-second intro for my channel in Code Motion".`);
console.log(`Open Code Motion from the app menu, or run: ${path.join(APP_DIR, 'codemotion.sh')}`);
process.exit(failed ? 1 : 0);
