// The strict native build (PRD-530, decision 11): a TypeScript game compiled ahead of time by the
// pinned Perry and linked against the engine's prebuilt static archives, with the identity manifest
// beside the executable. The compiler and the engine are inputs, never rebuilt here: a missing
// engine archive is refused, not built.
//
// Perry compiles the whole module graph in one invocation and links it itself, so the game project
// is staged the way the corpus stages a case (tools/native-typescript/run-corpus.mjs): the game and
// its modules under `src/`, the three facade as the `three` package, and the Perry adapter package
// whose manifest names the shim archive, the engine archives and the C++ runtime Perry links.
//
// Each step records the sha256 of its inputs in `<outDir>/.strict-cache/<step>.sha256` and is
// skipped when they match the last build, so a game-source-only edit restages and re-runs Perry
// (Perry's own per-module cache recompiles only the changed module and relinks), and nothing else
// runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeFor } from "../../../tools/native-typescript/three-bridge.mjs";
import { stageSharedFacade, PERRY_TRANSPORT } from "../../../tools/native-typescript/perry-facade.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const THREE_DIR = path.join(REPO, "tools", "native-typescript", "three");
const ADAPTER_PACKAGE = "tn-three-adapter";
const NATIVE = path.join(REPO, "packages", "runtime-native");
export const ENGINE_LIBS = [
  "tn_engine_abi",
  "tn_engine_bindings",
  "tn_engine_shader",
  "tn_engine_animation",
  "tn_engine_scene",
  "tn_engine_foundation",
];
/** Perry's strict dynamic-code controls (decision 11), the same flags the corpus compiles with. */
export const STRICT_FLAGS = ["--strict-eval", "--strict-dynamic-import", "--strict-unimplemented"];

/** Perry's warning for an import it could not resolve; the link then fails on a bare symbol. */
const UNRESOLVED_IMPORT = /Could not resolve import '([^']+)' from /gu;

/**
 * The first error of a tool run's output, or undefined when it succeeded. Perry warns about each
 * import it cannot resolve and only fails later at the link, naming one bare symbol
 * (`undefined reference to 'defineGame'`). When imports were unresolved that is the real cause, so
 * it is named first with every specifier, ahead of the link line it produced.
 */
export function summarizeCompilerOutput(output, status, tool = "tool") {
  const firstError = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^Error:|error\[|error:|undefined reference/.test(line));
  if (status === 0 && !firstError) return undefined;
  const specifiers = [...new Set([...output.matchAll(UNRESOLVED_IMPORT)].map((match) => match[1]))];
  if (specifiers.length > 0 && !firstError?.startsWith("Error: Could not resolve namespace import"))
    return `TN_STRICT_UNRESOLVED_IMPORT: ${specifiers.length} import(s) did not resolve: ${specifiers.join(", ")}${firstError ? ` (${firstError})` : ""}`;
  return firstError ?? `${tool} exited ${status}: ${output.split("\n")[0]}`;
}

function defaultExec(tool, args, env, opts = {}) {
  const run = spawnSync(tool, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
    cwd: opts.cwd,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  return summarizeCompilerOutput(output, run.status, path.basename(tool));
}

/** Directories at a game's root that hold no source Perry compiles. */
const NOT_GAME_SOURCE = new Set(["node_modules", "dist", "dist-native", ".git", "artifacts", "public", "assets", "docs", "playtests", "native-playtests"]);

/** The TypeScript, JavaScript and JSON files of a game's source tree, as paths relative to `root`. */
export function listGameSources(root) {
  const found = [];
  const walk = (directory, top) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (top && NOT_GAME_SOURCE.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full, false);
      else if (/\.(?:tsx?|m?js|json)$/u.test(entry.name) && entry.name !== "package.json") found.push(path.relative(root, full));
    }
  };
  walk(root, true);
  return found;
}

function digest(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(typeof part === "string" ? part : Buffer.from(part)).update("\0");
  return hash.digest("hex");
}

/** The packages the staged project resolves a game's `three` and adapter imports from. */
function writeStagedPackage(dir, name, main) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name, version: "0.185.1", main, types: main }, undefined, 2)}\n`,
  );
}

/** Adds the link fields to the staged adapter's manifest; the adapter's own stays pathless. */
function writeAdapterManifest(packageDir, libDirs, libs) {
  const manifestPath = path.join(packageDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const linux = manifest.perry.nativeLibrary.targets.linux;
  linux.libDirs = libDirs;
  linux.libs = libs;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
}

/**
 * Builds `<outDir>/<name>` from `entry` (and the relative modules it imports, `modules`), linked
 * with the three facade, its shim and hooks, and the engine archives in `engineBuild`.
 * `sourceRoot`, when given, stages the game's whole source tree under `outDir` with its layout kept
 * (`entry` must lie inside it), so a game whose modules sit in folders keeps its relative imports.
 * `stageOnly` stops after staging, the shim and the hooks, before Perry runs: a caller that drives
 * Perry itself (the survey in compile-game.mjs) gets the project, the facade and the adapter.
 * `compiler` is the provisioned Perry: `{ binaryPath, identity }`, `identity` naming its version
 * and checksum. Returns the executable, the steps that ran, and the first errors (empty on success).
 */
export function buildStrict({
  name,
  entry,
  modules = [],
  sourceRoot,
  stageOnly = false,
  sharedFacade = false,
  outDir,
  engineBuild,
  compiler,
  triple = [],
  manifest = true,
  exec = defaultExec,
}) {
  const ran = [];
  const errors = [];
  const exe = path.join(outDir, name);
  engineBuild ??= process.env.TN_NATIVE_ENGINE_BUILD ?? path.join(NATIVE, "build", "tn-linux");
  const archives = ENGINE_LIBS.map((lib) => path.join(engineBuild, `lib${lib}.a`));
  const identityTool = path.join(engineBuild, "tn-native-engine-identity");
  for (const required of manifest ? [...archives, identityTool] : archives) {
    if (!fs.existsSync(required)) {
      errors.push(`TN_STRICT_ENGINE_MISSING: ${required}; build or install the engine first`);
      return { exe, ran, errors };
    }
  }
  const cache = path.join(outDir, ".strict-cache");
  fs.mkdirSync(cache, { recursive: true });
  const env = { ...process.env, PERRY_CACHE_DIR: path.join(outDir, ".perry") };
  const engineDigest = digest(archives.map((archive) => fs.readFileSync(archive)));
  const sharedBridge = sharedFacade ? bridgeFor({ engineBuild, render: true, shared: true }) : undefined;

  // Runs `work` unless the inputs digest matches the last successful run and every output exists.
  const step = (stepName, inputs, outputs, work) => {
    const keyFile = path.join(cache, `${stepName}.sha256`);
    const key = digest(inputs);
    if (outputs.every((output) => fs.existsSync(output)) && fs.existsSync(keyFile) && fs.readFileSync(keyFile, "utf8") === key)
      return;
    ran.push(stepName);
    const before = errors.length;
    work();
    if (errors.length === before) fs.writeFileSync(keyFile, key);
    else fs.rmSync(keyFile, { force: true });
  };
  const run = (tool, args, opts) => {
    const error = exec(tool, args, env, opts);
    if (error !== undefined) errors.push(error);
  };

  // The staged project: the game and its modules beside the `three`, `three-aot` and adapter
  // packages Perry resolves them from.
  const staged = path.join(outDir, "src");
  const tree = sourceRoot ? listGameSources(sourceRoot) : [];
  const stagedEntry = sourceRoot ? path.join(outDir, path.relative(sourceRoot, entry)) : path.join(staged, path.basename(entry));
  const facadeDir = path.join(outDir, "node_modules", "three");
  const aotDir = path.join(outDir, "node_modules", "three-aot");
  const adapterDir = path.join(outDir, "node_modules", sharedFacade ? PERRY_TRANSPORT : ADAPTER_PACKAGE);
  const bridgeDir = path.join(outDir, "three-bridge");
  const treeFiles = tree.map((file) => path.join(sourceRoot, file));
  const sources = [path.join(THREE_DIR, "three.ts"), path.join(THREE_DIR, "three-aot.ts"), ...modules, entry, ...treeFiles.filter((file) => file !== entry)];
  if (sharedFacade) {
    const root = path.join(REPO, "packages/three-native");
    sources.push(...listGameSources(root).map(file => path.join(root,file)),
      path.join(root,"perry/Cargo.toml"),path.join(root,"perry/src/lib.rs"),
      path.join(REPO,"tools/native-typescript/perry-facade.mjs"), sharedBridge.archive);
  }
  step(
    "typescript",
    [engineBuild, bridgeDir, String(sharedFacade), ...sources.map((file) => fs.readFileSync(file))],
    [stagedEntry, path.join(outDir, "package.json"), path.join(facadeDir, "three.ts"), path.join(adapterDir, "package.json")],
    () => {
      fs.mkdirSync(path.dirname(stagedEntry), { recursive: true });
      for (const file of modules) fs.copyFileSync(file, path.join(staged, path.basename(file)));
      // A file the game no longer has leaves the staged tree too, or Perry would keep compiling it.
      const manifestFile = path.join(cache, "tree.json");
      if (fs.existsSync(manifestFile))
        for (const old of JSON.parse(fs.readFileSync(manifestFile, "utf8")))
          if (!tree.includes(old)) fs.rmSync(path.join(outDir, old), { force: true });
      for (const file of tree) {
        fs.mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
        fs.copyFileSync(path.join(sourceRoot, file), path.join(outDir, file));
      }
      fs.writeFileSync(manifestFile, JSON.stringify(tree));
      fs.copyFileSync(entry, stagedEntry);
      writeStagedPackage(facadeDir, "three", "three.ts");
      fs.copyFileSync(path.join(THREE_DIR, "three.ts"), path.join(facadeDir, "three.ts"));
      writeStagedPackage(aotDir, "three-aot", "three-aot.ts");
      fs.copyFileSync(path.join(THREE_DIR, "three-aot.ts"), path.join(aotDir, "three-aot.ts"));
      fs.cpSync(path.join(THREE_DIR, "perry-adapter"), adapterDir, {
        recursive: true,
        filter: (source) => !source.includes(`${path.sep}target${path.sep}`),
      });
      writeAdapterManifest(adapterDir, [bridgeDir, engineBuild], [
        "tn-three-shim",
        ...ENGINE_LIBS,
        "stdc++",
        "m",
        "pthread",
        "dl",
      ]);
      fs.writeFileSync(
        path.join(outDir, "package.json"),
        `${JSON.stringify(
          {
            name: "tn-strict-game",
            version: "0.0.0",
            private: true,
            dependencies: {
              three: "file:node_modules/three",
              "three-aot": "file:node_modules/three-aot",
              [ADAPTER_PACKAGE]: `file:node_modules/${ADAPTER_PACKAGE}`,
            },
            perry: { allow: { nativeLibrary: [ADAPTER_PACKAGE] } },
          },
          undefined,
          2,
        )}\n`,
      );
    },
  );

  if (sharedFacade) {
    stageSharedFacade(outDir, sharedBridge);
    if (errors.length > 0 || stageOnly) return {exe,ran,errors};
    run(compiler.binaryPath, ["compile",stagedEntry,"-o",exe,...STRICT_FLAGS,"--debug-symbols",...triple],{cwd:outDir});
    if (manifest && errors.length === 0) {
      const identity = `${exe}.identity`;
      step("identity", [compiler.identity, fs.readFileSync(identityTool)], [identity], () =>
        run(identityTool, ["--write", identity, "--compiler", compiler.identity, "--backend", "dawn"]),
      );
    }
    return {exe,ran,errors};
  }

  const include = path.join(NATIVE, "include");
  const shim = path.join(outDir, "tn_three_shim.o");
  const shimSource = path.join(THREE_DIR, "tn_three_shim.c");
  step("shim", [fs.readFileSync(shimSource), fs.readFileSync(path.join(include, "threenative", "abi", "tn_abi.h"))], [shim], () =>
    run("cc", ["-c", "-fPIC", `-I${include}`, shimSource, "-o", shim]),
  );
  // The hooks include engine headers, so an engine change (new archives) rebuilds them.
  const hooks = path.join(outDir, "tn_three_hooks.o");
  const hooksSource = path.join(THREE_DIR, "tn_three_hooks.cpp");
  step("hooks", [fs.readFileSync(hooksSource), engineDigest], [hooks], () =>
    run("c++", ["-c", "-fPIC", "-std=c++20", `-I${include}`, `-I${path.join(NATIVE, "src")}`, hooksSource, "-o", hooks]),
  );
  if (errors.length > 0 || stageOnly) return { exe, ran, errors };

  // Perry compiles the staged game and links it in one invocation, resolving the shim archive, the
  // engine archives and the C++ runtime through the staged adapter's manifest.
  const bridge = path.join(bridgeDir, "libtn-three-shim.a");
  step(
    "link",
    [compiler.identity, engineDigest, ...triple, ...sources.map((file) => fs.readFileSync(file)), fs.readFileSync(shim), fs.readFileSync(hooks)],
    [bridge, exe],
    () => {
      fs.mkdirSync(bridgeDir, { recursive: true });
      run("ar", ["crs", bridge, shim, hooks]);
      if (errors.length > 0) return;
      run(compiler.binaryPath, ["compile", stagedEntry, "-o", exe, ...STRICT_FLAGS, ...triple], { cwd: outDir });
    },
  );
  if (manifest && errors.length === 0) {
    const identity = `${exe}.identity`;
    step("identity", [compiler.identity, fs.readFileSync(identityTool)], [identity], () =>
      run(identityTool, ["--write", identity, "--compiler", compiler.identity, "--backend", "dawn"]),
    );
  }
  return { exe, ran, errors };
}
