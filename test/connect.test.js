// Connection checks in a fake home (never the real agent settings).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.test-tmp', 'connect-' + process.pid);
fs.rmSync(root, { recursive: true, force: true });
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CODEX_HOME: path.join(home, '.codex'),
  CODEMOTION_CONFIG_DIR: path.join(root, 'cfg'), CODEMOTION_CACHE_DIR: path.join(root, 'cache'), CODEMOTION_WORKSPACE: path.join(root, 'ws') });
if (!process.env.CODEMOTION_NODE) process.env.CODEMOTION_NODE = process.execPath;   // the fake home has no nvm

const K = await import('../server/connect.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('setup knows which agent is running it', () => {
  assert.equal(K.runningAgent({ CLAUDECODE: '1' }), 'claude');
  assert.equal(K.runningAgent({ OPENCODE: '1' }), 'opencode');
  assert.equal(K.runningAgent({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
  assert.equal(K.runningAgent({ CODEX_HOME: '/x', PATH: '/usr/bin' }), null);
});

test('an entry left by a moved copy is stale, the current one is connected', async () => {
  const f = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.writeFileSync(f, JSON.stringify({ mcp: { servers: { codemotion: { type: 'local', command: ['/old/node', '/gone/server/mcp.js'] } } } }));
  const oc = (await K.status()).find(s => s.id === 'opencode');
  if (!oc) return;   // OpenCode not installed here: nothing to check
  assert.equal(oc.stale, true); assert.equal(oc.connected, false);
  fs.writeFileSync(f, JSON.stringify({ mcp: { servers: { codemotion: { type: 'local', command: [K.ENTRY.command, ...K.ENTRY.args] } } } }));
  const now = (await K.status()).find(s => s.id === 'opencode');
  assert.equal(now.connected, true); assert.equal(now.stale, false);
});

test('the tool server starts the way agents start it and lists its tools', async () => {
  const v = await K.verify();
  assert.ok(v.ok, v.error);
  for (const t of ['codemotion_new', 'codemotion_open', 'codemotion_wait', 'codemotion_notes']) assert.ok(v.tools.includes(t), t);
});
