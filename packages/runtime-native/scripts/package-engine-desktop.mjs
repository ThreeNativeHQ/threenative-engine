#!/usr/bin/env node
// Desktop package for a game with `engine: "threenative"`: the V8 engine player, the game bundled on the
// engine's own three, its cooked assets and its built UI, in one directory with a launcher. The
// player reads `native/assets.tnpk` and `ui/index.html` beside the bundle, so the layout is the contract.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { readFileSync, readdirSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleNativeEngine, cookNativeEngineAssets } from "./bundle-native-engine.mjs";

// A Windows build has to contain a runnable image: the same bytes under the `.exe` name the
// operating system will spawn, and the path the playtest launcher resolver looks for there.
const PLAYER = process.platform === "win32" ? "tn-native-engine-player-v8.exe" : "tn-native-engine-player-v8";

/**
 * The launcher: the window opens with the game's title and size, the player takes the game's CPU priority
 * (`display.priority`, PRD-859), the player opens fullscreen unless the game sets `display.fullscreen: false`,
 * and every argument reaches the player (`--windowed` and `--fullscreen` included).
 */
export function launcher(width, height, title, priority = "game", fullscreen = true) {
  if (priority !== "game" && priority !== "normal") throw new Error(`TN_ENGINE_PACKAGE_ARGS: --priority must be game or normal, got ${priority}`);
  return [
    "#!/bin/sh",
    'DIR=$(cd "$(dirname "$0")" && pwd)',
    ...(title ? [`TN_PLAYER_TITLE=\${TN_PLAYER_TITLE:-'${title.replaceAll("'", "'\\''")}'}`, "export TN_PLAYER_TITLE"] : []),
    `: "\${TN_PLAYER_WIDTH:=${width}}"`,
    `: "\${TN_PLAYER_HEIGHT:=${height}}"`,
    `: "\${TN_PLAYER_PRIORITY:=${priority}}"`,
    `: "\${TN_PLAYER_FULLSCREEN:=${fullscreen ? 1 : 0}}"`,
    "export TN_PLAYER_WIDTH TN_PLAYER_HEIGHT TN_PLAYER_PRIORITY TN_PLAYER_FULLSCREEN",
    `exec "$DIR/${PLAYER}" "$DIR/game.js" "$@"`,
    "",
  ].join("\n");
}

/**
 * `launch.cfg`, beside `game.js`: the game's window and priority as `KEY=value` lines the player reads
 * itself at start (v8_main.cpp), so every way of starting the game applies them: the launchers here,
 * the store launcher, which runs the player directly, and a double-click on the player. A value
 * already in the environment or a `--fullscreen`/`--windowed` argument wins over the file.
 */
export function launchConfig({ width = 1280, height = 720, title, priority = "game", fullscreen = true, maximized = false, resizable = true } = {}) {
  if (priority !== "game" && priority !== "normal") throw new Error(`TN_ENGINE_PACKAGE_ARGS: --priority must be game or normal, got ${priority}`);
  return [
    `TN_PLAYER_WIDTH=${width}`,
    `TN_PLAYER_HEIGHT=${height}`,
    // One line per key: a line break in the title would start a second key.
    ...(title ? [`TN_PLAYER_TITLE=${title.replace(/[\r\n]+/gu, " ")}`] : []),
    `TN_PLAYER_PRIORITY=${priority}`,
    `TN_PLAYER_FULLSCREEN=${fullscreen ? 1 : 0}`,
    `TN_PLAYER_MAXIMIZED=${maximized ? 1 : 0}`,
    `TN_PLAYER_RESIZABLE=${resizable ? 1 : 0}`,
    "",
  ].join("\n");
}

/**
 * Writes `output` as a directory: `<name>` (launcher), the player, `game.js`, `native/assets.tnpk`
 * and, for a web UI, `ui/`. `bundle` and `cook` are the engine bundler's, injectable for the unit test.
 */
/** A path with every symlink resolved, including the ones above a file that does not exist yet. */
function resolvedPath(target) {
  const absolute = resolve(target);
  const rest = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** Whether two paths name the same file, through symlinks and through a file not yet written. */
function samePath(left, right) {
  return resolvedPath(left) === resolvedPath(right);
}

export async function packageEngineDesktop(
  { project, entry, player, ui, output, buildReceipt, width = 1280, height = 720, title, priority = "game", fullscreen = true, maximized = false, resizable = true, gameName, engine },
  { bundle = bundleNativeEngine, cook = cookNativeEngineAssets } = {},
) {
  // An older CLI passes the canonical cache path without ever downloading it: this packager can
  // fill that cache itself, through the same locked entry point a build uses, instead of sending
  // the reader to a recipe for a binary the release publishes.
  // Only the package's own cache path: an explicit `--player` elsewhere is the caller's file, and
  // downloading a player into a different directory would still leave packaging to fail.
  const canonicalPlayer = join(
    fileURLToPath(new URL('../prebuilt/', import.meta.url)),
    `${process.platform}-${process.arch}`,
    PLAYER,
  );
  // A snapshot this packager took, and where it lives: removed in `finally` however packaging ends,
  // because a cross-filesystem hard link fell back to a full 118 MiB copy.
  let snapshot;
  try {
  // A canonical cache path is always passed through the verifier: a file that exists is not a file
  // that verifies, and an install killed before writing its receipt leaves exactly that. Compared
  // through symlinks, because pnpm hands the CLI a linked `node_modules/@threenative/...` path.
  if (player && !process.env.THREENATIVE_ENGINE_PLAYER &&
      samePath(player, canonicalPlayer)) {
    // `new URL` needs no import of its own and resolves beside this file however it is symlinked.
    const installer = new URL('./install-prebuilt.mjs', import.meta.url);
    if (existsSync(installer)) {
      const { ensureNativeBinary } = await import(installer.href);
      if (typeof ensureNativeBinary === 'function') {
        // Verified and snapshotted under the lock, into a directory the packager can write even
        // when the install itself is read-only.
        player = await ensureNativeBinary({
          enginePlayer: true,
          stageDir: tmpdir(),
          stagePrivate: true,
        });
        // The snapshot is this packager's own copy: it is removed however packaging ends.
        snapshot = player;
      }
    }
  }
  if (!player || !existsSync(player)) {
    throw new Error(
      `TN_ENGINE_PLAYER_MISSING: engine "threenative" on desktop needs the engine player (${PLAYER}) at ${player ?? "(not set)"}. The first \`threenative build --target desktop\` downloads it (about 118 MiB, checksum-verified) unless THREENATIVE_ENGINE_PLAYER names a local file; build one from an engine checkout: run \`node scripts/download-deps.mjs\` and \`node scripts/build-native-physics.mjs --desktop\` first (every desktop preset enables native physics), and for a Linux or Windows web HUD \`node scripts/build-native-ui-overlay.mjs\` (CMake needs that library before it accepts the flag), then \`cmake --preset <platform> -B build/tn-engine-ui -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DTN_ENGINE_PLAYER_UI_OVERLAY=ON\`; on macOS or with a \"native\" HUD use the same command without the overlay flag (a web HUD on macOS needs engine: \"threejs\"), then \`cmake --build build/tn-engine-ui --target tn-native-engine-player-v8\` (the legacy host's \`native:build\` does not produce it), or set engine: "threejs" in threenative.config.ts to package with the legacy host.`,
    );
  }
  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });
  const outfile = join(output, "game.js");
  const bundled = await bundle({ entry, outfile, gameName, engine });
  await cook({ project, outfile });
  copyFileSync(player, join(output, PLAYER));
  chmodSync(join(output, PLAYER), 0o755);
  if (ui) {
    if (!existsSync(join(ui, "index.html")))
      throw new Error(`TN_UI_BUNDLE_MISSING: ${ui} has no index.html, which is the page the overlay loads.`);
    cpSync(ui, join(output, "ui"), { recursive: true });
  }
  // Windows cannot run the POSIX launcher, and the raw player exits without its bundle: a `.cmd`
  // beside the player is what a person double-clicking the folder can actually start.
  const windows = process.platform === "win32";
  const start = windows ? join(output, `${basename(output)}.cmd`) : join(output, basename(output));
  // The player reads the settings from `launch.cfg` itself, so the batch file only starts it: cmd
  // would mangle a title with `%` or `^`, and a `set` here would override the person's own variable.
  const settings = launchConfig({ width, height, title, priority, fullscreen, maximized, resizable });
  const startContents = windows
    ? ["@echo off", `"%~dp0${PLAYER}" "%~dp0game.js" %*`, ""].join("\r\n")
    : launcher(width, height, title, priority, fullscreen);
  // Write the launcher exclusively: on a case-insensitive filesystem a name that differs only in
  // case is the packaged player, and opening it for writing would destroy the binary. Existence is
  // the question the filesystem answers, not a string comparison.
  try {
    writeFileSync(start, startContents, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `TN_ENGINE_LAUNCHER_COLLIDES: the launcher path ${start} is already taken by the packaged player (${PLAYER}). Rename the game or its desktop output directory.`,
      );
    throw error;
  }
  writeFileSync(join(output, "launch.cfg"), settings, { encoding: "utf8", flag: "wx" });
  chmodSync(start, 0o755);
  if (buildReceipt) {
    const receipt = JSON.parse(readFileSync(buildReceipt, "utf8"));
    if (receipt.buildProtocol !== "midway-clean-build-v1" || !/^[a-f0-9]{40}$/.test(bundled?.engineCommit)
      || receipt.engineCommit !== bundled.engineCommit
      || receipt.playerSha256 !== createHash("sha256").update(readFileSync(join(output, PLAYER))).digest("hex"))
      throw new Error("TN_ENGINE_PROVENANCE_INVALID: rebuild packages/player from a clean matching engine checkout");
    const artifacts = {};
    const visit = (dir, prefix = "") => {
      for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const relative = prefix + item.name;
        if (item.isDirectory()) visit(join(dir, item.name), `${relative}/`);
        else if (item.isFile()) artifacts[relative] = createHash("sha256").update(readFileSync(join(dir, item.name))).digest("hex");
        else throw new Error(`TN_ENGINE_PROVENANCE_SYMLINK: ${relative}`);
      }
    };
    visit(output);
    const directorySha256 = createHash("sha256").update(Object.entries(artifacts).map(([file, digest]) => `${file} ${digest}`).join("\n")).digest("hex");
    writeFileSync(join(output, "midway-provenance.json"), JSON.stringify({ buildProtocol: receipt.buildProtocol, engineCommit: bundled.engineCommit, artifacts, directorySha256 }));
  }
  console.log(`ThreeNative desktop artifact: ${output}`);
  return output;
  } finally {
    if (snapshot !== undefined) rmSync(snapshot, { force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--project", "--entry", "--player", "--ui", "--output", "--build-receipt", "--width", "--height", "--title", "--priority", "--fullscreen", "--maximized", "--resizable", "--game-name", "--engine-name"].includes(args[i]) || !args[i + 1] || flags.has(args[i]))
      throw new Error(`TN_ENGINE_PACKAGE_ARGS: invalid or repeated option ${args[i]}`);
    flags.set(args[i], args[i + 1]);
  }
  try {
    await packageEngineDesktop({
      project: flags.get("--project"),
      entry: flags.get("--entry"),
      player: flags.get("--player"),
      ui: flags.get("--ui"),
      output: flags.get("--output"),
      buildReceipt: flags.get("--build-receipt"),
      width: flags.has("--width") ? Number(flags.get("--width")) : undefined,
      height: flags.has("--height") ? Number(flags.get("--height")) : undefined,
      title: flags.get("--title"),
      gameName: flags.get("--game-name"),
      engine: flags.get("--engine-name"),
      priority: flags.get("--priority"),
      fullscreen: flags.has("--fullscreen") ? flags.get("--fullscreen") !== "false" : undefined,
      maximized: flags.has("--maximized") ? flags.get("--maximized") === "true" : undefined,
      resizable: flags.has("--resizable") ? flags.get("--resizable") !== "false" : undefined,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
