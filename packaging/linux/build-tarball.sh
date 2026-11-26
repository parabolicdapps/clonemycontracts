#!/usr/bin/env bash
# Build a self-contained CloneMyContracts Linux tarball for x86_64 or aarch64.
# Cross-staging from macOS or Linux is supported because Node.js and Foundry anvil
# are official prebuilt Linux binaries and the production JS dependencies are platform-neutral.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# --- Pinned upstream release versions & SHA-256 checksums ---
# Node.js 24 LTS (Krypton) — official Linux builds require glibc >= 2.28 (Ubuntu 20.04+, Debian 10+, RHEL 8+)
NODE_VERSION="${NODE_VERSION:-v24.22.3}"
PINNED_NODE_SHA256_x64="4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb"
PINNED_NODE_SHA256_arm64="6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c"

# Foundry release (only `anvil` is extracted into the tarball)
FOUNDRY_VERSION="${FOUNDRY_VERSION:-v1.10.0}"
PINNED_FOUNDRY_SHA256_amd64="90729233bd9a683b872783ae2e3217fb56876fa2a3c37185f13e39dca8525041"
PINNED_FOUNDRY_SHA256_arm64="1ab8802cd11919914ee36ac57c6ca19b27a4b9b0a749f6fe2b9771f78fc83ec0"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/out/packaging}"
CACHE_DIR="${CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/cmc-packaging}"
SKIP_BUILD=0
VERIFY_ATTESTATION="${VERIFY_ATTESTATION:-0}"
VERSION_OVERRIDE=""
RAW_ARCH=""

usage() {
  cat <<EOF
Usage: $(basename "$0") <arch> [options]

Arguments:
  <arch>               Target Linux architecture: x86_64 (or amd64/x64) | aarch64 (or arm64)

Options:
  --out-dir <dir>      Output directory for tarball (default: <repo>/out/packaging)
  --cache-dir <dir>    Download cache directory (default: ~/.cache/cmc-packaging)
  --version <ver>      Override version from root package.json
  --skip-build         Skip 'npm run build' (assume dist/ is already up to date)
  --verify-attestation Verify Foundry GitHub attestation with 'gh attestation verify'
  -h, --help           Show this help

Environment overrides:
  NODE_VERSION         Default: $NODE_VERSION
  FOUNDRY_VERSION      Default: $FOUNDRY_VERSION
  OUT_DIR, CACHE_DIR, VERIFY_ATTESTATION
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --out-dir=*) OUT_DIR="${1#*=}"; shift ;;
    --cache-dir) CACHE_DIR="$2"; shift 2 ;;
    --cache-dir=*) CACHE_DIR="${1#*=}"; shift ;;
    --version) VERSION_OVERRIDE="$2"; shift 2 ;;
    --version=*) VERSION_OVERRIDE="${1#*=}"; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --verify-attestation) VERIFY_ATTESTATION=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$RAW_ARCH" ]]; then
        RAW_ARCH="$1"
      else
        echo "error: unexpected extra argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$RAW_ARCH" ]]; then
  echo "error: missing required <arch> argument (x86_64 or aarch64)" >&2
  usage >&2
  exit 2
fi

case "$RAW_ARCH" in
  x86_64|amd64|x64)
    ARCH="x86_64"
    NODE_ARCH="x64"
    FOUNDRY_ARCH="amd64"
    EXPECTED_ELF_MACHINE="62" # EM_X86_64
    ;;
  aarch64|arm64)
    ARCH="aarch64"
    NODE_ARCH="arm64"
    FOUNDRY_ARCH="arm64"
    EXPECTED_ELF_MACHINE="183" # EM_AARCH64
    ;;
  *)
    echo "error: unsupported arch '$RAW_ARCH' (use x86_64 or aarch64)" >&2
    exit 2
    ;;
esac

# --- Portable SHA-256 helper (macOS shasum + Linux sha256sum) ---
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

download_if_missing() {
  local url="$1"
  local dest="$2"
  if [[ -f "$dest" ]]; then
    return 0
  fi
  echo "==> Downloading $(basename "$dest")..."
  local tmp="${dest}.part.$$"
  curl -fL --retry 3 --retry-delay 2 -o "$tmp" "$url"
  mv "$tmp" "$dest"
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local label="$3"
  local actual
  actual="$(sha256_file "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "error: SHA-256 mismatch for $label ($(basename "$file"))!" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "    verified SHA-256 ($label): $actual"
}

# --- Resolve version from root package.json ---
if [[ -n "$VERSION_OVERRIDE" ]]; then
  VERSION="$VERSION_OVERRIDE"
else
  VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
fi
if [[ -z "$VERSION" ]]; then
  echo "error: could not determine version from $REPO_ROOT/package.json" >&2
  exit 1
fi

PKG_NAME="cmc-${VERSION}-linux-${ARCH}"
mkdir -p "$OUT_DIR" "$CACHE_DIR"

echo "==> Building $PKG_NAME"
echo "    Repo root:  $REPO_ROOT"
echo "    Node LTS:   $NODE_VERSION (linux-$NODE_ARCH)"
echo "    Foundry:    $FOUNDRY_VERSION (linux-$FOUNDRY_ARCH)"
echo "    Cache dir:  $CACHE_DIR"
echo "    Output dir: $OUT_DIR"

# --- Step 1: Fetch & verify official Node.js LTS tarball ---
NODE_ARCHIVE="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"
NODE_SHASUMS_CACHE="$CACHE_DIR/node-${NODE_VERSION}-SHASUMS256.txt"
NODE_ARCHIVE_CACHE="$CACHE_DIR/$NODE_ARCHIVE"

download_if_missing "${NODE_BASE_URL}/SHASUMS256.txt" "$NODE_SHASUMS_CACHE"
download_if_missing "${NODE_BASE_URL}/${NODE_ARCHIVE}" "$NODE_ARCHIVE_CACHE"

NODE_OFFICIAL_SHA="$(awk -v f="$NODE_ARCHIVE" '$2 == f {print $1; exit}' "$NODE_SHASUMS_CACHE")"
if [[ -z "$NODE_OFFICIAL_SHA" ]]; then
  echo "error: $NODE_ARCHIVE not listed in $NODE_SHASUMS_CACHE" >&2
  exit 1
fi
verify_sha256 "$NODE_ARCHIVE_CACHE" "$NODE_OFFICIAL_SHA" "Node SHASUMS256.txt"

if [[ "$NODE_VERSION" == "v24.22.3" ]]; then
  pinned_var="PINNED_NODE_SHA256_${NODE_ARCH}"
  verify_sha256 "$NODE_ARCHIVE_CACHE" "${!pinned_var}" "Node pinned checksum"
fi

# --- Step 2: Fetch & verify official Foundry release tarball ---
FOUNDRY_ARCHIVE="foundry_${FOUNDRY_VERSION}_linux_${FOUNDRY_ARCH}.tar.gz"
FOUNDRY_SHA_FILE="foundry_${FOUNDRY_VERSION}_linux_${FOUNDRY_ARCH}.sha256"
FOUNDRY_ATT_FILE="foundry_${FOUNDRY_VERSION}_linux_${FOUNDRY_ARCH}.attestation.txt"
FOUNDRY_BASE_URL="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}"

FOUNDRY_ARCHIVE_CACHE="$CACHE_DIR/$FOUNDRY_ARCHIVE"
FOUNDRY_SHA_CACHE="$CACHE_DIR/$FOUNDRY_SHA_FILE"
FOUNDRY_ATT_CACHE="$CACHE_DIR/$FOUNDRY_ATT_FILE"

download_if_missing "${FOUNDRY_BASE_URL}/${FOUNDRY_SHA_FILE}" "$FOUNDRY_SHA_CACHE"
download_if_missing "${FOUNDRY_BASE_URL}/${FOUNDRY_ARCHIVE}" "$FOUNDRY_ARCHIVE_CACHE"
download_if_missing "${FOUNDRY_BASE_URL}/${FOUNDRY_ATT_FILE}" "$FOUNDRY_ATT_CACHE" || true

FOUNDRY_OFFICIAL_SHA="$(awk '{print $1; exit}' "$FOUNDRY_SHA_CACHE")"
if [[ -z "$FOUNDRY_OFFICIAL_SHA" ]]; then
  echo "error: could not parse sha256 from $FOUNDRY_SHA_CACHE" >&2
  exit 1
fi
verify_sha256 "$FOUNDRY_ARCHIVE_CACHE" "$FOUNDRY_OFFICIAL_SHA" "Foundry .sha256"

if [[ "$FOUNDRY_VERSION" == "v1.10.0" ]]; then
  pinned_fvar="PINNED_FOUNDRY_SHA256_${FOUNDRY_ARCH}"
  verify_sha256 "$FOUNDRY_ARCHIVE_CACHE" "${!pinned_fvar}" "Foundry pinned checksum"
fi

if [[ "$VERIFY_ATTESTATION" == "1" ]]; then
  if command -v gh >/dev/null 2>&1; then
    echo "==> Verifying Foundry GitHub attestation..."
    gh attestation verify "$FOUNDRY_ARCHIVE_CACHE" --repo foundry-rs/foundry
  else
    echo "warning: --verify-attestation requested, but 'gh' CLI not found; skipping." >&2
  fi
elif [[ -f "$FOUNDRY_ATT_CACHE" ]]; then
  echo "    Foundry attestation URL: $(tr -d '[:space:]' < "$FOUNDRY_ATT_CACHE")"
fi

# --- Step 3: Build TypeScript workspaces + web UI ---
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Building CloneMyContracts workspaces..."
  if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
    (cd "$REPO_ROOT" && npm ci --no-audit --no-fund)
  fi
  (cd "$REPO_ROOT" && npm run build)
fi

for req in \
  "$REPO_ROOT/apps/api/dist/main.js" \
  "$REPO_ROOT/apps/web/dist/index.html" \
  "$REPO_ROOT/packages/core/dist/index.js" \
  "$REPO_ROOT/packages/translate/dist/index.js"
do
  if [[ ! -f "$req" ]]; then
    echo "error: expected built artefact missing: $req" >&2
    exit 1
  fi
done

# --- Step 4: Stage tarball contents in a clean temporary directory ---
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cmc-stage.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

STAGE="$WORK_DIR/$PKG_NAME"
mkdir -p "$STAGE/bin" "$STAGE/engine/apps/api" "$STAGE/engine/apps/web" \
         "$STAGE/engine/packages/core" "$STAGE/engine/packages/translate" \
         "$STAGE/engine/packages/cli"

# Launcher
cp "$SCRIPT_DIR/cmc" "$STAGE/cmc"
chmod 755 "$STAGE/cmc"

# Extract only bin/node and LICENSE from Node tarball
echo "==> Staging Node.js binary..."
NODE_EXTRACT="$WORK_DIR/node-extract"
mkdir -p "$NODE_EXTRACT"
tar -xJf "$NODE_ARCHIVE_CACHE" -C "$NODE_EXTRACT" \
  "node-${NODE_VERSION}-linux-${NODE_ARCH}/bin/node" \
  "node-${NODE_VERSION}-linux-${NODE_ARCH}/LICENSE"
cp "$NODE_EXTRACT/node-${NODE_VERSION}-linux-${NODE_ARCH}/bin/node" "$STAGE/bin/node"
chmod 755 "$STAGE/bin/node"

# Extract only anvil from Foundry tarball
echo "==> Staging Foundry anvil binary..."
FOUNDRY_EXTRACT="$WORK_DIR/foundry-extract"
mkdir -p "$FOUNDRY_EXTRACT"
tar -xzf "$FOUNDRY_ARCHIVE_CACHE" -C "$FOUNDRY_EXTRACT" anvil
cp "$FOUNDRY_EXTRACT/anvil" "$STAGE/bin/anvil"
chmod 755 "$STAGE/bin/anvil"

# Verify ELF target architecture of staged Linux binaries
verify_elf_arch() {
  local bin="$1"
  local expected_machine="$2"
  python3 - "$bin" "$expected_machine" <<'PY'
import struct, sys
path, want = sys.argv[1], int(sys.argv[2])
with open(path, "rb") as f:
    hdr = f.read(20)
if len(hdr) < 20 or hdr[:4] != b"\x7fELF":
    sys.exit(f"error: {path} is not an ELF binary")
ei_class = hdr[4]
ei_data = hdr[5]
if ei_class != 2 or ei_data != 1:
    sys.exit(f"error: {path} unexpected ELF class/endianness ({ei_class}/{ei_data})")
e_machine = struct.unpack("<H", hdr[18:20])[0]
if e_machine != want:
    sys.exit(f"error: {path} has ELF e_machine={e_machine}, expected {want}")
print(f"    verified ELF64 binary: {path} (e_machine={e_machine})")
PY
}

verify_elf_arch "$STAGE/bin/node" "$EXPECTED_ELF_MACHINE"
verify_elf_arch "$STAGE/bin/anvil" "$EXPECTED_ELF_MACHINE"

# Stage engine built outputs and workspace manifests
echo "==> Staging engine dist/ and installing production node_modules..."
cp "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$STAGE/engine/"

cp "$REPO_ROOT/apps/api/package.json" "$STAGE/engine/apps/api/"
cp -R "$REPO_ROOT/apps/api/dist" "$STAGE/engine/apps/api/dist"

cp "$REPO_ROOT/apps/web/package.json" "$STAGE/engine/apps/web/"
cp -R "$REPO_ROOT/apps/web/dist" "$STAGE/engine/apps/web/dist"

cp "$REPO_ROOT/packages/core/package.json" "$STAGE/engine/packages/core/"
cp -R "$REPO_ROOT/packages/core/dist" "$STAGE/engine/packages/core/dist"

cp "$REPO_ROOT/packages/translate/package.json" "$STAGE/engine/packages/translate/"
cp -R "$REPO_ROOT/packages/translate/dist" "$STAGE/engine/packages/translate/dist"
if [[ -d "$REPO_ROOT/packages/translate/targets" ]]; then
  cp -R "$REPO_ROOT/packages/translate/targets" "$STAGE/engine/packages/translate/targets"
fi

# Stage toolchain templates/samples referenced at runtime by @cmc/translate
if [[ -d "$REPO_ROOT/toolchains" ]]; then
  cp -R "$REPO_ROOT/toolchains" "$STAGE/engine/toolchains"
  # Never bundle local Rust build caches if any exist inside toolchains/
  find "$STAGE/engine/toolchains" -type d -name target -prune -exec rm -rf {} +
fi

cp "$REPO_ROOT/packages/cli/package.json" "$STAGE/engine/packages/cli/"
if [[ -d "$REPO_ROOT/packages/cli/dist" ]]; then
  cp -R "$REPO_ROOT/packages/cli/dist" "$STAGE/engine/packages/cli/dist"
fi

# Install production-only dependencies in the staging copy
(
  cd "$STAGE/engine"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)

# Defensive scrub of any dev-only platform packages that should never be in prod node_modules
for forbidden in \
  "$STAGE/engine/node_modules/@esbuild" \
  "$STAGE/engine/node_modules/esbuild" \
  "$STAGE/engine/node_modules/@rollup" \
  "$STAGE/engine/node_modules/rollup" \
  "$STAGE/engine/node_modules/typescript" \
  "$STAGE/engine/node_modules/fsevents"
do
  if [[ -e "$forbidden" ]]; then
    echo "    removing dev-only package: ${forbidden#$STAGE/}"
    rm -rf "$forbidden"
  fi
done

# Drop node_modules/.bin links whose target was just scrubbed (tsc, tsserver, ...)
find "$STAGE/engine/node_modules/.bin" -type l ! -exec test -e {} \; -exec rm -f {} + 2>/dev/null || true

# Audit node_modules for any Mach-O (macOS), Windows PE, native .node addons, or wrong-arch ELF binaries
echo "==> Auditing staged node_modules for platform-specific binaries..."
python3 - "$STAGE/engine/node_modules" "$EXPECTED_ELF_MACHINE" <<'PY'
import os, struct, sys

root = sys.argv[1]
want_machine = int(sys.argv[2])
bad = []

for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    # Skip workspace symlinks into ../apps or ../packages
    for fn in filenames:
        fp = os.path.join(dirpath, fn)
        if os.path.islink(fp):
            continue
        rel = os.path.relpath(fp, root)
        if fn.endswith(".node") or fn.endswith(".dylib") or fn.endswith(".dll") or fn.endswith(".exe"):
            bad.append(f"native addon/binary extension: {rel}")
            continue
        try:
            with open(fp, "rb") as f:
                hdr = f.read(20)
        except OSError:
            continue
        if len(hdr) < 4:
            continue
        # Mach-O (32/64/fat)
        if hdr[:4] in (b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
            bad.append(f"macOS Mach-O binary: {rel}")
        elif hdr[:4] == b"\x7fELF" and len(hdr) >= 20:
            e_machine = struct.unpack("<H", hdr[18:20])[0]
            if e_machine != want_machine:
                bad.append(f"wrong-arch ELF (e_machine={e_machine}, want {want_machine}): {rel}")
        elif hdr[:2] == b"MZ" and fn.lower().endswith((".exe", ".dll", ".pyd")):
            bad.append(f"Windows PE binary: {rel}")

if bad:
    print("error: platform-incompatible binaries found in staged node_modules:", file=sys.stderr)
    for b in bad:
        print(f"  - {b}", file=sys.stderr)
    sys.exit(1)
print("    node_modules audit passed: no darwin/wrong-arch native binaries found.")
PY

# --- Step 5: Stage legal files, third-party notices, and metadata ---
stage_legal_file() {
  local name="$1"
  local placeholder="$2"
  if [[ -f "$REPO_ROOT/$name" ]]; then
    cp "$REPO_ROOT/$name" "$STAGE/$name"
  else
    printf '%s\n' "$placeholder" > "$STAGE/$name"
    echo "    note: $name not present in repo root; wrote placeholder note."
  fi
}

stage_legal_file "LICENSE" \
"CloneMyContracts is licensed under the Apache License, Version 2.0.
Placeholder note: the full LICENSE file was not yet present in the repository root at build time.
Replace with the canonical Apache-2.0 LICENSE before any public release."

stage_legal_file "NOTICE" \
"CloneMyContracts
Placeholder note: the canonical NOTICE file was not yet present in the repository root at build time.
This distribution bundles third-party binaries:
  - Node.js ${NODE_VERSION} (MIT License; see THIRD_PARTY_LICENSES.txt)
  - Foundry anvil ${FOUNDRY_VERSION} (Apache-2.0 / MIT License; https://github.com/foundry-rs/foundry)"

stage_legal_file "DISCLAIMER.md" \
"# Disclaimer (Placeholder)

Placeholder note: the canonical DISCLAIMER.md was not yet present in the repository root at build time.
CloneMyContracts is provided AS IS without warranty. Always audit, simulate, and review any generated
or cloned smart contract code before deploying to a live network."

{
  echo "================================================================================"
  echo "Third-Party Bundled Software Licenses"
  echo "================================================================================"
  echo ""
  echo "--- Foundry (anvil ${FOUNDRY_VERSION}) ---"
  echo "Source: https://github.com/foundry-rs/foundry/releases/tag/${FOUNDRY_VERSION}"
  echo "License: Dual-licensed under Apache License 2.0 and MIT License."
  echo ""
  echo "--- Node.js (${NODE_VERSION}) ---"
  echo "Source: https://nodejs.org/dist/${NODE_VERSION}/"
  echo ""
  cat "$NODE_EXTRACT/node-${NODE_VERSION}-linux-${NODE_ARCH}/LICENSE"
} > "$STAGE/THIRD_PARTY_LICENSES.txt"

printf '%s\n' "$VERSION" > "$STAGE/VERSION"

GIT_REV="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$STAGE/BUILD_INFO.txt" <<EOF
package=${PKG_NAME}
version=${VERSION}
arch=${ARCH}
git_commit=${GIT_REV}
node_version=${NODE_VERSION}
node_archive=${NODE_ARCHIVE}
node_sha256=${NODE_OFFICIAL_SHA}
foundry_version=${FOUNDRY_VERSION}
foundry_archive=${FOUNDRY_ARCHIVE}
foundry_sha256=${FOUNDRY_OFFICIAL_SHA}
built_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

# --- Step 6: Package .tar.gz cleanly (suppress macOS AppleDouble ._ files and xattr PAX headers) ---
TARBALL="$OUT_DIR/${PKG_NAME}.tar.gz"
TMP_TARBALL="${TARBALL}.part.$$"
TAR_EXTRA_FLAGS=()
if tar --no-xattrs -cf /dev/null "$STAGE/VERSION" >/dev/null 2>&1; then
  TAR_EXTRA_FLAGS+=(--no-xattrs)
fi
if tar --no-mac-metadata -cf /dev/null "$STAGE/VERSION" >/dev/null 2>&1; then
  TAR_EXTRA_FLAGS+=(--no-mac-metadata)
fi
echo "==> Creating $(basename "$TARBALL")..."
COPYFILE_DISABLE=1 tar "${TAR_EXTRA_FLAGS[@]}" -C "$WORK_DIR" -czf "$TMP_TARBALL" "$PKG_NAME"
mv "$TMP_TARBALL" "$TARBALL"

TAR_SHA="$(sha256_file "$TARBALL")"
TAR_SIZE="$(wc -c < "$TARBALL" | tr -d '[:space:]')"
echo "==> Built: $TARBALL"
echo "    Size:   $TAR_SIZE bytes"
echo "    SHA256: $TAR_SHA"
