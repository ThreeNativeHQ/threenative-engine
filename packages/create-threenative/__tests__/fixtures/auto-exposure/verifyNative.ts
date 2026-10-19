import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  DesktopPlaytestDriver,
  type IStandalonePlaytestReport,
  runDesktopPlaytest,
} from "../../../../playtest/dist/runner/index.js";
import { regionMetrics } from "../../../../playtest/src/runner/steps.js";
import { pairedExposureSamples } from "./proof.js";

const fixture = dirname(fileURLToPath(import.meta.url));
const project = resolve(fixture, "../../..");
const root = resolve(project, "../..");
const runId = randomUUID();
const consumer = process.env.TN_EXPOSURE_CONSUMER === "1";
const output = join(root, "artifacts/prd339-native-exposure", runId);
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const runtime = resolve(
  process.env.TN_NATIVE_EXECUTABLE ?? join(root, "packages/runtime-native/build/tn-linux/mystral"),
);
const expectedLuminance = 3.0578835010528564; // Same bright-room browser fixture reference and 2% tolerance.
type ConsoleEntry = { text: string; type: string };

function marker(entries: readonly ConsoleEntry[], prefix: string) {
  const matches = entries.filter(({ text }) => text.includes(prefix));
  assert.equal(matches.length, 1, `Missing or duplicate ${prefix}`);
  const text = matches[0]?.text;
  assert.ok(text);
  return JSON.parse(text.slice(text.indexOf(prefix) + prefix.length));
}

function qualify(
  report: IStandalonePlaytestReport,
  consoleEntries: ConsoleEntry[],
  screenshot: Buffer,
) {
  const validation = marker(consoleEntries, "TN_EXPOSURE_NATIVE_VALIDATION:");
  assert.deepEqual(
    validation.errors,
    [null, null, null],
    "Native exposure GPU scopes were not clean",
  );
  assert.deepEqual(validation.scopes, ["internal", "out-of-memory", "validation"]);
  assert.equal(validation.updates, 180);
  assert.equal(report.pass, true, JSON.stringify(report.diagnostics));
  assert.equal(report.runtime, "native");
  assert.equal(report.target, "desktop");
  assert.equal(report.startup?.phase, "ready");
  assert.ok(
    !consoleEntries.some(
      ({ type, text }) =>
        type === "error" ||
        /\[error\]|Device error|device.lost|TN_FATAL|TN_NATIVE_START_FAILED|validation error|\[FATAL\]|\[WebGPU\].*Failed/i.test(
          text,
        ),
    ),
    "Native console reported an error or device loss",
  );
  const entries = consoleEntries.map(({ text }) => ({
    text: text.replace(/^\[(?:info|log)\]\s*/, ""),
  }));
  const samples = pairedExposureSamples(entries);
  assert.equal(samples.length, 180, "Exactly 180 accepted GPU readbacks are required");
  for (const [index, sample] of samples.entries()) {
    assert.equal(sample.clock, "deterministic-per-render");
    assert.equal(sample.updates, index + 1);
    assert.ok(Math.abs(sample.consumedSeconds - (index + 1) / 60) < 1e-9);
    assert.ok(Number.isFinite(sample.nodeTime) && Number.isInteger(sample.nodeFrameId));
    const previous = samples[index - 1];
    if (previous !== undefined) {
      assert.ok(sample.nodeTime > previous.nodeTime && sample.nodeFrameId > previous.nodeFrameId);
      assert.ok(sample.realConsumedSeconds >= previous.realConsumedSeconds);
    }
    assert.equal(sample.measurement.measured, true);
    assert.equal(sample.measurement.applied, true);
    assert.ok(
      [
        sample.measurement.exposureStops,
        sample.measurement.targetStops,
        sample.measurement.luminance,
        sample.realConsumedSeconds,
      ].every(Number.isFinite),
    );
    assert.ok(sample.measurement.luminance > 0);
    assert.equal(
      sample.measurement.settled,
      Math.abs(sample.measurement.targetStops - sample.measurement.exposureStops) <= 0.25,
    );
    assert.ok(Math.abs(Number(Reflect.get(sample, "deltaSeconds")) - 1 / 60) < 1e-12);
  }
  const terminal = samples.at(-1)?.measurement;
  assert.ok(terminal && terminal.settled === true);
  assert.ok(Number.isFinite(terminal.luminance) && terminal.luminance > 0);
  assert.ok(Math.abs(terminal.luminance / expectedLuminance - 1) <= 0.02);
  assert.ok(Math.abs(terminal.targetStops - Math.log2(0.18 / terminal.luminance)) < 0.001);
  assert.ok(Math.abs(terminal.exposureStops - terminal.targetStops) <= 0.25);
  assert.ok(Math.abs(terminal.exposureStops - Math.log2(0.18 / expectedLuminance)) <= 0.25);
  const warmup = marker(consoleEntries, "TN_EXPOSURE_WARMUP:");
  assert.equal(warmup.updates, 180);
  assert.deepEqual(warmup.measurement, terminal);
  assert.equal(marker(consoleEntries, "TN_EXPOSURE_READY:").warmupComplete, true);
  const provenance = marker(consoleEntries, "TN_PIPELINE_CAPTURE:");
  assert.ok(
    typeof provenance.adapter?.identity === "string" &&
      provenance.adapter.identity.startsWith("native:"),
  );
  assert.ok(!/null|swiftshader|llvmpipe|software/i.test(provenance.adapter.identity));
  const png = PNG.sync.read(screenshot);
  assert.equal(png.width, 640);
  assert.equal(png.height, 360);
  const pixels = regionMetrics(png, { x: 0, y: 0, width: 640, height: 360 });
  assert.ok(pixels.nonblankPixelRatio >= 0.15, "Native output failed the original nonblank gate");
  return {
    terminal,
    samples: samples.length,
    adapter: provenance.adapter.identity,
    pixels,
    validation,
  };
}

async function runVariant(inject: boolean) {
  const artifacts = join(output, inject ? "validation-negative" : "positive");
  await mkdir(artifacts, { recursive: true });
  const entry = join(artifacts, "entry.ts");
  await writeFile(
    entry,
    `import { createExposureFixture } from ${JSON.stringify(join(fixture, "game.ts"))};\nconsole.info("TN_EXPOSURE_CAPTURE_RUN:" + JSON.stringify(${JSON.stringify({ runId, variant: inject ? "validation-negative" : "positive" })}));\nexport default createExposureFixture({ enabled:true, bright:true, stops:11, snapGain:0, deterministic:true, nativeValidation:true, consumer:${consumer}, nativeValidationInject:${inject} });\n`,
  );
  const bundle = join(artifacts, "game.js");
  execFileSync(
    process.execPath,
    [
      "packages/runtime-native/scripts/bundle.mjs",
      "--project",
      project,
      "--entry",
      entry,
      "--target",
      "desktop",
      "--output",
      bundle,
    ],
    { cwd: root, stdio: "inherit" },
  );
  const scenario = JSON.parse(await readFile(join(fixture, "native-static.playtest.json"), "utf8"));
  if (inject) {
    scenario.steps[0].waitForResource = { id: "state", path: "sampleFrames", equals: 180 };
    scenario.assert.resources = scenario.assert.resources.slice(0, 1);
  }
  const scenarioPath = join(artifacts, "scenario.playtest.json");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  let driver: DesktopPlaytestDriver | undefined;
  const report = await runDesktopPlaytest(
    {
      artifactDirectory: artifacts,
      projectPath: project,
      scenarioPath,
      target: "desktop",
      desktop: {
        executable: runtime,
        hostArgs: ["run", bundle, "--width", "640", "--height", "360"],
      },
      headless: false,
      timeoutMs: 120000,
      trace: false,
      url: "",
    },
    {
      driverFactory(options) {
        driver = new DesktopPlaytestDriver(options);
        return driver;
      },
    },
  );
  assert.ok(driver);
  await writeFile(
    join(artifacts, "console.json"),
    JSON.stringify(await driver.captureConsole(), null, 2),
  );
  await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  const evidence = JSON.parse(
    await readFile(join(artifacts, "device-response-observations.json"), "utf8"),
  );
  assert.ok(
    Array.isArray(evidence.observations) && evidence.observations.length >= 4,
    "Raw native mailbox evidence is missing",
  );
  const replies = evidence.observations.map(
    (item: { method: string; body: string; order: number; requestId: string }, index: number) => {
      assert.equal(item.order, index + 1);
      assert.equal(item.requestId, String(index + 1));
      const response = JSON.parse(item.body);
      assert.equal(response.id, item.requestId);
      assert.equal(response.error, undefined);
      assert.ok(response.result && typeof response.result === "object");
      return { method: item.method, result: response.result };
    },
  );
  assert.equal(replies[0]?.method, "describe");
  assert.ok(replies[0].result.capabilities.includes("runtime.fixedStep"));
  assert.ok(
    replies.some(
      (reply: { method: string; result: { ready?: boolean } }) =>
        reply.method === "ready" && reply.result.ready === true,
    ),
  );
  const rawSamples = replies.filter((reply: { method: string }) => reply.method === "sample");
  assert.ok(rawSamples.length >= 2);
  for (const sample of rawSamples) assert.equal(sample.result.clock.mode, "fixed-step");
  const consoleEntries = JSON.parse(
    await readFile(join(artifacts, "console.json"), "utf8"),
  ) as ConsoleEntry[];
  if (consumer) {
    const observed = marker(consoleEntries, "TN_EXPOSURE_CONSUMER:");
    assert.deepEqual(observed, { installed: true, owned: true });
  }
  assert.deepEqual(
    marker(consoleEntries, "TN_EXPOSURE_CAPTURE_RUN:"),
    {
      runId,
      variant: inject ? "validation-negative" : "positive",
    },
    "Native host console must belong to this exact capture entry",
  );
  if (inject) {
    const paired = pairedExposureSamples(
      consoleEntries.map(({ text }) => ({ text: text.replace(/^\[(?:info|log)\]\s*/, "") })),
    );
    assert.equal(paired.length, 180);
    for (const [index, sample] of paired.entries()) {
      assert.equal(sample.updates, index + 1);
      assert.equal(sample.measurement.measured, true);
      assert.equal(sample.measurement.applied, true);
    }
    const validation = marker(consoleEntries, "TN_EXPOSURE_NATIVE_VALIDATION:");
    assert.ok(
      validation.errors.some(
        (error: unknown) => typeof error === "string" && /usage|buffer|validation/i.test(error),
      ),
      "Injected GPU validation error was not observed",
    );
    assert.throws(
      () => qualify(report, consoleEntries, Buffer.alloc(0)),
      /Native exposure GPU scopes were not clean/,
    );
    return { injectedValidationRejected: true };
  }
  const qualification = qualify(
    report,
    consoleEntries,
    await readFile(join(artifacts, "after.png")),
  );
  const before = PNG.sync.read(await readFile(join(artifacts, "before.png")));
  assert.equal(before.width, 640);
  assert.equal(before.height, 360);
  const beforePixels = regionMetrics(before, { x: 0, y: 0, width: 640, height: 360 });
  assert.ok(beforePixels.nonblankPixelRatio >= 0.15);
  const rawTerminal = rawSamples.at(-1)?.result.resources.state;
  assert.equal(rawTerminal.sampleFrames, 180);
  assert.equal(rawTerminal.validationDone, true);
  assert.deepEqual(rawTerminal.exposure, qualification.terminal);
  return { ...qualification, beforePixels };
}

const positive = await runVariant(false);
const negative = await runVariant(true);
const runtimeSha256 = createHash("sha256")
  .update(await readFile(runtime))
  .digest("hex");
await writeFile(
  join(output, "qualification.json"),
  JSON.stringify(
    {
      runId,
      sourceSha,
      consumer,
      positive,
      negative,
      runtimeSha256,
      diagnosticSource:
        "actual GPU error scopes and captured native host console; native GPUDevice.lost is an unsupported stub and is not a diagnostic producer; no normalized runtime diagnostic defaults",
    },
    null,
    2,
  ),
);
console.info(`Native exposure evidence: ${output}`);
console.info(
  `Native exposure desktop qualification passed: ${JSON.stringify({ positive, negative })}`,
);
