// The timeline: tracks, clips, ruler, playhead. Drag a clip to move it (also to another track of the same kind),
// drag its edges to trim, click the ruler to jump. Changes go through the editor (undo, save).
import { clamp, h, icon } from './lib.js';

const ROW = { video: 62, audio: 50 }, RULER = 26, SNAP_PX = 8;
const peaksCache = new Map();

export function createTimeline(root, ed) {
  const scroll = h('div', { class: 'tl-scroll' });
  const inner = h('div', { class: 'tl-inner' });
  const ruler = h('div', { class: 'tl-ruler' }); const rc = h('canvas'); ruler.append(rc);
  const tracksEl = h('div');
  const playhead = h('div', { class: 'playhead' });
  const snapLine = h('div', { class: 'snapline', style: { display: 'none' } });
  inner.append(ruler, tracksEl, playhead, snapLine); scroll.append(inner);
  const heads = h('div', { class: 'tl-heads' });
  const snapBtn = h('button', { class: 'icon-btn on', title: 'Snap to clip edges and the playhead', onclick: () => { ed.S.snap = !ed.S.snap; snapBtn.classList.toggle('on', ed.S.snap); } }, icon('magnet'));
  const tools = h('div', { class: 'tl-tools' },
    h('button', { class: 'icon-btn', title: 'Split at the playhead (S)', onclick: () => ed.split() }, icon('scissors')),
    h('button', { class: 'icon-btn', title: 'Delete the selected clip (Delete)', onclick: () => ed.removeSelected() }, icon('trash')),
    h('span', { class: 'sep', style: { width: '1px', height: '20px', background: 'var(--line)', margin: '0 4px' } }),
    snapBtn,
    h('button', { class: 'icon-btn', title: 'Zoom out (Ctrl + wheel)', onclick: () => zoomBy(1 / 1.4) }, icon('zoomout')),
    h('button', { class: 'icon-btn', title: 'Zoom in (Ctrl + wheel)', onclick: () => zoomBy(1.4) }, icon('zoomin')),
    h('button', { class: 'btn ghost sm', title: 'Show the whole video', onclick: () => fit() }, 'Fit'),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn ghost sm', onclick: () => ed.addTrack('video') }, icon('plus'), 'Video track'),
    h('button', { class: 'btn ghost sm', onclick: () => ed.addTrack('audio') }, icon('plus'), 'Audio track'));
  root.append(h('div', { class: 'tl' }, tools, h('div', { class: 'tl-body' }, heads, scroll)));

  const S = ed.S;
  const px = s => s * S.zoom;
  const total = () => ed.project().clips.reduce((m, c) => Math.max(m, c.start + c.out - c.in), 0);

  function fit() {
    const w = scroll.clientWidth - 30;
    S.zoom = clamp(w / Math.max(total(), 5), 2, 400); render();
  }
  function zoomBy(k, anchorX = scroll.clientWidth / 2) {
    const tAt = (scroll.scrollLeft + anchorX) / S.zoom;
    S.zoom = clamp(S.zoom * k, 2, 600); render();
    scroll.scrollLeft = tAt * S.zoom - anchorX;
  }
  scroll.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - scroll.getBoundingClientRect().left); }
  }, { passive: false });
  scroll.addEventListener('scroll', () => { heads.scrollTop = scroll.scrollTop; drawRuler(); });

  // ---------- ruler
  function drawRuler() {
    const w = scroll.clientWidth, dpr = devicePixelRatio || 1;
    rc.width = w * dpr; rc.height = RULER * dpr; rc.style.width = w + 'px'; rc.style.height = RULER + 'px'; rc.style.left = scroll.scrollLeft + 'px';
    const g = rc.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, RULER);
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find(s => s * S.zoom >= 80) || 600, minor = steps.filter(s => s < major && major / s <= 10 && s * S.zoom >= 8).pop() || major;
    const t0 = scroll.scrollLeft / S.zoom, t1 = (scroll.scrollLeft + w) / S.zoom;
    g.font = '11px system-ui, sans-serif'; g.textBaseline = 'top';
    for (let s = Math.floor(t0 / minor) * minor; s <= t1; s += minor) {
      const x = Math.round(px(s) - scroll.scrollLeft) + 0.5, isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6;
      g.strokeStyle = isMajor ? '#4a5062' : '#2c303c'; g.beginPath(); g.moveTo(x, isMajor ? 10 : 17); g.lineTo(x, RULER); g.stroke();
      if (isMajor) { g.fillStyle = '#8d92a3'; const m = Math.floor(s / 60), r = s - m * 60; g.fillText(major < 1 ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.round(r)).padStart(2, '0')}`, x + 4, 3); }
    }
  }
  const timeAt = clientX => Math.max(0, (clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft) / S.zoom);
  ruler.addEventListener('pointerdown', e => {
    ruler.setPointerCapture(e.pointerId); ed.seek(timeAt(e.clientX));
    const mv = ev => ed.seek(timeAt(ev.clientX));
    ruler.addEventListener('pointermove', mv);
    ruler.addEventListener('pointerup', () => ruler.removeEventListener('pointermove', mv), { once: true });
  });

  // ---------- tracks and clips
  function render() {
    const p = ed.project();
    const width = Math.max(scroll.clientWidth, px(total()) + Math.max(240, scroll.clientWidth * 0.4));
    inner.style.width = width + 'px';
    heads.replaceChildren(h('div', { class: 'tl-ruler-pad' }), ...p.tracks.map(tr => trackHead(tr)));
    tracksEl.replaceChildren(...p.tracks.map(tr => trackRow(tr, p)));
    inner.style.height = (RULER + p.tracks.reduce((s, tr) => s + ROW[tr.kind] + 1, 0)) + 'px';
    drawRuler(); drawMarks(); movePlayhead();
  }
  const marks = h('div'); ruler.append(marks);
  function drawMarks() {
    marks.replaceChildren(...(ed.notes?.() || []).map(n => h('div', { class: 'nmark' + (n.status === 'fixed' ? ' fixed' : ''), style: { left: px(n.time) + 'px' }, title: `#${n.n} ${n.text || ''}`, onpointerdown: e => { e.stopPropagation(); ed.focusNote(n.id); } })));
  }
  function trackHead(tr) {
    const toggle = tr.kind === 'video'
      ? h('button', { class: 'icon-btn' + (tr.hidden ? ' on' : ''), title: tr.hidden ? 'Show this track' : 'Hide this track', onclick: () => ed.updateTrack(tr.id, { hidden: !tr.hidden }) }, icon(tr.hidden ? 'eyeoff' : 'eye'))
      : h('button', { class: 'icon-btn' + (tr.muted ? ' on' : ''), title: tr.muted ? 'Unmute this track' : 'Mute this track', onclick: () => ed.updateTrack(tr.id, { muted: !tr.muted }) }, icon(tr.muted ? 'mute' : 'volume'));
    const empty = !ed.project().clips.some(c => c.track === tr.id);
    return h('div', { class: 'tl-head', style: { height: ROW[tr.kind] + 1 + 'px' } },
      icon(tr.kind === 'video' ? 'film' : 'music'), h('span', { class: 'nm', title: tr.name }, tr.name), toggle,
      empty ? h('button', { class: 'icon-btn rm', title: 'Remove this empty track', onclick: () => ed.removeTrack(tr.id) }, icon('close')) : null);
  }
  function trackRow(tr, p) {
    const row = h('div', { class: 'tl-track ' + tr.kind, style: { height: ROW[tr.kind] + 1 + 'px' } });
    row.dataset.track = tr.id; row.dataset.kind = tr.kind;
    for (const c of p.clips.filter(c => c.track === tr.id).sort((a, b) => a.start - b.start)) row.append(clipEl(c));
    row.addEventListener('pointerdown', e => { if (e.target === row) { ed.select(null); ed.seek(timeAt(e.clientX)); } });
    // drops from the media list or from the file manager
    row.addEventListener('dragover', e => {
      const kind = S.dragKind;
      if (e.dataTransfer.types.includes('Files') || (kind && accepts(tr.kind, kind))) { e.preventDefault(); row.classList.add('drop'); }
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('drop');
      const at = snapDrop(timeAt(e.clientX), tr.id);
      if (e.dataTransfer.files.length) return ed.uploadFiles([...e.dataTransfer.files], { track: tr.id, time: at });
      const src = e.dataTransfer.getData('text/cm-src');
      if (src) ed.addClip(src, { track: tr.id, time: at });
    });
    return row;
  }
  // a drop lands on 0, the playhead or the end of a clip on that track when it is close
  function snapDrop(t, trackId) {
    const pts = [0, ed.time(), ...ed.project().clips.filter(c => c.track === trackId).map(c => c.start + c.out - c.in)];
    let best = t, bd = (SNAP_PX * 2) / S.zoom;
    for (const s of pts) if (Math.abs(s - t) < bd) { bd = Math.abs(s - t); best = s; }
    return best;
  }
  const accepts = (trackKind, mediaKind) => trackKind === 'audio' ? mediaKind === 'audio' : mediaKind !== 'audio';

  function clipEl(c) {
    const d = c.out - c.in;
    const el = h('div', { class: `clip ${c.type}` + (S.sel === c.id ? ' sel' : '') + (c.muted ? ' muted' : '') + (S.flash.has(c.id) ? ' flash' : ''), style: { left: px(c.start) + 'px', width: Math.max(4, px(d)) + 'px' }, title: `${c.name || c.src}  ${d.toFixed(2)} s` });
    el.dataset.id = c.id;
    if (c.type === 'video') el.append(filmstrip(c, Math.max(4, px(d))));
    else if (c.type === 'image') el.append(h('div', { class: 'strip', style: { backgroundImage: `url("/api/projects/${encodeURIComponent(ed.id)}/thumb?src=${encodeURIComponent(c.src)}&at=0")`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x' } }));
    if (c.type === 'audio') el.append(wave(c, Math.max(4, px(d))));
    el.append(h('span', { class: 'cl-name' }, c.type === 'scene' ? '✦ ' : '', c.name || c.src.split('/').pop()),
      h('div', { class: 'edge l' }), h('div', { class: 'edge r' }));
    el.addEventListener('pointerdown', e => startDrag(e, c, el));
    el.addEventListener('dblclick', () => ed.seek(c.start));
    return el;
  }
  // frames along the clip, each at its own time, from one 24-frame strip of the whole file
  function filmstrip(c, w) {
    const box = h('div', { class: 'strip' });
    const src = ed.sourceDuration(c); if (!src) return box;
    const fh = ROW.video - 10, fw = Math.round(fh * 16 / 9), n = Math.min(60, Math.ceil(w / fw));
    const url = `url("/api/projects/${encodeURIComponent(ed.id)}/strip?src=${encodeURIComponent(c.src)}")`;
    for (let i = 0; i < n; i++) {
      const t = c.in + Math.min(c.out - c.in, ((i + 0.5) * fw) / S.zoom);
      const idx = Math.min(23, Math.max(0, Math.floor((t / src) * 24)));
      box.append(h('div', { style: { position: 'absolute', top: 0, bottom: 0, left: i * fw + 'px', width: fw + 'px', backgroundImage: url, backgroundSize: `${fw * 24}px 100%`, backgroundPosition: `${-idx * fw}px 0`, borderRight: '1px solid rgba(0,0,0,.35)' } }));
    }
    return box;
  }
  function wave(c, w) {
    const cv = h('canvas', { class: 'wave' });
    const width = Math.min(4000, Math.round(w));
    cv.width = width; cv.height = 40;
    const paint = data => {
      const g = cv.getContext('2d'); g.clearRect(0, 0, width, 40); g.fillStyle = 'rgba(255,255,255,.85)';
      const per = data.perSecond, d = c.out - c.in;
      for (let x = 0; x < width; x++) {
        const i = Math.floor((c.in + (x / width) * d) * per), v = (data.peaks[i] || 0) / 255;
        const hh = Math.max(1, v * 38); g.fillRect(x, 40 - hh, 1, hh);
      }
    };
    const cached = peaksCache.get(c.src);
    if (cached?.peaks) paint(cached);
    else {
      if (!cached) peaksCache.set(c.src, fetch(`/api/projects/${encodeURIComponent(ed.id)}/peaks?src=${encodeURIComponent(c.src)}`).then(r => r.ok ? r.json() : null).then(d => { peaksCache.set(c.src, d || { peaks: [] }); return d; }));
      Promise.resolve(peaksCache.get(c.src)).then(d => d?.peaks && paint(d));
    }
    return cv;
  }

  // ---------- dragging clips
  function startDrag(e, c, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    ed.select(c.id);
    const mode = e.target.classList.contains('edge') ? (e.target.classList.contains('l') ? 'l' : 'r') : 'move';
    const before = structuredClone(ed.project());
    const orig = before.clips.find(x => x.id === c.id);
    const x0 = e.clientX, y0 = e.clientY;
    const maxDur = ed.sourceDuration(c);
    const others = before.clips.filter(x => x.id !== c.id).flatMap(x => [x.start, x.start + x.out - x.in]);
    const snapPts = [0, ed.time(), ...others];
    let moved = false;
    // listeners on window: the timeline redraws while dragging, so the clip element itself is replaced
    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';

    const snap = t => {
      if (!S.snap) return { t, hit: null };
      let best = null, bd = SNAP_PX / S.zoom;
      for (const s of snapPts) { const dd = Math.abs(s - t); if (dd < bd) { bd = dd; best = s; } }
      return best == null ? { t, hit: null } : { t: best, hit: best };
    };
    const showSnap = s => { snapLine.style.display = s == null ? 'none' : 'block'; if (s != null) snapLine.style.left = px(s) + 'px'; };

    const onMove = ev => {
      const dt = (ev.clientX - x0) / S.zoom;
      if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      moved = true;
      const draft = structuredClone(before), dc = draft.clips.find(x => x.id === c.id), len = orig.out - orig.in;
      if (mode === 'move') {
        let start = Math.max(0, orig.start + dt);
        const a = snap(start), b = snap(start + len);
        let hit = null;
        if (a.hit != null && (b.hit == null || Math.abs(a.t - start) <= Math.abs(b.t - start - len))) { start = a.t; hit = a.hit; }
        else if (b.hit != null) { start = b.t - len; hit = b.hit; }
        dc.start = Math.max(0, start); showSnap(hit);
        const row = document.elementsFromPoint(ev.clientX, ev.clientY).find(n => n.classList?.contains('tl-track'));
        if (row && accepts(row.dataset.kind, c.type)) dc.track = row.dataset.track;
      } else if (mode === 'l') {
        const end = orig.start + len;
        let start = snap(orig.start + dt); showSnap(start.hit); start = start.t;
        start = Math.min(start, end - 0.1);
        if (c.type !== 'image') start = Math.max(start, orig.start - orig.in);   // cannot go before the source starts
        start = Math.max(0, start);
        if (c.type === 'image') { dc.start = start; dc.in = 0; dc.out = end - start; }
        else { dc.in = orig.in + (start - orig.start); dc.start = start; }
      } else {
        let end = snap(orig.start + len + dt); showSnap(end.hit); end = end.t;
        let out = orig.in + (end - orig.start);
        out = Math.max(orig.in + 0.1, out);
        if (maxDur) out = Math.min(out, maxDur);
        dc.out = out;
      }
      ed.preview(draft);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = ''; showSnap(null);
      if (moved) ed.commitFrom(before, mode === 'move' ? 'Move clip' : 'Trim clip');
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
  }

  function movePlayhead() {
    const x = px(ed.time());
    playhead.style.transform = `translateX(${x}px)`;
    playhead.style.height = inner.style.height;
    // keep the playhead in view while playing
    if (ed.playing() && (x > scroll.scrollLeft + scroll.clientWidth - 40 || x < scroll.scrollLeft)) scroll.scrollLeft = x - 60;
  }

  const ro = new ResizeObserver(() => drawRuler()); ro.observe(scroll);
  // dragging from the media list (pointer based, no browser drag and drop)
  let hoverRow = null;
  function rowAt(x, y, kind) {
    const row = document.elementsFromPoint(x, y).find(n => n.classList?.contains('tl-track'));
    return row && accepts(row.dataset.kind, kind) ? row : null;
  }
  function hover(x, y, kind) {
    const row = x == null ? null : rowAt(x, y, kind);
    if (row !== hoverRow) { hoverRow?.classList.remove('drop'); row?.classList.add('drop'); hoverRow = row; }
    return !!row;
  }
  function dropAt(x, y, kind) {
    const row = rowAt(x, y, kind); hover(null);
    return row ? { track: row.dataset.track, time: snapDrop(timeAt(x), row.dataset.track) } : null;
  }
  // when clips reach past the visible part, zoom out so everything shows
  function fitIfNeeded() { if (px(total()) > scroll.clientWidth - 24 || (total() > 0 && px(total()) < scroll.clientWidth * 0.25)) fit(); }
  return { render, movePlayhead, fit, fitIfNeeded, hover, dropAt, drawMarks, destroy: () => ro.disconnect() };
}
