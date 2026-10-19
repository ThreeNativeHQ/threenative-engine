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
import { exposureMutationPlugin } from "./mutations.js";
import { assertExposureConsumer } from "./proof.js";
import { qualifyExposureSnap } from "./snapProof.js";
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, "../../../../..");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const runId = randomUUID();
const consumer = process.env.TN_EXPOSURE_CONSUMER === "1";
const artifacts = join(root, "artifacts/prd339-snap-response", runId);
const site = join(artifacts, "site");
await mkdir(artifacts, { recursive: true });
await build({ configFile: false, root: fixture, build: { outDir: site, emptyOutDir: true } });
const vite = join(dirname(fileURLToPath(import.meta.resolve("vite/package.json"))), "bin/vite.js");
const results = [];
const variants = [
  { snapGain: 1 as const, missingWire: false },
  { snapGain: 0 as const, missingWire: false },
];
if (consumer) variants.push({ snapGain: 1, missingWire: true });
for (const { snapGain, missingWire } of variants) {
  const mutationRecords: unknown[] = [];
  if (missingWire)
    await build({
      configFile: false,
      root: fixture,
      build: { outDir: site, emptyOutDir: true },
      plugins: [exposureMutationPlugin("consumer", (record) => mutationRecords.push(record))],
    });
  const directory = join(artifacts, missingWire ? "consumer-missing-wire" : `gain-${snapGain}`);
  await mkdir(directory, { recursive: true });
  const report = await runStandalonePlaytest({
    artifactDirectory: directory,
    projectPath: fixture,
    scenarioPath: join(fixture, "cut-frames.playtest.json"),
    url: `http://127.0.0.1:4173/?bright=1&stops=11&snapGain=${snapGain}&deterministic=1&cameraCut=1${consumer ? "&consumer=1" : ""}`,
    port: 0,
    server: {
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(vite)} preview --host 127.0.0.1 --port $PORT --strictPort --outDir ${JSON.stringify(site)}`,
      cwd: fixture,
    },
    timeoutMs: 120000,
    headless: false,
    trace: false,
    target: "browser",
    browserArgs: WEBGPU_BROWSER_ARGS,
    allowSoftwareAdapter: true,
    captureArtifactScreenshots: true,
  });
  await writeFile(
    join(directory, "report.json"),
    `${JSON.stringify({ sourceSha, runId, snapGain, missingWire, mutationRecords, ...report }, null, 2)}\n`,
  );
  const response = qualifyExposureSnap(report, snapGain);
  if (missingWire) {
    let rejected = false;
    try {
      assertExposureConsumer(report);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("actual graph")) throw error;
      rejected = true;
    }
    if (!rejected) throw new Error("Missing-wire negative control did not fail the consumer gate.");
  } else if (consumer) assertExposureConsumer(report);
  results.push({
    snapGain,
    missingWire,
    expectedConsumerFailure: missingWire,
    ...response,
    capture: report.capture,
  });
}
await writeFile(
  join(artifacts, "summary.json"),
  `${JSON.stringify({ sourceSha, runId, consumer, criterion: "owner-approved AC2 first-update response", firstUpdateBudget: 1, adaptationDelta: 1 / 60, toleranceStops: 0.25, results }, null, 2)}\n`,
);
console.info(`PRD339_SNAP_RESPONSE_PROOF ${JSON.stringify(results)}`);
