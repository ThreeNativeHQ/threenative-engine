import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../examples/abyss-framework/node_modules/vite/dist/node/index.js";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "examples/abyss-framework");
const output = path.join(root, "artifacts/vq04-animation");
const site = path.join(output, "site");
await mkdir(output, { recursive: true });
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
await build({
  configFile: false,
  root: fixture,
  publicDir: false,
  build: {
    outDir: site,
    emptyOutDir: true,
    rollupOptions: { input: path.join(fixture, "animation-reversal.html") },
  },
});
// The framework probes a manifest at boot. Publish Vite's actual emitted model URL so
// the capture proves a clean asset load rather than suppressing an expected 404.
const models = (await readdir(path.join(site, "assets"))).filter((file) =>
  /^mannequin-.*\.glb$/.test(file),
);
assert.equal(models.length, 1, "Capture build must emit exactly one mannequin GLB.");
const modelUrl = `/assets/${models[0]}`;
await writeFile(
  path.join(site, "assets.manifest.json"),
  `${JSON.stringify({ version: 1, entries: { [modelUrl]: { output: modelUrl } } }, null, 2)}\n`,
);

if (!process.argv.includes("--build-only")) {
  const reports = [];
  for (const tick of [24, 25, 26, 48, 108]) {
    const directory = path.join(output, `tick-${tick}`);
    const report = await runStandalonePlaytest({
      allowSoftwareAdapter: true,
      artifactDirectory: directory,
      browserArgs: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      port: 0,
      projectPath: fixture,
      scenarioPath: "playtests/animation-reversal.playtest.json",
      server: {
        command: `pnpm exec vite preview --host 127.0.0.1 --port $PORT --strictPort --outDir ${JSON.stringify(site)}`,
        timeoutMs: 60_000,
      },
      timeoutMs: 180_000,
      trace: false,
      url: `http://127.0.0.1:5173/animation-reversal.html?tick=${tick}`,
    });
    await writeFile(
      path.join(directory, "report.json"),
      `${JSON.stringify({ sourceSha, ...report }, null, 2)}\n`,
    );
    for (const diagnostic of report.diagnostics)
      assert.ok(
        diagnostic.severity !== "error" &&
          diagnostic.code !== "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" &&
          !/device\s*(lost|loss)|lost\s*(webgpu|gpu)\s*device/i.test(diagnostic.message),
        `${tick}: ${diagnostic.code}: ${diagnostic.message}`,
      );
    assert.ok(
      !report.observations?.console.some((entry) =>
        /device\s*(lost|loss)|lost\s*(webgpu|gpu)\s*device/i.test(entry.text),
      ),
      `${tick}: device-loss console warning`,
    );
    assert.equal(report.pass, true, `${tick}: ${JSON.stringify(report.diagnostics)}`);
    assert.equal(report.capture?.rendererKind, "webgpu");
    assert.ok(
      report.capture?.adapter && Object.values(report.capture.adapter).some((v) => v.trim() !== ""),
    );
    const line = report.observations?.console
      .filter((entry) => entry.text.startsWith("TN_ANIMATION_REVERSAL:"))
      .at(-1);
    assert.ok(line, `${tick}: missing actual gait measurement`);
    const measurement = JSON.parse(line.text.slice("TN_ANIMATION_REVERSAL:".length));
    assert.equal(measurement.tick, tick);
    assert.ok(measurement.bones >= 60 && measurement.maxAnimatedRadians > 0.2);
    assert.ok(measurement.maxWeightError <= 1e-6 && measurement.maxPhaseJump <= 1e-6);
    assert.ok(measurement.maxPoseJumpMetres <= 1e-6 && measurement.maxPoseJumpRadians <= 1e-6);
    const png = await readFile(path.join(directory, "after.png"));
    assert.ok(png.length > 0);
    reports.push({
      tick,
      sourceSha,
      measurement,
      capture: report.capture,
      sha256: createHash("sha256").update(png).digest("hex"),
    });
    await writeFile(
      path.join(output, "summary.json"),
      `${JSON.stringify({ sourceSha, correctnessOnly: true, reports }, null, 2)}\n`,
    );
  }
  assert.equal(reports.at(-1)?.measurement.reversals, 9);
  assert.equal(reports.at(-1)?.measurement.activeActions, 1);
  assert.ok(
    new Set(reports.map((report) => report.sha256)).size >= 4,
    "The gait captures must contain actual pose changes.",
  );
  console.log(
    `VQ04_ANIMATION_PROOF ${JSON.stringify({ sourceSha, captures: reports.length, correctnessOnly: true })}`,
  );
}
