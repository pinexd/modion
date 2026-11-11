#!/bin/sh
# Installs Modion for your user (no root needed), or removes it again:
#
#   ./install.sh              install or update
#   ./install.sh --uninstall  remove the program (settings, instances and game files stay)
#
# The program goes to ~/.local/opt/modion, with a "modion" command in ~/.local/bin and an
# entry in the application menu.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
dest="$HOME/.local/opt/modion"
bin="$HOME/.local/bin"
desktop="$data/applications/modion.desktop"
icon="$data/icons/hicolor/256x256/apps/modion.png"

refresh() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data/applications" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q "$data/icons/hicolor" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$dest"
  rm -f "$bin/modion" "$desktop" "$icon"
  refresh
  echo "Modion was removed. Your settings (~/.config/Modion), instances and downloaded game files were left alone."
  exit 0
fi

if [ ! -x "$here/modion" ] || [ ! -f "$here/resources/app/main.js" ]; then
  echo "This script has to be run from the unpacked Modion folder." >&2
  exit 1
fi
if [ "$here" = "$dest" ]; then
  echo "Modion is already installed here. To update, unpack the new version somewhere else and run its install.sh." >&2
  exit 1
fi

# The new copy is put in place whole, so a failed copy never leaves half an installation.
mkdir -p "$(dirname "$dest")" "$bin" "$(dirname "$desktop")" "$(dirname "$icon")"
rm -rf "$dest.new"
cp -r "$here" "$dest.new"
rm -rf "$dest"
mv "$dest.new" "$dest"

cat > "$bin/modion" <<WRAPPER
#!/bin/sh
exec "$dest/modion" "\$@"
WRAPPER
chmod 755 "$bin/modion"

cp "$dest/resources/app/assets/icon.png" "$icon"
cat > "$desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Modion
Comment=Browse and install Minecraft mods from Modrinth and CurseForge
Exec="$dest/modion"
Icon=modion
Categories=Game;Utility;
StartupWMClass=modion
Terminal=false
ENTRY
refresh

echo "Modion is installed in $dest."
echo "Start it from the application menu, or with: modion"
case ":$PATH:" in *":$bin:"*) ;; *) echo "(The \"modion\" command needs $bin on your PATH.)" ;; esac
