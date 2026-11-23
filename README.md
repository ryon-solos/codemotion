# Code Motion

A local review tool for videos your coding agent makes as code. It isn't a video maker of its own.

## Get it in one message
Copy this link and send it to your coding agent (Claude Code, OpenCode or Codex):

> Set up Code Motion for me: https://github.com/ryon-solos/codemotion

The agent downloads it, runs the setup and connects itself. Then start a new chat and ask it for a video.
Free and open source (MIT). Linux first; macOS works, Windows is best effort.

1. **Ask your agent for a video in its own chat** (Claude Code, OpenCode or Codex). With Code Motion connected, the
   agent creates the project, writes the film as code and opens it here. Nothing is rendered.
2. **Watch it live and mark what's wrong.** Pause on the frame, then point, circle, box or draw on it and write what
   should change. Each note keeps the exact time, frame and pixel position, plus a picture of the frame with the mark.
3. **Send the notes.** "Fix with AI" sends them to the chat beside the preview, or "Send to the waiting agent chat"
   sends them to your agent's own chat while it waits (`codemotion_wait`). The agent fixes the code; the preview and
   timeline update by themselves and the note turns green.
4. **Export once**, when you're happy.

You can also edit by hand: import several videos, sounds and pictures, then move, trim, split, delete and mute clips,
stack tracks, and undo or redo everything. Changes the agent makes show up highlighted, and Undo takes them back too.

## Home
- **Edit a new video**: edit existing videos, or start a film made in code (16:9, 9:16 or 1:1).
- **Clean up**: caches, temporary files, unfinished exports, old dependencies and unused media, with their sizes.
  Caches are deleted (they rebuild when needed); anything inside a project goes to the Trash.
- **Folders** group projects. Each project's ⋯ menu has: Open, **Open the chat in your coding agent** (the
  conversation that made it, in the Claude desktop app or a terminal), Show in file manager, Move to folder, Rename and
  Move to Trash.
- **Settings**: connect your agents, what the editor's chat may do, export quality and processor use, the projects
  folder, and when the background server stops.

## Install
The easy way: give this repository's link to your coding agent and say **"set this up"**. It clones it, runs
`sh setup.sh` and connects itself to Code Motion. By hand:
```bash
git clone https://github.com/ryon-solos/codemotion ~/CodeMotion && cd ~/CodeMotion
sh setup.sh                # connects the agent running it; from a plain terminal, every agent it finds
```
Setup checks Node 22+, ffmpeg and Chrome, makes the projects folder, adds Code Motion to the app menu, connects the
agents, and checks the connection by starting the tool server the way they will. Options: `--agents all` (or
`claude,opencode,codex`), `--desktop`, `--dry-run`, `--uninstall` (projects stay). Running it again is always safe.

## Connecting your agent
Setup does it, and Settings → Coding agents → **Connect** does the same with one click: Code Motion's tool server and a
skill go into that agent (`claude mcp add` for Claude Code, `opencode mcp add --global` for OpenCode, an entry in
`config.toml` for Codex). The entry starts `bin/codemotion-mcp`, which finds Node 22+ by itself, so updating Node or
switching it with nvm doesn't break it. If the folder moves, Code Motion re-points the entries the next time it starts.
Only Code Motion's own entries are added or removed. Start a new chat in the agent afterwards.

Tools: `codemotion_new`, `codemotion_open`, `codemotion_import`, `codemotion_project`, `codemotion_wait`,
`codemotion_notes`, `codemotion_note_done`, `codemotion_export`.

The chat beside the preview runs the agent inside the project folder and has a model menu. If the Claude Code that
comes with the Claude desktop app isn't signed in for command-line use, the chat shows a **Sign in** button (a
one-time `claude auth login`).

## Requirements and start
Node.js 22+, ffmpeg, and Google Chrome or Chromium (a native package, not the Snap). On Ubuntu: `sudo apt install ffmpeg zenity`.
```bash
sh setup.sh               # once: checks, app menu entry, agent connection
./codemotion.sh         # or open it from the menu: http://127.0.0.1:7790 in an app window
```
Projects live in `~/Videos/CodeMotion/<project>/`, settings in `~/.config/codemotion/`, and caches in `~/.cache/codemotion/`.
It stays light: zero npm dependencies, one ffmpeg at a time at low priority, thumbnails and strips made only when
shown, and the server stops a few minutes after the last window closes.

## Keyboard
Space: play/pause · P / C / R / D: point, circle, box, draw · Esc: cancel · N: notes · S: split · Delete: remove clip
· M: mute clip · ←/→: one frame (Shift: one second) · Home/End · Ctrl+Z / Ctrl+Shift+Z · Ctrl+wheel on the timeline: zoom

## Project format
[server/agent-guide.md](server/agent-guide.md), copied into every project as `CLAUDE.md` and `AGENTS.md`.

## Development
`npm test` runs the checks with a throwaway workspace under `.test-tmp/`. For a test server, use another port and
scratch folders, and keep it from opening windows:
`CODEMOTION_NO_WINDOW=1 CODEMOTION_PORT=7797 CODEMOTION_WORKSPACE=$PWD/.test-tmp/ws CODEMOTION_CONFIG_DIR=$PWD/.test-tmp/cfg CODEMOTION_CACHE_DIR=$PWD/.test-tmp/cache node server/main.js`
