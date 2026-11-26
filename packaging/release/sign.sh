#!/usr/bin/env bash
# Sign or verify CloneMyContracts SHA256SUMS using minisign.
# NEVER generates or stores a real secret key inside this repository.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  cat <<EOF
Usage:
  $(basename "$0") sign <SHA256SUMS-or-dir> --key <path/to/release.key> [--comment <trusted-comment>]
  $(basename "$0") verify <SHA256SUMS-or-dir> (--pubkey <path/to/release.pub> | --pubkey-str <RW...>)
  $(basename "$0") keygen-help

Environment variables:
  CMC_MINISIGN_KEY       Path to offline minisign secret key (MUST live outside this repo)
  CMC_MINISIGN_PUBKEY    Path to minisign public key (.pub) or RW... string for verification

Never commit or store a minisign secret key inside the git repository.
EOF
}

keygen_help() {
  cat <<'EOF'
=== Generating a CloneMyContracts Release Signing Key (minisign) ===

1. Install minisign:
   - macOS:  brew install minisign
   - Ubuntu/Debian: sudo apt install minisign
   - Fedora: sudo dnf install minisign
   - Source: https://jedisct1.github.io/minisign/

2. Generate a passphrase-protected keypair OUTSIDE the repository
   (for example under ~/.config/clonemycontracts-release-keys/, never inside git):

     mkdir -p -m 700 "$HOME/.config/clonemycontracts-release-keys"
     minisign -G \
       -p "$HOME/.config/clonemycontracts-release-keys/cmc-release.pub" \
       -s "$HOME/.config/clonemycontracts-release-keys/cmc-release.key" \
       -c "CloneMyContracts release signing key"

3. Back up the encrypted secret key (`cmc-release.key`) to offline storage
   (e.g., encrypted USB / password manager) and keep file mode 600.
   NEVER commit `*.key` files to git or upload them to CI without dedicated HSM/secret controls.

4. Publish ONLY the public key (`cmc-release.pub` / the `RW...` line) in:
   - The repository README / SECURITY.md
   - The GitHub Release notes
   - The CloneMyContracts static downloads website

5. Sign SHA256SUMS for a release:
     packaging/release/sign.sh sign out/packaging/SHA256SUMS \
       --key "$HOME/.config/clonemycontracts-release-keys/cmc-release.key"

6. Users verify downloads with:
     minisign -Vm SHA256SUMS -P <PUBLIC_KEY_RW...>
     sha256sum -c SHA256SUMS
EOF
}

if [[ $# -eq 0 ]]; then
  usage
  exit 2
fi

CMD="$1"
shift

case "$CMD" in
  keygen-help|--keygen-help)
    keygen_help
    exit 0
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  sign|verify)
    ;;
  *)
    echo "error: unknown subcommand '$CMD' (expected: sign, verify, keygen-help)" >&2
    usage >&2
    exit 2
    ;;
esac

TARGET=""
KEY_PATH="${CMC_MINISIGN_KEY:-}"
PUB_PATH=""
PUB_STR=""
TRUSTED_COMMENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key|-s) KEY_PATH="$2"; shift 2 ;;
    --key=*) KEY_PATH="${1#*=}"; shift ;;
    --pubkey|-p) PUB_PATH="$2"; shift 2 ;;
    --pubkey=*) PUB_PATH="${1#*=}"; shift ;;
    --pubkey-str|-P) PUB_STR="$2"; shift 2 ;;
    --pubkey-str=*) PUB_STR="${1#*=}"; shift ;;
    --comment|-t) TRUSTED_COMMENT="$2"; shift 2 ;;
    --comment=*) TRUSTED_COMMENT="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "error: unknown option: $1" >&2
      exit 2
      ;;
    *)
      if [[ -z "$TARGET" ]]; then
        TARGET="$1"
      else
        echo "error: unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "error: missing path to SHA256SUMS (or release directory)" >&2
  exit 2
fi
if [[ -d "$TARGET" ]]; then
  TARGET="${TARGET%/}/SHA256SUMS"
fi
if [[ ! -f "$TARGET" ]]; then
  echo "error: file not found: $TARGET" >&2
  exit 1
fi

if ! command -v minisign >/dev/null 2>&1; then
  echo "error: 'minisign' is not installed or not on PATH." >&2
  echo "Run '$(basename "$0") keygen-help' for installation and key setup instructions." >&2
  exit 1
fi

resolve_abs() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

if [[ "$CMD" == "sign" ]]; then
  if [[ -z "$KEY_PATH" ]]; then
    echo "error: secret key path required (--key <path> or CMC_MINISIGN_KEY)." >&2
    echo "Run '$(basename "$0") keygen-help' for key generation instructions." >&2
    exit 2
  fi
  if [[ ! -f "$KEY_PATH" ]]; then
    echo "error: secret key file not found: $KEY_PATH" >&2
    exit 1
  fi

  ABS_KEY="$(resolve_abs "$KEY_PATH")"
  ABS_REPO="$(resolve_abs "$REPO_ROOT")"
  case "$ABS_KEY" in
    "$ABS_REPO"/*)
      echo "error: refusing to use a secret key located inside the git repository ($ABS_KEY)!" >&2
      echo "Move the secret key outside the repository (e.g. ~/.config/clonemycontracts-release-keys/)." >&2
      exit 1
      ;;
  esac

  if [[ -z "$TRUSTED_COMMENT" ]]; then
    VER="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo unknown)"
    TRUSTED_COMMENT="CloneMyContracts ${VER} SHA256SUMS ($(date -u +%Y-%m-%d))"
  fi

  echo "==> Signing $TARGET with minisign..."
  minisign -Sm "$TARGET" -s "$KEY_PATH" -t "$TRUSTED_COMMENT"
  echo "==> Signature created: ${TARGET}.minisig"
  exit 0
fi

if [[ "$CMD" == "verify" ]]; then
  if [[ -z "$PUB_PATH" && -z "$PUB_STR" && -n "${CMC_MINISIGN_PUBKEY:-}" ]]; then
    if [[ -f "$CMC_MINISIGN_PUBKEY" ]]; then
      PUB_PATH="$CMC_MINISIGN_PUBKEY"
    else
      PUB_STR="$CMC_MINISIGN_PUBKEY"
    fi
  fi
  if [[ -z "$PUB_PATH" && -z "$PUB_STR" ]]; then
    echo "error: public key required (--pubkey <file>, --pubkey-str <RW...>, or CMC_MINISIGN_PUBKEY)." >&2
    exit 2
  fi

  echo "==> Verifying ${TARGET}.minisig..."
  if [[ -n "$PUB_PATH" ]]; then
    minisign -Vm "$TARGET" -p "$PUB_PATH"
  else
    minisign -Vm "$TARGET" -P "$PUB_STR"
  fi
fi
