// Review notes: a mark on an exact frame (point, circle, rectangle or drawing) with a comment.
// Stored in <project>/.cm/notes.json; pictures of the marked frame in <project>/.cm/notes/.
// Status: open → sent (to an agent) → fixed (the agent says so) → reopened (the user says it is still there).
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './env.js';
import { httpError, loadProject, projectDir } from './projects.js';

const file = id => path.join(projectDir(id), '.cm', 'notes.json');
export function loadNotes(id) { return readJson(file(id), { notes: [] }).notes || []; }
function saveNotes(id, notes) { writeJson(file(id), { notes }); }

function saveImage(id, name, dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const dir = path.join(projectDir(id), '.cm', 'notes'); fs.mkdirSync(dir, { recursive: true });
  const rel = `.cm/notes/${name}.${m[1] === 'png' ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(projectDir(id), rel), Buffer.from(m[2], 'base64'));
  return rel;
}

export function addNote(id, body) {
  const notes = loadNotes(id);
  const n = notes.reduce((m, x) => Math.max(m, x.n || 0), 0) + 1;
  const nid = 'n' + n + '-' + Date.now().toString(36);
  const shape = body.shape || { type: 'point', x: 0.5, y: 0.5 };
  const note = {
    id: nid, n, time: +(+body.time || 0).toFixed(3), frame: Math.round(+body.frame || 0), shape,
    text: String(body.text || '').slice(0, 4000), clips: Array.isArray(body.clips) ? body.clips.slice(0, 8) : [],
    status: 'open', created: Date.now(),
    image: saveImage(id, nid, body.image), close: saveImage(id, nid + '-close', body.close),
  };
  notes.push(note); saveNotes(id, notes);
  return note;
}
export function updateNote(id, nid, patch) {
  const notes = loadNotes(id), note = notes.find(x => x.id === nid);
  if (!note) throw httpError(404, 'Note not found');
  for (const k of ['text', 'status', 'reply']) if (k in patch) note[k] = String(patch[k]).slice(0, 4000);
  if (patch.status === 'reopened') note.reopened = (note.reopened || 0) + 1;
  saveNotes(id, notes); return note;
}
export function deleteNote(id, nid) {
  const notes = loadNotes(id), note = notes.find(x => x.id === nid);
  if (!note) return false;
  for (const f of [note.image, note.close]) if (f) fs.rm(path.join(projectDir(id), f), { force: true }, () => { });
  saveNotes(id, notes.filter(x => x.id !== nid)); return true;
}
export function markSent(id, ids) {
  const notes = loadNotes(id);
  for (const n of notes) if (ids.includes(n.id) && n.status !== 'fixed') n.status = 'sent';
  saveNotes(id, notes);
}

const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; };
function where(s, W, H) {
  const X = v => Math.round(v * W), Y = v => Math.round(v * H);
  if (s.type === 'point') return `point at x ${X(s.x)}, y ${Y(s.y)} px`;
  if (s.type === 'circle') return `circle around x ${X(s.cx - s.rx)}–${X(s.cx + s.rx)}, y ${Y(s.cy - s.ry)}–${Y(s.cy + s.ry)} px (centre ${X(s.cx)}, ${Y(s.cy)})`;
  if (s.type === 'rect') return `rectangle x ${X(s.x)}–${X(s.x + s.w)}, y ${Y(s.y)}–${Y(s.y + s.h)} px`;
  if (s.type === 'draw' && s.points?.length) {
    const xs = s.points.map(p => p[0]), ys = s.points.map(p => p[1]);
    return `drawn mark inside x ${X(Math.min(...xs))}–${X(Math.max(...xs))}, y ${Y(Math.min(...ys))}–${Y(Math.max(...ys))} px`;
  }
  return 'whole frame';
}

// What the agent reads: exact time, frame, place in pixels, what is on screen there, and the marked pictures.
export function notesPrompt(id, ids) {
  const p = loadProject(id), dir = projectDir(id);
  const notes = loadNotes(id).filter(n => ids.includes(n.id)).sort((a, b) => a.time - b.time);
  if (!notes.length) throw httpError(400, 'No notes selected');
  const lines = [`Fix ${notes.length === 1 ? 'this review note' : `these ${notes.length} review notes`} on the video. Each note gives the exact time and frame, the marked place in pixels of the ${p.width}×${p.height} frame, what is on screen there, and a picture of that frame with the place marked in red (open the pictures with your file-reading tool before changing anything).`, ''];
  for (const n of notes) {
    lines.push(`Note #${n.n} at ${fmt(n.time)} (t = ${n.time.toFixed(3)} s, frame ${n.frame} at ${p.fps} fps)${n.status === 'reopened' ? ' — REOPENED: the last fix did not work' : ''}`);
    lines.push(`  Where: ${where(n.shape, p.width, p.height)}`);
    if (n.clips?.length) lines.push(`  On screen: ${n.clips.map(c => `${c.type === 'scene' ? 'scene' : 'clip'} "${c.name}" (${c.src}, track ${c.track}, ${c.type === 'scene' ? 'scene' : 'source'} time ${(+c.local).toFixed(2)} s)`).join('; ')}`);
    lines.push(`  Request: "${n.text || '(no comment: look at the mark)'}"`);
    if (n.reply) lines.push(`  Your previous reply: "${n.reply}"`);
    const pics = [n.image && path.join(dir, n.image), n.close && path.join(dir, n.close)].filter(Boolean);
    if (pics.length) lines.push(`  Pictures: ${pics.join('  |  ')}`);
    lines.push(`  Note id: ${n.id}`, '');
  }
  lines.push('Change the project code or project.json so each request holds on every frame it concerns. When a note is fixed, set its "status" to "fixed" and add a one-sentence "reply" in .cm/notes.json (or call the codemotion_note_done tool). Then say in one or two sentences what changed.');
  return lines.join('\n');
}
