#!/usr/bin/env node
// Run the native-TypeScript language corpus twice and compare.
//
//   --reference               run each case with tsx, compare stdout and exit to <case>.expected
//   --native --target <triple> compile each case with the pinned Perry to an
//                              executable and compare stdout and exit to <case>.expected
//   --packaged                with --adb and --case, run the case inside the corpus-player app's
//                              activity (android/corpus-player, built with the host's Gradle wrapper)
//                              instead of through the standalone loader
//   --build-only              link every case and run none of them
//   --adb <serial>            with a cross target, push each linked library to that device and run it
//                              there through tn_so_runner, comparing stdout and exit code to the same
//                              <case>.expected the host run uses
//   --out <dir>               where a cross target's artifacts land (default
//                              artifacts/native-typescript, ignored by git)
//   --case <name>             run only one case
//   --without-patches         run the native side against the toolchain exactly as upstream ships
//                              it (patches.json applied to none of it), then require the red case
//                              set to equal the set patches.json declares, and exit 1 naming the
//                              difference when it does not
//   --expect-compile-error    the selected cases must be compile-error cases (their
//                              .expected holds `# compile-error <text>`; nothing runs)
//
// Perry compiles a whole module graph in one invocation, so a case and the modules it imports are
// staged into a temporary project and compiled from its entry. Strict builds pass Perry's strict
// controls (decision 11): `--strict-eval` and `--strict-dynamic-import` make every runtime-unknown
// `eval`, `new Function` and dynamic `import` a compile-time error, and `--strict-unimplemented`
// does the same for a recognized-but-unimplemented stdlib API, so none of them survives to runtime.
//
// A cross target is a file in targets/ whose `triple` names it (PRD-507): `--target
// aarch64-linux-android` reads targets/android-arm64.json for its triple, API level and page size,
// and links with Perry's own Android target, which needs the pinned cross runtime and the NDK's
// own driver. Such a run leaves one <case>.so per linked case under <out>/<abi-ish>/.
//
// Each `<case>.expected` holds the reference stdout, optionally followed by a
// `# exit <n>` line naming the reference exit code (absent means 0).
// A native compile or link failure is a named failure (TN_NATIVE_TS_COMPILE
// <case>: <first error line>) and is never skipped. A `.ts` entry with no
// `.expected` is a named failure, not a skip. alloc-loop additionally fails
// when its peak resident set exceeds 512 MB.
//
// A case that imports "three" is game code against the engine (PRD-506): the reference
// build resolves "three" to the workspace's pinned three@<catalog>, the native build to
// three/three.ts, which reaches the engine only through the Perry adapter
// (three/perry-adapter) and the C ABI, linked with three/tn_three_shim.c and the engine's
// static libraries from TN_NATIVE_ENGINE_BUILD (default packages/runtime-native/build/tn-linux).
// The case's own source is never edited.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "node:util";
import { compareCaptures } from "../../packages/runtime-native/conformance/metrics.mjs";
import { inspect } from "../../packages/runtime-native/scripts/inspect-js-free.mjs";
import {
  buildPthreadKeys,
  buildSoRunner,
  ensureAndroidRuntime,
  findTarget,
  perryTarget,
  resolveAdb,
  resolveNdk,
} from "./android.mjs";
import { checkDevice, isAarch64Elf, pushRunner, runLibrary } from "./device.mjs";
import { runPackaged } from "./packaged.mjs";
import { compareRedToDeclared, loadLedger } from "./patches.mjs";
import { stageSharedFacade } from "./perry-facade.mjs";
import { provision } from "./provision.mjs";
import { ENGINE_LIBS, bridgeFor, buildEngineBridge } from "./three-bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, "corpus");
const REPO = path.resolve(HERE, "..", "..");
const DEFAULT_OUT = path.join(REPO, "artifacts", "native-typescript");
const RSS_LIMIT_BYTES = 512 * 1024 * 1024;
const IMPORT_RE = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
const THREE_IMPORT_RE = /\bfrom\s*["'](three(?:\/[\w-]+)?)["']/g;
const ADAPTER_PACKAGE = "tn-three-adapter";

// Allow one 8-bit code value of quantization, plus 1% edge pixels. A different sine layer
// changes the box interior by several code values; the mean Lab delta also caps color drift.
export const RENDER_BUDGET = { levels: 1, pixelMismatchRatio: 0.01, perceptualDeltaE: 0.3 };

export function compareRenderFrames(reference, native) {
  for (const [label, file] of [
    ["reference", reference],
    ["native", native],
  ])
    if (!fs.existsSync(file)) throw named("TN_NATIVE_TS_FRAME_MISSING", `${label} ${file}`);
  const metrics = compareCaptures(
    fs.readFileSync(reference),
    fs.readFileSync(native),
    RENDER_BUDGET.levels,
  );
  if (
    metrics.pixelMismatchRatio > RENDER_BUDGET.pixelMismatchRatio ||
    metrics.perceptualDeltaE > RENDER_BUDGET.perceptualDeltaE
  )
    throw named(
      "TN_NATIVE_TS_FRAME_MISMATCH",
      `${JSON.stringify(metrics)}; budget=${JSON.stringify(RENDER_BUDGET)}`,
    );
  return metrics;
}

/** Every case, strictly compiled: no runtime-unknown eval, Function or dynamic import may survive. */
export const STRICT_FLAGS = ["--strict-eval", "--strict-dynamic-import", "--strict-unimplemented"];

// Environment variable names are SCREAMING_SNAKE and must keep that spelling.
function mergeEnv(base, entries) {
  const env = { ...base };
  for (const [key, value] of entries) env[key] = value;
  return env;
}

function named(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * Names a case imports from "three" or a "three/..." subpath that the catalog does not mark
 * supported: each fails the build as TN_NATIVE_TS_UNSUPPORTED_EXPORT <specifier>#<name>, with the
 * catalog's own diagnostic when it records one, before anything compiles.
 */
export function unsupportedThreeImports(source, catalog, nativeExports = {}) {
  const entries = new Map(catalog.entries.map((entry) => [entry.name, entry]));
  const refused = [];
  for (const match of source.matchAll(
    /\bimport\s*\{([^}]*)\}\s*from\s*["'](three(?:\/[\w-]+)?)["']/g,
  )) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (!name) continue;
      const entry = entries.get(name);
      if (entry?.status?.kind === "supported" || nativeExports[match[2]]?.includes(name)) continue;
      const diagnostic = entry?.status?.diagnostic
        ? ` (${entry.status.diagnostic})`
        : entry
          ? ""
          : " (not in the catalog)";
      refused.push(`TN_NATIVE_TS_UNSUPPORTED_EXPORT ${match[2]}#${name}${diagnostic}`);
    }
  }
  return refused;
}

function importsThree(file) {
  return /\bfrom\s*["']three(?:\/[^"']+)?["']/.test(fs.readFileSync(file, "utf8"));
}

/** The workspace's pinned three, resolved the way the fixture reference runner resolves it. */
function pinnedThreeModuleUrl(specifier = "three") {
  const pinned = /^\s*three:\s*([^\s#]+)/m.exec(
    fs.readFileSync(path.join(REPO, "pnpm-workspace.yaml"), "utf8"),
  )?.[1];
  const entry = createRequire(path.join(REPO, "packages", "core", "package.json")).resolve("three");
  const build = path.dirname(entry);
  const version = JSON.parse(
    fs.readFileSync(path.join(build, "..", "package.json"), "utf8"),
  ).version;
  if (version !== pinned)
    throw named(
      "TN_NATIVE_TS_THREE_MISMATCH",
      `packages/core links three ${version}, the catalog pins ${pinned}`,
    );
  return pathToFileURL(
    path.join(
      build,
      specifier === "three"
        ? "three.module.js"
        : specifier === "three/webgpu"
          ? "three.webgpu.js"
          : "three.tsl.js",
    ),
  ).href;
}

/** Splits a `.expected` file into its stdout bytes and its stored reference exit code. */
export function parseExpected(buffer) {
  const text = buffer.toString("utf8");
  // A native-only case: the build must fail naming this text, and nothing runs.
  const compileError = /^# compile-error (.+)$/m.exec(text)?.[1];
  if (compileError !== undefined) return { compileError, exit: 0, stdout: Buffer.alloc(0) };
  // A case that uses the native-only "three-aot" hooks: compared on the native build alone.
  if (/^# native-only\r?\n/.test(text)) {
    const rest = Buffer.from(text.replace(/^# native-only\r?\n/, ""), "utf8");
    return { ...parseExpected(rest), nativeOnly: true };
  }
  const match = /(^|\n)# exit (\d+)\r?\n?$/.exec(text);
  if (match === null) return { exit: 0, stdout: buffer };
  const exit = Number(match[2]);
  const stripAt = match.index + match[1].length;
  return { exit, stdout: Buffer.from(text.slice(0, stripAt), "utf8") };
}

function expectedPath(name, corpusDir = CORPUS) {
  return path.join(corpusDir, `${name}.expected`);
}

/** A `.ts` case with no `.expected` beside it is a failure, never a silent skip. */
export function missingExpectationNote(name, corpusDir = CORPUS) {
  return fs.existsSync(expectedPath(name, corpusDir))
    ? undefined
    : `TN_NATIVE_TS_EXPECTED_MISSING ${name}: no ${name}.expected beside the case`;
}

function resolveModule(fromFile, spec) {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw named("TN_NATIVE_TS_IMPORT", `${fromFile}: cannot resolve import '${spec}'`);
}

function collectModules(entry) {
  const seen = new Set();
  const ordered = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    ordered.push(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveModule(file, match[1] ?? match[2]);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return ordered;
}

/**
 * Corpus cases are the top-level `.ts` files no other case imports; a helper module
 * (`imports-cycle-inner.ts`) is imported and is not itself a case. A stray top-level `.ts`
 * therefore becomes a case, and a case with no `.expected` fails the run.
 */
function corpusCaseNames(corpusDir = CORPUS) {
  const files = fs
    .readdirSync(corpusDir)
    .filter((file) => file.endsWith(".ts"))
    .sort();
  const imported = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(corpusDir, file), "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveModule(path.join(corpusDir, file), match[1] ?? match[2]);
      if (resolved) imported.add(resolved);
    }
  }
  return files
    .filter((file) => !imported.has(path.join(corpusDir, file)))
    .map((file) => file.slice(0, -".ts".length));
}

export function discoverCases(filter, corpusDir = CORPUS) {
  const names = corpusCaseNames(corpusDir);
  return filter ? names.filter((name) => name === filter) : names;
}

async function runReference(name, plan = {}) {
  let file = path.join(CORPUS, `${name}.ts`);
  const expected = parseExpected(fs.readFileSync(expectedPath(name)));
  if (expected.compileError !== undefined || expected.nativeOnly)
    return { ok: true, notApplicable: true };
  if (name === "three-native-minimal" || name === "three-native-midway-assets") {
    const { runWasmReference } = await import("./shared-reference.mjs");
    const result = await runWasmReference(file, expected);
    if (!result.ok || !plan.render) return result;
    const { renderReference } = await import("./render-reference.mjs");
    await renderReference(file, path.join(plan.outDir, `${name}-reference.png`), { shared: true });
    return result;
  }
  if (importsThree(file)) {
    const staged = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "tn-ref-three-")),
      `${name}.mts`,
    );
    fs.writeFileSync(
      staged,
      fs
        .readFileSync(file, "utf8")
        .replace(THREE_IMPORT_RE, (_, specifier) => `from "${pinnedThreeModuleUrl(specifier)}"`),
    );
    file = staged;
  }
  if (plan.render) {
    const { renderReference } = await import("./render-reference.mjs");
    await renderReference(file, path.join(plan.outDir, `${name}-reference.png`));
    return { ok: true, note: "reference frame dumped" };
  }
  // Run scene fixtures through tsx's module API: no CLI IPC socket or child Node is needed.
  if (importsThree(path.join(CORPUS, `${name}.ts`))) {
    const { tsImport } = await import("tsx/esm/api");
    const log = console.log;
    let output = "";
    let error;
    console.log = (...args) => {
      output += `${format(...args)}\n`;
    };
    try {
      await tsImport(file, import.meta.url);
    } catch (thrown) {
      error = thrown;
    } finally {
      console.log = log;
    }
    return {
      ok: error === undefined && Buffer.from(output).equals(expected.stdout),
      note:
        error === undefined
          ? Buffer.from(output).equals(expected.stdout)
            ? ""
            : "stdout mismatch"
          : String(error),
    };
  }
  const run = spawnSync(process.execPath, ["--import", "tsx", path.relative(REPO, file)], {
    cwd: REPO,
    env: mergeEnv(process.env, [
      ["NO_COLOR", "1"],
      ["FORCE_COLOR", "0"],
    ]),
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) return { ok: false, note: String(run.error), exit: -1 };
  const actual = run.stdout ?? Buffer.alloc(0);
  const status = run.status ?? -1;
  if (!actual.equals(expected.stdout)) {
    return {
      ok: false,
      note: `stdout mismatch (exit ${status}): expected ${expected.stdout.length}B, got ${actual.length}B`,
      exit: status,
    };
  }
  if (status !== expected.exit) {
    return {
      ok: false,
      note: `exit mismatch: expected ${expected.exit}, reference ${status}`,
      exit: status,
    };
  }
  return { ok: true, note: "", exit: status };
}

/**
 * The temporary project one case compiles in. Perry takes one entry and resolves the rest, so the
 * case and every module it imports are copied under `src/` with their imports intact. A case that
 * imports "three" gets the facade staged as its `three` module and the Perry adapter as a package
 * it may import, because the corpus resolves both from beside the case itself.
 */
export async function stageProject({ entry, modules, tmp, three, bridge, shared = false }) {
  const src = path.join(tmp, "src");
  await fsp.mkdir(src, { recursive: true });
  for (const file of modules) {
    await fsp.copyFile(file, path.join(src, path.basename(file)));
  }
  const entryName = path.basename(entry);
  if (three) {
    // A case imports "three" and "three-aot" by name, so both are staged as the packages it
    // resolves: "three" is the facade over the engine C ABI, and the adapter is the Perry native
    // library the facade imports.
    // "three-aot" is its own package too, so a case that imports only the hooks resolves them.
    for (const [name, facade] of [
      ["three", "three.ts"],
      ["three-aot", "three-aot.ts"],
    ]) {
      const dir = path.join(tmp, "node_modules", name);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.copyFile(path.join(HERE, "three", facade), path.join(dir, facade));
      await fsp.writeFile(
        path.join(dir, "package.json"),
        `${JSON.stringify({ name, version: "0.185.1", main: facade, types: facade }, undefined, 2)}\n`,
      );
    }
    for (const [file, staged] of [
      ["three-tsl.ts", "three-tsl.ts"],
      ["three-tsl.ts", "tsl.ts"],
      ["webgpu.ts", "webgpu.ts"],
    ]) {
      await fsp.copyFile(
        path.join(HERE, "three", file),
        path.join(tmp, "node_modules", "three", staged),
      );
    }
    const packageDir = path.join(tmp, "node_modules", ADAPTER_PACKAGE);
    await fsp.cp(path.join(HERE, "three", "perry-adapter"), packageDir, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}target${path.sep}`),
    });
    await bridge?.writeManifest(packageDir);
  }
  await fsp.writeFile(
    path.join(tmp, "package.json"),
    `${JSON.stringify(
      {
        name: "tn-corpus-case",
        version: "0.0.0",
        private: true,
        ...(three
          ? {
              dependencies: {
                three: "file:node_modules/three",
                "three-aot": "file:node_modules/three-aot",
                [ADAPTER_PACKAGE]: `file:node_modules/${ADAPTER_PACKAGE}`,
              },
            }
          : {}),
        perry: three ? { allow: { nativeLibrary: [ADAPTER_PACKAGE] } } : {},
      },
      undefined,
      2,
    )}\n`,
  );
  if (shared) stageSharedFacade(tmp, bridge);
  return { dir: tmp, entry: path.join(src, entryName) };
}

/**
 * Compiles one case with Perry. A failure is named from its first error line, so a Perry refusal
 * (`eval` under strict controls, an unresolvable dynamic import) is reported as itself.
 */
export function compileWithPerry({ perry, project, out, env, extraFlags = [] }) {
  const args = ["compile", project.entry, "-o", out, ...STRICT_FLAGS, ...extraFlags];
  const run = spawnSync(perry, args, {
    cwd: project.dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const error = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^Error:|error\[|error:|undefined reference/.test(line));
  if (run.status !== 0 || error) {
    return { ok: false, error: error ?? `perry exited ${run.status}`, output };
  }
  return { ok: true, output };
}

/**
 * One native case in a staged project that is removed afterwards: a three-import case builds a
 * Rust adapter into it (about 300 MB), and /tmp is RAM. TN_NATIVE_TS_KEEP=1 keeps it for debugging.
 */
async function runNative(name, info, target, plan = {}) {
  const missing = missingExpectationNote(name);
  if (missing !== undefined) return { ok: false, note: missing };
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tn-native-ts-"));
  try {
    return await runNativeIn(tmp, name, info, target, plan);
  } finally {
    if (process.env.TN_NATIVE_TS_KEEP !== "1") await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function runNativeIn(tmp, name, info, target, plan) {
  const shared = name === "three-native-minimal" || name === "three-native-midway-assets";
  const entry = path.join(CORPUS, `${name}.ts`);
  const modules = collectModules(entry);
  const three = importsThree(entry);
  // A cross target with no engine archives for its ABI cannot link a three-import case: refuse it
  // with the missing archives named, rather than trying the host archives and reporting a link error.
  const compileErrorCase = parseExpected(fs.readFileSync(expectedPath(name))).compileError;
  if (three && plan.blockedThreeImport && compileErrorCase === undefined)
    return { ok: false, note: plan.blockedThreeImport };
  const bridge =
    three && !plan.blockedThreeImport
      ? await bridgeFor({
          android: plan.target,
          ndk: plan.ndk,
          render: shared || plan.render,
          shared,
          engineBuild: plan.target ? undefined : process.env.TN_NATIVE_ENGINE_BUILD,
        })
      : undefined;
  const env = mergeEnv(process.env, [["PERRY_CACHE_DIR", path.join(tmp, ".perry")]]);
  if (plan.render) env.TN_TSL_FRAME = path.join(plan.outDir, `${name}-native.png`);
  for (const [key, value] of plan.env ?? []) env[key] = value;

  const refusedImports = unsupportedThreeImports(
    fs.readFileSync(entry, "utf8"),
    JSON.parse(
      fs.readFileSync(path.join(REPO, "packages", "three-native", "api", "catalog.json"), "utf8"),
    ),
    // AOT TSL/renderer bindings are qualified here; the VM catalog still refuses these names.
    { "three/tsl": ["float", "uv", "sin", "vec3", "struct"], "three/webgpu": ["WebGPURenderer"] },
  );
  const exe = path.join(tmp, name);
  const project = await stageProject({ entry, modules, tmp, three, bridge, shared });
  const compile = compileWithPerry({
    perry: info.binaryPath,
    project,
    out: exe,
    env,
    extraFlags: [
      ...(name === "dynamic-tsl" || shared ? ["--debug-symbols"] : []),
      ...(plan.perryFlags ?? []),
    ],
  });
  const compileErrors = [...refusedImports];
  if (refusedImports.length === 0 && !compile.ok) compileErrors.push(compile.error);

  const expectedCompile = parseExpected(fs.readFileSync(expectedPath(name))).compileError;
  if (expectedCompile !== undefined) {
    return compileErrors.some((error) => error.includes(expectedCompile))
      ? { ok: true, note: `refused at compile time: ${expectedCompile}` }
      : {
          ok: false,
          note: `expected the build to fail with ${expectedCompile}; got ${compileErrors[0] ?? "a successful build"}`,
        };
  }
  if (compileErrors.length > 0) {
    return { ok: false, note: `TN_NATIVE_TS_COMPILE ${name}: ${compileErrors[0]}` };
  }
  await fsp.mkdir(plan.outDir, { recursive: true });
  const artifact = path.join(
    plan.outDir,
    plan.target ? plan.target.output.replace("{case}", name) : name,
  );
  await fsp.copyFile(exe, artifact);
  if (plan.target && !isAarch64Elf(artifact))
    return { ok: false, note: `TN_NATIVE_TS_ARTIFACT ${artifact} is not an arm64 ELF` };
  if (name === "dynamic-tsl" || shared) {
    const audit = inspect({ binary: artifact });
    if (!audit.jsFree)
      return { ok: false, note: `TN_NATIVE_TS_JS_FREE ${JSON.stringify(audit.findings)}` };
  }
  if (plan.buildOnly) return { ok: true, note: "linked, not run (--build-only)" };

  if (plan.render) await fsp.rm(env.TN_TSL_FRAME, { force: true });
  const measured = plan.device
    ? plan.device.packaged
      ? await runPackaged({
          adb: plan.device.adb,
          serial: plan.device.serial,
          name,
          library: artifact,
        })
      : await runLibrary(plan.device.adb, plan.device.serial, artifact)
    : name === "alloc-loop"
      ? await runMeasured(exe, env)
      : { ...(await runExecutable(exe, env)), peakRssBytes: 0 };
  if (process.env.TN_NATIVE_TS_DEBUG === "1") {
    console.error(measured.stderr);
    console.error(`stdout: ${measured.stdout.toString()}`);
  }
  const expected = parseExpected(fs.readFileSync(expectedPath(name)));

  if (!measured.stdout.equals(expected.stdout)) {
    return {
      ok: false,
      note: `stdout mismatch (exit ${measured.status}): expected ${expected.stdout.length}B, got ${measured.stdout.length}B`,
    };
  }
  if (measured.status !== expected.exit) {
    return {
      ok: false,
      note: `exit mismatch: expected ${expected.exit}, native ${measured.status}; stderr: ${measured.stderr.trim() || "(empty)"}`,
    };
  }
  if (name === "alloc-loop" && measured.peakRssBytes > RSS_LIMIT_BYTES) {
    return {
      ok: false,
      note: `peak RSS ${(measured.peakRssBytes / (1024 * 1024)).toFixed(1)} MB over 512 MB`,
    };
  }
  if (plan.render && (!fs.existsSync(env.TN_TSL_FRAME) || fs.statSync(env.TN_TSL_FRAME).size === 0))
    return { ok: false, note: "TN_NATIVE_TS_FRAME_MISSING" };
  return {
    ok: true,
    note:
      name === "alloc-loop"
        ? `peak RSS ${(measured.peakRssBytes / (1024 * 1024)).toFixed(1)} MB`
        : "",
  };
}

function runExecutable(exe, env) {
  return new Promise((resolve) => {
    const child = spawn(exe, [], { env });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ stdout: Buffer.concat(stdout), stderr, status: status ?? -1 });
    });
  });
}

/** Finds an executable by absolute path or on `PATH`; undefined when absent. */
function resolveExecutable(candidates) {
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir === "") continue;
      const full = path.join(dir, candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // next PATH entry
      }
    }
  }
  return undefined;
}

/**
 * Peak RSS, exactly, without sampling. `/usr/bin/time -f %M` reads the kernel's own
 * `getrusage`; when it is absent the `resource` module's `RUSAGE_CHILDREN.ru_maxrss` (the
 * largest waited-for child's high-water mark) is used. Polling `/proc/<pid>/status` misses a
 * process that peaks and exits between samples, and Node's `process.resourceUsage()` reports
 * `RUSAGE_SELF`, which never includes the child. When neither tool exists this fails closed.
 */
export async function runMeasured(exe, env, args = []) {
  const rssFile = path.join(os.tmpdir(), `tn-native-ts-rss-${randomUUID()}.txt`);
  try {
    const timeBin = resolveExecutable(["/usr/bin/time"]);
    const pythonBin = resolveExecutable(["/usr/bin/python3", "python3", "python"]);
    let run;
    if (timeBin !== undefined) {
      run = spawnSync(timeBin, ["-f", "%M", "-o", rssFile, exe, ...args], {
        env,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
    } else if (pythonBin !== undefined) {
      const script =
        "import resource,subprocess,sys; " +
        "p=subprocess.run(sys.argv[2:]); " +
        "open(sys.argv[1],'w').write(str(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)); " +
        "sys.exit(p.returncode)";
      run = spawnSync(pythonBin, ["-c", script, rssFile, exe, ...args], {
        env,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
    } else {
      throw named("TN_NATIVE_TS_RSS", "cannot measure peak RSS: no /usr/bin/time and no python3");
    }
    const peakRssKb = Number(fs.readFileSync(rssFile, "utf8").trim());
    if (!Number.isSafeInteger(peakRssKb) || peakRssKb <= 0) {
      throw named("TN_NATIVE_TS_RSS", `no peak RSS reported for ${exe}`);
    }
    return {
      peakRssBytes: peakRssKb * 1024,
      status: run.status ?? -1,
      stderr: (run.stderr ?? Buffer.alloc(0)).toString(),
      stdout: run.stdout ?? Buffer.alloc(0),
    };
  } finally {
    await fsp.rm(rssFile, { force: true });
  }
}

function printTable(rows) {
  const widths = { case: 4, reference: 9, native: 6, note: 4 };
  for (const row of rows) {
    widths.case = Math.max(widths.case, row.name.length);
    widths.reference = Math.max(widths.reference, (row.reference ?? "-").length);
    widths.native = Math.max(widths.native, (row.native ?? "-").length);
    widths.note = Math.max(widths.note, row.note.length);
  }
  const line = (name, reference, native, note) =>
    `${name.padEnd(widths.case)}  ${reference.padEnd(widths.reference)}  ${native.padEnd(widths.native)}  ${note}`;
  console.log(line("case", "reference", "native", "note"));
  console.log(
    `${"-".repeat(widths.case)}  ${"-".repeat(widths.reference)}  ${"-".repeat(widths.native)}  ${"-".repeat(widths.note)}`,
  );
  for (const row of rows) {
    console.log(line(row.name, row.reference ?? "-", row.native ?? "-", row.note));
  }
}

/**
 * What a cross target links with: the Perry cross runtime for its triple and the NDK its target
 * file pins. A case that imports "three" is refused here, naming what is missing — the engine
 * archives exist for no Android build tree in every lane this runner can rely on, and Perry's
 * Android target links its own runtime rather than objects the runner emits.
 */
async function crossPlan(targetFile, outDir, serial, packaged) {
  const ndk = resolveNdk(targetFile);
  const runtime = await ensureAndroidRuntime(targetFile, { ndk, log: () => {} });
  const dir = path.join(outDir, targetFile.outDir);
  // The loader and the keys object are not corpus libraries, so they stay out of the directory the
  // 16 KB check walks.
  const helpers = path.join(outDir, `${targetFile.outDir}-tools`);
  await fsp.mkdir(dir, { recursive: true });
  let device;
  if (serial !== undefined) {
    const adb = resolveAdb();
    device = { adb, serial, packaged, ...(await checkDevice(adb, serial, targetFile)) };
    await pushRunner(adb, serial, buildSoRunner(targetFile, ndk, helpers));
  }
  const engineBuild = path.join(
    REPO,
    "packages",
    "runtime-native",
    "build",
    `android-core-${targetFile.abi}`,
  );
  const missing = ENGINE_LIBS.filter(
    (lib) => !fs.existsSync(path.join(engineBuild, `lib${lib}.a`)),
  ).map((lib) => `lib${lib}.a`);
  return {
    target: targetFile,
    ndk,
    outDir: dir,
    device,
    perryFlags: ["--target", perryTarget(targetFile.triple)],
    // Perry links its own cross runtime from here; without it the target has no runtime to link.
    // Perry drives the NDK clang named by ANDROID_NDK_HOME, so the pinned NDK is exported, not inherited.
    env: [
      ["PERRY_RUNTIME_DIR", runtime.dir],
      ["ANDROID_NDK_HOME", ndk.dir],
      ["PERRY_EXTRA_LINK_ARGS", buildPthreadKeys(targetFile, ndk, helpers)],
    ],
    blockedThreeImport:
      missing.length === 0
        ? undefined
        : `three-import link is blocked: ${missing.join(", ")} exist for no ${targetFile.abi} engine build (cmake -DTN_ENGINE_CORE_ONLY=ON into packages/runtime-native/build/android-core-${targetFile.abi}, the command conformance/run-conformance.mjs prints)`,
    summary: (rows) => {
      const ok = rows.filter((row) => row.native === "PASS").length;
      const where = device
        ? `, run${device.packaged ? " packaged in an activity" : ""} on ${device.model} ${device.serial} (${device.abi}, Android ${device.release}${device.emulator ? ", emulator" : ", physical"})`
        : "";
      return `${targetFile.triple}: Perry ${perryTarget(targetFile.triple)}, NDK ${ndk.version}, ${targetFile.maxPageSize}-byte pages${where} — ${ok}/${rows.length} cases ok`;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const wantReference = args.includes("--reference");
  const wantNative = args.includes("--native");
  const buildOnly = args.includes("--build-only");
  const render = args.includes("--render");
  const withoutPatches = args.includes("--without-patches");
  let target;
  let filter;
  let serial;
  let packaged = false;
  let outDir = DEFAULT_OUT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target") target = args[++i];
    else if (args[i] === "--adb") serial = args[++i];
    else if (args[i] === "--packaged") packaged = true;
    else if (args[i] === "--case") {
      i += 1;
      filter = args[i];
    } else if (args[i] === "--out") outDir = path.resolve(args[++i]);
  }
  if (!wantReference && !wantNative) {
    throw named(
      "TN_NATIVE_TS_USAGE",
      "pass --reference and/or --native [--target <triple>] [--build-only] [--without-patches] [--case <name>]",
    );
  }
  if (withoutPatches && !wantNative) {
    throw named(
      "TN_NATIVE_TS_USAGE",
      "--without-patches compares the native red set against the ledger, so it needs --native",
    );
  }
  const targetFile = wantNative && target !== undefined ? findTarget(target) : undefined;
  const cross = targetFile !== undefined;
  if (wantNative && target && !target.startsWith("x86_64-linux") && !cross) {
    throw named(
      "TN_NATIVE_TS_TARGET",
      `unsupported target ${target}: pin it in tools/native-typescript/targets/<name>.json or use x86_64-linux-gnu`,
    );
  }

  if (render && filter !== "dynamic-tsl" && filter !== "three-native-minimal")
    throw named(
      "TN_NATIVE_TS_USAGE",
      "--render requires --case dynamic-tsl or three-native-minimal",
    );
  if (render && cross) throw named("TN_NATIVE_TS_USAGE", "--render requires the host target");
  const captureReference = wantReference || (render && wantNative && !buildOnly);
  const names = discoverCases(filter);
  if (names.length === 0) throw named("TN_NATIVE_TS_CASE", `no corpus case matches '${filter}'`);
  // --expect-compile-error states the selected cases are compile-error cases; a case that is not
  // one would pass for the wrong reason, so it stops the run.
  if (args.includes("--expect-compile-error")) {
    for (const name of names) {
      const note = missingExpectationNote(name);
      if (
        note === undefined &&
        parseExpected(fs.readFileSync(expectedPath(name))).compileError === undefined
      )
        throw named("TN_NATIVE_TS_USAGE", `${name} has no '# compile-error' expectation`);
    }
  }

  // Usage is settled before the toolchain is provisioned: a wrong flag must not cost a download.
  if (serial !== undefined && !cross)
    throw named("TN_NATIVE_TS_USAGE", "--adb needs --native --target <android triple>");
  if (cross && serial === undefined && !buildOnly)
    throw named(
      "TN_NATIVE_TS_USAGE",
      "a cross target runs on a device: pass --adb <serial> or --build-only",
    );
  if (packaged && (serial === undefined || filter === undefined))
    throw named(
      "TN_NATIVE_TS_USAGE",
      "--packaged runs one case on a device: add --adb <serial> --case <name>",
    );
  if (serial !== undefined && buildOnly)
    throw named("TN_NATIVE_TS_USAGE", "--adb runs the cases; drop --build-only");

  // The ledger is read for every native run: a malformed one fails closed rather than reading as
  // "no patches", and an ordinary native run is the patched one it declares.
  const ledger = wantNative ? loadLedger() : undefined;
  const info = wantNative
    ? await provision({ patches: withoutPatches ? [] : ledger.patches, log: () => {} })
    : undefined;
  const plan = cross
    ? { ...(await crossPlan(targetFile.target, outDir, serial, packaged)), buildOnly }
    : { buildOnly, render, outDir };
  const rows = [];
  let failed = false;
  for (const name of names) {
    const row = {
      name,
      reference: captureReference ? "PASS" : undefined,
      native: undefined,
      note: "",
    };
    const missing = missingExpectationNote(name);
    if (missing !== undefined) {
      failed = true;
      if (captureReference) row.reference = "FAIL";
      if (wantNative) row.native = "FAIL";
      row.note = missing;
      rows.push(row);
      continue;
    }
    if (captureReference) {
      let result;
      try {
        result = await runReference(name, plan);
      } catch (error) {
        result = { ok: false, note: error instanceof Error ? error.message : String(error) };
      }
      // A native compile-error case has no reference run to compare.
      row.reference = result.notApplicable ? "n/a" : result.ok ? "PASS" : "FAIL";
      if (!result.ok) {
        failed = true;
        row.note = result.note;
      }
    }
    if (wantNative) {
      let result;
      try {
        result = await runNative(name, info, target, plan);
        if (result.ok && render && !buildOnly && row.reference === "PASS") {
          const metrics = compareRenderFrames(
            path.join(plan.outDir, `${name}-reference.png`),
            path.join(plan.outDir, `${name}-native.png`),
          );
          result.note = `frames match: ${JSON.stringify(metrics)}; budget=${JSON.stringify(RENDER_BUDGET)}`;
        }
      } catch (error) {
        result = { ok: false, note: error instanceof Error ? error.message : String(error) };
      }
      row.native = result.ok ? "PASS" : "FAIL";
      if (!result.ok) {
        failed = true;
        row.note = row.note ? `${row.note}; ${result.note}` : result.note;
      } else if (result.note) {
        row.note = result.note;
      }
    }
    rows.push(row);
  }
  printTable(rows);
  if (cross) console.log(plan.summary(rows));
  if (withoutPatches) {
    reportRedSet(rows, ledger, info);
  } else if (failed) {
    process.exitCode = 1;
  }
}

/**
 * What `--without-patches` exists to answer: with the toolchain exactly as upstream ships it, are
 * the red cases the ones the ledger says each local patch is needed for? A declared case that stayed
 * green and a red case the ledger does not declare are both differences, and a difference exits 1
 * with the case names. So the exit code here is the comparison's, not the run's own.
 */
function reportRedSet(rows, ledger, info) {
  const red = rows
    .filter((row) => row.native === "FAIL")
    .map((row) => row.name)
    .sort();
  const verdict = compareRedToDeclared(ledger.declaredCases, red);
  const list = (names) => (names.length === 0 ? "none" : names.join(", "));
  console.log(`unpatched toolchain: ${info.binaryPath}`);
  console.log(
    `${ledger.patches.length} local patches (${ledger.patches.map((p) => p.id).join(", ") || "none applied"})`,
  );
  console.log(`declared red cases: ${list(ledger.declaredCases)}`);
  console.log(`red cases: ${list(red)}`);
  if (verdict.ok) {
    console.log("red set equals the declared set");
    return;
  }
  if (verdict.missing.length > 0) {
    console.log(`declared but green (the patch proves nothing): ${list(verdict.missing)}`);
  }
  if (verdict.extra.length > 0) {
    console.log(`red but undeclared (no ledger patch owns it): ${list(verdict.extra)}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
