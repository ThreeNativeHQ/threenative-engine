import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../../../../playtest/dist/runner/index.js";
import { exposureSettings } from "../../../template-assets/exposure.js";
import { qualifyExposureCapture } from "./captureProof.js";
import { assertHistogramProbe } from "./histogramProof.js";
import {
  type ExposureMutation,
  exposureMutationPlugin,
  meanMeterBaselinePlugin,
} from "./mutations.js";
import type { IExposureCaseProof } from "./proof.js";

const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, "../../../../..");
const artifacts = join(root, "artifacts/prd339-exposure");
interface IFixtureCase extends IExposureCaseProof {
  name: string;
  query: string;
  scenario: "static" | "cut" | "cut-frames" | "backlit";
  mutation?: ExposureMutation | "mean";
  /** Largest allowed move of the settled target from the dark-adapted room (backlit rooms only). */
  maxShiftStops?: number;
  /** Also run the synthetic-histogram probe page and compare it with the CPU reference. */
  histogram?: boolean;
}
// Scene-linear readings of the clipped-histogram meter (PRD-571), independently of adaptation.
// The 5c3b176 mean meter read 0.0019189 / 3.8961 on the same frames; the 10/90 log mean sits 0.37
// stop under that arithmetic mean at both lighting levels. This pins the meter against a
// constant/doubled-meter bug; display-tone metrics remain PRD341-owned.
const darkLuminance = 0.0014869463630020618;
const sunlightLuminance = 3.0578835010528564;
// The dark room's settled target; a backlit patch must leave it where it was.
const darkTargetStops = Math.log2(exposureSettings.key / darkLuminance);
const cases: IFixtureCase[] = [
  {
    name: "camera-eleven-reverse",
    query: "bright=1&stops=11&snapGain=0&deterministic=1&cameraCut=1",
    scenario: "cut-frames",
    cutStops: 11,
    cameraCut: true,
    deterministic: true,
    applied: true,
  },
  {
    name: "camera-one-reverse",
    query: "bright=1&stops=1&snapGain=0&deterministic=1&cameraCut=1",
    scenario: "cut-frames",
    cutStops: 1,
    cameraCut: true,
    deterministic: true,
    applied: true,
  },
  {
    name: "camera-linear-one",
    query: "bright=1&stops=1&snapGain=0&deterministic=1&cameraCut=1",
    scenario: "cut-frames",
    cutStops: 1,
    cameraCut: true,
    deterministic: true,
    applied: true,
    mutation: "linear",
  },
  {
    name: "camera-linear-eleven",
    query: "bright=1&stops=11&snapGain=0&deterministic=1&cameraCut=1",
    scenario: "cut-frames",
    cutStops: 11,
    cameraCut: true,
    deterministic: true,
    applied: true,
    mutation: "linear",
    reject: "TN_EXPOSURE_NOT_SETTLED",
  },
  {
    name: "dark-adapted",
    query: "bright=0",
    scenario: "static",
    applied: true,
    expectedLuminance: darkLuminance,
  },
  {
    name: "sunlight-adapted",
    query: "bright=1",
    scenario: "static",
    applied: true,
    expectedLuminance: sunlightLuminance,
  },
  {
    name: "eleven-stop-cut",
    query: "bright=0&stops=11&snapGain=0",
    scenario: "cut",
    cutStops: 11,
    applied: true,
    expectedLuminance: sunlightLuminance,
  },
  {
    name: "one-stop-cut",
    query: "bright=0&stops=1&snapGain=0",
    scenario: "cut",
    cutStops: 1,
    applied: true,
    expectedLuminance: darkLuminance * 2,
  },
  {
    name: "eleven-stop-reverse",
    query: "bright=1&stops=11&snapGain=0",
    scenario: "cut",
    cutStops: 11,
    applied: true,
    expectedLuminance: darkLuminance,
  },
  {
    name: "one-stop-reverse",
    query: "bright=1&stops=1&snapGain=0",
    scenario: "cut",
    cutStops: 1,
    applied: true,
    expectedLuminance: darkLuminance,
  },
  // PRD-571: a sky 10 stops over the room (8% of the frame) and a 1% sun disc 14 stops over it
  // must both leave the metered subject inside backlit.playtest.json's tone band.
  {
    name: "backlit-sky",
    query: "bright=0&backlit=sky",
    scenario: "backlit",
    applied: true,
    maxShiftStops: 0.25,
  },
  {
    name: "backlit-disc",
    query: "bright=0&backlit=disc",
    scenario: "backlit",
    applied: true,
    maxShiftStops: 0.1,
  },
  // Red control: the pre-PRD-571 clamped mean meter, served from git, fails the same two rooms.
  {
    name: "backlit-sky-mean",
    query: "bright=0&backlit=sky",
    scenario: "backlit",
    applied: true,
    mutation: "mean",
  },
  {
    name: "backlit-disc-mean",
    query: "bright=0&backlit=disc",
    scenario: "backlit",
    applied: true,
    mutation: "mean",
  },
  // PRD-571: the shipped adaptation shader walks synthetic histograms like the CPU reference.
  {
    name: "histogram-reference",
    query: "bright=0&histogramProbe=1",
    scenario: "static",
    applied: true,
    expectedLuminance: darkLuminance,
    histogram: true,
  },
  {
    name: "fixed-exposure",
    query: "enabled=0&bright=1",
    scenario: "static",
    applied: false,
    expectedLuminance: sunlightLuminance,
  },
  {
    name: "deterministic-eleven-reverse",
    query: "bright=1&stops=11&snapGain=0&deterministic=1",
    scenario: "cut-frames",
    cutStops: 11,
    deterministic: true,
    applied: true,
    expectedLuminance: darkLuminance,
  },
  {
    name: "deterministic-one-reverse",
    query: "bright=1&stops=1&snapGain=0&deterministic=1",
    scenario: "cut-frames",
    cutStops: 1,
    deterministic: true,
    applied: true,
    expectedLuminance: darkLuminance,
  },
  {
    name: "linear-one-stop",
    query: "bright=1&stops=1&snapGain=0&deterministic=1",
    scenario: "cut-frames",
    deterministic: true,
    cutStops: 1,
    applied: true,
    expectedLuminance: darkLuminance,
    mutation: "linear",
  },
  {
    name: "linear-eleven-stop",
    query: "bright=1&stops=11&snapGain=0&deterministic=1",
    scenario: "cut-frames",
    deterministic: true,
    cutStops: 11,
    applied: true,
    expectedLuminance: darkLuminance,
    mutation: "linear",
    reject: "TN_EXPOSURE_NOT_SETTLED",
  },
  {
    name: "disabled-unmeasured",
    query: "enabled=0&bright=1",
    scenario: "static",
    applied: false,
    expectedLuminance: sunlightLuminance,
    mutation: "disabled",
    reject: "TN_EXPOSURE_MEASUREMENT_MISSING",
  },
  {
    name: "doubled-meter",
    query: "bright=1",
    scenario: "static",
    applied: true,
    expectedLuminance: sunlightLuminance,
    mutation: "meter",
    reject: "TN_EXPOSURE_METER_RANGE",
  },
  {
    name: "wrong-clock",
    query: "bright=1",
    scenario: "static",
    applied: true,
    expectedLuminance: sunlightLuminance,
    mutation: "clock",
    reject: "TN_EXPOSURE_WRONG_CLOCK",
  },
];
// TN_EXPOSURE_CASES=<regex> runs a subset of the cases while iterating; CI runs them all.
const only = process.env.TN_EXPOSURE_CASES;
const selected =
  only === undefined ? cases : cases.filter(({ name }) => new RegExp(only).test(name));
await mkdir(artifacts, { recursive: true });
const sites = new Map<string, string>();
for (const mutation of [undefined, "linear", "disabled", "meter", "clock", "mean"] as const) {
  const name = mutation ?? "normal";
  if (!selected.some((item) => item.mutation === mutation)) continue;
  const site = join(artifacts, "sites", name);
  let mutationReceipt: unknown;
  await build({
    configFile: false,
    root: fixture,
    plugins:
      mutation === undefined
        ? []
        : mutation === "mean"
          ? [meanMeterBaselinePlugin()]
          : [
              exposureMutationPlugin(mutation, (receipt) => {
                mutationReceipt = receipt;
              }),
            ],
    build: { outDir: site, emptyOutDir: true },
  });
  if (mutation !== undefined && mutation !== "mean" && mutationReceipt === undefined)
    throw new Error(`${mutation}: mutation receipt missing.`);
  if (mutationReceipt !== undefined)
    await writeFile(join(site, "mutation.json"), `${JSON.stringify(mutationReceipt, null, 2)}\n`);
  sites.set(name, site);
}
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
  for (const item of selected) {
    const site = sites.get(item.mutation ?? "normal");
    if (site === undefined) throw new Error(`${item.name}: fixture build missing.`);
    const directory = join(artifacts, item.name);
    await mkdir(directory, { recursive: true });
    const report = await runStandalonePlaytest({
      artifactDirectory: directory,
      projectPath: fixture,
      scenarioPath: join(fixture, `${item.scenario}.playtest.json`),
      url: `http://127.0.0.1:4173/?${item.query}`,
      port: 0,
      server: {
        command: `TN_EXPOSURE_HTTP_LOG=${JSON.stringify(join(directory, "http-errors.jsonl"))} ${JSON.stringify(process.execPath)} ${JSON.stringify(vite)} preview --host 127.0.0.1 --port $PORT --strictPort --outDir ${JSON.stringify(site)}`,
        cwd: fixture,
      },
      timeoutMs: 180_000,
      headless: false,
      trace: false,
      target: "browser",
      browserArgs: WEBGPU_BROWSER_ARGS,
      allowSoftwareAdapter: true,
      captureArtifactScreenshots: true,
    });
    await writeFile(
      join(directory, "report.json"),
      `${JSON.stringify({ sourceSha, mutation: item.mutation ?? null, ...report }, null, 2)}\n`,
    );
    const screenshot = join(directory, "after.png");
    const marker = report.observations?.console
      .filter(({ text }) => text.startsWith("TN_AUTO_EXPOSURE:"))
      .at(-1);
    // A rejected mutation arm legitimately has no measurement; every other arm must.
    if (marker === undefined && item.reject === undefined)
      throw new Error(`${item.name}: GPU exposure observation missing.`);
    const shift =
      marker === undefined
        ? Number.NaN
        : Math.abs(
            JSON.parse(marker.text.slice("TN_AUTO_EXPOSURE:".length)).targetStops - darkTargetStops,
          );
    // Red control: the pre-PRD-571 clamped mean must fail the scenario and move the exposure
    // more than a stop. Its frame may be too dark to read tone at all, so any failure counts.
    if (item.mutation === "mean" && (report.pass || !(shift > 1)))
      throw new Error(
        `${item.name}: the mean meter must fail the backlit scene; pass=${report.pass}, shift=${shift} stops.`,
      );
    if (
      item.mutation !== "mean" &&
      item.maxShiftStops !== undefined &&
      !(shift <= item.maxShiftStops)
    )
      throw new Error(
        `${item.name}: backlit patch moved the settled exposure ${shift} stops, over ${item.maxShiftStops}.`,
      );
    const histogramCases =
      item.histogram === true
        ? assertHistogramProbe(report.observations?.console ?? [])
        : undefined;
    const result =
      item.mutation === "mean"
        ? { expectedFailure: report.diagnostics.map(({ code }) => code), shiftStops: shift }
        : {
            ...(await qualifyExposureCapture(report, item, screenshot, item.name)),
            shiftStops: shift,
          };
    results.push({
      name: item.name,
      sourceSha,
      mutation: item.mutation ?? null,
      ...result,
      ...(histogramCases === undefined ? {} : { histogramCases }),
      capture: report.capture,
      screenshot,
    });
    await writeFile(
      join(artifacts, "summary.json"),
      `${JSON.stringify({ sourceSha, correctnessOnly: true, results }, null, 2)}\n`,
    );
  }
  console.info(
    `PRD339_EXPOSURE_PROOF ${JSON.stringify({ sourceSha, captures: results.length, correctnessOnly: true })}`,
  );
}
