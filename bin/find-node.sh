#!/bin/sh
# Prints a Node.js 22+ to use, even when started without your shell's PATH (app menu, coding agents):
# $CODEMOTION_NODE, node on PATH, then nvm, fnm, volta, asdf, mise and the usual system folders, newest first.
major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null; }
for n in "${CODEMOTION_NODE:-}" "$(command -v node 2>/dev/null)" \
  $(ls -d "$HOME"/.nvm/versions/node/*/bin/node "${XDG_DATA_HOME:-$HOME/.local/share}"/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.fnm/node-versions/*/installation/bin/node "$HOME"/.asdf/installs/nodejs/*/bin/node \
    "${XDG_DATA_HOME:-$HOME/.local/share}"/mise/installs/node/*/bin/node 2>/dev/null | sort -V -r) \
  "$HOME/.volta/bin/node" "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node; do
  [ -n "$n" ] && [ -x "$n" ] || continue
  m="$(major "$n")"
  [ -n "$m" ] && [ "$m" -ge 22 ] 2>/dev/null && { echo "$n"; exit 0; }
done
exit 1
