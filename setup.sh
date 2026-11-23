#!/bin/sh
# Sets up Code Motion and connects your coding agent. Run it again any time; it only fixes what is missing.
#   ./setup.sh                    connect the agent running this (from a plain terminal: every agent found)
#   ./setup.sh --agents all       connect Claude Code, OpenCode and Codex, whichever are installed
#   ./setup.sh --desktop          also put Code Motion on the Desktop
#   ./setup.sh --dry-run          show what would happen
#   ./setup.sh --uninstall        disconnect the agents and remove the menu entry (projects stay)
DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
NODE="$(sh "$DIR/bin/find-node.sh")" || {
  echo "Code Motion needs Node.js 22 or newer."
  echo "  Ubuntu/Debian: see https://nodejs.org/en/download (or: nvm install 22)"
  echo "  Fedora: sudo dnf install nodejs   Arch: sudo pacman -S nodejs   macOS: brew install node"
  exit 1
}
exec "$NODE" "$DIR/scripts/setup.mjs" "$@"
