#!/usr/bin/env node
// Desktop package for a game with `engine: "native"`: the V8 engine player, the game bundled on the
// engine's own three, its cooked assets and its built UI, in one directory with a launcher. The
// player reads `native/assets.tnpk` and `ui/index.html` beside the bundle, so the layout is the contract.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleNativeEngine, cookNativeEngineAssets } from "./bundle-native-engine.mjs";

const PLAYER = "tn-native-engine-player-v8";

/** The launcher: the window opens with the game's title and size, and every argument reaches the player. */
export function launcher(width, height, title) {
  return [
    "#!/bin/sh",
    'DIR=$(cd "$(dirname "$0")" && pwd)',
    ...(title ? [`TN_PLAYER_TITLE=\${TN_PLAYER_TITLE:-'${title.replaceAll("'", "'\\''")}'}`, "export TN_PLAYER_TITLE"] : []),
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
  { project, entry, player, ui, output, buildReceipt, width = 1280, height = 720, title },
  { bundle = bundleNativeEngine, cook = cookNativeEngineAssets } = {},
) {
  if (!player || !existsSync(player)) {
    throw new Error(
      `TN_ENGINE_PLAYER_MISSING: engine "native" on desktop needs the engine player (${PLAYER}) at ${player ?? "(not set)"}. ` +
        "Build it (cmake --preset tn-linux -B build/tn-engine-ui -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DTN_ENGINE_PLAYER_UI_OVERLAY=ON) and set THREENATIVE_ENGINE_PLAYER, or set engine: \"legacy\" in threenative.config.ts to package with the legacy host.",
    );
  }
  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });
  const outfile = join(output, "game.js");
  const bundled = await bundle({ entry, outfile });
  await cook({ project, outfile });
  copyFileSync(player, join(output, PLAYER));
  chmodSync(join(output, PLAYER), 0o755);
  if (ui) {
    if (!existsSync(join(ui, "index.html")))
      throw new Error(`TN_UI_BUNDLE_MISSING: ${ui} has no index.html, which is the page the overlay loads.`);
    cpSync(ui, join(output, "ui"), { recursive: true });
  }
  const start = join(output, basename(output));
  writeFileSync(start, launcher(width, height, title));
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--project", "--entry", "--player", "--ui", "--output", "--build-receipt", "--width", "--height", "--title"].includes(args[i]) || !args[i + 1] || flags.has(args[i]))
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
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
