#!/usr/bin/env node
// The link bridge between Perry and the ThreeNative engine (decision 11).
//
// The Perry adapter (three/perry-adapter) is a Rust staticlib built by Perry's native-library
// mechanism. It calls the engine through the versioned C ABI, so this module's whole job is to
// compile the C half of the boundary — three/tn_three_shim.c and three/tn_three_hooks.cpp — into one
// archive, and to write the manifest fields that put that archive, the engine's own static
// libraries and the C++ runtime on Perry's link line. The engine is an input here and is never
// rebuilt: a missing archive is refused, not built.
//
// The staged adapter's package.json is the checked-in one plus these link fields, so the adapter's
// own manifest stays free of machine paths and the corpus runner owns them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const NATIVE = path.join(REPO, "packages", "runtime-native");
const THREE = path.join(HERE, "three");

/** The engine archives a game-code link needs: the C ABI, its bindings and the systems behind them. */
export const ENGINE_LIBS = [
  "tn_engine_abi",
  "tn_engine_bindings",
  "tn_engine_shader",
  "tn_engine_animation",
  "tn_engine_scene",
  "tn_engine_foundation",
];

const HOST_TOOLS = { cc: "cc", cxx: "c++", ar: "ar" };

/** The NDK's clang, clang++ and ar for a cross target, so the C half is built for the device's ABI. */
export function ndkTools(ndk, android) {
  const bin = path.join(ndk.bin, "bin");
  const clang = path.join(bin, `${android.triple}${android.apiLevel}-clang`);
  return { cc: clang, cxx: `${clang}++`, ar: path.join(bin, "llvm-ar") };
}

function named(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function firstError(output, tool) {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.includes("error:"));
  return line ?? `${tool} failed: ${output.split("\n")[0]}`;
}

/**
 * The archive holding the C half of the boundary: the shim (engine handle table, argument staging)
 * and the hooks (the engine's own RenderCallback, which needs the engine's internal headers).
 * Rebuilt only when its sources or the engine include tree change.
 */
export function buildEngineBridge({
  outDir,
  engineBuild,
  render = false,
  shared = false,
  tools = HOST_TOOLS,
}) {
  fs.mkdirSync(outDir, { recursive: true });
  const include = path.join(NATIVE, "include");
  const archive = path.join(outDir, shared ? "libtn-native-shim.a" : "libtn-three-shim.a");
  const shim = path.join(outDir, shared ? "perry_transport.o" : "tn_three_shim.o");
  const hooks = path.join(outDir, "tn_three_hooks.o");
  const sources = shared
    ? [path.join(NATIVE, "src/engine/abi/perry_transport.c")]
    : [path.join(THREE, "tn_three_shim.c"), path.join(THREE, "tn_three_hooks.cpp")];
  const newest = (dir) => {
    let latest = 0;
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) walk(file);
        else latest = Math.max(latest, fs.statSync(file).mtimeMs);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return latest;
  };
  // The render build adds the one-shot frame dump and the benchmark session (PRD-533).
  const renderSources = shared
    ? [
        path.join(NATIVE, "src/engine/abi/perry_renderer.cpp"),
        path.join(NATIVE, "src/engine/abi/perry_assets.cpp"),
      ]
    : ["tn_three_render.cpp", "tn_three_bench.cpp"].map((name) => path.join(THREE, name));
  if (render) sources.push(...renderSources);
  const stamp = Math.max(
    ...sources.map((file) => fs.statSync(file).mtimeMs),
    fs.statSync(fileURLToPath(import.meta.url)).mtimeMs,
    newest(include),
    newest(path.join(NATIVE, "src", "engine")),
    ...(render ? [fs.statSync(path.join(engineBuild, "compile_commands.json")).mtimeMs] : []),
  );
  if (
    fs.existsSync(archive) &&
    fs.existsSync(shim) &&
    (shared || fs.existsSync(hooks)) &&
    fs.statSync(archive).mtimeMs >= stamp
  ) {
    return archive;
  }

  const compile = (tool, args) => {
    const run = spawnSync(tool, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    if (run.status !== 0) throw named("TN_STRICT_SHIM", firstError(output, tool));
  };
  compile(tools.cc, ["-c", "-fPIC", `-I${include}`, sources[0], "-o", shim]);
  if (!shared)
    compile(tools.cxx, [
      "-c",
      "-fPIC",
      "-std=c++20",
      `-I${include}`,
      `-I${path.join(NATIVE, "src")}`,
      ...(render ? ["-DTN_TSL_RENDER"] : []),
      sources[1],
      "-o",
      hooks,
    ]);
  const objects = shared ? [shim] : [shim, hooks];
  if (render) {
    const commands = JSON.parse(
      fs.readFileSync(path.join(engineBuild, "compile_commands.json"), "utf8"),
    );
    const command = commands.find((entry) => entry.file.endsWith("/fixture/render_main.cpp"));
    if (!command)
      throw named("TN_STRICT_RENDER_BUILD", "render driver's compile command is missing");
    const flags = command.command
      .match(/-D\S+|-I\S+|-isystem\s+\S+/g)
      .flatMap((flag) => flag.split(/\s+/));
    for (const source of renderSources) {
      const object = path.join(outDir, `${path.basename(source, ".cpp")}.o`);
      compile(tools.cxx, [
        "-c",
        "-fPIC",
        "-std=c++20",
        ...flags,
        `-I${path.join(NATIVE, "src")}`,
        source,
        "-o",
        object,
      ]);
      objects.push(object);
    }
  }
  compile(tools.ar, ["crs", archive, ...objects]);
  return archive;
}

/**
 * The bridge one run links with: the C archive plus the engine archives beside it. Every archive is
 * refused when absent — the engine is an input to a game build, never rebuilt by one.
 */
export function bridgeFor({
  android,
  ndk,
  engineBuild: override,
  render = false,
  shared = false,
} = {}) {
  if (android && render) throw named("TN_STRICT_RENDER_BUILD", "--render has no Android build");
  const engineBuild =
    override ?? path.join(NATIVE, "build", android ? `android-core-${android.abi}` : "tn-linux");
  const outDir = path.join(
    engineBuild,
    "three-bridge",
    ...(shared ? ["shared"] : []),
    ...(render ? ["render"] : []),
  );
  for (const lib of ENGINE_LIBS) {
    const archive = path.join(engineBuild, `lib${lib}.a`);
    if (!fs.existsSync(archive)) {
      throw named(
        "TN_STRICT_ENGINE_MISSING",
        `${archive}; build or install the engine first (TN_NATIVE_ENGINE_BUILD names another tree)`,
      );
    }
  }
  const archive = buildEngineBridge({
    outDir,
    engineBuild,
    render,
    shared,
    tools: android ? ndkTools(ndk, android) : HOST_TOOLS,
  });
  const renderArchives = render
    ? fs
        .readFileSync(path.join(engineBuild, "build.ninja"), "utf8")
        .match(/^build tn-native-engine-render-driver:[\s\S]*?^ {2}LINK_LIBRARIES = (.+)$/m)?.[1]
        .trim()
        .split(/\s+/)
        .filter((file) => file.endsWith(".a"))
        .map((file) => path.resolve(engineBuild, file))
    : [];
  if (!renderArchives)
    throw named("TN_STRICT_RENDER_BUILD", "render driver's native link dependencies are missing");
  for (const file of renderArchives)
    if (!fs.existsSync(file)) throw named("TN_STRICT_RENDER_BUILD", `${file} missing`);
  return {
    archive,
    engineBuild,
    libDirs: [
      ...new Set([outDir, engineBuild, ...renderArchives.map((file) => path.dirname(file))]),
    ],
    libs: [
      shared ? "tn-native-shim" : "tn-three-shim",
      ...ENGINE_LIBS,
      ...renderArchives.map((file) => path.basename(file).replace(/^lib|\.a$/g, "")),
      // Android's libc carries pthread; its C++ runtime is the NDK's static libc++.
      ...(android ? ["c++_static", "c++abi", "m", "dl", "log"] : ["stdc++", "m", "pthread", "dl"]),
    ],
    /** Writes the link fields into the staged adapter's manifest; the adapter's own stays pathless. */
    async writeManifest(packageDir) {
      const manifestPath = path.join(packageDir, "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const platform = manifest.perry.nativeLibrary.targets[android ? "android" : "linux"];
      platform.libDirs = this.libDirs;
      platform.libs = this.libs;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
    },
  };
}
