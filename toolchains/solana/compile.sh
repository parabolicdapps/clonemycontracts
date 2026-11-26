#!/bin/bash
# usage: compile [dir]  (default /work). Project: Anchor workspace (Anchor.toml, Cargo.toml, programs/app/...)
[ "${1:-compile}" = compile ] || { echo "unknown command $1" >&2; exit 2; }
SRC=${2:-/work}
export CARGO_NET_OFFLINE=true
OUT=$(mktemp -d)
cp -r "$SRC"/. "$OUT"/ || exit 2
cd "$OUT" || exit 2
[ -f Anchor.toml ] || { echo "error: Anchor.toml not found" >&2; exit 3; }
[ -f Cargo.lock ] || cp /sample/Cargo.lock . 2>/dev/null
anchor build 2>&1
rc=$?
[ $rc -eq 0 ] && ls "$CARGO_TARGET_DIR"/deploy/*.so >/dev/null 2>&1 || { [ $rc -eq 0 ] && echo "error: no .so produced" >&2 && rc=4; }
exit $rc
