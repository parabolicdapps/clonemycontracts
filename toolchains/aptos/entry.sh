#!/bin/bash
# cmc-toolchain-aptos:0.2 entry.   usage: compile|test [dir]   (dir defaults to /work, mounted read-only)
#   compile  aptos move compile
#   test     aptos move test (Move unit tests in <dir>/tests/*.move, #[test_only]); the runner output is printed as is
CMD=${1:-compile}
SRC=${2:-/work}
case "$CMD" in compile|test) ;; *) echo "unknown command '$CMD' (compile | test)" >&2; exit 2;; esac
OUT=$(mktemp -d)
cp -r "$SRC"/. "$OUT"/ || exit 2
cd "$OUT" || exit 2
find . -name '._*' -delete   # AppleDouble files from macOS tar break the Move package loader
[ -f Move.toml ] || { echo "error: Move.toml not found" >&2; exit 3; }
if [ "$CMD" = compile ]; then
  aptos move compile --skip-fetch-latest-git-deps --save-metadata 2>&1 | sed 's/^/[aptos] /'
else
  aptos move test --skip-fetch-latest-git-deps --ignore-compile-warnings 2>&1 | sed 's/^/[aptos] /'
fi
exit ${PIPESTATUS[0]}
