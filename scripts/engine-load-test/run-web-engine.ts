// The `tn-engine-web` arm (PRD-573 slice 7): the `tn-web` page, built with every `three` import bound to the
// Wasm engine (`examples/engine-load-test/vite.config.ts`, `TN_BENCH_TARGET=web-engine`), served from its own
// `dist-engine` and driven by the same collector. It refuses a Wasm older than the engine sources it was built
// from, because a stale artifact measures code that no longer exists.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { BenchError } from "./report.js";

const execFileAsync = promisify(execFile);

export const WEB_ENGINE_WASM = "packages/runtime-native/build/web/tn-native-engine-web.wasm";
export const ENGINE_DIST = "examples/engine-load-test/dist-engine";
/** What the Wasm is compiled from; a newer file here means the build in `build/web` is stale. */
// The CMake file is not here: a flag edit that leaves the output unchanged relinks nothing, so its mtime would
// fail the check forever; ninja relinks on a real flag change.
const ENGINE_SOURCES = ["packages/runtime-native/src/engine", "packages/runtime-native/include"];

async function newestMtime(entry: string): Promise<{ file: string; mtimeMs: number }> {
  const info = await stat(entry);
  if (!info.isDirectory()) return { file: entry, mtimeMs: info.mtimeMs };
  let newest = { file: entry, mtimeMs: 0 };
  for (const name of await readdir(entry)) {
    const found = await newestMtime(path.join(entry, name));
    if (found.mtimeMs > newest.mtimeMs) newest = found;
  }
  return newest;
}

export interface IWasmBuild {
  mtime: string;
  sha256: string;
}

/** The Wasm's identity, or `TN_BENCH_STALE_WASM` when an engine source is newer than it. */
export async function freshWasm(repoRoot: string): Promise<IWasmBuild> {
  const wasm = path.join(repoRoot, WEB_ENGINE_WASM);
  if (!existsSync(wasm))
    throw new BenchError(
      "TN_BENCH_WASM_MISSING",
      `${WEB_ENGINE_WASM} does not exist; build it with \`pnpm wasm:build\` from the repository root`,
      1,
    );
  const built = await stat(wasm);
  for (const source of ENGINE_SOURCES) {
    const newest = await newestMtime(path.join(repoRoot, source));
    if (newest.mtimeMs > built.mtimeMs)
      throw new BenchError(
        "TN_BENCH_STALE_WASM",
        `${path.relative(repoRoot, newest.file)} is newer than ${WEB_ENGINE_WASM}; rebuild tn-native-engine-web before measuring`,
        1,
      );
  }
  return {
    mtime: built.mtime.toISOString(),
    sha256: createHash("sha256")
      .update(await readFile(wasm))
      .digest("hex"),
  };
}

export interface IWebArtifact {
  /** Every `.js` file the build emitted, raw and gzip-9 bytes. */
  jsBytes: number;
  jsGzipBytes: number;
  /** Every `.wasm` file the build emitted (the engine and any decoder), raw and gzip-9 bytes. */
  wasmBytes: number;
  wasmGzipBytes: number;
}

/** The bytes a production web build ships, summed per kind. */
export async function webArtifactBytes(dist: string): Promise<IWebArtifact> {
  const totals = { jsBytes: 0, jsGzipBytes: 0, wasmBytes: 0, wasmGzipBytes: 0 };
  const assets = path.join(dist, "assets");
  for (const name of await readdir(assets)) {
    const kind = name.endsWith(".js") ? "js" : name.endsWith(".wasm") ? "wasm" : undefined;
    if (kind === undefined) continue;
    const bytes = await readFile(path.join(assets, name));
    totals[`${kind}Bytes`] += bytes.length;
    totals[`${kind}GzipBytes`] += gzipSync(bytes, { level: 9 }).length;
  }
  if (totals.jsBytes === 0)
    throw new BenchError("TN_BENCH_TN_BUILD_MISSING", `${assets} holds no .js`, 1);
  return totals;
}

/** `vite build` of the load test with `three` bound to the Wasm engine, into `dist-engine`. */
export async function buildWebEngineExample(repoRoot: string): Promise<void> {
  try {
    await execFileAsync("pnpm", ["--filter", "threenative-engine-load-test", "build"], {
      cwd: repoRoot,
      env: { ...process.env, TN_BENCH_TARGET: "web-engine" },
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    throw new BenchError(
      "TN_BENCH_TN_BUILD_FAILED",
      `the engine build failed: ${stderr || String(error)}`,
      1,
    );
  }
  if (!existsSync(path.join(repoRoot, ENGINE_DIST, "index.html")))
    throw new BenchError(
      "TN_BENCH_TN_BUILD_MISSING",
      `${ENGINE_DIST}/index.html does not exist`,
      1,
    );
}
