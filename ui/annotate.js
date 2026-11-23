// Marking the preview: point, circle, rectangle or free drawing on the exact frame, then a comment.
// Shapes are kept in 0..1 coordinates of the frame; the note also stores a picture of the frame with the mark.
import { api, h, icon, toast } from './lib.js';

const COLOR = '#ff5f2e';
export const TOOLS = [['point', 'pin', 'Point at a spot (P)'], ['circle', 'circle', 'Circle an area (C)'], ['rect', 'rect', 'Box an area (R)'], ['draw', 'pen', 'Draw freely (D)']];

export function drawShape(g, s, W, H, { n, lw = 4, dim = false } = {}) {
  g.save();
  g.strokeStyle = COLOR; g.fillStyle = COLOR; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
  g.globalAlpha = dim ? 0.55 : 1;
  g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = lw * 1.5;
  let lx = 0, ly = 0;
  if (s.type === 'point') {
    const x = s.x * W, y = s.y * H, r = lw * 3.2;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.lineWidth = lw * 0.8; g.strokeStyle = '#fff'; g.stroke();
    lx = x + r; ly = y - r;
  } else if (s.type === 'circle') {
    g.beginPath(); g.ellipse(s.cx * W, s.cy * H, Math.max(2, s.rx * W), Math.max(2, s.ry * H), 0, 0, Math.PI * 2); g.stroke();
    lx = (s.cx + s.rx * 0.72) * W; ly = (s.cy - s.ry * 0.72) * H;
  } else if (s.type === 'rect') {
    g.strokeRect(s.x * W, s.y * H, s.w * W, s.h * H);
    lx = (s.x + s.w) * W; ly = s.y * H;
  } else if (s.type === 'draw' && s.points?.length) {
    g.beginPath(); s.points.forEach(([x, y], i) => i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)); g.stroke();
    const last = s.points[s.points.length - 1]; lx = last[0] * W; ly = last[1] * H;
  }
  if (n != null) {   // number badge
    const r = lw * 3.4; g.shadowBlur = 0; g.globalAlpha = 1;
    g.beginPath(); g.arc(lx + r * 0.6, ly - r * 0.2, r, 0, Math.PI * 2); g.fillStyle = COLOR; g.fill();
    g.fillStyle = '#fff'; g.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), lx + r * 0.6, ly - r * 0.2 + 1);
  }
  g.restore();
}
function bbox(s) {
  if (s.type === 'point') return { x0: s.x, y0: s.y, x1: s.x, y1: s.y };
  if (s.type === 'circle') return { x0: s.cx - s.rx, y0: s.cy - s.ry, x1: s.cx + s.rx, y1: s.cy + s.ry };
  if (s.type === 'rect') return { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h };
  const xs = s.points.map(p => p[0]), ys = s.points.map(p => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export function createAnnotator(screen, ed) {
  const cv = h('canvas');
  const wrap = h('div', { class: 'annot' }, cv);
  screen.append(wrap);
  const st = { tool: null, shape: null, pending: null, pop: null, focus: null };

  function setTool(t) {
    st.tool = st.tool === t ? null : t;
    wrap.classList.toggle('active', !!st.tool);
    closePop(); ed.onToolChange?.(st.tool);
    if (st.tool && ed.playing()) ed.pause();
    render();
  }
  const norm = e => { const r = wrap.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };

  wrap.addEventListener('pointerdown', e => {
    if (!st.tool || e.button !== 0) return;
    e.preventDefault(); closePop();
    wrap.setPointerCapture(e.pointerId);
    const [x, y] = norm(e), t = st.tool;
    st.start = [x, y];
    st.shape = t === 'point' ? { type: 'point', x, y } : t === 'circle' ? { type: 'circle', cx: x, cy: y, rx: 0, ry: 0 } : t === 'rect' ? { type: 'rect', x, y, w: 0, h: 0 } : { type: 'draw', points: [[x, y]] };
    render();
  });
  wrap.addEventListener('pointermove', e => {
    if (!st.shape) return;
    const [x, y] = norm(e), [sx, sy] = st.start, s = st.shape;
    if (s.type === 'point') { s.x = x; s.y = y; }
    else if (s.type === 'circle') { s.cx = (sx + x) / 2; s.cy = (sy + y) / 2; s.rx = Math.abs(x - sx) / 2; s.ry = Math.abs(y - sy) / 2; }
    else if (s.type === 'rect') { s.x = Math.min(sx, x); s.y = Math.min(sy, y); s.w = Math.abs(x - sx); s.h = Math.abs(y - sy); }
    else { const last = s.points[s.points.length - 1]; if (Math.hypot(x - last[0], y - last[1]) > 0.003) s.points.push([+x.toFixed(4), +y.toFixed(4)]); }
    render();
  });
  wrap.addEventListener('pointerup', () => {
    const s = st.shape; st.shape = null; if (!s) return;
    // a click with the circle or box tool still makes a sensible mark
    if (s.type === 'circle' && s.rx < 0.01 && s.ry < 0.01) { s.rx = 0.06; s.ry = 0.06 * 16 / 9; }
    if (s.type === 'rect' && s.w < 0.01 && s.h < 0.01) { s.x -= 0.07; s.y -= 0.07; s.w = 0.14; s.h = 0.14; }
    if (s.type === 'draw' && s.points.length < 2) s.points.push([s.points[0][0] + 0.002, s.points[0][1] + 0.002]);
    for (const k of ['x', 'y', 'w', 'h', 'cx', 'cy', 'rx', 'ry']) if (k in s) s[k] = +s[k].toFixed(4);
    st.pending = s; render(); openPop(s);
  });

  function openPop(s) {
    closePop();
    const t = ed.time(), fps = ed.project().fps;
    const text = h('textarea', { placeholder: 'What should change here?' });
    const add = async send => {
      const msg = text.value.trim();
      if (!msg && !send) { text.focus(); return toast('Write what should change, or press Add & fix to send the mark alone'); }
      btns.forEach(b => b.disabled = true);
      try {
        const notesNow = ed.notes();
        const n = (notesNow.reduce((m, x) => Math.max(m, x.n || 0), 0)) + 1;
        const { image, close } = pictures(s, n);
        const note = await api(`/api/projects/${encodeURIComponent(ed.id)}/notes`, { method: 'POST', body: { time: t, frame: Math.round(t * fps), shape: s, text: msg, clips: ed.onScreen(t), image, close } });
        st.pending = null; closePop(); render();
        ed.noteAdded(note);
        if (send) ed.sendNotes([note.id]);
        else toast(`Note #${note.n} saved. Send it from the Notes tab, or keep marking.`, 'ok');
      } catch (e) { toast(e.message, 'error'); btns.forEach(b => b.disabled = false); }
    };
    const btns = [
      h('button', { class: 'btn sm', onclick: () => add(false) }, 'Add note'),
      h('button', { class: 'btn sm accent', onclick: () => add(true), title: 'Save the note and ask the agent to fix it now' }, icon('send'), 'Add & fix'),
    ];
    text.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add(true);
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(false); }
      else if (e.key === 'Escape') { st.pending = null; closePop(); render(); }
    });
    const m = Math.floor(t / 60), sec = (t - m * 60).toFixed(2).padStart(5, '0');
    const pop = h('div', { class: 'note-pop' },
      h('div', { class: 'meta' }, `${m}:${sec} · frame ${Math.round(t * fps)} · ${{ point: 'point', circle: 'circle', rect: 'box', draw: 'drawing' }[s.type]}`),
      text, h('div', { class: 'row gap', style: { marginTop: '8px' } }, h('button', { class: 'btn sm ghost', onclick: () => { st.pending = null; closePop(); render(); } }, 'Cancel'), h('span', { class: 'grow' }), ...btns));
    // place it next to the mark, inside the stage
    const b = bbox(s), r = screen.getBoundingClientRect(), stage = screen.parentElement.getBoundingClientRect();
    screen.parentElement.append(pop);
    const W = 300, H = pop.offsetHeight || 150, gap = 14;
    const L = r.left - stage.left + b.x0 * r.width, R = r.left - stage.left + b.x1 * r.width, T = r.top - stage.top + b.y0 * r.height, B = r.top - stage.top + b.y1 * r.height;
    const cx = Math.max(8, Math.min(stage.width - W - 8, (L + R) / 2 - W / 2));
    // beside the mark when there is room, else below or above it; never on top of it
    const spots = [[R + gap, T], [L - gap - W, T], [cx, B + gap], [cx, T - gap - H]];
    const fits = ([x, y]) => x >= 8 && x + W <= stage.width - 8 && y >= 8 && y + H <= stage.height - 8;
    const [x, y] = spots.find(fits) || [cx, Math.min(stage.height - H - 8, B + gap)];
    pop.style.left = x + 'px'; pop.style.top = Math.max(8, y) + 'px';
    st.pop = pop; setTimeout(() => text.focus(), 20);
  }
  function closePop() { st.pop?.remove(); st.pop = null; }

  // full frame (≤ 1600 px wide) and a close-up of the marked area, both with the mark drawn
  function pictures(s, n) {
    const p = ed.project();
    const full = ed.capture(1);
    const g = full.getContext('2d'); drawShape(g, s, full.width, full.height, { n, lw: Math.max(4, full.width / 320) });
    const k = Math.min(1, 1600 / full.width), out = document.createElement('canvas');
    out.width = Math.round(full.width * k); out.height = Math.round(full.height * k);
    out.getContext('2d').drawImage(full, 0, 0, out.width, out.height);
    const b = bbox(s); let bw = (b.x1 - b.x0) * full.width, bh = (b.y1 - b.y0) * full.height;
    const side = Math.max(320, bw * 1.6, bh * 1.6 * 16 / 9) | 0, sideH = Math.round(side * 9 / 16);
    let cx = ((b.x0 + b.x1) / 2) * full.width - side / 2, cy = ((b.y0 + b.y1) / 2) * full.height - sideH / 2;
    cx = Math.max(0, Math.min(full.width - side, cx)); cy = Math.max(0, Math.min(full.height - sideH, cy));
    const close = document.createElement('canvas'); const ck = Math.min(1, 960 / side);
    close.width = Math.round(Math.min(side, full.width) * ck); close.height = Math.round(Math.min(sideH, full.height) * ck);
    close.getContext('2d').drawImage(full, cx, cy, Math.min(side, full.width), Math.min(sideH, full.height), 0, 0, close.width, close.height);
    void p;
    return { image: out.toDataURL('image/jpeg', 0.88), close: close.toDataURL('image/jpeg', 0.9) };
  }

  // marks near the playhead (and the note picked in the list) stay visible while paused
  function render() {
    const r = wrap.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (!r.width) return;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    const t = ed.time(), lw = 2.5 * dpr;
    if (!ed.playing()) for (const n of ed.notes()) {
      if (n.id !== st.focus && (Math.abs(n.time - t) > 0.12 || n.status === 'fixed')) continue;
      drawShape(g, n.shape, cv.width, cv.height, { n: n.n, lw, dim: n.id !== st.focus && n.status === 'sent' });
    }
    if (st.pending) drawShape(g, st.pending, cv.width, cv.height, { lw });
    if (st.shape) drawShape(g, st.shape, cv.width, cv.height, { lw });
  }
  const ro = new ResizeObserver(render); ro.observe(wrap);
  return {
    setTool, render, get tool() { return st.tool; },
    focus(id) { st.focus = id; render(); },
    cancel() { if (st.pop || st.pending) { st.pending = null; closePop(); render(); return true; } if (st.tool) { setTool(null); return true; } return false; },
    destroy() { ro.disconnect(); closePop(); },
  };
}
