#!/usr/bin/env bash
# Builds the release packages:   dev/build-release.sh <version> <output-folder>
#
#   modion-<version>-app.zip             Modion itself, without Electron (what self-update fetches)
#   modion-<version>-linux-x64.tar.gz    Modion with Electron for Linux, plus install.sh
#   modion-<version>-windows-x64.zip     Modion with Electron for Windows (portable)
#   modion-<version>-windows-x64/        the same, unpacked, for the installer to pick up
#
# Electron's builds are downloaded from its GitHub releases and checked against the
# checksums Electron publishes. Set CURSEFORGE_KEY to include a default CurseForge key.
set -euo pipefail

version="${1:?version, for example 1.0.0}"
out="$(mkdir -p "${2:?output folder}" && cd "$2" && pwd)"
src="$(cd "$(dirname "$0")/.." && pwd)"
electron="${ELECTRON:-44.10.2}"
cache="${ELECTRON_CACHE:-$out/.electron}"
mkdir -p "$cache"

# --- Modion itself ---
app="$out/app"
rm -rf "$app" && mkdir "$app"
cp -r "$src"/main.js "$src"/preload.js "$src"/package.json "$src"/README.md "$src"/src "$src"/ui "$src"/assets "$app/"
[ -f "$src/LICENSE" ] && cp "$src/LICENSE" "$app/"
# The package records its version and the Electron it was built for (self-update checks both).
node -e '
  const fs = require("fs"), f = process.argv[1];
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  p.version = process.argv[2];
  p.modionElectron = process.argv[3];
  fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
' "$app/package.json" "$version" "$electron"
if [ -n "${CURSEFORGE_KEY:-}" ]; then
  printf '%s\n' "$CURSEFORGE_KEY" > "$app/curseforge.key"
else
  echo "note: no CURSEFORGE_KEY set; the packages ship without a CurseForge key" >&2
fi
rm -f "$out/modion-$version-app.zip"
(cd "$app" && zip -qr "$out/modion-$version-app.zip" .)

# --- Electron, checked ---
fetch_electron() { # <platform>  -> path of the verified zip
  local name="electron-v$electron-$1.zip" base="https://github.com/electron/electron/releases/download/v$electron"
  [ -f "$cache/SHASUMS256-$electron.txt" ] || curl -fsSL -o "$cache/SHASUMS256-$electron.txt" "$base/SHASUMS256.txt"
  [ -f "$cache/$name" ] || curl -fsSL -o "$cache/$name" "$base/$name"
  local want have
  want="$(grep " \*\?$name\$" "$cache/SHASUMS256-$electron.txt" | cut -d' ' -f1)"
  have="$(sha256sum "$cache/$name" | cut -d' ' -f1)"
  if [ -z "$want" ] || [ "$want" != "$have" ]; then
    rm -f "$cache/$name"
    echo "error: $name does not match Electron's published checksum" >&2
    exit 1
  fi
  echo "$cache/$name"
}

# --- Linux: Electron renamed to "modion", Modion in resources/app, and the installer script ---
linux="$out/modion-$version-linux-x64"
rm -rf "$linux" && mkdir "$linux"
unzip -q "$(fetch_electron linux-x64)" -d "$linux"
rm -f "$linux/resources/default_app.asar"
mv "$linux/electron" "$linux/modion"
cp -r "$app" "$linux/resources/app"
cp "$src/dev/install.sh" "$linux/install.sh"
chmod 755 "$linux/install.sh" "$linux/modion"
tar -C "$out" -czf "$out/modion-$version-linux-x64.tar.gz" "modion-$version-linux-x64"

# --- Windows: Electron renamed to Modion.exe, Modion in resources/app, an icon for shortcuts ---
win="$out/modion-$version-windows-x64"
rm -rf "$win" && mkdir "$win"
unzip -q "$(fetch_electron win32-x64)" -d "$win"
rm -f "$win/resources/default_app.asar"
mv "$win/electron.exe" "$win/Modion.exe"
cp -r "$app" "$win/resources/app"
node "$src/dev/make-ico.js" "$src/assets/icon.png" "$win/Modion.ico"
rm -f "$out/modion-$version-windows-x64.zip"
(cd "$out" && zip -qr "modion-$version-windows-x64.zip" "modion-$version-windows-x64")

echo "built in $out:"
ls -1 "$out" | grep "^modion-$version" | sed 's/^/  /'
