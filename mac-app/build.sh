#!/bin/bash
# Builds dist/Hi-Techie.app and dist/Hi-Techie-<version>.dmg. Needs a Mac with the Xcode command line tools
# (xcode-select --install); nothing else to install.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="2.0.0"
APP="dist/Hi-Techie.app"
TMP="dist/tmp"
rm -rf dist
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$TMP"

# One binary for Apple silicon and Intel (the Intel part adds only a few hundred KB).
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -parse-as-library -target "$arch-apple-macos12.0" Sources/*.swift -o "$TMP/Hi-Techie-$arch"
done
lipo -create "$TMP/Hi-Techie-arm64" "$TMP/Hi-Techie-x86_64" -output "$APP/Contents/MacOS/Hi-Techie"

sed "s/__VERSION__/$VERSION/g" Info.plist > "$APP/Contents/Info.plist"

# The icon, from the site's 512 px icon.
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature: required to run on Apple silicon. Not an Apple Developer ID (see README).
codesign --force --sign - "$APP"

# The .dmg: the app plus a shortcut to Applications to drag it onto.
mkdir -p "$TMP/dmg"
cp -R "$APP" "$TMP/dmg/"
ln -s /Applications "$TMP/dmg/Applications"
hdiutil create -quiet -volname "Hi-Techie" -srcfolder "$TMP/dmg" -ov -format UDZO "dist/Hi-Techie-$VERSION.dmg"
rm -rf "$TMP"

du -sh "$APP" "dist/Hi-Techie-$VERSION.dmg"
