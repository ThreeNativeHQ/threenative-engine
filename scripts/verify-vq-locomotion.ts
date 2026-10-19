import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../packages/create-threenative/src/build.js";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "examples/abyss-framework");
const scenario = "playtests/vq-locomotion-blend-spaces.playtest.json";
const output = path.join(root, "artifacts/vq04-animation/locomotion");
const site = path.join(output, "site");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
await mkdir(output, { recursive: true });
// The fixture loads `mannequin.glb` by name, so the project's own build cooks it and publishes the
// manifest the loader reads. Nothing here hand-writes an asset URL: the capture proves the clean
// asset load a generated game actually gets.
await build({ cwd: fixture, target: "web", viteArgs: ["--outDir", site] });
const manifest = JSON.parse(await readFile(path.join(site, "assets.manifest.json"), "utf8")) as {
  entries?: Record<string, { output?: string }>;
};
const model = manifest.entries?.["mannequin.glb"]?.output;
assert.ok(model, "The build manifest must name the compiled mannequin.");
assert.ok(
  (await readFile(path.join(site, model))).length > 0,
  "The cooked mannequin must be published.",
);

if (!process.argv.includes("--build-only")) {
  const run = path.join(output, "run");
  const report = await runStandalonePlaytest({
    allowSoftwareAdapter: true,
    artifactDirectory: run,
    browserArgs: [...WEBGPU_BROWSER_ARGS],
    headless: false,
    port: 0,
    projectPath: fixture,
    scenarioPath: scenario,
    server: {
      command: `pnpm exec vite preview --host 127.0.0.1 --port $PORT --strictPort --outDir ${JSON.stringify(site)}`,
      timeoutMs: 60_000,
    },
    timeoutMs: 300_000,
    trace: false,
    url: "http://127.0.0.1:5173/index.html?vq-locomotion",
  });
  await writeFile(
    path.join(run, "report.json"),
    `${JSON.stringify({ sourceSha, ...report }, null, 2)}\n`,
  );
  for (const diagnostic of report.diagnostics)
    assert.ok(
      diagnostic.severity !== "error" &&
        diagnostic.code !== "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" &&
        !/device\s*(lost|loss)|lost\s*(webgpu|gpu)\s*device/i.test(diagnostic.message),
      `${diagnostic.code}: ${diagnostic.message}`,
    );
  assert.ok(
    !report.observations?.console.some((entry) =>
      /device\s*(lost|loss)|lost\s*(webgpu|gpu)\s*device/i.test(entry.text),
    ),
    "device-loss console warning",
  );
  assert.equal(report.pass, true, JSON.stringify(report.diagnostics));
  assert.equal(report.capture?.rendererKind, "webgpu");
  assert.ok(
    report.capture?.adapter && Object.values(report.capture.adapter).some((v) => v.trim() !== ""),
  );
  // The names the scenario itself asks for, so a renamed step cannot leave a stale file passing.
  const authored = JSON.parse(await readFile(path.join(fixture, scenario), "utf8")) as {
    steps?: { screenshot?: string }[];
  };
  const names = (authored.steps ?? []).flatMap((step) =>
    step.screenshot === undefined ? [] : [`${step.screenshot}.png`],
  );
  assert.ok(
    names.length >= 12,
    `The scenario must name both views' frames, found ${names.length}.`,
  );
  const frames = await Promise.all(
    names.map(async (name) => {
      // A missing frame fails here rather than passing as an empty read.
      const png = await readFile(path.join(run, name));
      assert.ok(png.length > 0, `${name} is empty.`);
      return { name, sha256: createHash("sha256").update(png).digest("hex") };
    }),
  );
  // Both views name six frames each: the speed poses seen from the first-person eye, the direction
  // poses seen from the gait camera. Two identical captures would leave one named pose unproven, so
  // the frame count is the bound, not a rounded-up fraction of it.
  assert.equal(
    new Set(frames.map((frame) => frame.sha256)).size,
    frames.length,
    "Two captures are identical, so one named pose has no frame of its own.",
  );
  await writeFile(
    path.join(output, "summary.json"),
    `${JSON.stringify(
      { sourceSha, adapter: report.capture.adapter, frames, correctnessOnly: true },
      null,
      2,
    )}\n`,
  );
  console.log(
    `VQ04_LOCOMOTION_PROOF ${JSON.stringify({ sourceSha, frames: frames.length, correctnessOnly: true })}`,
  );
}
