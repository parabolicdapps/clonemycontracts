#!/bin/zsh
# Puts the engine into <app>/Contents/Resources/engine/ :
#   node            pinned official Node LTS darwin-arm64 binary (verified against SHASUMS256.txt)
#   anvil           Foundry anvil (from ~/.foundry/bin or a pinned release asset, sha256 checked)
#   app/            package.json, lockfile, packages/*/{package.json,dist}, apps/{api,web}/{package.json,dist}, production node_modules
# Usage: bundle-engine.sh <path/to/CloneMyContracts.app>
set -euo pipefail
APP="${1:?usage: bundle-engine.sh <App.app>}"
HERE="${0:A:h}"
REPO="${HERE:h:h:h}"
NODE_VERSION="${NODE_VERSION:-v26.12.1}"   # verified 2026-11-25; TODO(owner): confirm this is the LTS line you want to ship
# Optional pinned anvil release (used when ~/.foundry/bin/anvil is absent). TODO(owner): fill both to ship without a local Foundry install.
ANVIL_URL="${ANVIL_URL:-}"; ANVIL_SHA256="${ANVIL_SHA256:-}"
CACHE="${CMC_BUNDLE_CACHE:-$HOME/Library/Caches/CloneMyContracts-build}"
DEST="$APP/Contents/Resources/engine"
mkdir -p "$CACHE"

# 1. Node
TARBALL="node-$NODE_VERSION-darwin-arm64.tar.gz"
if [[ ! -f "$CACHE/$TARBALL" ]]; then curl -fsSL -o "$CACHE/$TARBALL" "https://nodejs.org/dist/$NODE_VERSION/$TARBALL"; fi
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
WANT=$(grep " $TARBALL\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | cut -d' ' -f1)
GOT=$(shasum -a 256 "$CACHE/$TARBALL" | cut -d' ' -f1)
[[ -n "$WANT" && "$WANT" == "$GOT" ]] || { echo "node checksum mismatch ($WANT vs $GOT)"; rm -f "$CACHE/$TARBALL"; exit 1; }
rm -rf "$CACHE/node-x" && mkdir -p "$CACHE/node-x" && tar -xzf "$CACHE/$TARBALL" -C "$CACHE/node-x" --strip-components=1

# 2. built engine, production deps only, in a staging copy
[[ -f "$REPO/apps/api/dist/main.js" && -d "$REPO/apps/web/dist" ]] || { echo "run 'npm ci && npm run build' in $REPO first"; exit 1; }
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/cmc-stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
cd "$REPO"
cp package.json package-lock.json "$STAGE/"
# whole package dirs minus sources/tests: the translate package reads targets/*/primer.md etc. next to dist at run time
for d in packages/* apps/api apps/web; do
  [[ -f "$d/package.json" ]] || continue
  mkdir -p "$STAGE/$d"
  rsync -a --exclude node_modules --exclude /src --exclude /test --exclude '*.tsbuildinfo' --exclude /tsconfig.json --exclude '*.tmp.mjs' --exclude '/*.md' "$d/" "$STAGE/$d/"
done
[[ -d toolchains ]] && cp -R toolchains "$STAGE/toolchains"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )
# typescript is a devDependency, but npm keeps it as viem's optional peer ("devOptional" in the lockfile) even with --omit=dev.
# viem/abitype/ox only use it for types, never at run time, so drop it (23 MB).
rm -rf "$STAGE/node_modules/typescript" "$STAGE/node_modules/.bin/tsc" "$STAGE/node_modules/.bin/tsserver"
( cd "$STAGE" && node -e "import('viem').then(()=>import('solc')).catch((e)=>{console.error('bundle smoke test failed:',e.message);process.exit(1)})" )

# 3. assemble
rm -rf "$DEST"; mkdir -p "$DEST"
cp "$CACHE/node-x/bin/node" "$DEST/node"
cp -R "$STAGE" "$DEST/app"
ANVIL="$HOME/.foundry/bin/anvil"
if [[ ! -x "$ANVIL" && -n "$ANVIL_URL" ]]; then
  curl -fsSL -o "$CACHE/anvil.tgz" "$ANVIL_URL"
  [[ "$(shasum -a 256 "$CACHE/anvil.tgz" | cut -d' ' -f1)" == "$ANVIL_SHA256" ]] || { echo "anvil checksum mismatch"; exit 1; }
  tar -xzf "$CACHE/anvil.tgz" -C "$CACHE" anvil; ANVIL="$CACHE/anvil"
fi
[[ -x "$ANVIL" ]] || { echo "no anvil: install Foundry or set ANVIL_URL and ANVIL_SHA256"; exit 1; }
cp "$ANVIL" "$DEST/anvil"
chmod +x "$DEST/node" "$DEST/anvil"
du -sh "$APP" "$DEST/node" "$DEST/anvil" "$DEST/app"
