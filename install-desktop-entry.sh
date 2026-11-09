#!/bin/sh
# Adds Modion to your application menu (run again after moving this folder).
set -e
here="$(dirname "$(readlink -f "$0")")"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$apps"
cat > "$apps/modion.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Modion
Comment=Browse and install Minecraft mods from Modrinth and CurseForge
Exec="$here/modion"
Icon=$here/assets/icon.png
Categories=Game;Utility;
StartupWMClass=modion
ENTRY
echo "Installed $apps/modion.desktop"
