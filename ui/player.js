// The preview: plays the timeline from the files themselves (no render). Only clips near the playhead get a
// <video>/<audio>/<iframe>; the rest are released, so long timelines stay light.
const NEAR_BEFORE = 4, NEAR_AFTER = 8, DRIFT = 0.25;

export function createPlayer(screen, { projectId, getProject, onTime, onEnd, previewUrl, onRedraw }) {
  const layers = new Map();   // clip id → { el, kind, src, url, ready }
  let t = 0, playing = false, startPerf = 0, startT = 0, raf = 0, sceneVersion = {};
  const msg = document.createElement('div'); msg.className = 'msg'; screen.append(msg);

  const dur = () => getProject().clips.reduce((m, c) => Math.max(m, c.start + c.out - c.in), 0);
  const covers = (c, x) => x >= c.start && x < c.start + (c.out - c.in);

  function trackInfo(p) {
    const video = p.tracks.filter(tr => tr.kind === 'video');
    const z = {}; video.forEach((tr, i) => { z[tr.id] = video.length - i; });   // tracks higher in the list are on top
    const state = {}; for (const tr of p.tracks) state[tr.id] = tr;
    return { z, state };
  }

  function ensure(c) {
    let L = layers.get(c.id);
    if (L && L.src === c.src) return L;
    if (L) release(c.id);
    let el;
    if (c.type === 'video') { el = document.createElement('video'); el.preload = 'auto'; el.playsInline = true; }
    else if (c.type === 'audio') { el = document.createElement('audio'); el.preload = 'auto'; }
    else if (c.type === 'image') { el = document.createElement('img'); el.alt = ''; }
    else if (c.type === 'scene') { el = document.createElement('iframe'); el.setAttribute('tabindex', '-1'); el.className = 'layer scene'; }
    else return null;
    if (c.type !== 'audio') { el.classList.add('layer', 'hidden'); screen.insertBefore(el, msg); }
    L = { el, kind: c.type, src: c.src, ready: false };
    layers.set(c.id, L);
    if (c.type === 'scene') {
      el.src = sceneUrl(c.src);
      // draw once the scene says READY: its own start-up code paints frame 0 when its fonts load
      el.onload = () => {
        L.ready = true; sizeScene(L); draw();
        let n = 0; const wait = setInterval(() => {
          let ok = false; try { ok = el.contentWindow.READY === true; } catch { }
          if (ok || ++n > 60 || layers.get(c.id) !== L) { clearInterval(wait); if (layers.get(c.id) === L) { draw(); onRedraw?.(); } }
        }, 50);
      };
    } else if (c.type === 'image') {
      el.src = `/p/${encodeURIComponent(projectId)}/media?src=${encodeURIComponent(c.src)}`;
    } else {
      previewUrl(c.src).then(r => {
        if (layers.get(c.id) !== L) return;
        if (!r) { L.error = 'Missing file'; return; }
        if (!r.ready) { L.waiting = true; return; }
        L.waiting = false; el.src = r.url; L.ready = true;
        el.onloadeddata = () => draw();
      });
    }
    return L;
  }
  function release(id) {
    const L = layers.get(id); if (!L) return;
    if (L.el.pause) { L.el.pause(); L.el.removeAttribute('src'); L.el.load?.(); }
    L.el.remove(); layers.delete(id);
  }
  const sceneUrl = src => `/p/${encodeURIComponent(projectId)}/files/${src.split('/').map(encodeURIComponent).join('/')}/index.html?v=${sceneVersion[src] || 0}`;
  function sizeScene(L) {
    const p = getProject(); const s = screen.clientWidth / p.width;
    Object.assign(L.el.style, { width: p.width + 'px', height: p.height + 'px', transform: `scale(${s})`, transformOrigin: '0 0', inset: 'auto', left: '0', top: '0' });
  }

  // put every layer in the right state for time t
  function draw(seeking = false) {
    const p = getProject(), { z, state } = trackInfo(p);
    const near = new Set();
    let anyVisible = false, waiting = false, missing = false;
    for (const c of p.clips) {
      const st = state[c.track] || {};
      if (c.start - NEAR_AFTER > t || c.start + (c.out - c.in) + NEAR_BEFORE < t) continue;
      near.add(c.id);
      const L = ensure(c); if (!L) continue;
      const on = covers(c, t) && !(st.kind === 'video' && st.hidden);
      const local = c.in + (t - c.start);
      if (L.kind !== 'audio') { L.el.classList.toggle('hidden', !on); L.el.style.zIndex = z[c.track] || 0; }
      if (on) { anyVisible ||= L.kind !== 'audio'; waiting ||= !!L.waiting; missing ||= !!L.error; }
      if (L.kind === 'video' || L.kind === 'audio') {
        const el = L.el;
        const vol = c.muted || st.muted ? 0 : Math.min(1, c.volume ?? 1);
        if (el.volume !== vol) el.volume = vol;
        if (!L.ready) continue;
        if (on) {
          if (seeking || Math.abs(el.currentTime - local) > DRIFT || (!playing && Math.abs(el.currentTime - local) > 0.02)) { try { el.currentTime = local; } catch { } }
          if (playing && el.paused) el.play().catch(() => { });
          if (!playing && !el.paused) el.pause();
        } else {
          if (!el.paused) el.pause();
          // preload the first frame of a clip that is coming up
          if (c.start > t && Math.abs(el.currentTime - c.in) > 0.05 && el.readyState >= 1) { try { el.currentTime = c.in; } catch { } }
        }
      } else if (L.kind === 'scene' && on && L.ready) {
        try { L.el.contentWindow.renderOut?.(Math.max(0, local)); } catch { }
      }
    }
    for (const id of [...layers.keys()]) if (!near.has(id)) release(id);
    msg.textContent = waiting ? 'Preparing a preview copy of this video…' : missing ? 'A file on the timeline is missing' : !p.clips.length ? 'Drop videos here or add them from the left' : anyVisible ? '' : '';
  }

  function loop() {
    if (!playing) return;
    t = startT + (performance.now() - startPerf) / 1000;
    const end = dur();
    if (t >= end) { t = end; pause(); onEnd?.(); }
    draw(); onTime?.(t);
    raf = requestAnimationFrame(loop);
  }
  function play() {
    if (playing) return;
    if (t >= dur() - 0.01) t = 0;
    playing = true; startT = t; startPerf = performance.now();
    draw(true); loop();
  }
  function pause() {
    playing = false; cancelAnimationFrame(raf);
    for (const L of layers.values()) if (L.el.pause && !L.el.paused) L.el.pause();
    draw(true); onTime?.(t);
  }
  function seek(x) {
    t = Math.max(0, Math.min(x, Math.max(dur(), 0)));
    if (playing) { startT = t; startPerf = performance.now(); }
    draw(true); onTime?.(t);
  }
  function resize() { for (const L of layers.values()) if (L.kind === 'scene') sizeScene(L); }
  function reloadScene(src) {
    sceneVersion[src] = (sceneVersion[src] || 0) + 1;
    for (const [id, L] of layers) if (L.kind === 'scene' && L.src === src) release(id);
    draw(true);
  }
  function refreshMedia() { for (const [id, L] of layers) if (L.waiting || L.error) release(id); draw(true); }
  // The frame as it looks now, drawn into a canvas of the project's size (for notes and covers).
  function capture(scale = 1) {
    const p = getProject(), W = Math.round(p.width * scale), H = Math.round(p.height * scale);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const fit = (sw, sh) => { const k = Math.min(W / sw, H / sh); return [(W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k]; };
    const vis = [...layers.values()].filter(L => L.kind !== 'audio' && !L.el.classList.contains('hidden')).sort((a, b) => (+a.el.style.zIndex || 0) - (+b.el.style.zIndex || 0));
    for (const L of vis) {
      try {
        if (L.kind === 'video' && L.el.videoWidth) g.drawImage(L.el, ...fit(L.el.videoWidth, L.el.videoHeight));
        else if (L.kind === 'image' && L.el.naturalWidth) g.drawImage(L.el, ...fit(L.el.naturalWidth, L.el.naturalHeight));
        else if (L.kind === 'scene') {
          const doc = L.el.contentDocument; if (!doc) continue;
          const cs = [...doc.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height);
          for (const c of cs.slice(0, 4).reverse()) if (c.width && c.height) g.drawImage(c, 0, 0, W, H);
        }
      } catch { }
    }
    return cv;
  }
  // what is on screen at time x (for notes): clip, its track, and the time inside its source
  function onScreen(x = t) {
    const p = getProject(), names = Object.fromEntries(p.tracks.map(tr => [tr.id, tr.name]));
    return p.clips.filter(c => covers(c, x) && c.type !== 'audio').map(c => ({ id: c.id, name: c.name || c.src.split('/').pop(), src: c.src, type: c.type, track: names[c.track] || c.track, local: +(c.in + (x - c.start)).toFixed(3) }));
  }
  function destroy() { playing = false; cancelAnimationFrame(raf); for (const id of [...layers.keys()]) release(id); }

  return { play, pause, seek, toggle: () => playing ? pause() : play(), get time() { return t; }, get playing() { return playing; }, refresh: () => draw(true), resize, reloadScene, refreshMedia, destroy, duration: dur, capture, onScreen };
}
