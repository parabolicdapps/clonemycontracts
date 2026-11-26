#!/bin/zsh
# Ad-hoc signing for local tests, same layout and flags as the release signing (hardened runtime, node with allow-jit).
set -euo pipefail
APP="${1:?usage: sign-local.sh <App.app>}"; HERE="${0:A:h}"; E="$APP/Contents/Resources/engine"
for f in "$E/anvil"; do [[ -f $f ]] && codesign --force --options runtime --sign - "$f"; done
[[ -f "$E/node" ]] && codesign --force --options runtime --entitlements "$HERE/node.entitlements" --sign - "$E/node"
# any native addons in production node_modules
find "$E/app" \( -name '*.node' -o -name '*.dylib' \) -exec codesign --force --options runtime --sign - {} \; 2>/dev/null || true
codesign --force --options runtime --sign - "$APP"
codesign --verify --deep --strict "$APP" && echo "ad-hoc signed OK"
