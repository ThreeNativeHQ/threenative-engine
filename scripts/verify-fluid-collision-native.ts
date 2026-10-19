import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { PNG } from "pngjs";
import type { IStandalonePlaytestReport } from "../packages/playtest/src/runner/runner.js";
import { regionMetrics } from "../packages/playtest/src/runner/steps.js";
import { type IPlaytestScenario, loadPlaytestScenario } from "../packages/playtest/src/scenario.js";
import { assertFluidOutcome } from "./fluid-collision-proof.js";

export function nativeFluidScenario(authored: IPlaytestScenario): IPlaytestScenario {
  assert.ok(
    authored.assert?.resources?.length,
    "Native fluid requires authored resource predicates",
  );
  assert.equal(authored.warmupFrames, 0, "Native fluid baseline cannot consume a measured step");
  const { sourcePath: _sourcePath, ...scenario } = authored;
  return {
    ...scenario,
    target: "desktop",
    artifacts: { screenshots: "before-after", console: true },
    assert: {
      resources: authored.assert.resources,
    },
  };
}

export function assertNativeFluidCapture(
  report: Pick<
    IStandalonePlaytestReport,
    "pass" | "runtime" | "target" | "diagnostics" | "assertionResults" | "observations"
  >,
  nativeConsole: unknown,
  expectedFailure?: string,
): void {
  assertFluidOutcome(report, expectedFailure);
  assert.equal(report.runtime, "native", "Fluid collision requires the actual native runtime");
  assert.equal(report.target, "desktop", "Fluid collision requires the desktop target");
  for (const [phase, completedScopes] of [
    ["before", 1],
    ["after", 2],
  ] as const) {
    const gpu = report.observations?.resources.FluidGPU?.[phase] as
      | Record<string, unknown>
      | undefined;
    assert.equal(
      gpu?.completedScopes,
      completedScopes,
      "Actual GPU scopes must complete before sampling",
    );
    assert.equal(gpu?.errors, 0, "Actual GPU scopes must be clean");
  }
  const before = report.observations?.resources.FluidCollision?.before as
    | Record<string, unknown>
    | undefined;
  const after = report.observations?.resources.FluidCollision?.after as
    | Record<string, unknown>
    | undefined;
  assert.equal(before?.measuredSteps, 0, "Native before capture must precede the measured step");
  assert.equal(before?.totalSteps, 1, "Native before capture must follow GPU initialization");
  assert.equal(after?.measuredSteps, 1, "Native after capture must follow one measured step");
  assert.equal(after?.totalSteps, 2, "Native after capture must include exactly two GPU steps");
  assert.equal(after?.gateClosed, expectedFailure === undefined, "Native gate variant must match");
  const adapter = report.observations?.resources.FluidAdapter?.after;
  assert.ok(
    adapter !== null && typeof adapter === "object" && !Array.isArray(adapter),
    "Native adapter info must exist",
  );
  assert.ok(
    ["architecture", "description", "device", "vendor"].some((field) => {
      const value = (adapter as Record<string, unknown>)[field];
      return (
        typeof value === "string" &&
        value.trim() !== "" &&
        !/^(unknown|unavailable)$/iu.test(value.trim())
      );
    }),
    "Native fluid requires an identified actual adapter",
  );
  assert.deepEqual(
    report.observations?.resources.FluidAdapter?.before,
    adapter,
    "Native adapter must stay unchanged",
  );
  assert.ok(
    Array.isArray(nativeConsole) && nativeConsole.length > 0,
    "Native console evidence is missing",
  );
  for (const entry of nativeConsole) {
    assert.ok(
      entry && typeof entry.text === "string" && typeof entry.type === "string",
      "Malformed native console entry",
    );
    assert.notEqual(entry.type, "error", "Native host emitted a console error");
    assert.ok(
      !/\[FATAL\]|\[WebGPU\].*(?:Device error|Device lost|Failed)|validation error|device(?:[ _-]| was )?lost|(?:Type|Reference|Range|Syntax)Error|TN_(?:NATIVE_START_FAILED|ASSETS_UNRESOLVED)/iu.test(
        entry.text,
      ),
      "Native host emitted a runtime or GPU error",
    );
  }
  assert.ok(
    nativeConsole.some((entry) => entry.text.includes("TN_NATIVE_SMOKE_FIRST_FRAME")),
    "Native host first-frame marker is missing",
  );
}

/** Inspect the runner's actual mailbox replies before normalization can default missing data. */
export function assertNativeFluidResponses(
  evidence: unknown,
  report: Pick<IStandalonePlaytestReport, "observations">,
): void {
  const observations = (evidence as { observations?: unknown } | undefined)?.observations;
  assert.ok(
    Array.isArray(observations) && observations.length > 0,
    "Raw native mailbox evidence is missing",
  );
  const replies = observations.map((entry, index) => {
    assert.ok(
      entry && typeof entry.method === "string" && typeof entry.body === "string",
      "Malformed native mailbox record",
    );
    assert.equal(entry.order, index + 1, "Native mailbox replies must retain exact request order");
    assert.equal(
      entry.requestId,
      String(entry.order),
      "Native mailbox request identity must match its order",
    );
    const response = JSON.parse(entry.body) as { id?: unknown; error?: unknown; result?: unknown };
    assert.equal(
      response?.id,
      entry.requestId,
      "Raw native response must match its request identity",
    );
    assert.equal(response.error, undefined, "Native mailbox returned an error");
    assert.ok(
      response.result !== null &&
        typeof response.result === "object" &&
        !Array.isArray(response.result),
      "Native mailbox result must exist",
    );
    return { method: entry.method as string, result: response.result as Record<string, unknown> };
  });
  assert.equal(
    replies[0]?.method,
    "describe",
    "Native mailbox must start with its actual capability handshake",
  );
  const capabilities = replies[0]?.result.capabilities;
  assert.ok(
    Array.isArray(capabilities) &&
      capabilities.includes("runtime.resources") &&
      capabilities.includes("runtime.diagnostics"),
    "Native producer must expose actual resources",
  );
  const readyIndex = replies.findIndex(({ method }) => method === "ready");
  const firstSampleIndex = replies.findIndex(({ method }) => method === "sample");
  assert.ok(
    readyIndex > 0 && firstSampleIndex > readyIndex,
    "Native readiness must precede raw samples",
  );
  assert.equal(
    replies[readyIndex]?.result.ready,
    true,
    "Native producer must report actual readiness",
  );
  const samples = replies.filter(({ method }) => method === "sample").map(({ result }) => result);
  assert.ok(samples.length >= 2, "Native proof requires raw before and after samples");
  for (const sample of samples)
    assert.deepEqual(
      sample.diagnostics,
      [],
      "Raw native diagnostics must be observed and clean on every sample",
    );
  for (const [sample, phase] of [
    [samples[0], "before"],
    [samples.at(-1), "after"],
  ] as const) {
    const resources = sample?.resources as Record<string, unknown> | undefined;
    assert.ok(resources?.FluidCollision !== undefined, "Raw native fluid measurements are missing");
    assert.deepEqual(
      resources.FluidGPU,
      report.observations?.resources.FluidGPU?.[phase],
      "Raw GPU scope observations must match",
    );
    assert.deepEqual(
      resources.FluidCollision,
      report.observations?.resources.FluidCollision?.[phase],
      "Raw native samples must match the reported before and measured states",
    );
  }
}

export function assertNativeFluidPixels(bytes: Buffer, authored: IPlaytestScenario): void {
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, authored.viewport.width, "Native screenshot width must match");
  assert.equal(png.height, authored.viewport.height, "Native screenshot height must match");
  assert.ok(authored.assert?.visual?.length, "Native fluid requires an authored pixel gate");
  for (const visual of authored.assert.visual) {
    const region = visual.region;
    assert.ok(
      region && "x" in region && region.minNonblankPixelRatio !== undefined,
      "Native fluid expects a static nonblank region",
    );
    assert.ok(
      regionMetrics(png, region).nonblankPixelRatio >= region.minNonblankPixelRatio,
      "Native pixels fail the authored nonblank gate",
    );
  }
}

const NATIVE_FAILURE_CODES = new Set([
  "TN_PLAYTEST_BRIDGE_MISSING",
  "TN_PLAYTEST_BRIDGE_NOT_READY",
  "TN_PLAYTEST_CAPABILITY_MISSING",
  "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
  "TN_PLAYTEST_DEVICE_FAILED",
  "TN_PLAYTEST_HOST_EXITED",
  "TN_PLAYTEST_OPERATION_TIMEOUT",
  "TN_PLAYTEST_STARTUP_HOST_EXITED",
  "TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE",
  "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED",
  "TN_PLAYTEST_CONSOLE_ERROR",
  "TN_PLAYTEST_SOFTWARE_DEVICE_LOST",
  "TN_CAPTURE_BLANK",
  "TN_NATIVE_START_FAILED",
  "TN_FATAL",
  "TN_PLAYTEST_DEVICE_TRANSPORT",
  "TN_PLAYTEST_MAILBOX_POLL_STALLED",
  "TN_ASSETS_UNRESOLVED",
]);
const NATIVE_FAILURE_WORDS = new Set(
  (
    "a an and at before after cannot can could create created creating did do does error failed failure for from has have in invalid is it missing no not of on or read reading return returned the this to undefined null unavailable unsupported was were with " +
    "properties property function constructor method object value size buffer buffers map mapped mapping mapAsync getMappedRange already pending shader wgsl validation device adapter texture storage compute queue submit requestAdapter requestDevice getArrayBufferAsync " +
    "promise then called incompatible receiver expected received features limits canvas context renderer init compile pipeline bind group format dimension usage reference type range syntax gpu webgpu ready startup bridge native script exception unhandled rejected lost out memory parse redacted " +
    "ReferenceError TypeError RangeError SyntaxError GPUBufferUsage GPUMapMode GPUShaderStage GPUTextureUsage navigator performance requestAnimationFrame setAnimationLoop addEventListener TextEncoder URL WeakRef FinalizationRegistry"
  )
    .split(/\s+/u)
    .map((word) => word.toLowerCase()),
);

/** Publish technical failure words only; unknown text, paths, URLs and host identifiers stay private. */
function scrubNativeFailureText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/https?:\/\/[^\s]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/gu, "[redacted]")
    .replace(/[^\x20-\x7e]/gu, " ")
    .replace(/[A-Za-z_$][A-Za-z0-9_$-]*|[0-9]+/gu, (word) =>
      NATIVE_FAILURE_WORDS.has(word.toLowerCase()) || NATIVE_FAILURE_CODES.has(word)
        ? word
        : "[redacted]",
    )
    .replace(/(?:\[redacted\][\s:;=,.]*){2,}/gu, "[redacted] ")
    .slice(0, 240);
}

export function nativeFluidFailureDetails(
  report: { pass: boolean; diagnostics: readonly { code: string }[] } | undefined,
  nativeConsole: unknown,
  startupTimeoutMs: number,
  verifierError?: unknown,
) {
  const verifierDiagnostic =
    verifierError === undefined
      ? undefined
      : verifierError instanceof Error &&
          /^Xvfb did not report a display within \d+ms\.$/u.test(verifierError.message)
        ? "XVFB_DISPLAY_TIMEOUT"
        : verifierError instanceof Error &&
            verifierError.message === "Desktop playtest did not produce a report."
          ? "PLAYTEST_REPORT_MISSING"
          : "UNCLASSIFIED_VERIFIER_ERROR";
  const observed =
    Array.isArray(nativeConsole) &&
    nativeConsole.length > 0 &&
    nativeConsole.every(
      (entry) => entry && typeof entry.text === "string" && typeof entry.type === "string",
    );
  const hostErrors = observed
    ? nativeConsole
        .filter(
          (entry) =>
            entry.type === "error" ||
            /TN_NATIVE_START_FAILED|\[WebGPU\].*(?:Device error|Device lost|Failed)|(?:Reference|Type|Range|Syntax)Error/u.test(
              entry.text,
            ),
        )
        .slice(0, 16)
        .map(({ text }: { text: string }) => ({
          classification:
            /(?:Reference|Type|Range|Syntax)Error/u.exec(text)?.[0] ??
            (/Device error.*Validation/iu.test(text)
              ? "GPUValidation"
              : /device.*lost/iu.test(text)
                ? "GPUDeviceLost"
                : /TN_NATIVE_START_FAILED/u.test(text)
                  ? "NativeStart"
                  : "Unclassified"),
          message: scrubNativeFailureText(text),
        }))
    : undefined;
  return {
    startupTimeoutMs,
    reportDiagnosticChannel: report === undefined ? "unavailable" : "observed",
    diagnostics: report?.diagnostics.map(({ code }) =>
      NATIVE_FAILURE_CODES.has(code) ? code : "UNRECOGNIZED_DIAGNOSTIC",
    ),
    hostDiagnosticChannel: observed ? "observed" : "unavailable",
    ...(hostErrors === undefined ? {} : { hostErrors }),
    ...(verifierDiagnostic === undefined ? {} : { verifierDiagnostic }),
  };
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const project = path.join(root, "examples/prd476-fluid-particles");
  const output = path.join(root, "artifacts/fluid-collision-native");
  const runtime = process.env.THREENATIVE_RUNTIME_BINARY;
  assert.ok(runtime, "THREENATIVE_RUNTIME_BINARY must name the actual desktop host");
  const inputs = [
    "packages/core/src/fluid-particles.ts",
    "packages/core/src/gpu-readback.ts",
    "packages/core/patches/three@0.185.1.patch",
    "examples/prd476-fluid-particles/src/collision-proof.ts",
    "examples/prd476-fluid-particles/playtests/fluid-collision.playtest.json",
    "scripts/fluid-collision-proof.ts",
    "scripts/verify-fluid-collision-native.ts",
    "packages/runtime-native/scripts/bundle.mjs",
  ];
  execFileSync("git", ["ls-files", "--error-unmatch", "--", ...inputs], { cwd: root });
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    "",
    "Native fluid proof requires a clean committed source tree",
  );
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const hash = async (filename: string) =>
    createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
  const sourceFiles = await Promise.all(
    inputs.map(async (filename) => ({ filename, sha256: await hash(path.join(root, filename)) })),
  );
  const runtimeSha256 = await hash(runtime);
  const qualification =
    "Linux desktop GPU correctness with actual initialization/measured-work validation scopes and real host-console error/device-loss checks; no generic normalized runtime-diagnostics, internal error-scope, mobile or hardware-performance claim. The desktop mailbox has no network observer; this bundled fixture has no external assets or runtime imports.";
  const variants: Record<string, unknown>[] = [];
  await mkdir(output, { recursive: true });
  const authored = await loadPlaytestScenario(project, "playtests/fluid-collision.playtest.json");
  const { DesktopPlaytestDriver, runDesktopPlaytest } = await import(
    "../packages/playtest/dist/runner/index.js"
  );
  const startupTimeoutMs = 120_000;
  let lastReport: IStandalonePlaytestReport | undefined;
  let captureNativeConsole: (() => Promise<unknown>) | undefined;
  let lastBundleSha256: string | undefined;
  let lastVariant: string | undefined;
  try {
    for (const variant of ["gate", "gate-disabled"] as const) {
      lastVariant = variant;
      lastReport = undefined;
      lastBundleSha256 = undefined;
      captureNativeConsole = undefined;
      const artifactDirectory = path.join(output, variant);
      await mkdir(artifactDirectory, { recursive: true });
      const entry = path.join(artifactDirectory, "entry.ts");
      await writeFile(
        entry,
        `import proof from ${JSON.stringify(path.join(project, "src/collision-proof.ts"))};\nexport default { start: () => proof.start({ gateClosed: ${variant === "gate"} }) };\n`,
      );
      const bundle = path.join(artifactDirectory, "fluid-native.js");
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
          "--native-backend",
          "--output",
          bundle,
        ],
        { cwd: root, stdio: "inherit" },
      );
      const bundleSha256 = await hash(bundle);
      lastBundleSha256 = bundleSha256;
      const scenarioPath = path.join(artifactDirectory, "scenario.playtest.json");
      await writeFile(scenarioPath, `${JSON.stringify(nativeFluidScenario(authored), null, 2)}\n`);
      const report = await runDesktopPlaytest(
        {
          artifactDirectory,
          projectPath: project,
          scenarioPath,
          target: "desktop",
          desktop: {
            executable: runtime,
            hostArgs: ["run", bundle, "--windowed", "--width", "960", "--height", "540"],
          },
          allowSoftwareAdapter: true,
          headless: false,
          timeoutMs: startupTimeoutMs,
          trace: false,
          url: "",
        },
        {
          driverFactory: (options) => {
            const driver = new DesktopPlaytestDriver(options);
            // Early failure reports return before console.json is written. Retain the same driver,
            // leaving display, mailbox, process lifetime and every qualification gate unchanged.
            captureNativeConsole = () => driver.captureConsole();
            return driver;
          },
        },
      );
      lastReport = report;
      const expectedFailure =
        variant === "gate-disabled" ? "resource.FluidCollision.collisionPassed" : undefined;
      // Surface the primary host failure before trying an artifact it may not have written.
      assertFluidOutcome(report, expectedFailure);
      assertNativeFluidResponses(
        JSON.parse(
          await readFile(path.join(artifactDirectory, "device-response-observations.json"), "utf8"),
        ),
        report,
      );
      // Keep raw host output local; publish only bounded identities, numbers and genuine pixels.
      assertNativeFluidCapture(
        report,
        JSON.parse(await readFile(path.join(artifactDirectory, "console.json"), "utf8")),
        expectedFailure,
      );
      const images = [];
      for (const filename of ["before.png", "after.png"]) {
        const bytes = await readFile(path.join(artifactDirectory, filename));
        assertNativeFluidPixels(bytes, authored);
        images.push({ filename, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      assert.equal(await hash(bundle), bundleSha256, "Native game bundle changed during capture");
      assert.equal(await hash(runtime), runtimeSha256, "Native executable changed during capture");
      variants.push({
        variant,
        pass: report.pass,
        runtime: report.runtime,
        target: report.target,
        bundleSha256,
        adapter: report.observations?.resources.FluidAdapter?.after,
        assertions: report.assertionResults?.map(({ id, pass }) => ({ id, pass })),
        diagnostics: report.diagnostics.map(({ code }) => code),
        measurements: report.observations?.resources.FluidCollision,
        gpuValidation: report.observations?.resources.FluidGPU,
        images,
      });
      await writeFile(
        path.join(output, "summary.json"),
        `${JSON.stringify({ sourceSha, sourceFiles, runtimeSha256, qualification, variants }, null, 2)}\n`,
      );
    }
    await writeFile(
      path.join(output, "summary.json"),
      `${JSON.stringify({ sourceSha, sourceFiles, runtimeSha256, qualification, expectedOutcomesPassed: true, variants }, null, 2)}\n`,
    );
    console.log(
      "Native fluid: actual gate passed; missing gate failed only its collision assertion.",
    );
  } catch (error) {
    const nativeConsole = await captureNativeConsole?.().catch(() => undefined);
    const failure = nativeFluidFailureDetails(lastReport, nativeConsole, startupTimeoutMs, error);
    await writeFile(
      path.join(output, "failure.json"),
      `${JSON.stringify(
        {
          sourceSha,
          sourceFiles,
          runtimeSha256,
          bundleSha256: lastBundleSha256,
          variant: lastVariant,
          qualification,
          pass: false,
          ...failure,
          verifierError: scrubNativeFailureText(
            error instanceof Error ? error.message : String(error),
          ),
        },
        null,
        2,
      )}\n`,
    );
    console.error(
      `Native fluid qualification failed: ${failure.diagnostics?.join(", ") || "see failure.json"}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
