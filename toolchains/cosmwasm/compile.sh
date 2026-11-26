#!/bin/bash
# usage: compile [dir]  (default /work). Project: Cargo.toml (cdylib, wasm) + src/*.rs
[ "${1:-compile}" = compile ] || { echo "unknown command $1" >&2; exit 2; }
SRC=${2:-/work}
export CARGO_NET_OFFLINE=true
OUT=$(mktemp -d)
cp -r "$SRC"/. "$OUT"/ || exit 2
cd "$OUT" || exit 2
[ -f Cargo.toml ] || { echo "error: Cargo.toml not found" >&2; exit 3; }
# Seed the lockfile pinned in the image when the project has none (keeps resolution inside the vendored registry).
[ -f Cargo.lock ] || cp /sample/Cargo.lock . 2>/dev/null
cargo build --release --lib --target wasm32-unknown-unknown 2>&1 || exit $?
W=$(ls "$CARGO_TARGET_DIR"/wasm32-unknown-unknown/release/*.wasm 2>/dev/null | head -1)
[ -n "$W" ] || { echo "error: no .wasm produced (needs crate-type cdylib)" >&2; exit 4; }
wasm-opt -Os --signext-lowering "$W" -o "$W.opt" 2>/dev/null && mv "$W.opt" "$W"
cosmwasm-check "$W" 2>&1 || exit $?
