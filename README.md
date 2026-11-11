# Modion

A Minecraft mod manager for Linux, with an experimental Windows port. Browse, read about and install mods, resource packs,
shaders and data packs from **Modrinth** and **CurseForge** into the instances of the
launchers you already use.

> **This project is AI-coded ("vibe-coded").** The code was written by an AI model (Claude)
> under a person's direction, not by hand. It has automated tests, but it has not had a
> line-by-line human review. Read it before you rely on it.

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**

## Install

### Linux

Download `modion-<version>-linux-x64.tar.gz` from a
[release](https://github.com/pinexd/modion/releases), unpack it and run the installer in it:

```sh
./install.sh
```

It installs for your user only (no root): the program goes to `~/.local/opt/modion`, with
a `modion` command in `~/.local/bin` and an entry in the application menu. Electron is
included. `./install.sh --uninstall` removes the program again and leaves your settings,
instances and game files alone. You can also skip installing and run `./modion` straight
from the unpacked folder.

### Windows

Download `modion-<version>-windows-x64-setup.exe` from a release and run it. It installs
for your user only (no administrator rights) into `%LOCALAPPDATA%\Programs\Modion`, adds
Start menu and desktop shortcuts, and can be removed under "Installed apps". The installer
is not code-signed, so Windows SmartScreen will ask before running it. There is also a
portable `modion-<version>-windows-x64.zip`: unpack it anywhere and run `Modion.exe`. Settings are kept in `%APPDATA%\Modion`, new
instances in `%APPDATA%\Modion\instances`, and downloaded game files in
`%LOCALAPPDATA%\ModionApp`.

### Updates

Modion looks at this project's GitHub releases when it starts (this can be switched off in
Settings, which also has a "Check Now" button) and asks before doing anything. An installed
or portable copy can then update itself: it downloads the new version of Modion's own
files, checks them against the project's release signature (the public key is built in; an
update that is unsigned or signed by anyone else is refused), swaps them in and restarts.
A copy run from a source checkout is only pointed at the release page. When a new version
needs a newer Electron, the full package has to be downloaded once.

### From a checkout

With Electron installed (`sudo pacman -S electron`), `./modion` in a clone of this
repository starts it with no build step; `./install-desktop-entry.sh` adds that copy to
the application menu. `dev/build-release.sh <version> <folder>` builds the release packages.

## Using it

- **Instances** – the picker in the bottom-left. "Detect Launchers" finds game folders from
  the Minecraft Launcher, Prism Launcher / MultiMC / PolyMC and the Modrinth App (native or
  Flatpak), including their game version and mod loader. Any folder can be added by hand.
- **New Instance / Play** – By default Modion starts the game itself, with your Microsoft
  account: until you are signed in, the Play button in the bottom bar is a **Sign In**
  button, and new instances are kept in Modion's own folder. Settings can switch
  "Starting the game" to Prism Launcher instead; then "New Instance..." writes a Prism
  instance and Play asks Prism to launch it, with the account and Java Prism manages.
  Instances Modion cannot start itself get the launcher that owns them: "Open Launcher".
- **Instances page** – create an instance, import a modpack (Modrinth `.mrpack` or a
  CurseForge zip; the latter needs your CurseForge API key), and rename, delete or open the
  folder of instances Modion made. Instances added from other launchers can be selected and
  forgotten, never renamed or deleted.
- **Direct launching** – Modion can also start the game itself: vanilla back to
  Minecraft 1.0, and Fabric, Quilt, Forge and NeoForge on the versions those loaders exist
  for. It downloads the game, assets and Java from Mojang into `~/.local/share/ModionApp`.
  Forge and NeoForge builds are looked up through Prism Launcher's metadata service, and
  from 1.13 on are started through ForgeWrapper, which runs Forge's installer steps on the
  first start (that first start takes a minute or two). This needs a Microsoft sign-in (Settings, "Sign In
  with Microsoft"): the sign-in page opens in your own web browser and Modion receives the
  result on a one-shot `http://localhost` listener, never your password. Settings has a
  "Starting the game" choice between Prism Launcher and starting directly. An offline mode exists for
  developing the launch code; it is locked to the developer's own computer and does not
  appear anywhere else.
- **Instance libraries** – with either "start directly" setting, new instances are made in
  Modion's own folder (`~/.local/share/Modion` unless Settings names another) instead of in
  Prism. Settings lists these folders: add one, choose which receives new instances,
  relocate one with everything in it, or remove it from the list. An instance carries its
  identity in its `instance.json`, so a library moved by hand is recognised when its new
  folder is added. Such instances also have a **Move** button on the Instances page.
- **Instance settings** – the Settings button on an instance (Instances page): which Java to
  use (automatic, one found on the computer, or one you browse to), a memory slider, extra
  Java arguments and environment variables. They apply when Modion starts the game itself.
  If the Java arguments contain `-Xmx` or `-Xms`, those decide the memory and the slider is
  switched off.
- **Browse** – pick Modrinth or CurseForge in the sidebar, a content type in the tabs. Results
  are filtered to the active instance's version and loader.
- **Modpacks** – the first tab on the Modrinth and CurseForge pages (Mods is still the one
  that opens). Installing a modpack creates a new instance from it; the version and loader
  filters there are your own choice, not the selected instance's.
- **Project page** – description, gallery and file list. *Install* takes the newest file that
  fits the instance and pulls in required dependencies; the *Files* tab installs a specific one.
- **Library** – what is in the instance, including files Modion did not install (identified
  by hash through Modrinth). Disable, re-enable or remove (to the trash).

### CurseForge

CurseForge only serves apps that send an API key. Get a free one at
<https://console.curseforge.com/> and paste it under Settings. Authors can switch off
third-party downloads for their project. For those files Modion opens the file's page on
curseforge.com in a separate window; you press Download there, and Modion puts the file in
the instance. With a key set, mods installed from one site also show as installed on the other.

Released packages can carry a key of their own: a file named `curseforge.key` next to
`main.js` is used when no key is saved in Settings. That file is never committed; the
release workflow writes it from the repository secret `CURSEFORGE_KEY`.

## Releases

Actions → Release → Run workflow, with a version tag (`v0.1.0`), and optionally a title and
notes. It packs a tarball and opens a release, as a draft by default so the notes can be
finished in GitHub's editor before publishing.

## Layout

| Path | What |
| --- | --- |
| `main.js`, `preload.js` | Electron main process and the narrow bridge to the UI |
| `src/modrinth.js`, `src/curseforge.js` | API clients, normalised to one shape |
| `src/content.js` | Downloads (checksum-verified), dependencies, library management |
| `src/instances.js` | Launcher detection |
| `src/launcher.js` | Creating Prism instances and starting the game through Prism |
| `src/updater.js` | Looking for new releases and installing a signed update |
| `src/java.js` | Finding the Java installations on the computer |
| `src/platform.js` | Folders and names that differ between Linux and Windows |
| `src/libraries.js` | Instance libraries: the folders of Modion's own instances |
| `src/game.js` | Downloading and starting the game directly |
| `src/account.js` | Microsoft sign-in |
| `src/webinstall.js` | The CurseForge page window that catches a manual download |
| `src/modpack.js` | Reading `.mrpack` and CurseForge modpack zips |
| `ui/` | The interface; `markdown.js` renders and sanitises project descriptions |
| `dev/smoke.js` | End-to-end check: `MODION_HEADLESS=1 electron dev/smoke.js out-dir` |

Settings live in `~/.config/Modion/`.

Not affiliated with Mojang, Microsoft, Modrinth or CurseForge.
