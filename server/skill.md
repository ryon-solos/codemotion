---
name: codemotion
description: Make and fix videos with Code Motion, the user's local video review tool for videos written as code. Use whenever the user asks for a video, animation, explainer, intro, short or motion graphics made in code, wants to edit or combine existing videos, mentions Code Motion, review notes on frames, or pastes Code Motion notes.
---

# Code Motion workflow

Code Motion (installed at `{{APP_DIR}}`) plays a video straight from its code with no render, lets the user circle,
point at, box or draw on any frame and comment, and sends those notes back to you with the exact time, frame, pixel
area and a marked picture. **Never render to check your work and never render repeatedly: the preview is live.**

## Tools (MCP server `codemotion`)
- `codemotion_new({name, kind?, duration?, width?, height?, fps?, folder?})` — creates the project in the user's
  workspace and opens it. `kind:"film"` (default) gives `scenes/film/index.html` to write the film in; `kind:"edit"`
  starts an empty timeline for existing videos.
- `codemotion_import({project, files})` — add existing videos/audio/images (absolute paths) to the timeline.
- `codemotion_open({project, time?})` — show it in Code Motion after a change.
- `codemotion_wait({project})` — wait for the user's notes instead of ending your turn ("nothing yet" → call again).
- `codemotion_notes({project})`, `codemotion_note_done({project, id, reply})`, `codemotion_project({project})`.
- `codemotion_export({project})` — only when the user asks for the final MP4.

Without the tools, the same works by hand: projects are folders in the user's Code Motion workspace (shown in the app),
each with `project.json`, `scenes/`, `media/` and a `CLAUDE.md` describing the format.

## The loop
1. `codemotion_new` (one project per video). Write the film in `scenes/film/index.html`:
   - one canvas the size of the project; `window.renderOut(t)` draws second `t` **synchronously**, as a pure function
     of `t` (no `Date.now()`, no state between frames, no unseeded `Math.random()`);
   - `window.READY = true` when fonts and images are loaded;
   - `scenes/film/scene.json` `{"duration": seconds}`; keep the film clip in `project.json` the same length.
   More scenes (titles, lower thirds with a transparent background) go in `scenes/<name>/` as clips on higher tracks.
2. `codemotion_open`, tell the user in one sentence (in their language) that it is open in Code Motion and they can mark
   notes on frames, then call `codemotion_wait`.
3. Notes arrive: open each note's pictures first (the red mark is the spot), fix the code, `codemotion_note_done` per
   note, tell the user what changed in 1–2 sentences, and `codemotion_wait` again.
4. Export only when asked.

Never delete the user's media. Throwaway files go in `.cm/tmp/` inside the project.
