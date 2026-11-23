# Code Motion project

This folder is a video project opened in **Code Motion**, a local video editor. The user watches the preview and the
timeline in Code Motion while you work; every file you change shows up there within a second. You do not render or
export: the user presses Export in the app.

## Files
- `project.json` — the edit. Keep it valid JSON; Code Motion reloads it on every save.
- `media/` — video, audio and image files. Put new files here (generated audio, downloaded images...).
- `scenes/<name>/` — motion graphics written as code: `index.html` + `scene.json`.
- `exports/` — finished videos made by Code Motion. Do not edit.
- `.cm/` — Code Motion's own files. Do not edit them, except a note's `status` ("fixed") and `reply` in `.cm/notes.json` after fixing it.
- `.cm/notes/` — pictures of review notes: the frame with the marked spot in red (read them before fixing a note).
- Temporary files go to `.cm/tmp/` (the app's Clean up removes them).

## project.json
```json
{
  "name": "My video", "width": 1920, "height": 1080, "fps": 30, "rev": 7,
  "tracks": [
    { "id": "v2", "kind": "video", "name": "Video 2" },
    { "id": "v1", "kind": "video", "name": "Video 1" },
    { "id": "a1", "kind": "audio", "name": "Audio 1" }
  ],
  "clips": [
    { "id": "c1", "track": "v1", "type": "video", "src": "media/intro.mp4", "start": 0, "in": 2, "out": 8, "volume": 1, "muted": false, "name": "intro" },
    { "id": "c2", "track": "v2", "type": "scene", "src": "scenes/title", "start": 1, "in": 0, "out": 4, "name": "Title" },
    { "id": "c3", "track": "a1", "type": "audio", "src": "media/music.mp3", "start": 0, "in": 0, "out": 30, "volume": 0.4 }
  ],
  "media": [ { "src": "/home/user/Videos/clip.mp4", "name": "clip.mp4" } ]
}
```
- Times are seconds. A clip plays source time `in`..`out` at timeline time `start`..`start + (out - in)`.
- `type`: `video`, `audio`, `image` (shows for `out - in` seconds) or `scene`.
- `src`: a path relative to this folder, or an absolute path of a file elsewhere (then also list it in `media`).
- Tracks are listed top to bottom. Video tracks higher in the list cover the ones below; transparent scenes let the
  video below show through. Audio from video clips and audio clips is mixed.
- Clip ids must be unique. Keep `rev` as it is (Code Motion counts it). Keep clips you were not asked to change.
- Find a file's length with `ffprobe -v error -show_entries format=duration -of csv=p=0 "<file>"`.

## Scenes (motion graphics as code)
`scenes/<name>/index.html` draws on one fixed-size canvas (the project's width × height):
- `window.renderOut(t)` draws second `t` of the scene **synchronously**, as a pure function of `t` (no `Date.now()`,
  no state carried between frames, no unseeded `Math.random()`), so any frame can be drawn in any order;
- `window.READY = true` once fonts/images are loaded;
- keep the page background transparent when the scene should sit over video (titles, lower thirds, callouts).
`scenes/<name>/scene.json`: `{ "name": "Title", "duration": 5, "transparent": true }`.
To use a scene, add a clip with `"type": "scene", "src": "scenes/<name>"`. Start from an existing scene folder.

## Working style
Make the change the user asks for, keep the JSON valid, then say in one or two sentences what changed and where on the
timeline. Never delete the user's media files.
