import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../../../../playtest/dist/runner/index.js";
import { qualifyColdBoot, qualifyColdBootSpread } from "./coldBootProof.js";

const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, "../../../../..");
const artifacts = join(root, "artifacts/prd339-cold-boot");
const site = join(artifacts, "site");
await mkdir(artifacts, { recursive: true });
await build({ configFile: false, root: fixture, build: { outDir: site, emptyOutDir: true } });
if (!process.argv.includes("--build-only")) {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const vite = join(
    dirname(fileURLToPath(import.meta.resolve("vite/package.json"))),
    "bin/vite.js",
  );
  const results = [];
  for (const snapGain of [1, 0] as const) {
    const runs = [];
    for (let launch = 0; launch < 10; launch++) {
      const launchId = randomUUID();
      const directory = join(artifacts, `snap-${snapGain}`, String(launch));
      await mkdir(directory, { recursive: true });
      const report = await runStandalonePlaytest({
        artifactDirectory: directory,
        projectPath: fixture,
        scenarioPath: join(fixture, "cold-boot.playtest.json"),
        url: `http://127.0.0.1:4173/?bright=1&stops=11&coldBoot=1&snapGain=${snapGain}`,
        port: 0,
        server: {
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(vite)} preview --host 127.0.0.1 --port $PORT --strictPort --outDir ${JSON.stringify(site)}`,
          cwd: fixture,
        },
        timeoutMs: 120_000,
        headless: false,
        trace: false,
        target: "browser",
        browserArgs: WEBGPU_BROWSER_ARGS,
        allowSoftwareAdapter: true,
        captureArtifactScreenshots: true,
      });
      await writeFile(
        join(directory, "report.json"),
        `${JSON.stringify({ sourceSha, launch, launchId, snapGain, ...report }, null, 2)}\n`,
      );
      for (const name of ["before.png", "after.png", "tone-0.png"])
        if ((await stat(join(directory, name))).size === 0)
          throw new Error(`Cold boot ${snapGain}/${launch}: ${name} missing.`);
      const proof = qualifyColdBoot(report);
      runs.push({ launch, launchId, ...proof, capture: report.capture });
      await writeFile(
        join(artifacts, `snap-${snapGain}.json`),
        `${JSON.stringify({ sourceSha, snapGain, boundary: "three accepted live-clock GPU updates", runs }, null, 2)}\n`,
      );
    }
    results.push({ snapGain, ...qualifyColdBootSpread(runs), runs });
  }
  // Repeatability and snap responsiveness are independent acceptance gates.
  // Preserve the zero-gain boot measurements; its required red gate is verifySnap.ts.
  await writeFile(
    join(artifacts, "summary.json"),
    `${JSON.stringify({ sourceSha, correctnessOnly: true, results }, null, 2)}\n`,
  );
  if (results[0]?.pass !== true)
    throw new Error(
      `Cold-boot spread qualification failed: ${JSON.stringify(results.map(({ snapGain, spread, pass }) => ({ snapGain, spread, pass })))}`,
    );
  console.info(`PRD339_COLD_BOOT_PROOF ${JSON.stringify({ sourceSha, launches: 20, limit: 0.1 })}`);
}
