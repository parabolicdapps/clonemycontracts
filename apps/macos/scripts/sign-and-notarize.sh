#!/bin/zsh
# RELEASE signing + notarisation (Developer ID). Standard flow, inside-out:
#   sign nested Mach-O -> sign app -> notarise a zip of the app -> staple the app -> image the stapled app (UDZO, /Applications link)
#   -> sign dmg -> notarise dmg -> staple dmg -> assess.
# Notarising the app first means the app carries its own ticket after being dragged out of the dmg (works offline).
# Usage: DEVELOPER_ID='Developer ID Application: Name (TEAM)' NOTARY_PROFILE=cmc-notary sign-and-notarize.sh <App.app> <out.dmg>
# Defaults below are the owner's identity/profile on the build Mac. Uploads ONLY to Apple notarytool.
set -euo pipefail
APP="${1:?usage: sign-and-notarize.sh <App.app> <out.dmg>}"; DMG="${2:?}"; HERE="${0:A:h}"
IDENTITY="${DEVELOPER_ID:-Developer ID Application: Kunal Jaiswal (NN563U243B)}"
PROFILE="${NOTARY_PROFILE:-cmc-notary}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
E="$APP/Contents/Resources/engine"
S=(codesign --force --timestamp --options runtime --sign "$IDENTITY")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cmc-notarize.XXXXXX"); trap 'rm -rf "$WORK"' EXIT

# 0. hard gate before signing: no build-machine paths in the app's own executable (run build.sh with the Release strip settings)
if grep -a -q -E '/Users/|/home/' "$APP/Contents/MacOS/${${APP:t}%.app}"; then
  echo "FAIL: $APP/Contents/MacOS/${${APP:t}%.app} contains build-machine paths:"; grep -a -o -E '/(Users|home)/[^[:space:]]{0,80}' "$APP/Contents/MacOS/${${APP:t}%.app}" | sort -u | head
  exit 1
fi
# 1. every nested Mach-O except node and the app's main executable (candidates: executable bits and native-addon extensions, confirmed with file(1)), inside-out
find "$E" -type f \( -perm +111 -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0 |
  while IFS= read -r -d '' f; do
    [[ "$f" == "$E/node" ]] && continue
    file -b "$f" | grep -q 'Mach-O' || continue
    echo "sign nested: ${f#$APP/}"; "${S[@]}" "$f"
  done
echo "sign nested: node (allow-jit)"; "${S[@]}" --entitlements "$HERE/node.entitlements" "$E/node"
# 2. the app last (no sandbox, no extra entitlements)
"${S[@]}" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
# 3. notarise the app (zip), staple it
ditto -c -k --keepParent "$APP" "$WORK/app.zip"
xcrun notarytool submit "$WORK/app.zip" --keychain-profile "$PROFILE" --wait | tee "$WORK/app-notary.txt"
grep -q 'status: Accepted' "$WORK/app-notary.txt" || { echo "app notarisation failed; run: xcrun notarytool log <id> --keychain-profile $PROFILE"; exit 1; }
xcrun stapler staple "$APP"
# 4. dmg from the stapled app
rm -f "$DMG"
mkdir "$WORK/stage"; ditto "$APP" "$WORK/stage/$(basename "$APP")"; ln -s /Applications "$WORK/stage/Applications"
hdiutil create -volname "CloneMyContracts" -srcfolder "$WORK/stage" -ov -format UDZO "$DMG"
"${S[@]}" "$DMG"
# 5. notarise + staple the dmg, assess
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait | tee "$WORK/dmg-notary.txt"
grep -q 'status: Accepted' "$WORK/dmg-notary.txt" || { echo "dmg notarisation failed; run: xcrun notarytool log <id> --keychain-profile $PROFILE"; exit 1; }
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
/usr/sbin/spctl -a -vv -t install "$DMG"
echo "done: $DMG"
