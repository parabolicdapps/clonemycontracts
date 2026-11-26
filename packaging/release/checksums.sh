#!/usr/bin/env bash
# Generate or verify SHA256SUMS for CloneMyContracts release artefacts.
set -euo pipefail

usage() {
  cat <<EOF
Usage:
  $(basename "$0") <artefact-dir> [--output <path>]
  $(basename "$0") --verify <artefact-dir> [--checksums <path>]

Generates standard GNU-format SHA256SUMS (two-space separator, basenames only)
for all release artefacts in <artefact-dir>, excluding checksum and signature files.
Works on both Linux (sha256sum) and macOS (shasum -a 256).
EOF
}

VERIFY=0
DIR=""
OUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify|-c) VERIFY=1; shift ;;
    --output|-o|--checksums) OUT_FILE="$2"; shift 2 ;;
    --output=*|--checksums=*) OUT_FILE="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$DIR" ]]; then
        DIR="$1"
      else
        echo "error: unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$DIR" ]]; then
  echo "error: missing <artefact-dir>" >&2
  usage >&2
  exit 2
fi
if [[ ! -d "$DIR" ]]; then
  echo "error: directory not found: $DIR" >&2
  exit 1
fi

DIR="$(cd "$DIR" && pwd)"
OUT_FILE="${OUT_FILE:-$DIR/SHA256SUMS}"

sha256_one() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  else
    echo "error: neither sha256sum nor shasum found" >&2
    exit 1
  fi
}

if [[ "$VERIFY" -eq 1 ]]; then
  if [[ ! -f "$OUT_FILE" ]]; then
    echo "error: checksum file not found: $OUT_FILE" >&2
    exit 1
  fi
  echo "==> Verifying checksums in $OUT_FILE"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$DIR" && sha256sum -c "$OUT_FILE")
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$DIR" && shasum -a 256 -c "$OUT_FILE")
  else
    echo "error: neither sha256sum nor shasum found" >&2
    exit 1
  fi
  exit 0
fi

FILES=()
while IFS= read -r f; do
  base="$(basename "$f")"
  case "$base" in
    SHA256SUMS|SHA256SUMS.*|*.minisig|*.sig|*.asc|.*|*.part.*) continue ;;
    *) FILES+=("$base") ;;
  esac
done < <(find "$DIR" -maxdepth 1 -type f | LC_ALL=C sort)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "error: no release artefacts found in $DIR" >&2
  exit 1
fi

TMP_OUT="${OUT_FILE}.part.$$"
trap 'rm -f "$TMP_OUT"' EXIT
: > "$TMP_OUT"

(
  cd "$DIR"
  for base in "${FILES[@]}"; do
    h="$(sha256_one "$base")"
    printf '%s  %s\n' "$h" "$base" >> "$TMP_OUT"
  done
)

mv "$TMP_OUT" "$OUT_FILE"
echo "==> Wrote $OUT_FILE (${#FILES[@]} files):"
cat "$OUT_FILE"
