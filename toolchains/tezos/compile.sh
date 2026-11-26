#!/bin/bash
# usage: compile [dir]   (default /work). Project layout: contract.py (SmartPy module + @sp.add_test scenario)
# SmartPy 0.25.3 bundles x86_64 compilers only. On an arm64 container (Apple silicon / ARM Linux) they run under the qemu-user-static installed
# in the image (explicit, so it does not depend on the host's binfmt setup: Rosetta crashes the compiler with SIGILL, qemu works).
if [ "$(uname -m)" = aarch64 ]; then
  _sp=/usr/local/lib/python3.12/site-packages/smartpy
  _q=$(command -v qemu-x86_64-static 2>/dev/null)
  export SMARTPY_OASIS="${SMARTPY_OASIS:-$_q $_sp/smartpy-oasis-linux.exe}" SMARTPY_CANOPY="${SMARTPY_CANOPY:-$_q $_sp/smartpy-canopy-linux.exe}"
fi
[ "${1:-compile}" = compile ] || { echo "unknown command $1" >&2; exit 2; }
SRC=${2:-/work}
OUT=$(mktemp -d)
cp -r "$SRC"/. "$OUT"/ || exit 2
cd "$OUT" || exit 2
[ -f contract.py ] || { echo "error: contract.py not found in project root" >&2; exit 3; }
python3 contract.py || exit $?
n=$(find . -name '*_contract.tz' | wc -l)
if [ "$n" -eq 0 ]; then echo "error: no Michelson (*_contract.tz) produced - did the scenario add the contract (scenario += c)?" >&2; exit 4; fi
find . -name '*_contract.tz' | head -3 | while read f; do echo "michelson ok: $f ($(wc -c <"$f") bytes)"; done
