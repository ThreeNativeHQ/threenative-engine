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
/**
 * The two web engines: the single-thread module, and the `-pthread` one a cross-origin-isolated page
 * loads (PRD-752 phase 4, CMake `TN_WEB_THREADS`). Each names its sources in its own stamp.
 */
export const MODULES = ["tn-native-engine-web", "tn-native-engine-web-threads"];
const moduleFile = (name) => `build/web/${name}.wasm`;
const stampFile = (name) => `build/web/${name}.sources`;
export const STAMP = stampFile(MODULES[0]);

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

export function writeEngineStamp(root = ROOT, name = MODULES[0]) {
  if (!MODULES.includes(name)) throw new Error(`TN_WEB_ENGINE_STAMP_MODULE: ${name} is not one of ${MODULES.join(", ")}`);
  writeFileSync(join(root, stampFile(name)), `${engineSourceHash(root)}\n`);
}

/**
 * Throws unless each built module's stamp names the sources in `root`. A tree with no module built
 * passes: packing without one is `assertWebEngineBuilt`'s and the CI engine action's refusal, and
 * jobs that pack only for the other packages' files have no engine to vouch for.
 */
export function assertEngineStampCurrent(root = ROOT) {
  let current;
  for (const name of MODULES) {
    const module = moduleFile(name);
    if (!existsSync(join(root, module))) continue;
    const stamp = join(root, stampFile(name));
    const rebuild = "rebuild both in packages/runtime-native: node scripts/build-wasm.mjs (presets wasm and wasm-threads)";
    if (!existsSync(stamp))
      throw new Error(
        `TN_PACK_WEB_ENGINE_UNSTAMPED: ${relative(process.cwd(), stamp)} is missing, so nothing says which sources the packed web engine was built from; ${rebuild}`,
      );
    const built = readFileSync(stamp, "utf8").trim();
    current ??= engineSourceHash(root);
    if (built !== current)
      throw new Error(
        `TN_PACK_WEB_ENGINE_STALE: ${module} was built from other engine sources (${built.slice(0, 12)}) than this tree holds (${current.slice(0, 12)}); a pack would ship the older engine; ${rebuild}`,
      );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    if (mode === "--write") writeEngineStamp(ROOT, process.argv[3]);
    else if (mode === "--check") assertEngineStampCurrent();
    else throw new Error("usage: web-engine-stamp.mjs --write [module] | --check");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
