#!/bin/bash
# usage: compile [dir]  (default /work). Project: Move.toml + sources/*.move
[ "${1:-compile}" = compile ] || { echo "unknown command $1" >&2; exit 2; }
SRC=${2:-/work}
OUT=$(mktemp -d)
cp -r "$SRC"/. "$OUT"/ || exit 2
cd "$OUT" || exit 2
[ -f Move.toml ] || { echo "error: Move.toml not found" >&2; exit 3; }
aptos move compile --skip-fetch-latest-git-deps --save-metadata 2>&1 | sed 's/^/[aptos] /'
exit ${PIPESTATUS[0]}
