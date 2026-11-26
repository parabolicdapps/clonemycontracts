#!/usr/bin/env bash
# Generate a CycloneDX JSON SBOM for CloneMyContracts.
# Automatically selects `syft` if available (preferred for scanning packaged tarballs),
# otherwise falls back to `npx @cyclonedx/cyclonedx-npm` for workspace npm dependencies,
# and clearly reports which generator produced the SBOM.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TOOL="auto"
TARGET_TARBALL=""
OUT_FILE=""
OUT_DIR="$REPO_ROOT/out/packaging"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --tool <auto|syft|cyclonedx-npm>   SBOM generator to use (default: auto)
  --tarball <path.tar.gz>            Scan a built release tarball (requires syft; falls back
                                     to cyclonedx-npm on the repo with bundled-binary notice)
  --out-dir <dir>                    Output directory (default: <repo>/out/packaging)
  --output <path>                    Explicit output JSON path
  -h, --help                         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool) TOOL="$2"; shift 2 ;;
    --tool=*) TOOL="${1#*=}"; shift ;;
    --tarball) TARGET_TARBALL="$2"; shift 2 ;;
    --tarball=*) TARGET_TARBALL="${1#*=}"; shift ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --out-dir=*) OUT_DIR="${1#*=}"; shift ;;
    --output|-o) OUT_FILE="$2"; shift 2 ;;
    --output=*) OUT_FILE="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
mkdir -p "$OUT_DIR"

if [[ -z "$OUT_FILE" ]]; then
  if [[ -n "$TARGET_TARBALL" ]]; then
    base="$(basename "$TARGET_TARBALL")"
    base="${base%.tar.gz}"
    OUT_FILE="$OUT_DIR/${base}.cdx.json"
  else
    OUT_FILE="$OUT_DIR/cmc-${VERSION}-sbom.cdx.json"
  fi
fi

HAS_SYFT=0
command -v syft >/dev/null 2>&1 && HAS_SYFT=1

SELECTED=""
case "$TOOL" in
  auto)
    if [[ "$HAS_SYFT" -eq 1 ]]; then
      SELECTED="syft"
    else
      SELECTED="cyclonedx-npm"
    fi
    ;;
  syft)
    if [[ "$HAS_SYFT" -ne 1 ]]; then
      echo "error: --tool syft requested, but 'syft' is not installed on PATH." >&2
      exit 1
    fi
    SELECTED="syft"
    ;;
  cyclonedx-npm)
    SELECTED="cyclonedx-npm"
    ;;
  *)
    echo "error: unsupported --tool '$TOOL' (use auto, syft, or cyclonedx-npm)" >&2
    exit 2
    ;;
esac

echo "==> SBOM generator selected: $SELECTED"

if [[ "$SELECTED" == "syft" ]]; then
  SCAN_SRC="${TARGET_TARBALL:-dir:$REPO_ROOT}"
  echo "    Scanning: $SCAN_SRC"
  syft "$SCAN_SRC" -o "cyclonedx-json=${OUT_FILE}"
  echo "==> Wrote CycloneDX SBOM (via syft): $OUT_FILE"
  exit 0
fi

# Fallback: @cyclonedx/cyclonedx-npm
if ! command -v npx >/dev/null 2>&1; then
  echo "error: neither 'syft' nor 'npx' is available to generate a CycloneDX SBOM." >&2
  exit 1
fi

if [[ -n "$TARGET_TARBALL" ]]; then
  echo "    note: 'syft' not installed; generating npm production SBOM via @cyclonedx/cyclonedx-npm" >&2
  echo "    note: bundled upstream binaries (Node.js + Foundry anvil) are recorded in BUILD_INFO.txt inside the tarball." >&2
fi

if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "==> Installing workspace dependencies for @cyclonedx/cyclonedx-npm..."
  (cd "$REPO_ROOT" && npm ci --no-audit --no-fund)
fi

echo "    Running: npx --yes @cyclonedx/cyclonedx-npm --omit dev --output-format JSON --output-file $OUT_FILE"
(
  cd "$REPO_ROOT"
  npx --yes @cyclonedx/cyclonedx-npm \
    --omit dev \
    --flatten-components \
    --output-format JSON \
    --output-file "$OUT_FILE"
)

echo "==> Wrote CycloneDX SBOM (via @cyclonedx/cyclonedx-npm): $OUT_FILE"
