// Core checks with a throwaway workspace, config and cache under .test-tmp (never the real ones).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.test-tmp', 'unit-' + process.pid);
fs.rmSync(root, { recursive: true, force: true });
process.env.CODEMOTION_WORKSPACE = path.join(root, 'ws');
process.env.CODEMOTION_CONFIG_DIR = path.join(root, 'cfg');
process.env.CODEMOTION_CACHE_DIR = path.join(root, 'cache');

const P = await import('../server/projects.js');
const X = await import('../server/exporter.js');
const C = await import('../server/cleaner.js');
const A = await import('../server/agent.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a new project explains itself to agents and lists in the workspace', () => {
  const id = P.createProject('My First Video!');
  assert.equal(id, 'my-first-video');
  const dir = P.projectDir(id);
  for (const f of ['project.json', 'CLAUDE.md', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(P.listProjects()[0].name, 'My First Video!');
  assert.equal(P.createProject('My First Video!'), 'my-first-video-2');
});

test('normalize keeps hand-written projects usable', () => {
  const p = P.normalize({ name: 'x', clips: [
    { id: 'a', track: 'v1', src: 'media/a.mp4', start: -3, in: 2, out: 1 },
    { id: 'a', track: 'v1', src: 'scenes/title', start: 1, in: 0, out: 4 },
    { track: 'nope', src: 'media/b.mp4' },
  ] });
  assert.equal(p.clips.length, 2);
  assert.equal(p.clips[0].start, 0);
  assert.ok(p.clips[0].out > p.clips[0].in);
  assert.notEqual(p.clips[0].id, p.clips[1].id);
  assert.equal(p.clips[1].type, 'scene');
});

test('saving refuses to overwrite a change it has not seen (agent edits keep rev)', () => {
  const id = P.createProject('Conflict');
  const p = P.loadProject(id);
  const f = path.join(P.projectDir(id), 'project.json');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8')); raw.name = 'Changed by agent';
  const later = new Date(Date.now() + 5000); fs.writeFileSync(f, JSON.stringify(raw)); fs.utimesSync(f, later, later);
  assert.throws(() => P.saveProject(id, p, p.version), e => e.status === 409);
  const fresh = P.loadProject(id);
  assert.equal(P.saveProject(id, { ...fresh, name: 'Mine' }, fresh.version).name, 'Mine');
});

test('the export graph layers tracks top over bottom and mixes sound', async () => {
  const id = P.createProject('Graph');
  const p = P.loadProject(id);
  p.clips = [
    { id: 'i1', track: 'v1', type: 'image', src: 'media/a.png', start: 0, in: 0, out: 3 },
    { id: 's1', track: 'v2', type: 'scene', src: 'scenes/t', start: 1, in: 0, out: 2 },
  ];
  const { args } = await X.buildCommand(P.normalize(p), id, new Map([['scenes/t', '/tmp/t.mov']]));
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /color=c=black:s=1920x1080/);
  assert.ok(graph.indexOf('[base][v0]') >= 0 && graph.indexOf('[o0][v1]') > graph.indexOf('[base][v0]'), 'image below, scene above');
  assert.match(graph, /enable='between\(t,1\.000,3\.000\)'/);
  assert.match(graph, /anull\[aout\]/);   // no sound sources → silent track
});

test('clean up finds caches and never offers files outside them for deletion', async () => {
  fs.mkdirSync(path.join(process.env.CODEMOTION_CACHE_DIR, 'thumbs'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEMOTION_CACHE_DIR, 'thumbs', 'x.jpg'), 'x'.repeat(2000));
  const items = await C.scan();
  const thumbs = items.find(i => i.id === 'cache:thumbs');
  assert.ok(thumbs && thumbs.size >= 2000);
  for (const it of items.filter(i => i.action === 'delete')) assert.ok(path.resolve(it.path).startsWith(path.resolve(process.env.CODEMOTION_CACHE_DIR)));
  const r = await C.clean(['cache:thumbs']);
  assert.ok(r.freed >= 2000);
  assert.ok(!fs.existsSync(path.join(process.env.CODEMOTION_CACHE_DIR, 'thumbs')));
});

test('agent detection returns only agents that exist', () => {
  for (const a of A.detectAgents(true)) assert.ok(fs.existsSync(a.path), a.path);
});

test('notes keep the exact frame, place and pictures, and the prompt says all of it', async () => {
  const N = await import('../server/notes.js');
  const id = P.createProject('Notes', { film: true });
  const px = 'data:image/jpeg;base64,' + Buffer.from('fake').toString('base64');
  const n = N.addNote(id, { time: 2.129, frame: 64, shape: { type: 'circle', cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.1 }, text: 'Bigger title', clips: [{ name: 'Film', src: 'scenes/film', type: 'scene', track: 'Video 1', local: 2.129 }], image: px, close: px });
  assert.equal(n.n, 1);
  assert.ok(fs.existsSync(path.join(P.projectDir(id), n.image)));
  const prompt = N.notesPrompt(id, [n.id]);
  assert.match(prompt, /frame 64/);
  assert.match(prompt, /x 480–1440, y 432–648 px/);
  assert.match(prompt, /Bigger title/);
  assert.match(prompt, /scene "Film"/);
  N.markSent(id, [n.id]); assert.equal(N.loadNotes(id)[0].status, 'sent');
  N.updateNote(id, n.id, { status: 'fixed', reply: 'Done' }); assert.equal(N.loadNotes(id)[0].status, 'fixed');
});

test('a film project starts with its code scene on the timeline', () => {
  const id = P.createProject('Film one', { film: true, width: 1080, height: 1920 });
  const p = P.loadProject(id);
  assert.equal(p.width, 1080);
  assert.equal(p.clips[0].type, 'scene');
  assert.ok(fs.readFileSync(path.join(P.projectDir(id), 'scenes/film/index.html'), 'utf8').includes('width="1080" height="1920"'));
});

test('folders group projects; deleting a folder keeps its projects', () => {
  const f = P.addFolder('Clients');
  const id = P.createProject('In folder', { folder: f.id });
  assert.equal(P.listProjects().find(p => p.id === id).folder, f.id);
  P.deleteFolder(f.id);
  assert.equal(P.listProjects().find(p => p.id === id).folder, null);
  assert.ok(fs.existsSync(P.projectDir(id)));
});

test('agents can name a project by id, name or any folder inside it', () => {
  const id = P.createProject('Find Me');
  assert.equal(P.findProject(id), id);
  assert.equal(P.findProject('find me'), id);
  assert.equal(P.findProject(path.join(P.projectDir(id), 'scenes')), id);
  assert.equal(P.findProject('/nowhere/at/all'), null);
});
