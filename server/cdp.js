// A tiny headless-Chrome driver over the DevTools protocol (Node's built-in WebSocket). No npm packages.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CACHE_DIR, getTools } from './env.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function openBrowser() {
  const bin = getTools().browser;
  if (!bin) throw new Error('No Chrome, Chromium or Edge found (needed to export code scenes). Set CODEMOTION_BROWSER.');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(CACHE_DIR, 'chrome-profile-'));
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--disable-extensions', '--disable-background-networking',
    '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  const close = () => {
    try { process.platform !== 'win32' ? process.kill(-proc.pid, 'SIGKILL') : proc.kill('SIGKILL'); } catch { }
    setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => { }), 500);
  };
  try {
    let port = null;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { }
      if (proc.exitCode != null) throw new Error('The browser closed at start');
    }
    if (!port) throw new Error('The browser did not start');
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = list.find(t => t.type === 'page');
    const page = await connect(target.webSocketDebuggerUrl);
    return { page, close: () => { page.close(); close(); } };
  } catch (e) { close(); throw e; }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
      },
      async eval(expr, timeout = 30000) {
        const r = await Promise.race([
          this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
          sleep(timeout).then(() => { throw new Error('The page did not answer'); }),
        ]);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text);
        return r.result?.value;
      },
      close() { try { ws.close(); } catch { } },
    });
    ws.onerror = () => reject(new Error('Could not talk to the browser'));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
    };
    ws.onclose = () => { for (const w of waiting.values()) w.rej(new Error('The browser closed')); waiting.clear(); };
  });
}
