'use strict';
// Starting Minecraft directly: fetches the game, its libraries, assets and a matching Java
// from Mojang's own servers into a shared folder, builds the launch command from the
// version's metadata, and runs it in the instance's game folder.
//
// Works on Linux and Windows (64-bit Intel/AMD). Covers vanilla from 1.0 on, and Fabric and Quilt wherever those loaders exist. Versions
// before 1.19 need native libraries unpacked; versions before 1.13 describe their launch
// command in an older format; versions before 1.7.3 keep their assets as plain files.
// Forge and NeoForge are described by Prism Launcher's metadata service, which has every
// build back to 1.1 in one format. From 1.13 on they are started through ForgeWrapper, a
// small program that runs Forge's own installer steps on first start; 1.6 to 1.12.2 are
// extra libraries plus a "tweak class"; 1.5.2 and older are patches merged into the game jar.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getJson, ApiError, arr } = require('./http');
const { download } = require('./content');
const { openZip, writeZip } = require('./zip');
const launcher = require('./launcher');
const platform = require('./platform');

const ROOT = require('./libraries').APP_DATA; // ~/.local/share/ModionApp
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RUNTIMES = 'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const ASSETS = 'https://resources.download.minecraft.net';
const LOADER_META = {
  fabric: { name: 'Fabric', base: 'https://meta.fabricmc.net/v2/versions/loader' },
  quilt: { name: 'Quilt', base: 'https://meta.quiltmc.org/v3/versions/loader' },
};
const PARALLEL = 12;

const PRISM_LOADERS = { forge: 'Forge', neoforge: 'NeoForge' };
// Libraries old Forge (1.3.2 to 1.5.2) expects in the game folder's "lib"; it used to fetch
// them itself from servers that no longer exist.
const FML_LIBS_URL = 'https://files.prismlauncher.org/fmllibs/';
const FML_OLD = ['argo-2.25.jar', 'guava-12.0.1.jar', 'asm-all-4.0.jar'];
const FML_15 = ['argo-small-3.2.jar', 'guava-14.0-rc3.jar', 'asm-all-4.1.jar', 'bcprov-jdk15on-148.jar', 'scala-library.jar'];
const fmlLibs = (gameVersion) => (
  gameVersion === '1.3.2' ? FML_OLD
    : /^1\.4(\.\d)?$/.test(gameVersion) ? [...FML_OLD, 'bcprov-jdk15on-147.jar']
      : /^1\.5(\.[12])?$/.test(gameVersion) ? [...FML_15, `deobfuscation_data_${gameVersion}.zip`]
        : []);

// Forge's installer steps check their output files byte for byte. On systems whose zlib is
// zlib-ng (Arch-based and Fedora, among others) Java compresses slightly differently, the
// files are correct but not identical, and the check fails. It is switched off there.
let zlibNg = null;
function systemZlibIsNg() {
  if (zlibNg === null) {
    zlibNg = ['/usr/lib/libz.so.1', '/usr/lib64/libz.so.1', '/usr/lib/x86_64-linux-gnu/libz.so.1', '/lib/x86_64-linux-gnu/libz.so.1'].some((file) => {
      try { return fs.readFileSync(file).includes('zlib-ng'); } catch { return false; }
    });
  }
  return zlibNg;
}

const supports = (inst) => Boolean(inst && inst.gameVersion
  && (!inst.loader || Object.hasOwn(LOADER_META, inst.loader) || Object.hasOwn(PRISM_LOADERS, inst.loader)));

// Mojang's metadata marks libraries and arguments with rules such as "only on macOS".
function allowed(rules) {
  if (!Array.isArray(rules) || !rules.length) return true;
  let ok = false;
  for (const r of rules) {
    if (!r) continue;
    const osOk = !r.os || ((!r.os.name || r.os.name === platform.OS_NAME) && (!r.os.arch || r.os.arch === 'x64'));
    // Optional launcher features (demo mode, custom resolution, quick play) are all off.
    const featuresOk = !r.features || Object.values(r.features).every((v) => v === false);
    if (osOk && featuresOk) ok = r.action === 'allow';
  }
  return ok;
}

// "group:artifact:version[:classifier]" -> path inside a Maven repository
function mavenPath(name) {
  const [group, artifact, version, classifier] = String(name).split(':');
  if (!group || !artifact || !version) throw new ApiError(`Unreadable library name: ${name}`, 'BAD_REPLY');
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
}

// Keeps files inside the folder they belong to, whatever the metadata says.
function inside(base, rel) {
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new ApiError('Refusing a file path that leaves its folder.', 'BAD_NAME');
  return full;
}

async function versionJson(gameVersion) {
  const file = path.join(ROOT, 'versions', gameVersion, `${gameVersion}.json`);
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
  const entry = arr((await getJson(MANIFEST)).versions).find((v) => v && v.id === gameVersion);
  if (!entry || !entry.url) throw new ApiError(`Mojang does not list Minecraft ${gameVersion}.`, 'NO_GAME_VERSION');
  const json = await getJson(entry.url);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(json));
  return json;
}

async function loaderProfile(loader, gameVersion) {
  if (Object.hasOwn(PRISM_LOADERS, loader)) {
    const version = await launcher.loaderBuild(loader, gameVersion);
    const meta = await launcher.loaderMeta(loader, version);
    if (!meta || typeof meta !== 'object') throw new ApiError(`${PRISM_LOADERS[loader]} ${version} has no usable description.`, 'BAD_REPLY');
    return {
      version,
      mainClass: typeof meta.mainClass === 'string' ? meta.mainClass : null,
      libraries: arr(meta.libraries),
      extraFiles: arr(meta.mavenFiles),   // needed on disk, not on the classpath
      jarMods: arr(meta.jarMods),         // patches to merge into the game jar
      gameLine: typeof meta.minecraftArguments === 'string' ? meta.minecraftArguments : null,
      tweakers: arr(meta['+tweakers']).filter((t) => typeof t === 'string' && /^[\w.$]+$/.test(t)),
      legacyFML: arr(meta['+traits']).includes('legacyFML'),
      javaFix: loader === 'forge' && gameVersion === '1.7.2',
      // These builds are described on the assumption that the game uses the patched log4j
      // that Prism lists for it, so that is taken along (it also closes Log4Shell properly).
      patched: arr((await launcher.gameMeta(gameVersion).catch(() => null) || {}).libraries)
        .filter((l) => l && typeof l.name === 'string' && l.name.startsWith('org.apache.logging.log4j:')),
      prism: true,
    };
  }
  const meta = LOADER_META[loader];
  const builds = arr(await getJson(`${meta.base}/${encodeURIComponent(gameVersion)}`)).filter((b) => b && b.loader && b.loader.version);
  const pick = builds.find((b) => b.loader.stable) || builds.find((b) => !/beta|alpha|rc/i.test(b.loader.version)) || builds[0];
  if (!pick) throw new ApiError(`${meta.name} is not available for Minecraft ${gameVersion}.`, 'NO_LOADER_VERSION');
  return getJson(`${meta.base}/${encodeURIComponent(gameVersion)}/${encodeURIComponent(pick.loader.version)}/profile/json`);
}

// Downloads whatever is missing, a few files at a time, reporting overall progress.
async function fetchAll(items, progress) {
  const missing = [];
  for (const it of items) {
    let st = null;
    try { st = await fsp.stat(path.join(it.dir, it.filename)); } catch {}
    if (!st || !st.isFile() || (it.size && st.size !== it.size)) missing.push(it);
  }
  const total = missing.reduce((n, it) => n + (it.size || 0), 0);
  let done = 0, next = 0, failure = null;
  const worker = async () => {
    while (next < missing.length && !failure) {
      const it = missing[next++];
      try {
        // A dropped connection among hundreds of files is worth a second and third try.
        for (let attempt = 1; ; attempt++) {
          try { await download(it, it.dir); break; } catch (e) {
            if (attempt >= 3 || !(e instanceof ApiError) || e.code !== 'NETWORK') throw e;
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
        if (it.mode) await fsp.chmod(path.join(it.dir, it.filename), it.mode);
      } catch (e) {
        failure = e;
        return;
      }
      done += it.size || 0;
      progress(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, missing.length) }, worker));
  if (failure) throw failure;
  return missing.length;
}

// A Java of the right major version: one already on the system, or Mojang's own runtime.
async function findJava(wanted, progress) {
  const major = Number(wanted && wanted.majorVersion) || 8;
  const component = (wanted && wanted.component) || 'jre-legacy';
  let systems = []; // (Linux keeps installed Javas in one place; on Windows Mojang's own is always used)
  try { if (!platform.WIN) systems = await fsp.readdir('/usr/lib/jvm'); } catch {}
  for (const name of systems) {
    const home = path.join('/usr/lib/jvm', name);
    try {
      const m = (await fsp.readFile(path.join(home, 'release'), 'utf8')).match(/^JAVA_VERSION="(\d+)(?:\.(\d+))?/m);
      const found = m && (m[1] === '1' ? Number(m[2]) : Number(m[1]));
      await fsp.access(path.join(home, 'bin/java'), fs.constants.X_OK);
      if (found === major) return path.join(home, 'bin/java');
    } catch {}
  }

  if (!/^[\w-]+$/.test(component)) throw new ApiError('Unreadable Java runtime name.', 'BAD_REPLY');
  const home = path.join(ROOT, 'runtimes', component);
  const java = path.join(home, platform.JAVA);
  const marker = path.join(home, '.complete');
  if (fs.existsSync(marker) && fs.existsSync(java)) return java;

  const all = await getJson(RUNTIMES);
  const offer = arr(all[platform.RUNTIME_OS] && all[platform.RUNTIME_OS][component])[0];
  if (!offer || !offer.manifest || !offer.manifest.url) throw new ApiError(`No Java ${major} runtime is available for this system. Install Java ${major} and try again.`, 'NO_JAVA');
  const files = (await getJson(offer.manifest.url)).files || {};
  const items = [], links = [];
  for (const [rel, f] of Object.entries(files)) {
    const full = inside(home, rel);
    if (f.type === 'directory') await fsp.mkdir(full, { recursive: true });
    else if (f.type === 'link' && typeof f.target === 'string') links.push([full, f.target]);
    else if (f.type === 'file' && f.downloads && f.downloads.raw && f.downloads.raw.size === 0) {
      // Some runtimes contain files that are meant to be empty; there is nothing to download.
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, '');
    } else if (f.type === 'file' && f.downloads && f.downloads.raw) {
      items.push({ url: f.downloads.raw.url, sha1: f.downloads.raw.sha1, size: f.downloads.raw.size, dir: path.dirname(full), filename: path.basename(full), mode: f.executable ? 0o755 : 0o644 });
    }
  }
  await fetchAll(items, progress);
  for (const [full, target] of links) {
    inside(home, path.join(path.dirname(path.relative(home, full)), target)); // links may not point outside the runtime
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.rm(full, { force: true });
    await fsp.symlink(target, full);
  }
  await fsp.writeFile(marker, offer.version && offer.version.name ? String(offer.version.name) : 'ok');
  return java;
}

// Old versions keep native code (LWJGL and friends) in separate jars that have to be unpacked
// into a folder the game is pointed at. Unpacked afresh for each start.
async function unpackNatives(jars, dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const { file, exclude } of jars) {
    const zip = openZip(file);
    try {
      for (const entry of zip.entries.values()) {
        if (entry.name.endsWith('/') || exclude.some((x) => entry.name.startsWith(x))) continue;
        const full = inside(dir, entry.name);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, zip.read(entry));
      }
    } finally {
      zip.close();
    }
  }
}

// Forge from 1.13 on finishes its installation on the computer: it patches the game jar
// and writes the results into the libraries folder. ForgeWrapper does that work when it is
// started. Here it is started once on its own, with nothing but itself on the classpath:
// the installation runs, and then ForgeWrapper fails to start the game, which is not
// there. That failure (a non-zero exit) is the sign that it got all the way through; when
// the installation itself fails, ForgeWrapper says so and exits normally.
// Doing this before the game starts means a failure is reported instead of the game just
// not appearing, and that everything Forge builds exists by the time the game needs it.
async function installForge(java, wrapper, options, gameLine, name) {
  // Only the arguments that say which Forge this is; none of them carry account details.
  const words = String(gameLine || '').split(/\s+/).filter(Boolean);
  const ident = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (/^--(fml\.\w+|launchTarget)$/.test(words[i]) && !words[i + 1].includes('${')) ident.push(words[i], words[i + 1]);
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modion-forge-'));
  try {
    const { finished, text } = await new Promise((resolve) => {
      require('child_process').execFile(java, [...options, '-cp', wrapper, 'io.github.zekerzhayard.forgewrapper.installer.Main', ...ident],
        { cwd: dir, timeout: 20 * 60 * 1000, maxBuffer: 256 * 2 ** 20, windowsHide: true },
        (err, stdout, stderr) => resolve({ finished: Boolean(err) && !err.killed && Number.isInteger(err.code) && err.code !== 0, text: `${stdout}\n${stderr}` }));
    });
    if (!finished || /Processor failed|forgewrapper\.installer\.Installer\.|\.installer\.actions\./.test(text)) {
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^at /.test(l));
      const at = lines.findIndex((l) => /Processor failed/.test(l));
      const tail = (at >= 0 ? lines.slice(at, at + 4) : lines.slice(-4)).join(' | ').slice(0, 600);
      throw new ApiError(`Setting up ${name} did not finish. ${tail}`.trim(), 'LOADER_INSTALL');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// Forge for these versions crashes on Wayland while opening its own loading window ("GLFW
// error before init: Wayland: The platform does not provide the window position"); Forge
// fixed it from 26.1.2 on. Forge has a setting that leaves the window to the game, and with
// it these builds start, so that setting is switched off in the instance's Forge config.
const FORGE_WAYLAND_CRASH = ['26.1', '26.1.1'];
async function disableForgeEarlyWindow(gameDir) {
  const file = path.join(gameDir, 'config', 'fml.toml');
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch {}
  const line = /^earlyWindowControl\s*=.*$/m;
  if (/^earlyWindowControl\s*=\s*false\s*$/m.test(text)) return;
  const next = line.test(text) ? text.replace(line, 'earlyWindowControl = false') : `${text}${text && !text.endsWith('\n') ? '\n' : ''}earlyWindowControl = false\n`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, next);
  } catch {} // if it cannot be written, the game is still started and Forge reports its own error
}

// Old Forge is installed by putting its files into the game jar: later archives win over
// earlier ones, and the jar's signature (META-INF) goes, since it no longer matches.
async function mergeJars(base, patches, out) {
  const files = new Map();
  for (const file of [base, ...patches]) {
    const zip = openZip(file);
    try {
      for (const entry of zip.entries.values()) {
        if (entry.name.endsWith('/') || entry.name.startsWith('META-INF/')) continue;
        files.set(entry.name, zip.read(entry));
      }
    } finally {
      zip.close();
    }
  }
  const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.part`;
  try {
    writeZip(tmp, [...files].map(([name, data]) => ({ name, data })));
    await fsp.rename(tmp, out);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw new ApiError(`Could not build the patched game jar: ${e.code || e.message}.`, 'FS');
  }
}

// Versions before 1.7.3 read their sounds and language files by name, not through the
// asset index: from <game folder>/resources (up to 1.5.2) or from one shared folder.
async function legacyAssets(index, id, gameDir) {
  if (!index.virtual && !index.map_to_resources) return null;
  const dir = index.map_to_resources ? path.join(gameDir, 'resources') : path.join(ROOT, 'assets', 'virtual', id);
  for (const [name, o] of Object.entries(index.objects || {})) {
    if (!o || !/^[0-9a-f]{40}$/.test(o.hash)) continue;
    const to = inside(dir, name);
    let have = null;
    try { have = await fsp.stat(to); } catch {}
    if (have && have.size === o.size) continue;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(path.join(ROOT, 'assets', 'objects', o.hash.slice(0, 2), o.hash), to);
  }
  return dir;
}

// Mojang's logging setup for the version. It matters for more than looks: for 1.7 to 1.18
// it is what closes the Log4Shell hole. Mojang's file prints the console output as XML for
// its own launcher, so the copy Modion uses prints it as plain lines instead.
async function loggingConfig(game) {
  const spec = game.logging && game.logging.client;
  const f = spec && spec.file;
  if (!f || !f.url || typeof spec.argument !== 'string' || !/^[\w.-]+\.xml$/.test(String(f.id))) return null;
  const dir = path.join(ROOT, 'assets', 'log_configs');
  await fetchAll([{ url: f.url, sha1: f.sha1, size: f.size, dir, filename: f.id }], () => {});
  const xml = await fsp.readFile(path.join(dir, f.id), 'utf8');
  const pattern = xml.match(/<PatternLayout\b[^>]*\/>/);
  const plain = pattern ? xml.replace(/<(?:Legacy)?XMLLayout\s*\/>/g, pattern[0]) : xml;
  const file = path.join(dir, `plain-${f.id}`);
  await fsp.writeFile(file, plain);
  return spec.argument.replace('${path}', file);
}

// Everything needed to start this instance, downloading what is missing.
async function prepare(inst, progress) {
  if (process.arch !== 'x64') throw new ApiError('Direct launching is only set up for 64-bit Intel/AMD computers so far.', 'UNSUPPORTED');
  const game = await versionJson(inst.gameVersion);
  if ((!game.arguments && typeof game.minecraftArguments !== 'string') || !game.downloads || !game.downloads.client || !game.assetIndex) {
    throw new ApiError(`Mojang's description of Minecraft ${inst.gameVersion} is not one Modion can start.`, 'UNSUPPORTED');
  }
  const profile = inst.loader ? await loaderProfile(inst.loader, inst.gameVersion) : null;

  const libDir = path.join(ROOT, 'libraries');
  const libs = new Map(); // "group:artifact[:classifier]" -> item; the loader's choice of a library wins
  const nativeJars = [];  // jars of native code to unpack (versions before 1.19)
  const add = (name, item) => { const [g, a, , c] = String(name).split(':'); const key = `${g}:${a}${c ? `:${c}` : ''}`; if (!libs.has(key)) libs.set(key, item); };
  // A loader's library: either a full download record, or a name plus the repository it is in.
  const loaderItem = (lib) => {
    const a = (lib.downloads && lib.downloads.artifact) || {};
    const rel = typeof a.path === 'string' && a.path ? a.path : mavenPath(lib.name);
    const full = inside(libDir, rel);
    return {
      url: a.url || String(lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/') + rel,
      sha1: a.sha1 || lib.sha1, size: a.size || lib.size, dir: path.dirname(full), filename: path.basename(full),
    };
  };
  for (const lib of [...arr(profile && profile.libraries), ...arr(profile && profile.patched)]) {
    if (lib && lib.name && allowed(lib.rules)) add(lib.name, loaderItem(lib));
  }
  const extras = arr(profile && profile.extraFiles).filter((l) => l && l.name).map((l) => ({ name: String(l.name), item: loaderItem(l) }));
  const jarMods = arr(profile && profile.jarMods).filter((l) => l && l.downloads && l.downloads.artifact && l.downloads.artifact.url).map((l) => {
    const a = l.downloads.artifact;
    return { url: a.url, sha1: a.sha1, size: a.size, dir: path.join(ROOT, 'jarmods'), filename: path.basename(new URL(a.url).pathname) };
  });
  const gameLib = profile && profile.legacyFML
    ? fmlLibs(inst.gameVersion).map((name) => ({ url: FML_LIBS_URL + name, dir: path.join(inst.path, 'lib'), filename: name }))
    : [];
  // Some Forge builds of that era stop with an error on any Java newer than 7, and there is
  // no Java 7 to be had any more. Forge's own remedy is a small mod, "legacy Java fixer",
  // which goes into the instance's mods folder like any other.
  if (profile && profile.javaFix) {
    gameLib.push({ url: 'https://maven.minecraftforge.net/net/minecraftforge/lex/legacyjavafixer/1.0/legacyjavafixer-1.0.jar', sha1: 'a11b502bef19f49bfc199722b94da5f3d7b470a8', size: 6245, dir: path.join(inst.path, 'mods'), filename: 'legacyjavafixer-1.0.jar' });
  }
  for (const lib of arr(game.libraries)) {
    if (!lib || !allowed(lib.rules)) continue;
    const a = lib.downloads && lib.downloads.artifact;
    if (a && a.url && a.path) {
      const full = inside(libDir, a.path);
      add(lib.name, { url: a.url, sha1: a.sha1, size: a.size, dir: path.dirname(full), filename: path.basename(full) });
    }
    const key = lib.natives && typeof lib.natives[platform.OS_NAME] === 'string' ? lib.natives[platform.OS_NAME].replace('${arch}', '64') : null;
    const n = key && lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[key];
    if (n && n.url && n.path) {
      const full = inside(libDir, n.path);
      nativeJars.push({
        item: { url: n.url, sha1: n.sha1, size: n.size, dir: path.dirname(full), filename: path.basename(full) },
        file: full,
        exclude: arr(lib.extract && lib.extract.exclude).filter((x) => typeof x === 'string' && x),
      });
    }
  }

  const versionDir = path.join(ROOT, 'versions', inst.gameVersion);
  const client = { url: game.downloads.client.url, sha1: game.downloads.client.sha1, size: game.downloads.client.size, dir: versionDir, filename: `${inst.gameVersion}.jar` };

  if (!/^[\w.-]+$/.test(String(game.assetIndex.id))) throw new ApiError('Unreadable asset index name.', 'BAD_REPLY');
  const indexFile = path.join(ROOT, 'assets', 'indexes', `${game.assetIndex.id}.json`);
  let index;
  try { index = JSON.parse(await fsp.readFile(indexFile, 'utf8')); } catch {
    index = await getJson(game.assetIndex.url);
    await fsp.mkdir(path.dirname(indexFile), { recursive: true });
    await fsp.writeFile(indexFile, JSON.stringify(index));
  }
  const assets = new Map();
  for (const o of Object.values(index.objects || {})) {
    if (!o || !/^[0-9a-f]{40}$/.test(o.hash)) continue;
    const two = o.hash.slice(0, 2);
    assets.set(o.hash, { url: `${ASSETS}/${two}/${o.hash}`, sha1: o.hash, size: o.size, dir: path.join(ROOT, 'assets', 'objects', two), filename: o.hash });
  }

  // Java first: its progress is reported on its own, then the game files as one total.
  // A Java chosen in the instance's settings is used as it is, if it is still there.
  const chosen = inst.settings && inst.settings.java;
  const java = chosen && platform.isFile(chosen) ? chosen : await findJava(game.javaVersion, progress);
  await fetchAll([client, ...libs.values(), ...extras.map((e) => e.item), ...jarMods, ...gameLib, ...nativeJars.map((n) => n.item), ...assets.values()], progress);

  const natives = path.join(ROOT, 'natives', crypto.createHash('sha1').update(inst.path).digest('hex').slice(0, 12));
  await unpackNatives(nativeJars, natives);
  const gameAssets = await legacyAssets(index, game.assetIndex.id, inst.path);
  const logging = await loggingConfig(game);

  // The game jar itself, or (old Forge) a copy with the loader's patches merged in.
  let gameJar = path.join(versionDir, client.filename);
  if (jarMods.length) {
    const patched = path.join(versionDir, `${inst.gameVersion}-${inst.loader}-${String(profile.version).replace(/[^\w.-]/g, '_')}.jar`);
    if (!fs.existsSync(patched)) await mergeJars(gameJar, jarMods.map((j) => path.join(j.dir, j.filename)), patched);
    gameJar = patched;
  }

  // Extra Java options the loader needs.
  const jvm = [];
  const built = []; // jars the loader makes for itself on the first start
  const installer = extras.find((e) => e.name.endsWith(':installer'));
  if (installer) {
    // ForgeWrapper: where the libraries are, which installer to run, and which game jar to patch.
    jvm.push(`-Dforgewrapper.librariesDir=${libDir}`, `-Dforgewrapper.installer=${path.join(installer.item.dir, installer.item.filename)}`, `-Dforgewrapper.minecraft=${gameJar}`);
    if (systemZlibIsNg()) jvm.push('-Dforgewrapper.skipHashCheck=true');
    // Newer Forge lists the patched game jar, which its installer steps produce on the first
    // start, among its libraries. It cannot be downloaded, so the metadata leaves it out;
    // it still has to be on the classpath, ahead of the unpatched game.
    try {
      const zip = openZip(path.join(installer.item.dir, installer.item.filename));
      try {
        const entry = zip.entries.get('version.json');
        for (const lib of arr(entry && JSON.parse(zip.read(entry).toString('utf8')).libraries)) {
          if (lib && /^net\.(minecraftforge|neoforged):[\w.-]+:[\w.-]+:client$/.test(String(lib.name))) built.push(inside(libDir, mavenPath(lib.name)));
        }
      } finally {
        zip.close();
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BAD_NAME') throw e;
    }
  } else if (profile && profile.prism) {
    // Old Forge checks that the game jar is untouched and stops if it is not sure.
    jvm.push('-Dfml.ignoreInvalidMinecraftCertificates=true', '-Dfml.ignorePatchDiscrepancies=true');
    // Forge up to 1.5.2 takes the game folder from this setting, not from the command line.
    if (jarMods.length) jvm.push(`-Dminecraft.applet.TargetDirectory=${inst.path}`);
  }

  if (installer) {
    const wrapper = [...libs].find(([key]) => key === 'io.github.zekerzhayard:ForgeWrapper');
    const done = `${path.join(installer.item.dir, installer.item.filename)}.installed`;
    if (wrapper && (!fs.existsSync(done) || built.some((f) => !fs.existsSync(f)))) {
      await installForge(java, path.join(wrapper[1].dir, wrapper[1].filename), jvm, profile.gameLine, `${PRISM_LOADERS[inst.loader] || 'the loader'} ${profile.version}`);
      await fsp.writeFile(done, new Date().toISOString());
    }
  }

  // Versions up to 1.5.2 work out where their files go from the home folder, and write a log
  // there before they are told the game folder. Giving them the game folder as "home"
  // keeps that stray file inside the instance instead of in the real ~/.minecraft.
  // (On Windows they go by the APPDATA setting instead, which is given to the game likewise.)
  const env = {};
  if (index.map_to_resources) {
    jvm.push(`-Duser.home=${inst.path}`);
    if (platform.WIN) env.APPDATA = inst.path;
  }

  if (inst.loader === 'forge' && FORGE_WAYLAND_CRASH.includes(inst.gameVersion) && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')) {
    await disableForgeEarlyWindow(inst.path);
  }

  const classpath = [...built, ...[...libs.values()].map((l) => path.join(l.dir, l.filename)), gameJar];
  return { game, profile, java, classpath, natives, gameAssets, logging, jvm, env };
}

function launchArgs({ game, profile, classpath, natives, gameAssets, logging, jvm }, inst, session) {
  const values = {
    auth_player_name: session.name,
    auth_uuid: session.uuid,
    auth_access_token: session.token,
    auth_session: `token:${session.token}:${session.uuid}`, // what versions before 1.7 are given
    auth_xuid: '',
    clientid: '',
    user_type: session.offline ? 'legacy' : 'msa',
    user_properties: '{}',
    version_name: inst.gameVersion,
    version_type: game.type || 'release',
    game_directory: inst.path,
    assets_root: path.join(ROOT, 'assets'),
    game_assets: gameAssets || path.join(ROOT, 'assets'),
    assets_index_name: game.assetIndex.id,
    natives_directory: natives,
    launcher_name: 'modion',
    launcher_version: require('../package.json').version,
    classpath: classpath.join(path.delimiter),
  };
  const fill = (s) => String(s).replace(/\$\{(\w+)\}/g, (m, k) => (Object.hasOwn(values, k) ? values[k] : ''));
  const expand = (list) => arr(list).flatMap((a) => {
    if (typeof a === 'string') return [fill(a)];
    if (!a || !allowed(a.rules)) return [];
    return (Array.isArray(a.value) ? a.value : [a.value]).filter((v) => typeof v === 'string').map(fill);
  });
  // Up to 1.12.2 the game's own arguments are one line of text, and the Java ones are implied.
  const words = (line) => String(line || '').split(/\s+/).filter(Boolean).map(fill);
  const modern = Boolean(game.arguments);
  const own = inst.settings || {};
  const memory = own.memory || defaultMemory();
  return [
    // The memory setting, unless the instance's own Java arguments already say.
    ...(setsMemory(own.jvmArgs) ? [] : [`-Xmx${memory}M`, `-Xms${Math.min(512, memory)}M`]),
    '-Dlog4j2.formatMsgNoLookups=true',
    ...(logging ? [logging] : []),
    ...(modern ? expand(game.arguments.jvm) : [`-Djava.library.path=${natives}`, '-cp', values.classpath]),
    ...expand(profile && profile.arguments && profile.arguments.jvm),
    ...jvm,
    ...splitArgs(own.jvmArgs), // the instance's own Java arguments go last, so they win
    (profile && profile.mainClass) || game.mainClass,
    // A loader may replace the game's argument line with its own (Forge from 1.13 on does).
    ...(profile && profile.gameLine ? words(profile.gameLine) : modern ? expand(game.arguments.game) : words(game.minecraftArguments)),
    ...expand(profile && profile.arguments && profile.arguments.game),
    ...arr(profile && profile.tweakers).flatMap((t) => ['--tweakClass', t]),
  ];
}

// Where the output of a game Modion started itself is written.
const outputLog = (gameDir) => path.join(ROOT, 'logs', `${crypto.createHash('sha1').update(gameDir).digest('hex').slice(0, 12)}.log`);

const running = new Set(); // instance paths being prepared or just started
const live = new Map();    // instance path -> the process of its game, started from here and still open
// Is the game for this folder being started or running (as far as this session knows)?
const inUse = (gameDir) => running.has(gameDir) || live.has(gameDir);
const isLive = (gameDir) => live.has(gameDir);
let changed = () => {};
// Calls back whenever a game started from here opens or closes.
const onChange = (cb) => { changed = cb; };

// Remembers a started game until its process ends.
function track(gameDir, child) {
  live.set(gameDir, child);
  changed();
  child.once('exit', () => {
    if (live.get(gameDir) !== child) return;
    live.delete(gameDir);
    changed();
  });
}

// Ends a game process and whatever it started (the game runs as the head of its own process group).
function kill(child, sig) {
  if (process.platform === 'win32') {
    require('child_process').execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
}

// Stops the game of this folder: asks first, and insists a few seconds later if it is still there.
function stop(gameDir) {
  const child = live.get(gameDir);
  if (!child) return false;
  kill(child, 'SIGTERM');
  const timer = setTimeout(() => { if (live.get(gameDir) === child) kill(child, 'SIGKILL'); }, 4000);
  if (timer.unref) timer.unref();
  return true;
}

// "-Xmx2G -Dname="two words"" -> ['-Xmx2G', '-Dname=two words']
function splitArgs(line) {
  const out = [];
  String(line || '').replace(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g, (word) => { out.push(word.replace(/"([^"]*)"|'([^']*)'/g, (m, a, b) => a ?? b)); return ''; });
  return out;
}

// "NAME=value" lines -> { NAME: 'value' }; anything else is ignored.
function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/\r$/, '');
  }
  return env;
}

// Do these Java arguments set the memory themselves? Then the memory setting stays out of it.
const setsMemory = (line) => splitArgs(line).some((a) => /^-Xm[xs]/.test(a));
// What Modion gives the game when nothing is chosen: half the computer's memory, 2 to 4 GB.
const defaultMemory = () => Math.max(2, Math.min(4, Math.floor(os.totalmem() / 2 ** 30 / 2))) * 1024;

// Which Java the game's metadata asks for, if that version has been looked at before.
function wantedJava(gameVersion) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'versions', gameVersion, `${gameVersion}.json`), 'utf8')).javaVersion;
    return Number(j && j.majorVersion) || 8;
  } catch {
    return null;
  }
}

// session: { name, uuid, token, offline? }. Resolves once the game process has stayed up
// for a few seconds; a crash on startup is reported with the end of its log.
async function launch(inst, session, emit) {
  if (!supports(inst)) throw new ApiError('Modion cannot start this instance directly.', 'UNSUPPORTED');
  if (live.has(inst.path)) throw new ApiError(`"${inst.name}" is already running.`, 'BUSY');
  if (running.has(inst.path)) throw new ApiError(`"${inst.name}" is already being started.`, 'BUSY');
  running.add(inst.path);
  const job = { id: crypto.randomUUID(), title: inst.name, filename: `Minecraft ${inst.gameVersion}`, saved: true };
  let last = 0;
  const progress = (received, total) => {
    const now = Date.now();
    if (now - last < 100 && received < total) return;
    last = now;
    emit({ ...job, state: 'progress', received, total });
  };
  try {
    let ready;
    try {
      ready = await prepare(inst, progress);
    } finally {
      emit({ ...job, state: 'done' });
    }
    const args = launchArgs(ready, inst, session);
    const logFile = outputLog(inst.path);
    await fsp.mkdir(path.dirname(logFile), { recursive: true });
    const log = fs.openSync(logFile, 'w');
    let child;
    try {
      child = require('child_process').spawn(ready.java, args, { cwd: inst.path, env: { ...process.env, ...ready.env, ...parseEnv(inst.settings && inst.settings.env) }, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    } finally {
      fs.closeSync(log);
    }
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ up: true }), 6000);
      child.once('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    if (!outcome.up) {
      let tail = '';
      try { tail = (await fsp.readFile(logFile, 'utf8')).trim().split('\n').slice(-4).join(' | ').slice(-400); } catch {}
      throw new ApiError(`Minecraft stopped right after starting (${outcome.error || `exit ${outcome.code ?? outcome.signal}`}). ${tail}`.trim(), 'CRASHED');
    }
    child.unref();
    track(inst.path, child);
    return { label: 'Modion', play: true, pid: child.pid, log: logFile };
  } finally {
    running.delete(inst.path);
  }
}

// The profile ID Minecraft itself gives an offline player of this name.
function offlineSession(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return { name, uuid: h.toString('hex'), token: '0', offline: true };
}

module.exports = { splitArgs, parseEnv, setsMemory, defaultMemory, wantedJava, supports, launch, inUse, isLive, onChange, track, stop, outputLog, offlineSession, fetchAll, versionJson, ROOT };
