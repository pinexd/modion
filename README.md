# Modion

A Minecraft mod manager for Linux. Browse, read about and install mods, resource packs,
shaders and data packs from **Modrinth** and **CurseForge** into the instances of the
launchers you already use.

> **This project is AI-coded ("vibe-coded").** The code was written by an AI model (Claude)
> under a person's direction, not by hand. It has automated tests, but it has not had a
> line-by-line human review. Read it before you rely on it.

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**

## Run

Needs Electron (`sudo pacman -S electron`). No other dependencies, no build step.

```sh
./modion
```

`./install-desktop-entry.sh` adds it to your application menu.

## Using it

- **Instances** – the picker in the bottom-left. "Detect Launchers" finds game folders from
  the Minecraft Launcher, Prism Launcher / MultiMC / PolyMC and the Modrinth App (native or
  Flatpak), including their game version and mod loader. Any folder can be added by hand.
- **New Instance / Play** – Modion does not sign in to Minecraft or download the game itself.
  "New Instance..." writes a Prism Launcher instance (game version + Fabric, Quilt, Forge or
  NeoForge), and the Play button in the bottom bar asks Prism to launch it, with the account
  and Java that Prism already manages. Instances owned by other launchers get an
  "Open Launcher" button instead.
- **Instances page** – create an instance, import a modpack (Modrinth `.mrpack` or a
  CurseForge zip; the latter needs your CurseForge API key), and rename, delete or open the
  folder of instances Modion made. Instances added from other launchers can be selected and
  forgotten, never renamed or deleted.
- **Direct launching (in progress)** – Modion can also start the game itself (vanilla, Fabric
  and Quilt on 1.19+), downloading the game, assets and Java from Mojang into
  `~/.local/share/modion`. In normal use this needs a Microsoft sign-in (Settings), which
  depends on an application ID approved for the Minecraft API. Settings has a "Starting the
  game" choice between Prism Launcher and starting directly. An offline mode exists for
  developing the launch code; it is locked to the developer's own computer and does not
  appear anywhere else.
- **Browse** – pick Modrinth or CurseForge in the sidebar, a content type in the tabs. Results
  are filtered to the active instance's version and loader.
- **Project page** – description, gallery and file list. *Install* takes the newest file that
  fits the instance and pulls in required dependencies; the *Files* tab installs a specific one.
- **Library** – what is in the instance, including files Modion did not install (identified
  by hash through Modrinth). Disable, re-enable or remove (to the trash).

### CurseForge

CurseForge only serves apps that send an API key. Get a free one at
<https://console.curseforge.com/> and paste it under Settings. Authors can switch off
third-party downloads for their project; those files get a "Website Only" button.

## Layout

| Path | What |
| --- | --- |
| `main.js`, `preload.js` | Electron main process and the narrow bridge to the UI |
| `src/modrinth.js`, `src/curseforge.js` | API clients, normalised to one shape |
| `src/content.js` | Downloads (checksum-verified), dependencies, library management |
| `src/instances.js` | Launcher detection |
| `src/launcher.js` | Creating Prism instances and starting the game through Prism |
| `src/game.js` | Downloading and starting the game directly |
| `src/account.js` | Microsoft sign-in |
| `src/modpack.js` | Reading `.mrpack` and CurseForge modpack zips |
| `ui/` | The interface; `markdown.js` renders and sanitises project descriptions |
| `dev/smoke.js` | End-to-end check: `MODION_HEADLESS=1 electron dev/smoke.js out-dir` |

Settings live in `~/.config/Modion/`.

Not affiliated with Mojang, Microsoft, Modrinth or CurseForge.
