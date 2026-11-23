// Connect Code Motion to the coding agents' own chats: one MCP entry and one skill per agent.
// The entry starts bin/codemotion-mcp, which finds Node 22+ itself, so it survives Node updates. Only Code Motion's
// own entries are added, repaired or removed; everything else in the agents' settings stays as it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_DIR, IS_WIN, readJson } from './env.js';
import { detectAgents } from './agent.js';

const HOME = () => os.homedir();
const XDG = () => process.env.XDG_CONFIG_HOME || path.join(HOME(), '.config');
const CODEX_HOME = () => process.env.CODEX_HOME || path.join(HOME(), '.codex');
const MCP = path.join(APP_DIR, 'server', 'mcp.js');
const LAUNCHER = path.join(APP_DIR, 'bin', 'codemotion-mcp');
// What agents run: the launcher (Linux/macOS), or this Node with mcp.js (Windows has no sh)
export const ENTRY = IS_WIN ? { command: process.execPath, args: [MCP] } : { command: LAUNCHER, args: [] };
const ENTRY_LIST = () => [ENTRY.command, ...ENTRY.args];
const skillDir = id => ({ claude: path.join(HOME(), '.claude', 'skills', 'codemotion'), opencode: path.join(XDG(), 'opencode', 'skills', 'codemotion'),
  codex: path.join(CODEX_HOME(), 'skills', 'codemotion') })[id];
const claudeCfg = () => path.join(HOME(), '.claude.json');
const opencodeCfg = () => path.join(XDG(), 'opencode', 'opencode.json');
const codexCfg = () => path.join(CODEX_HOME(), 'config.toml');

function run(cmd, args, timeout = 30000) {
  return new Promise(resolve => {
    let out = ''; const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out }); });
  });
}

// The agent running this process, from the markers each one sets in its shells.
export function runningAgent(env = process.env) {
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT || /^claude-code/.test(env.AI_AGENT || '')) return 'claude';
  if (env.OPENCODE === '1' || env.OPENCODE_TERMINAL === '1') return 'opencode';
  if (Object.keys(env).some(k => k.startsWith('CODEX_') && k !== 'CODEX_HOME') || /^codex/.test(env.AI_AGENT || '')) return 'codex';
  return null;
}

// ---- what each agent has now: { command: [...] } or null
function codexBlock() {
  let t = ''; try { t = fs.readFileSync(codexCfg(), 'utf8'); } catch { return null; }
  const i = t.search(/^\[mcp_servers\.codemotion\]\s*$/m); if (i < 0) return null;
  const rest = t.slice(i).replace(/^.*\n?/, ''), end = rest.search(/^\[/m);
  return end < 0 ? rest : rest.slice(0, end);
}
function entryOf(id) {
  if (id === 'claude') { const e = readJson(claudeCfg(), {})?.mcpServers?.codemotion; return e ? { command: [e.command, ...(e.args || [])] } : null; }
  if (id === 'opencode') { const m = readJson(opencodeCfg(), {})?.mcp; const e = m?.servers?.codemotion || m?.codemotion; return e ? { command: [].concat(e.command || []) } : null; }
  if (id === 'codex') {
    const b = codexBlock(); if (b == null) return null;
    const cmd = b.match(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*")/m)?.[1], args = b.match(/^\s*args\s*=\s*(\[[^\]]*\])/m)?.[1];
    try { return { command: [JSON.parse(cmd), ...(args ? JSON.parse(args) : [])] }; } catch { return { command: [] }; }
  }
  return null;
}
// Current = starts exactly this copy's entry. Anything else (an older Node path, a moved or deleted copy) is stale.
function isCurrent(e) {
  const want = ENTRY_LIST();
  return !!e && e.command.length === want.length && e.command.every((c, i) => (IS_WIN && i === 0) ? fs.existsSync(c) : c === want[i]);
}

export async function status() {
  return detectAgents(true).map(a => {
    const e = entryOf(a.id), connected = isCurrent(e);
    return { id: a.id, name: a.name, path: a.path, signedIn: a.signedIn, connected, stale: !!e && !connected,
      skill: fs.existsSync(path.join(skillDir(a.id), 'SKILL.md')) };
  });
}

function writeSkill(id) {
  const dir = skillDir(id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fs.readFileSync(path.join(APP_DIR, 'server', 'skill.md'), 'utf8').replaceAll('{{APP_DIR}}', APP_DIR));
}
function removeSkill(id) {
  const f = path.join(skillDir(id), 'SKILL.md');
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('name: codemotion')) fs.rmSync(skillDir(id), { recursive: true, force: true });
}
function backupOnce(f) { const b = f + '.before-codemotion'; if (fs.existsSync(f) && !fs.existsSync(b)) fs.copyFileSync(f, b); }

function removeOpencode() {
  const f = opencodeCfg(), j = readJson(f, null); if (!j?.mcp) return;
  let changed = false;
  if (j.mcp.codemotion) { delete j.mcp.codemotion; changed = true; }
  if (j.mcp.servers?.codemotion) { delete j.mcp.servers.codemotion; changed = true; }
  if (changed) fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
function removeCodex() {
  const b = codexBlock(); if (b == null) return;
  const f = codexCfg(), t = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, t.replace(/^\[mcp_servers\.codemotion\]\s*\n?/m, '').replace(b, '').replace(/\n{3,}/g, '\n\n'));
}

export async function connect(id) {
  const a = detectAgents(true).find(x => x.id === id); if (!a) throw Object.assign(new Error('Agent not found'), { status: 404 });
  const cmd = ENTRY_LIST();
  if (id === 'claude') {
    await run(a.path, ['mcp', 'remove', '-s', 'user', 'codemotion']);
    const r = await run(a.path, ['mcp', 'add', '-s', 'user', 'codemotion', '--', ...cmd]);
    if (r.code !== 0) throw new Error('Claude Code refused the entry: ' + r.out.trim().slice(0, 300));
  } else if (id === 'opencode') {
    // OpenCode's own command first (it knows its config format); then the file, in OpenCode 2's "mcp.servers" form
    removeOpencode();
    const r = await run(a.path, ['mcp', 'add', '--global', 'codemotion', '--', ...cmd]);
    if (r.code !== 0 || !isCurrent(entryOf('opencode'))) {
      const f = opencodeCfg(); let j = {};
      if (fs.existsSync(f)) {
        try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new Error(`${f} has comments or is not plain JSON; run: opencode mcp add --global codemotion -- ${cmd.join(' ')}`); }
        backupOnce(f);
      }
      j.mcp = j.mcp && typeof j.mcp === 'object' ? j.mcp : {};
      j.mcp.servers = j.mcp.servers && typeof j.mcp.servers === 'object' ? j.mcp.servers : {};
      j.mcp.servers.codemotion = { type: 'local', command: cmd };
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
    }
  } else if (id === 'codex') {
    const f = codexCfg(); backupOnce(f); removeCodex();
    let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch { }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, (t.trim() ? t.replace(/\n*$/, '\n\n') : '') +
      `[mcp_servers.codemotion]\ncommand = ${JSON.stringify(ENTRY.command)}\nargs = ${JSON.stringify(ENTRY.args)}\ntool_timeout_sec = 600\n`);
  }
  if (!isCurrent(entryOf(id))) throw new Error(`${a.name} did not keep the Code Motion entry`);
  writeSkill(id);
  return status();
}

export async function disconnect(id) {
  const a = detectAgents(true).find(x => x.id === id); if (!a) throw Object.assign(new Error('Agent not found'), { status: 404 });
  if (id === 'claude') await run(a.path, ['mcp', 'remove', '-s', 'user', 'codemotion']);
  else if (id === 'opencode') removeOpencode(); else if (id === 'codex') removeCodex();
  removeSkill(id);
  return status();
}

// Re-point entries left by an older or moved copy of Code Motion, and refresh the skills of connected agents.
// Agents the user never connected (or disconnected) are left alone.
export async function repair() {
  const fixed = [];
  for (const s of await status()) {
    if (s.stale) { try { await connect(s.id); fixed.push(s.id); } catch { } }
    else if (s.connected) { try { writeSkill(s.id); } catch { } }
  }
  return fixed;
}

// Start the entry exactly as an agent would and ask for its tools: proof that the connection works.
export function verify(timeout = 15000) {
  return new Promise(resolve => {
    let buf = '', err = '', done = false;
    const p = spawn(ENTRY.command, ENTRY.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = r => { if (done) return; done = true; clearTimeout(t); try { p.kill(); } catch { } resolve(r); };
    const t = setTimeout(() => finish({ ok: false, error: err.trim() || 'The tool server did not answer' }), timeout);
    p.on('error', e => finish({ ok: false, error: e.message }));
    p.on('close', () => finish({ ok: false, error: err.trim() || 'The tool server stopped' }));
    p.stderr.on('data', d => { err += d; });
    p.stdout.on('data', d => {
      buf += d;
      for (const line of buf.split('\n')) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) finish(m.result?.tools?.length ? { ok: true, tools: m.result.tools.map(x => x.name) } : { ok: false, error: 'No tools listed' });
      }
    });
    const send = o => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codemotion-setup', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}
