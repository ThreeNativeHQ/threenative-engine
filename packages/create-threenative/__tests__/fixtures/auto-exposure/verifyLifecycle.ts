import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../../../../playtest/dist/runner/index.js";
import { qualifyExposureLifecycle } from "./lifecycleProof.js";
import { assertExposureConsumer } from "./proof.js";
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, "../../../../..");
const consumer = process.env.TN_EXPOSURE_CONSUMER === "1";
const runId = randomUUID();
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const directory = join(root, "artifacts/prd339-lifecycle", runId);
const site = join(directory, "site");
await mkdir(directory, { recursive: true });
await build({ configFile: false, root: fixture, build: { outDir: site, emptyOutDir: true } });
const vite = join(dirname(fileURLToPath(import.meta.resolve("vite/package.json"))), "bin/vite.js");
const report = await runStandalonePlaytest({
  artifactDirectory: directory,
  projectPath: fixture,
  scenarioPath: join(fixture, "lifecycle.playtest.json"),
  url: `http://127.0.0.1:4173/?bright=1&stops=11&snapGain=0&deterministic=1${consumer ? "&consumer=1" : ""}`,
  port: 0,
  server: {
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(vite)} preview --host 127.0.0.1 --port $PORT --strictPort --outDir ${JSON.stringify(site)}`,
    cwd: fixture,
  },
  timeoutMs: 180000,
  headless: false,
  trace: false,
  target: "browser",
  browserArgs: WEBGPU_BROWSER_ARGS,
  allowSoftwareAdapter: true,
  captureArtifactScreenshots: true,
});
await writeFile(
  join(directory, "report.json"),
  `${JSON.stringify({ sourceSha, runId, consumer, ...report }, null, 2)}\n`,
);
if (consumer) assertExposureConsumer(report);
console.info(`PRD339_LIFECYCLE_PROOF ${JSON.stringify(qualifyExposureLifecycle(report))}`);
