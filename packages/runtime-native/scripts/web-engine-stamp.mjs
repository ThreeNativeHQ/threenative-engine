import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The packed web engine names the sources it was built from.
 *
 * `build/web` is not rebuilt by `pnpm build` or `pnpm pack`, so a tarball packed after an engine
 * commit carried the Wasm of an older one, and every consumer of it ran the older engine while
 * reading as HEAD (2026-10-24: Lantern Vale declined `notWorthwhile` on the RTX and the laptop from
 * a 12:23 build/web packed at 14:21, while the same scene projected on HEAD's engine on both GPUs).
 * The Wasm build writes the hash of its sources beside the module; `prepack` refuses a module whose
 * hash no longer matches the tree it would be packed from.
 *
 * ponytail: the hash covers the engine C++ and headers the web target compiles from, minus the V8
 * player; a CMake flag change is not in it (CI's cache key covers that case).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["src/engine", "include"];
const SKIPPED = new Set(["src/engine/player"]);
const MODULE = "build/web/tn-native-engine-web.wasm";
export const STAMP = "build/web/tn-native-engine-web.sources";

function files(root, directory) {
  const found = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED.has(path)) found.push(...files(root, path));
    } else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** sha256 over each source's path and bytes, in path order. */
export function engineSourceHash(root = ROOT) {
  const hash = createHash("sha256");
  const paths = SOURCES.flatMap((source) => files(root, source)).sort();
  for (const path of paths) {
    hash.update(`${path}\0`);
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function writeEngineStamp(root = ROOT) {
  writeFileSync(join(root, STAMP), `${engineSourceHash(root)}\n`);
}

/**
 * Throws unless the built module's stamp names the sources in `root`. A tree with no module built
 * passes: packing without one is `assertWebEngineBuilt`'s and the CI engine action's refusal, and
 * jobs that pack only for the other packages' files have no engine to vouch for.
 */
export function assertEngineStampCurrent(root = ROOT) {
  if (!existsSync(join(root, MODULE))) return;
  const stamp = join(root, STAMP);
  const rebuild =
    "rebuild it in packages/runtime-native: cmake --preset wasm && cmake --build build/wasm --target tn-native-engine-web";
  if (!existsSync(stamp))
    throw new Error(
      `TN_PACK_WEB_ENGINE_UNSTAMPED: ${relative(process.cwd(), stamp)} is missing, so nothing says which sources the packed web engine was built from; ${rebuild}`,
    );
  const built = readFileSync(stamp, "utf8").trim();
  const current = engineSourceHash(root);
  if (built !== current)
    throw new Error(
      `TN_PACK_WEB_ENGINE_STALE: ${MODULE} was built from other engine sources (${built.slice(0, 12)}) than this tree holds (${current.slice(0, 12)}); a pack would ship the older engine; ${rebuild}`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    if (mode === "--write") writeEngineStamp();
    else if (mode === "--check") assertEngineStampCurrent();
    else throw new Error("usage: web-engine-stamp.mjs --write | --check");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
