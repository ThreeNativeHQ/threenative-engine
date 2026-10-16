import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaytestScenario } from "../../../../playtest/dist/index.js";
import { runDesktopPlaytest } from "../../../../playtest/dist/runner/index.js";
import {
  assertNativeDecalCapture,
  evaluateDecalPixels,
  nativeDecalCases,
  nativeDecalScenario,
} from "./native-proof.js";

const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, "../../../../..");
const artifacts = join(root, "artifacts/vq11-decals-native");
const bundleOnly = process.argv.includes("--bundle-only");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fileHash = async (path: string) => hash(await readFile(path));
const write = async (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const run = (script: string, args: string[]) =>
  execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" });
await mkdir(artifacts, { recursive: true });
if (!bundleOnly)
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    "",
    "Native capture requires a clean committed source tree.",
  );
const summary: {
  sourceSha: string;
  pass: boolean;
  qualification: string;
  results: unknown[];
  identity?: unknown;
  error?: string;
} = {
  sourceSha,
  pass: false,
  qualification:
    "Packaged Linux ARM V8 software-adapter correctness. No mobile or hardware-performance claim.",
  results: [],
};
await write(join(artifacts, "attempt.json"), {
  sourceSha,
  runId: process.env.GITHUB_RUN_ID,
  bundleOnly,
});
try {
  const bundles = new Map<string, string>();
  for (const entry of new Set(nativeDecalCases.map((item) => item.entry))) {
    const bundle = join(artifacts, "variants", entry.replace(".ts", ".js"));
    run("packages/runtime-native/scripts/bundle.mjs", [
      "--project",
      fixture,
      "--entry",
      entry,
      "--target",
      "desktop",
      "--native-backend",
      "--output",
      bundle,
    ]);
    bundles.set(entry, bundle);
  }
  if (bundleOnly) {
    console.info("VQ11 native bundles built; no native execution or screenshot claim.");
  } else {
    const runtime = process.env.THREENATIVE_RUNTIME_BINARY;
    assert.ok(runtime, "THREENATIVE_RUNTIME_BINARY must name this job's actual native build.");
    assert.equal(process.platform, "linux");
    assert.equal(process.arch, "arm64");
    const version = execFileSync(runtime, ["--version"], { encoding: "utf8", timeout: 10_000 });
    assert.match(version, /\+ v8 build\b/iu, "Expected the actual ARM V8 host.");
    const capabilities = { engine: "v8", version: version.trim() };
    const runtimeBytes = await readFile(runtime);
    const assets = ["receiver.glb", "assets.manifest.json"];
    const assetHashes = Object.fromEntries(
      await Promise.all(
        assets.map(async (name) => [name, await fileHash(join(fixture, "public", name))]),
      ),
    );
    const config = join(artifacts, "packaging-config.json");
    await write(config, {
      app: { id: "com.threenative.vq11", name: "VQ11 bounded decals", version: "1.0.0", build: 1 },
      display: { fullscreen: false, maxFps: 60 },
      window: { width: 960, height: 540, maximized: false, resizable: false },
      renderer: { preferWebGPU: true, resolutionScale: 1 },
      ui: { renderer: "native" },
    });
    const executables = new Map<
      string,
      { path: string; sha256: string; bundle: string; bundleSha256: string }
    >();
    for (const [entry, bundle] of bundles) {
      const executable = join(artifacts, "variants", entry.replace(".ts", ""), "decals");
      run("packages/runtime-native/scripts/package-desktop.mjs", [
        "--bundle",
        bundle,
        "--assets",
        join(fixture, "public"),
        "--runtime",
        runtime,
        "--config",
        config,
        "--mode",
        "debug",
        "--output",
        executable,
      ]);
      const packaged = await readFile(executable);
      assert.equal(
        hash(packaged.subarray(0, runtimeBytes.length)),
        hash(runtimeBytes),
        "Package must carry the exact selected runtime prefix.",
      );
      executables.set(entry, {
        path: executable,
        sha256: hash(packaged),
        bundle,
        bundleSha256: await fileHash(bundle),
      });
    }
    summary.identity = {
      runtimeSha256: hash(runtimeBytes),
      capabilities,
      assetHashes,
      executables: Object.fromEntries(executables),
    };
    await write(join(artifacts, "summary.json"), summary);
    for (const item of nativeDecalCases) {
      const authored = await loadPlaytestScenario(fixture, `${item.scenario}.playtest.json`);
      const directory = join(artifacts, item.name);
      await mkdir(directory, { recursive: true });
      const scenarioPath = join(directory, "scenario.playtest.json");
      await write(scenarioPath, nativeDecalScenario(authored));
      await loadPlaytestScenario(root, scenarioPath);
      const executable = executables.get(item.entry);
      assert.ok(executable, "Native variant was not packaged.");
      const report = await runDesktopPlaytest({
        target: "desktop",
        projectPath: fixture,
        scenarioPath,
        artifactDirectory: directory,
        desktop: {
          executable: executable.path,
          hostArgs: ["--windowed", "--width", "960", "--height", "540"],
        },
        allowSoftwareAdapter: true,
        headless: false,
        timeoutMs: 180_000,
        trace: false,
        url: "",
      });
      await write(join(directory, "report.json"), { sourceSha, ...report });
      // A crashed host can omit console.json; preserve/report its real diagnostics first.
      const nativeConsole: unknown = await readFile(join(directory, "console.json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      assertNativeDecalCapture(report, nativeConsole);
      const png = await readFile(join(directory, "after.png"));
      const pixels = evaluateDecalPixels(png, authored);
      const failed = pixels.assertions
        .filter(({ pass }) => !pass)
        .map(({ id }) => id)
        .sort();
      const pass = JSON.stringify(failed) === JSON.stringify(item.expectedPixelFailures);
      summary.results.push({
        name: item.name,
        pass,
        negativeControl: item.expectedPixelFailures.length > 0,
        capture: report.capture,
        state: report.observations?.resources?.state?.after,
        screenshotSha256: hash(png),
        pixels,
        diagnostics: report.diagnostics,
      });
      await write(join(artifacts, "summary.json"), summary);
      assert.ok(pass, `Native ${item.name} pixel predicates failed: ${JSON.stringify(failed)}`);
      assert.equal(
        await fileHash(executable.path),
        executable.sha256,
        "Packaged executable changed during capture.",
      );
    }
    assert.equal(await fileHash(runtime), hash(runtimeBytes), "Runtime changed during capture.");
    for (const [name, expected] of Object.entries(assetHashes))
      assert.equal(
        await fileHash(join(fixture, "public", name)),
        expected,
        "Receiver assets changed.",
      );
    for (const entry of executables.values()) {
      assert.equal(await fileHash(entry.path), entry.sha256);
      assert.equal(await fileHash(entry.bundle), entry.bundleSha256);
    }
    summary.pass = true;
  }
} catch (error) {
  summary.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  throw error;
} finally {
  await write(join(artifacts, "summary.json"), summary);
}
