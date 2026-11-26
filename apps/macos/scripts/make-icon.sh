#!/bin/zsh
# Renders apps/web/public/favicon.svg into Resources/Assets.xcassets/AppIcon.appiconset (16..1024 px PNGs + Contents.json).
# The SVG's rounded tile spans 56 of 64 units; it is scaled so the tile is 824 px inside a 1024 canvas (Apple icon grid), transparent margin.
# Needs only macOS (swift + sips). Reproducible: run again after changing the SVG.
set -euo pipefail
HERE="${0:A:h}"; SVG="${HERE:h:h:h}/apps/web/public/favicon.svg"; OUT="${HERE:h}/Resources/Assets.xcassets/AppIcon.appiconset"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
mkdir -p "$OUT"; rm -f "$OUT"/*.png(N)
SWIFT=$(mktemp "${TMPDIR:-/tmp}/mkicon.XXXXXX"); mv "$SWIFT" "$SWIFT.swift"; SWIFT="$SWIFT.swift"; trap 'rm -f "$SWIFT"' EXIT
cat > "$SWIFT" <<'SW'
import AppKit
let a = CommandLine.arguments
guard let svg = NSImage(contentsOf: URL(fileURLWithPath: a[1])) else { fatalError("cannot load svg") }
let S = 1024, side = 824.0 * 64.0 / 56.0, off = (Double(S) - side) / 2
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: S, pixelsHigh: S, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current!.imageInterpolation = .high
svg.draw(in: NSRect(x: off, y: off, width: side, height: side))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
SW
swiftc -O -o "$SWIFT.bin" "$SWIFT" -framework AppKit 2>/dev/null; "$SWIFT.bin" "$SVG" "$OUT/icon_1024.png"; rm -f "$SWIFT.bin"
for s in 16 32 64 128 256 512; do sips -z $s $s "$OUT/icon_1024.png" --out "$OUT/icon_$s.png" >/dev/null; done
cat > "$OUT/Contents.json" <<'J'
{"images":[
{"size":"16x16","idiom":"mac","filename":"icon_16.png","scale":"1x"},
{"size":"16x16","idiom":"mac","filename":"icon_32.png","scale":"2x"},
{"size":"32x32","idiom":"mac","filename":"icon_32.png","scale":"1x"},
{"size":"32x32","idiom":"mac","filename":"icon_64.png","scale":"2x"},
{"size":"128x128","idiom":"mac","filename":"icon_128.png","scale":"1x"},
{"size":"128x128","idiom":"mac","filename":"icon_256.png","scale":"2x"},
{"size":"256x256","idiom":"mac","filename":"icon_256.png","scale":"1x"},
{"size":"256x256","idiom":"mac","filename":"icon_512.png","scale":"2x"},
{"size":"512x512","idiom":"mac","filename":"icon_512.png","scale":"1x"},
{"size":"512x512","idiom":"mac","filename":"icon_1024.png","scale":"2x"}],
"info":{"version":1,"author":"xcode"}}
J
echo "icon set written to $OUT"
