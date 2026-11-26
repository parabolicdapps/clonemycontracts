#!/bin/bash
# cmc-toolchain-cosmwasm:0.2 entry.   usage: compile|test|run-plan [dir]   (dir defaults to /work)
#   compile  [dir]  as 0.1 (wasm build + wasm-opt + cosmwasm-check); if /out is writable, copies the wasm to /out/app.wasm
#   test     [dir]  compile, then run-plan
#   run-plan [dir]  no wasm build: build cmc-cosmwasm-runner natively against the project source, run <dir>/cmc/plan.json
# The runner JSON is printed to stdout between ===CMC_RESULT_BEGIN=== and ===CMC_RESULT_END===.
CMD=${1:-compile}
SRC=${2:-/work}
export CARGO_NET_OFFLINE=true

do_compile() {
  /usr/local/bin/cmc-compile compile "$SRC"; local rc=$?
  if [ $rc -eq 0 ] && [ -d /out ] && [ -w /out ]; then
    local w; w=$(ls "$CARGO_TARGET_DIR"/wasm32-unknown-unknown/release/*.wasm 2>/dev/null | head -n1)
    [ -n "$w" ] && cp "$w" /out/app.wasm
  fi
  return $rc
}

do_run_plan() {
  local plan="$SRC/cmc/plan.json"
  [ -f "$plan" ] || { echo "error: plan not found: $plan" >&2; exit 3; }
  [ -f "$SRC/Cargo.toml" ] || { echo "error: Cargo.toml not found" >&2; exit 3; }
  rm -rf /opt/runner/app
  mkdir /opt/runner/app && cp -r "$SRC"/. /opt/runner/app/ || exit 2
  rm -rf /opt/runner/app/target /opt/runner/app/Cargo.lock
  cd /opt/runner || exit 2
  local log; log=$(mktemp)
  CARGO_TARGET_DIR=/opt/runner-target cargo +1.84.1 build --release --offline >"$log" 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then cat "$log"; exit $rc; fi
  local res; res=$(mktemp)
  /opt/runner-target/release/cmc-cosmwasm-runner --plan "$plan" >"$res"
  rc=$?
  if [ $rc -ne 0 ]; then echo "error: cmc-cosmwasm-runner failed (exit $rc)" >&2; exit $rc; fi
  echo "===CMC_RESULT_BEGIN==="
  cat "$res"
  echo "===CMC_RESULT_END==="
  exit 0
}

case "$CMD" in
  compile) do_compile; exit $? ;;
  test) do_compile; rc=$?; [ $rc -eq 0 ] || exit $rc; do_run_plan ;;
  run-plan) do_run_plan ;;
  *) echo "unknown command '$CMD' (compile | test | run-plan)" >&2; exit 2 ;;
esac
