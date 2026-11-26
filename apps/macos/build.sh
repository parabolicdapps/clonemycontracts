#!/bin/zsh
# Build the app (Apple silicon), bundle the engine into it and ad-hoc sign it. Output: build/dd/Build/Products/Release/CloneMyContracts.app
# SKIP_ENGINE=1 builds the shell only.
set -euo pipefail
cd "${0:A:h}"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodegen generate --quiet
xcodebuild -project CloneMyContracts.xcodeproj -scheme CloneMyContracts -configuration Release \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath build/dd -quiet build
APP="$PWD/build/dd/Build/Products/Release/CloneMyContracts.app"
[[ -z "${SKIP_ENGINE:-}" ]] && scripts/bundle-engine.sh "$APP"
scripts/sign-local.sh "$APP"
echo "$APP"
