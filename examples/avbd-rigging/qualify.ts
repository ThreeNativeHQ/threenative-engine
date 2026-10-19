import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IPlaytestCaptureProvenance } from "@threenative/playtest";
import { parseStandalonePlaytestArgs } from "@threenative/playtest/runner";
import { assertRiggingCapture, qualifyRiggingDraw, riggingScenario } from "./verify-capture.js";
import { qualifyRiggingTiming } from "./verify-comparison.js";

// Keep the existing runner's flags, display/lock ownership, target routing and exit codes.
const args = process.argv.slice(2);
const config = parseStandalonePlaytestArgs(args);
if (config.scenarioPaths !== undefined && config.scenarioPaths.length !== 1)
  throw new Error("TN_AVBD_QUALIFICATION: one frozen scenario per identified attempt.");
const mode = riggingScenario(readFileSync(resolve(config.projectPath, config.scenarioPath)));
if (mode === "benchmark" && config.liveClock !== true)
  throw new Error("TN_AVBD_QUALIFICATION: the frozen comparison requires --live-clock.");
if (config.target !== "browser" && config.target !== "desktop")
  throw new Error(
    "TN_AVBD_QUALIFICATION: this prototype qualifies browser and Linux desktop only.",
  );
if (config.allowSoftwareAdapter === true || (config.target === "browser" && config.headless))
  throw new Error("TN_AVBD_QUALIFICATION: a recorded hardware WebGPU capture is required.");
if (mode !== "benchmark" && config.liveClock === true)
  throw new Error(
    "TN_AVBD_QUALIFICATION: correctness and lifecycle require the existing exact fixed-step clock; live clock belongs to performance comparisons.",
  );
if (config.captureArtifactScreenshots === false)
  throw new Error("TN_AVBD_QUALIFICATION: captured rope/sail/flag evidence is required.");
const beforePath = join(config.artifactDirectory, "before.png");
const afterPath = join(config.artifactDirectory, "after.png");
const receiptPath = join(config.artifactDirectory, "rigging-qualification.json");
const comparisonPath = join(config.artifactDirectory, "rigging-comparison.json");
const consolePath = join(config.artifactDirectory, "console.json");
if ([beforePath, afterPath, receiptPath, comparisonPath].some(existsSync))
  throw new Error(
    "TN_AVBD_QUALIFICATION: use a fresh --artifacts directory; prior captures cannot qualify another attempt.",
  );
const packagePath = fileURLToPath(import.meta.resolve("@threenative/playtest/package.json"));
const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { bin: Record<string, string> };
const cli = manifest.bin["threenative-playtest"];
if (typeof cli !== "string")
  throw new Error("TN_AVBD_QUALIFICATION: installed runner entry is missing.");
const result = spawnSync(process.execPath, [join(dirname(packagePath), cli), ...args], {
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024, // the comparison report carries every staged resource sample
  stdio: ["ignore", "pipe", "inherit"],
});
if (result.error !== undefined)
  throw new Error("TN_AVBD_QUALIFICATION: runner process failed.", { cause: result.error });
if (result.status !== 0) {
  process.stdout.write(result.stdout ?? "");
  process.exitCode = result.status ?? 2;
} else {
  const report = JSON.parse(result.stdout) as {
    pass?: unknown;
    capture?: IPlaytestCaptureProvenance;
  };
  if (report.pass !== true)
    throw new Error("TN_AVBD_QUALIFICATION: successful runner exit has no passing report.");
  let draw: ReturnType<typeof qualifyRiggingDraw> | { pass: false; error: string };
  try {
    assertRiggingCapture(report.capture, config.target);
    draw = qualifyRiggingDraw(
      readFileSync(beforePath),
      readFileSync(afterPath),
      mode === "correctness",
    );
  } catch (error) {
    draw = { pass: false, error: String(error) };
  }
  if (mode !== "benchmark") {
    const qualified = { ...report, pass: draw.pass, drawQualification: draw };
    const text = `${JSON.stringify(qualified, null, 2)}\n`;
    writeFileSync(receiptPath, text);
    process.stdout.write(text);
    process.exitCode = draw.pass ? 0 : 1;
  } else {
    let comparison: ReturnType<typeof qualifyRiggingTiming> | { error: string };
    try {
      comparison = qualifyRiggingTiming(JSON.parse(readFileSync(consolePath, "utf8")));
    } catch (error) {
      comparison = { error: String(error) };
    }
    const disposition =
      "performanceDisposition" in comparison ? comparison.performanceDisposition : null;
    const decision = disposition === "PASS" ? "GO" : disposition === "FAIL" ? "NO-GO" : null;
    const receipt = { ...report, drawQualification: draw, comparison, decision };
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    writeFileSync(comparisonPath, text);
    process.stdout.write(text);
    process.exitCode = draw.pass && (disposition === "PASS" || disposition === "FAIL") ? 0 : 1;
  }
}
