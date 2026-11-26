#!/bin/bash
# cmc-toolchain-tezos:0.2 entry.   compile [dir] | run-plan [dir]      (default dir /work, mounted read-only; /out optional, writable)
#  compile:  python3 contract.py in a copy of the project; on success the Michelson is copied to /out/contract.tz and the initial storage to /out/storage.tz.
#            If <dir>/cmc/variants/<name>/contract_def.py exist, each variant (the same project with that one file replaced) is compiled too and
#            reported as "=== VARIANT <name> exit <code> ===" followed by its error tail: this isolates one error per model-written unit, because the
#            SmartPy compiler stops at the first error of a file.
#  run-plan: runs <dir>/cmc/plan.json with the SmartPy simulator (runner/cmc_runner.py) and prints the JSON result between ===CMC_RESULT_BEGIN/END===.
# SmartPy 0.25.3 bundles x86_64 compilers only. On an arm64 container (Apple silicon / ARM Linux) they run under the qemu-user-static installed
# in the image (explicit, so it does not depend on the host's binfmt setup: Rosetta crashes the compiler with SIGILL, qemu works).
if [ "$(uname -m)" = aarch64 ]; then
  _sp=/usr/local/lib/python3.12/site-packages/smartpy
  _q=$(command -v qemu-x86_64-static 2>/dev/null)
  export SMARTPY_OASIS="${SMARTPY_OASIS:-$_q $_sp/smartpy-oasis-linux.exe}" SMARTPY_CANOPY="${SMARTPY_CANOPY:-$_q $_sp/smartpy-canopy-linux.exe}"
fi
cmd=${1:-compile}
SRC=${2:-/work}
case "$cmd" in
  compile|run-plan) ;;
  *) echo "unknown command $cmd" >&2; exit 2;;
esac
OUT=$(mktemp -d)
cp -r "$SRC"/. "$OUT"/ || exit 2
cd "$OUT" || exit 2
if [ "$cmd" = run-plan ]; then
  exec python3 /usr/local/lib/cmc/cmc_runner.py "$OUT"
fi
[ -f contract.py ] || { echo "error: contract.py not found in project root" >&2; exit 3; }
python3 contract.py
rc=$?
if [ $rc -eq 0 ]; then
  m=$(find . -path ./cmc -prune -o -name '*_contract.tz' -print | head -1)
  s=$(find . -path ./cmc -prune -o -name '*_storage.tz' -print | head -1)
  if [ -z "$m" ]; then echo "error: no Michelson (*_contract.tz) produced - did the scenario add the contract (scenario += c)?" >&2; rc=4
  else
    echo "michelson ok: $m ($(wc -c <"$m") bytes)"
    if [ -d /out ]; then cp "$m" /out/contract.tz; [ -n "$s" ] && cp "$s" /out/storage.tz; fi
  fi
fi
if [ -d "$SRC/cmc/variants" ] && [ "${CMC_VARIANTS:-1}" = 1 ] && [ $rc -ne 0 ]; then
  for v in "$SRC"/cmc/variants/*/; do
    name=$(basename "$v")
    V=$(mktemp -d); cp -r "$SRC"/. "$V"/; cp "$v"/contract_def.py "$V"/contract_def.py
    ( cd "$V" && python3 contract.py > variant.log 2>&1 ); vrc=$?
    echo "=== VARIANT $name exit $vrc ==="
    [ $vrc -ne 0 ] && grep -v '^\s*$' "$V/variant.log" | grep -v '^Traceback' | tail -${CMC_VARIANT_TAIL:-14}
    rm -rf "$V"
  done
fi
exit $rc
