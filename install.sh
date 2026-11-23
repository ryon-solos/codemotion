#!/bin/sh
# Older name for setup.sh (kept so existing instructions still work).
exec sh "$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)/setup.sh" "$@"
