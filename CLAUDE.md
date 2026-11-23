# Code Motion: notes for agents working on this app

A local review tool for videos coding agents make as code, with simple manual editing (Node 22+, ES modules, no build step, **zero npm dependencies**, vanilla-JS UI). Linux first;
macOS/Windows best effort. Read README.md first.

## Setting up Code Motion for the user
When the user gives you this repository (a link or this folder) and asks you to set it up or install it, do it for
them and explain each step briefly in their language. Don't change application code during a setup.
1. If you only have the link: `git clone <link> ~/CodeMotion` (or a folder the user names), then work in that folder.
   Keep it there: the connection points to this folder (running setup again after a move fixes it).
2. Run `sh setup.sh --dry-run`, then `sh setup.sh`. It checks Node 22+, ffmpeg and Chrome/Chromium, makes the projects
   folder, adds Code Motion to the app menu and **connects you, the agent running it** (Claude Code, OpenCode or Codex:
   a `codemotion` tool server and skill). Add `--agents all` when the user wants every installed agent connected, and
   `--desktop` for a Desktop icon. Nothing needs root; it never edits other entries in the agents' settings.
3. Read the output. For a missing tool, tell the user the install command it prints and ask before installing system
   packages yourself. Re-running setup is always safe.
4. Tell the user: open Code Motion from the app menu (or `./codemotion.sh`), then start a **new** chat with you (open
   chats don't load new tools) and ask for a video. Undo everything with `sh setup.sh --uninstall` (projects stay).

## Map
- `server/main.js` — loopback HTTP server, routes, server-sent events, watcher of the open project, idle exit.
- `server/env.js` — XDG folders, config, tool discovery, `politeSpawnArgs` (nice/ionice). The only place for OS paths.
- `server/projects.js` — project folders, `project.json` (normalize, save with a file-stamp conflict check), media bin, scenes.
- `server/media.js` — ffprobe, thumbnails, waveforms, preview proxies; one low-priority ffmpeg at a time.
- `server/exporter.js` + `cdp.js` — export: scenes drawn in headless Chrome over DevTools (built-in WebSocket), one ffmpeg graph.
- `server/agent.js` — finds Claude Code / Codex / OpenCode, sign-in check, runs a chat turn in the project folder, parses its stream.
- `server/notes.js` — review notes (shape on an exact frame + comment + marked pictures) and the prompt agents get.
- `server/mcp.js` — the zero-dependency MCP tool server for the agents' own chats; `server/connect.js` registers it and
  `server/skill.md` with Claude Code / OpenCode / Codex (only Code Motion's own entries), spots and repairs stale
  entries (`repair()`, also run 5 s after the real server starts), knows the agent running it and `verify()`s the handshake.
- `setup.sh` → `scripts/setup.mjs` — checks, folders, app menu, agent connection and a live check; `install.sh` is its old name.
- `bin/codemotion-mcp` (what agents start) and `bin/find-node.sh` (Node 22+ without the shell's PATH; also used by `codemotion.sh`).
- `server/cleaner.js`, `trash.js` — Clean up; caches deleted, project files to the Trash.
- `server/agent-guide.md` — the project format, copied into each project as CLAUDE.md / AGENTS.md.
- `ui/` — `app.js` (router), `home.js` (home, folders, settings, clean up), `editor.js`, `player.js` (live preview, frame capture), `annotate.js` (marks and notes), `timeline.js`, `chat.js`, `lib.js`.

## Rules
- Keep it light: no polling loops while idle, no folder walks in request paths without yielding, heavy work through `politeSpawnArgs`.
- Never hard-delete user files: Trash for anything in a project; direct delete only inside the cache folder.
- The UI never imports `server/`. No npm packages. English UI.
- Never change the user's real agent configs in tests: use a fake HOME/XDG_CONFIG_HOME (OpenCode also needs `run --standalone`, its background service reads the real config).
- Test on a scratch server (`CODEMOTION_NO_WINDOW=1`, port 7797–7799, `CODEMOTION_WORKSPACE/CONFIG_DIR/CACHE_DIR` under `.test-tmp`), never the user's projects. Stop test servers afterwards.
- `npm test` and `node --check` changed files before handing work back.
