#!/bin/bash
# cmc-toolchain-solana:0.2 entry.   usage: compile|test|run-plan [dir]   (dir defaults to /work)
#   compile   [dir]  anchor build; if /out is writable, copies target/deploy/*.so and target/idl/*.json there
#   test      [dir]  anchor build, then run <dir>/cmc/plan.json against the built program in cmc-runner
#   run-plan  [dir]  no build; plan <dir>/cmc/plan.json; program from /artifacts/app.so + /artifacts/app.json if /artifacts exists
#   live-demo [dir]  start solana-test-validator (localhost), deploy /artifacts/app.so, run <dir>/cmc/plan.json (first scenario) live
# The runner's JSON is printed to stdout between ===CMC_RESULT_BEGIN=== and ===CMC_RESULT_END===.
CMD=${1:-compile}
SRC=${2:-/work}
export CARGO_NET_OFFLINE=true

prep_project() {
  WORK=$(mktemp -d)
  cp -r "$SRC"/. "$WORK"/ || exit 2
  cd "$WORK" || exit 2
  [ -f Anchor.toml ] || { echo "error: Anchor.toml not found" >&2; exit 3; }
  [ -f Cargo.lock ] || cp /sample/Cargo.lock . 2>/dev/null
}

# build_project <log-file>: anchor build, then check artifacts. Returns the build exit code.
build_project() {
  anchor build >"$1" 2>&1
  local rc=$?
  if [ $rc -eq 0 ] && ! ls "$CARGO_TARGET_DIR"/deploy/*.so >/dev/null 2>&1; then
    echo "error: no .so produced" >>"$1"
    rc=4
  fi
  return $rc
}

# find the IDL json produced by anchor build (workspace target/idl, or under CARGO_TARGET_DIR)
find_idl() {
  local d f
  for d in "$WORK/target/idl" "$CARGO_TARGET_DIR/idl"; do
    f=$(ls "$d"/*.json 2>/dev/null | head -n1)
    [ -n "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}

run_runner() { # run_runner <plan> [--so x --idl y]
  local plan=$1; shift
  [ -f "$plan" ] || { echo "error: plan not found: $plan" >&2; exit 3; }
  local res; res=$(mktemp)
  cmc-runner --plan "$plan" "$@" >"$res"
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "error: cmc-runner failed (exit $rc)" >&2
    exit $rc
  fi
  echo "===CMC_RESULT_BEGIN==="
  cat "$res"
  echo "===CMC_RESULT_END==="
  exit 0
}

case "$CMD" in
  compile)
    prep_project
    LOG=$(mktemp)
    build_project "$LOG"; rc=$?
    cat "$LOG"
    if [ $rc -eq 0 ] && [ -d /out ] && [ -w /out ]; then
      cp "$CARGO_TARGET_DIR"/deploy/*.so /out/ 2>/dev/null
      for d in "$WORK/target/idl" "$CARGO_TARGET_DIR/idl"; do
        ls "$d"/*.json >/dev/null 2>&1 && { cp "$d"/*.json /out/; break; }
      done
    fi
    exit $rc
    ;;
  test)
    prep_project
    LOG=$(mktemp)
    build_project "$LOG"; rc=$?
    if [ $rc -ne 0 ]; then cat "$LOG"; exit $rc; fi
    cat "$LOG" >&2
    SO=$(ls "$CARGO_TARGET_DIR"/deploy/app.so 2>/dev/null || ls "$CARGO_TARGET_DIR"/deploy/*.so | head -n1)
    IDL=$(find_idl) || { echo "error: no IDL produced by anchor build" >&2; exit 4; }
    run_runner "$WORK/cmc/plan.json" --so "$SO" --idl "$IDL"
    ;;
  run-plan)
    PLAN="$SRC/cmc/plan.json"
    if [ -d /artifacts ]; then
      [ -f /artifacts/app.so ] && [ -f /artifacts/app.json ] || { echo "error: /artifacts needs app.so and app.json" >&2; exit 3; }
      run_runner "$PLAN" --so /artifacts/app.so --idl /artifacts/app.json
    else
      run_runner "$PLAN"
    fi
    ;;
  live-demo)
    PLAN="$SRC/cmc/plan.json"
    [ -f "$PLAN" ] || { echo "error: plan not found: $PLAN" >&2; exit 3; }
    [ -f /artifacts/app.so ] && [ -f /artifacts/app.json ] || { echo "error: /artifacts needs app.so and app.json" >&2; exit 3; }
    RPC=http://127.0.0.1:8899
    L=$(mktemp -d)
    # An Anchor program checks declare_id!() against the id it runs under, so it must live at the IDL address
    # (a fresh program keypair would give DeclaredProgramIdMismatch). The validator therefore loads it at that
    # address in genesis (upgradeable loader, no upgrade authority) instead of `solana program deploy`.
    PID=$(grep -o '"address": *"[^"]*"' /artifacts/app.json | head -n1 | sed 's/.*: *"\(.*\)"/\1/')
    [ -n "$PID" ] || { echo "error: no address in /artifacts/app.json" >&2; exit 3; }
    # local-only validator: loopback bind, no external network needed (needs io_uring: see RUNNER.md)
    solana-test-validator --reset --ledger "$L/ledger" --quiet --bind-address 127.0.0.1 --gossip-port 8001 --rpc-port 8899 \
      --upgradeable-program "$PID" /artifacts/app.so none >"$L/validator.log" 2>&1 &
    VPID=$!
    trap 'kill $VPID 2>/dev/null; wait $VPID 2>/dev/null' EXIT
    ok=
    for _ in $(seq 1 180); do
      solana -u $RPC cluster-version >/dev/null 2>&1 && { ok=1; break; }
      kill -0 $VPID 2>/dev/null || break
      sleep 1
    done
    [ -n "$ok" ] || { echo "error: solana-test-validator did not start" >&2; tail -20 "$L/validator.log" >&2; tail -20 "$L/ledger/validator.log" >&2; exit 5; }
    solana-keygen new --no-bip39-passphrase --silent --force -o "$L/cli.json" >/dev/null || exit 5
    solana -u $RPC -k "$L/cli.json" program show "$PID" || { echo "error: program not found on validator" >&2; exit 5; }
    res=$(mktemp)
    cmc-runner live --rpc $RPC --plan "$PLAN" --idl /artifacts/app.json >"$res"
    rc=$?
    [ $rc -eq 0 ] || { echo "error: cmc-runner live failed (exit $rc)" >&2; exit $rc; }
    echo "===CMC_RESULT_BEGIN==="
    cat "$res"
    echo "===CMC_RESULT_END==="
    exit 0
    ;;
  *)
    echo "unknown command '$CMD' (compile | test | run-plan | live-demo)" >&2
    exit 2
    ;;
esac
