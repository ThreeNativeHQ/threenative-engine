import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_NAMES,
  generateNativeAssetFixture,
  inspectFixtureModel,
} from "../examples/abyss-framework/vq-assets/generate.js";
import config from "../examples/abyss-framework/vq-assets/threenative.config.js";
import {
  build,
  resolveRuntimeAssetCapabilities,
} from "../packages/create-threenative/src/build.js";
import { hashArtifact } from "../packages/create-threenative/src/buildReport.js";
import { runDesktopPlaytest } from "../packages/playtest/dist/runner/index.js";
import {
  assertNativeAssetCapture,
  inspectNativeAssetScreenshot,
} from "./native-asset-capture-proof.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "examples/abyss-framework/vq-assets");
const output = path.join(root, "artifacts/vq01-native-assets");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const write = async (name: string, value: unknown) =>
  writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await write("attempt.json", { sourceSha, runId: process.env.GITHUB_RUN_ID, status: "started" });
try {
  const runtime = process.env.THREENATIVE_RUNTIME_BINARY;
  assert.ok(runtime, "THREENATIVE_RUNTIME_BINARY must name this run's actual native build");
  const capabilities = resolveRuntimeAssetCapabilities("desktop", runtime);
  assert.equal(
    capabilities.engine,
    "quickjs",
    "This proof must execute the actual QuickJS fallback",
  );
  assert.deepEqual(capabilities.decoders, { ktx2: false, meshopt: false, draco: false });
  await write("runtime.json", capabilities);
  await rm(path.join(project, ".generated"), { recursive: true, force: true });
  const source = path.join(project, config.assets.source);
  const ktx2 = await generateNativeAssetFixture(source);
  await build({ cwd: project, target: "desktop" });
  const cookedRoot = path.join(project, config.assets.output);
  const manifest = JSON.parse(
    await readFile(path.join(cookedRoot, "assets.manifest.json"), "utf8"),
  );
  const models = [];
  for (const [index, name] of MODEL_NAMES.entries()) {
    const authoredPath = path.join(source, `${name}.glb`);
    const cookedPath = path.join(cookedRoot, manifest.entries[`${name}.glb`].output);
    const authored = await inspectFixtureModel(authoredPath);
    const cooked = await inspectFixtureModel(cookedPath);
    assert.ok(
      authored.extensions.includes(
        index === 0 ? "EXT_meshopt_compression" : "KHR_draco_mesh_compression",
      ),
    );
    assert.ok(!cooked.extensions.some((extension) => /meshopt|draco|basisu/u.test(extension)));
    assert.deepEqual(cooked.positions, authored.positions, `${name}: decoded vertex values`);
    assert.equal(cooked.triangles, authored.triangles);
    assert.deepEqual(cooked.animation, authored.animation);
    assert.deepEqual(
      cooked.images.map((image) => image.data),
      authored.images.map((image) => image.data),
    );
    models.push({
      name,
      sourceSha256: sha256(await readFile(authoredPath)),
      cookedSha256: sha256(await readFile(cookedPath)),
      sourceEncodedBytes: authored.encodedBytes,
      cookedEncodedBytes: cooked.encodedBytes,
      decodedGeometryBytes: cooked.decodedGeometryBytes,
      decodedImageBytes: cooked.images.reduce((sum, image) => sum + image.data.length, 0),
      triangles: cooked.triangles,
    });
  }
  assert.match(manifest.entries["checker.png"].output, /\.png$/u);
  assert.doesNotMatch(
    await readFile(path.join(project, ".threenative/build/game.js"), "utf8"),
    /\bWebAssembly\b/u,
  );
  await write("cook.json", {
    models,
    manifest,
    measurement:
      "Encoded bytes and decoded CPU buffer bytes are separate; no GPU memory reduction claimed.",
  });
  const executable = path.join(project, "dist-native/vq-native-assets");
  const runtimeBytes = await readFile(runtime);
  const packagedBytes = await readFile(executable);
  assert.equal(
    sha256(packagedBytes.subarray(0, runtimeBytes.length)),
    sha256(runtimeBytes),
    "Packaged executable must carry the exact selected runtime bytes before its appended game",
  );
  const packaged = await hashArtifact(executable);
  const buildReport = JSON.parse(await readFile(`${executable}.build-report.json`, "utf8"));
  assert.equal(
    buildReport.artifact.sha256,
    packaged.sha256,
    "Build report must describe the actual executable",
  );
  await writeFile(path.join(source, "authored.ktx2"), ktx2);
  await assert.rejects(
    build({ cwd: project, target: "desktop" }),
    /TN_NATIVE_KTX2_UNSUPPORTED.*authored.ktx2/u,
  );
  assert.deepEqual(
    await hashArtifact(executable),
    packaged,
    "Codec refusal must preserve the previous package",
  );
  const report = await runDesktopPlaytest({
    target: "desktop",
    desktop: { executable, hostArgs: ["--windowed"] },
    projectPath: project,
    scenarioPath: "../playtests/vq-native-asset-capabilities.playtest.json",
    artifactDirectory: output,
    allowSoftwareAdapter: true,
    headless: false,
    timeoutMs: 120_000,
    trace: false,
    url: "",
  });
  await write("report.json", report);
  assert.equal(report.pass, true, JSON.stringify(report.diagnostics));
  const nativeConsole: unknown = JSON.parse(
    await readFile(path.join(output, "console.json"), "utf8"),
  );
  assertNativeAssetCapture(report, nativeConsole);
  const bytes = await readFile(path.join(output, "after.png"));
  const pixels = inspectNativeAssetScreenshot(bytes);
  assert.deepEqual(await hashArtifact(executable), packaged);
  await write("summary.json", {
    pass: true,
    sourceSha,
    runId: process.env.GITHUB_RUN_ID,
    qualification:
      "Packaged Linux QuickJS fallback correctness on a named hosted software adapter. No Android, iOS, native compressed-codec admission or hardware-performance claim.",
    observability:
      "Native host console, live readiness and resource observations; runtime.diagnostics is not exposed by this bridge.",
    runtime: capabilities,
    packaged,
    models,
    capture: report.capture,
    pixels,
    screenshotSha256: sha256(bytes),
    refusedCodec: "authored KTX2",
    previousPackagePreserved: true,
  });
} catch (error) {
  await write("failure.json", {
    pass: false,
    sourceSha,
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  throw error;
}
