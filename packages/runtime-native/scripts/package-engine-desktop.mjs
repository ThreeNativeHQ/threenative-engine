#!/usr/bin/env node
// Desktop package for a game with `engine: "native"`: the V8 engine player, the game bundled on the
// engine's own three, its cooked assets and its built UI, in one directory with a launcher. The
// player reads `native/assets.tnpk` and `ui/index.html` beside the bundle, so the layout is the contract.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleNativeEngine, cookNativeEngineAssets } from "./bundle-native-engine.mjs";

const PLAYER = "tn-native-engine-player-v8";

/** The launcher: the window opens at the game's configured size, and every argument reaches the player. */
export function launcher(width, height) {
  return [
    "#!/bin/sh",
    'DIR=$(cd "$(dirname "$0")" && pwd)',
    `: "\${TN_PLAYER_WIDTH:=${width}}"`,
    `: "\${TN_PLAYER_HEIGHT:=${height}}"`,
    "export TN_PLAYER_WIDTH TN_PLAYER_HEIGHT",
    `exec "$DIR/${PLAYER}" "$DIR/game.js" "$@"`,
    "",
  ].join("\n");
}

/**
 * Writes `output` as a directory: `<name>` (launcher), the player, `game.js`, `native/assets.tnpk`
 * and, for a web UI, `ui/`. `bundle` and `cook` are the engine bundler's, injectable for the unit test.
 */
export async function packageEngineDesktop(
  { project, entry, player, ui, output, width = 1280, height = 720 },
  { bundle = bundleNativeEngine, cook = cookNativeEngineAssets } = {},
) {
  if (!player || !existsSync(player)) {
    throw new Error(
      `TN_ENGINE_PLAYER_MISSING: engine "native" on desktop needs the engine player (${PLAYER}) at ${player ?? "(not set)"}. ` +
        "Build it (cmake --preset tn-linux -B build/tn-engine-ui -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DTN_ENGINE_PLAYER_UI_OVERLAY=ON) and set THREENATIVE_ENGINE_PLAYER.",
    );
  }
  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });
  const outfile = join(output, "game.js");
  await bundle({ entry, outfile });
  await cook({ project, outfile });
  copyFileSync(player, join(output, PLAYER));
  chmodSync(join(output, PLAYER), 0o755);
  if (ui) {
    if (!existsSync(join(ui, "index.html")))
      throw new Error(`TN_UI_BUNDLE_MISSING: ${ui} has no index.html, which is the page the overlay loads.`);
    cpSync(ui, join(output, "ui"), { recursive: true });
  }
  const start = join(output, basename(output));
  writeFileSync(start, launcher(width, height));
  chmodSync(start, 0o755);
  console.log(`ThreeNative desktop artifact: ${output}`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--project", "--entry", "--player", "--ui", "--output", "--width", "--height"].includes(args[i]) || !args[i + 1] || flags.has(args[i]))
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
      width: flags.has("--width") ? Number(flags.get("--width")) : undefined,
      height: flags.has("--height") ? Number(flags.get("--height")) : undefined,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
