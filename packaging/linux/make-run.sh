#!/usr/bin/env bash
# Wrap a CloneMyContracts Linux .tar.gz tarball in a self-extracting .bin installer.
# The resulting .bin extracts to ~/.local/opt/clonemycontracts/<version> (overridable
# via --target) and launches the bundled `cmc` script (unless --extract-only).
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <tarball.tar.gz> [output.bin] [options]

Options:
  --output <path>   Explicit output path (default: <tarball without .tar.gz>.bin)
  --version <ver>   Override version embedded in the self-extracting header
  -h, --help        Show this help
EOF
}

TARBALL=""
OUT_BIN=""
VERSION_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUT_BIN="$2"; shift 2 ;;
    --output=*) OUT_BIN="${1#*=}"; shift ;;
    --version) VERSION_OVERRIDE="$2"; shift 2 ;;
    --version=*) VERSION_OVERRIDE="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$TARBALL" ]]; then
        TARBALL="$1"
      elif [[ -z "$OUT_BIN" ]]; then
        OUT_BIN="$1"
      else
        echo "error: unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$TARBALL" ]]; then
  echo "error: missing <tarball.tar.gz> argument" >&2
  usage >&2
  exit 2
fi
if [[ ! -f "$TARBALL" ]]; then
  echo "error: tarball not found: $TARBALL" >&2
  exit 1
fi

sha256_file() {
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

if [[ -z "$OUT_BIN" ]]; then
  case "$TARBALL" in
    *.tar.gz) OUT_BIN="${TARBALL%.tar.gz}.bin" ;;
    *.tgz)    OUT_BIN="${TARBALL%.tgz}.bin" ;;
    *)        OUT_BIN="${TARBALL}.bin" ;;
  esac
fi

# Detect version from the tarball's top-level directory or VERSION file
if [[ -n "$VERSION_OVERRIDE" ]]; then
  CMC_VERSION="$VERSION_OVERRIDE"
else
  TOP_DIR="$(tar -tzf "$TARBALL" 2>/dev/null | { IFS= read -r first || true; printf '%s' "${first%%/*}"; cat >/dev/null; })"
  if [[ "$TOP_DIR" =~ ^cmc-([^-]+)-linux- ]]; then
    CMC_VERSION="${BASH_REMATCH[1]}"
  else
    CMC_VERSION="$(tar -xOzf "$TARBALL" "${TOP_DIR}/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "0.1.0")"
  fi
fi

PAYLOAD_SHA256="$(sha256_file "$TARBALL")"
TMP_OUT="${OUT_BIN}.part.$$"
trap 'rm -f "$TMP_OUT"' EXIT

cat > "$TMP_OUT" <<EOF
#!/usr/bin/env sh
# CloneMyContracts self-extracting Linux bundle (${CMC_VERSION})
# Extracts to ~/.local/opt/clonemycontracts/${CMC_VERSION} and runs the bundled launcher.
set -eu

CMC_VERSION="${CMC_VERSION}"
PAYLOAD_SHA256="${PAYLOAD_SHA256}"
EXTRACT_ONLY=0
FORCE_EXTRACT=0
SKIP_VERIFY=0
TARGET_DIR=""

usage() {
  cat <<USAGE
CloneMyContracts self-extracting Linux bundle (\$CMC_VERSION)

Usage: \$(basename "\$0") [installer-options] [-- launcher-options...]

Installer options:
  --extract-only     Extract the payload and exit without launching CloneMyContracts
  --target <dir>     Extraction directory (default: ~/.local/opt/clonemycontracts/\$CMC_VERSION)
  --force            Re-extract even if target already matches this payload
  --no-verify        Skip payload SHA-256 verification before extracting
  --version          Print bundle version and exit
  -h, --help         Show this help message

Any unrecognized options (or options after '--') are passed directly to the 'cmc' launcher,
for example:  ./\$(basename "\$0") --no-open
USAGE
}

# Collect arguments to forward to the cmc launcher using a safe POSIX positional rebuild
FWD_COUNT=0
PARSE_INSTALLER=1
TOTAL_ARGS=\$#
IDX=0
while [ "\$IDX" -lt "\$TOTAL_ARGS" ]; do
  IDX=\$((IDX + 1))
  ARG="\$1"
  shift
  if [ "\$PARSE_INSTALLER" -eq 1 ]; then
    case "\$ARG" in
      --extract-only)
        EXTRACT_ONLY=1
        continue
        ;;
      --force)
        FORCE_EXTRACT=1
        continue
        ;;
      --no-verify)
        SKIP_VERIFY=1
        continue
        ;;
      --target)
        if [ "\$IDX" -ge "\$TOTAL_ARGS" ]; then
          echo "[cmc-bin] error: --target requires a directory argument" >&2
          exit 2
        fi
        IDX=\$((IDX + 1))
        TARGET_DIR="\$1"
        shift
        continue
        ;;
      --target=*)
        TARGET_DIR="\${ARG#*=}"
        continue
        ;;
      --version)
        printf 'CloneMyContracts %s (self-extracting Linux bundle)\n' "\$CMC_VERSION"
        exit 0
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        PARSE_INSTALLER=0
        continue
        ;;
    esac
  fi
  set -- "\$@" "\$ARG"
done

if [ -z "\$TARGET_DIR" ]; then
  TARGET_DIR="\${HOME}/.local/opt/clonemycontracts/\${CMC_VERSION}"
fi
while [ "\$TARGET_DIR" != "/" ] && [ "\${TARGET_DIR%/}" != "\$TARGET_DIR" ]; do
  TARGET_DIR="\${TARGET_DIR%/}"
done

STAMP_FILE="\${TARGET_DIR}/.cmc-payload-sha256"
NEED_EXTRACT=1
if [ "\$FORCE_EXTRACT" -eq 0 ] && [ -x "\${TARGET_DIR}/cmc" ] && [ -f "\$STAMP_FILE" ]; then
  EXISTING_SHA="\$(cat "\$STAMP_FILE" 2>/dev/null || true)"
  if [ "\$EXISTING_SHA" = "\$PAYLOAD_SHA256" ]; then
    NEED_EXTRACT=0
  fi
fi

if [ "\$NEED_EXTRACT" -eq 1 ]; then
  ARCHIVE_LINE="\$(awk '/^__CMC_ARCHIVE_BELOW__\$/ { print NR + 1; exit 0; }' "\$0")"
  if [ -z "\$ARCHIVE_LINE" ]; then
    echo "[cmc-bin] error: corrupt self-extracting archive (marker missing)" >&2
    exit 1
  fi

  if [ "\$SKIP_VERIFY" -eq 0 ]; then
    ACTUAL_SHA=""
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL_SHA="\$(tail -n "+\$ARCHIVE_LINE" "\$0" | sha256sum | awk '{print \$1}')"
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL_SHA="\$(tail -n "+\$ARCHIVE_LINE" "\$0" | shasum -a 256 | awk '{print \$1}')"
    else
      echo "[cmc-bin] warning: neither sha256sum nor shasum found; skipping payload integrity check." >&2
    fi
    if [ -n "\$ACTUAL_SHA" ] && [ "\$ACTUAL_SHA" != "\$PAYLOAD_SHA256" ]; then
      echo "[cmc-bin] error: payload SHA-256 mismatch (archive may be truncated or modified)!" >&2
      echo "  expected: \$PAYLOAD_SHA256" >&2
      echo "  actual:   \$ACTUAL_SHA" >&2
      exit 1
    fi
  fi

  PARENT_DIR="\$(dirname "\$TARGET_DIR")"
  mkdir -p "\$PARENT_DIR"
  TMP_EXTRACT="\$(mktemp -d "\${PARENT_DIR}/.cmc-extract.XXXXXX")"
  cleanup_tmp() { rm -rf "\$TMP_EXTRACT" 2>/dev/null || true; }
  trap cleanup_tmp EXIT INT TERM

  echo "[cmc-bin] Extracting CloneMyContracts \${CMC_VERSION} to \${TARGET_DIR}..." >&2
  tail -n "+\$ARCHIVE_LINE" "\$0" | tar -xzf - --strip-components=1 -C "\$TMP_EXTRACT"
  printf '%s\n' "\$PAYLOAD_SHA256" > "\${TMP_EXTRACT}/.cmc-payload-sha256"

  # Never wipe a directory that is not an earlier CloneMyContracts install (a stray --target like \$HOME).
  if [ -e "\$TARGET_DIR" ]; then
    if [ -f "\$STAMP_FILE" ] || { [ -f "\${TARGET_DIR}/cmc" ] && [ -f "\${TARGET_DIR}/VERSION" ]; }; then
      rm -rf "\$TARGET_DIR"
    elif [ -d "\$TARGET_DIR" ] && [ -z "\$(ls -A "\$TARGET_DIR" 2>/dev/null)" ]; then
      rmdir "\$TARGET_DIR"
    else
      echo "[cmc-bin] error: \$TARGET_DIR exists and is not a CloneMyContracts install; refusing to overwrite it." >&2
      exit 1
    fi
  fi
  mv "\$TMP_EXTRACT" "\$TARGET_DIR"
  chmod 755 "\$TARGET_DIR"
  trap - EXIT INT TERM
else
  echo "[cmc-bin] Using existing installation in \${TARGET_DIR} (pass --force to re-extract)." >&2
fi

if [ "\$EXTRACT_ONLY" -eq 1 ]; then
  printf '%s\n' "\$TARGET_DIR"
  exit 0
fi

exec "\${TARGET_DIR}/cmc" "\$@"
__CMC_ARCHIVE_BELOW__
EOF

cat "$TARBALL" >> "$TMP_OUT"
chmod 755 "$TMP_OUT"
mv "$TMP_OUT" "$OUT_BIN"

BIN_SHA="$(sha256_file "$OUT_BIN")"
BIN_SIZE="$(wc -c < "$OUT_BIN" | tr -d '[:space:]')"
echo "==> Created self-extracting bundle: $OUT_BIN"
echo "    Size:   $BIN_SIZE bytes"
echo "    SHA256: $BIN_SHA"
