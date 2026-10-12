import { entityPosition, isAnonymousMovementScenario, length, subtract } from "./shared.js";
import type { IPlaytestDeviceMetricsObservation } from "./deviceMetrics.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import {
  evaluateRichPlaytestAssertions,
  loadPlaytestScenario,
  playtestDiagnostic,
  playtestStepHoldTicks,
  playtestStepWaitTicks,
  resolveDiagnosticsPolicy,
  type IPlaytestArtifactRequest,
  type IPlaytestAssertionResult,
  type IPlaytestCaptureProvenance,
  type IPlaytestDiagnosticsPolicy,
  type IPlaytestDiagnostic,
  type IPlaytestFramebufferCoverageObservation,
  type IPlaytestObservationSnapshot,
  type IPlaytestObservations,
  type IPlaytestPathAssertion,
  type IPlaytestProtocolDiagnostic,
  type IPlaytestReport,
  type IPlaytestSampleRequest,
  type IPlaytestScenario,
  type IPlaytestSetupApplication,
  type IPlaytestSetupRequest,
  type IPlaytestTrivialityOptOut,
  type PlaytestVec3,
} from "../index.js";
import { assertCaptureNotBlank, CaptureGuardError } from "../capture.js";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";

import { connectPlaytestBridge, PlaytestBridgeError, type IPlaytestBridgeClient } from "./bridgeClient.js";
import {
  PERFORMANCE_BROWSER_ARGS,
  reconcileBrowserPointers,
  resolveBrowserArguments,
  softwareAdapterName,
} from "./browser.js";
import type { IStandalonePlaytestConfig } from "./config.js";
import {
  provideDisplay,
  runNeedsPixels,
  type IProvidedDisplay,
} from "./captureEnvironment.js";
import {
  acquireCaptureLock,
  decideLockPolicy,
  defaultCaptureLockRoot,
  detectCaptureConcurrency,
  isProcessAlive,
  type ICaptureLease,
} from "./captureLock.js";
import {
  finishFramebufferCoverageProbe,
  startFramebufferCoverageProbe,
} from "./framebufferCoverage.js";
import { STANDALONE_PLAYTEST_OBSERVATION_FIELDS } from "./observationFields.js";
// Extracted verbatim from runner.ts (PRD-182 Phase 4); do not edit semantics here.
import { componentObservations, buildObservations, collectTrivialityOptOuts } from "./steps.js";
import {
  entityRotation,
  normalizedRuntimeDiagnostics,
  observedMovementSample,
  resourceObservations,
} from "./observationSampling.js";
import { cameraReport, evaluateCamera } from "./camera.js";
import type { IStandalonePlaytestReport } from "./shared.js";
import type { ILabeledPlaytestSample, IMovementSampleInterval, IRunnerConsoleEntry } from "./shared.js";
// Extracted verbatim from runner.ts (PRD-182 Phase 4); do not edit semantics here.

export function preflightDisplay(
  config: Pick<IStandalonePlaytestConfig, "headless">,
  scenario: Pick<IPlaytestScenario, "artifacts" | "assert" | "steps">,
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): IPlaytestDiagnostic | undefined {
  const takesScreenshot = scenario.artifacts?.screenshots !== false
    || scenario.steps.some(({ screenshot }) => screenshot !== undefined);
  const evaluatesVisual = (scenario.assert?.visual?.length ?? 0) > 0 || (scenario.assert?.tone?.length ?? 0) > 0;
  const evaluatesFramebuffer = scenario.assert?.framebufferCoverage !== undefined;
  if (platform !== "linux" || config.headless !== true || environment.DISPLAY || environment.WAYLAND_DISPLAY || (!takesScreenshot && !evaluatesVisual && !evaluatesFramebuffer)) {
    return undefined;
  }
  return {
    code: evaluatesFramebuffer
      ? "TN_PLAYTEST_FRAMEBUFFER_PIXELS_UNREADABLE"
      : "TN_PLAYTEST_HEADLESS_WEBGPU",
    message: evaluatesFramebuffer
      ? "Headless Linux cannot provide trusted per-frame WebGPU pixels without a display; use sh scripts/xvfb.sh <cmd>."
      : "Headless Linux visual runs may render WebGPU blank without a display; use sh scripts/xvfb.sh <cmd>.",
    severity: evaluatesFramebuffer ? "error" : "warning",
    suggestion: "Prefix the command with sh scripts/xvfb.sh.",
  };
}

/**
 * Capture-environment bake-in (report §2.10): the runner, not a wrapper, owns serialisation
 * and display provisioning for pixel-producing runs. Lock policy is decided from detected
 * concurrency (`CAPTURE_LOCK=1` forces it); lock state is printed either way so an agent can
 * tell its own failure from someone else's queue.
 */
export async function acquireRunnerCaptureLock(): Promise<ICaptureLease> {
  const lockRoot = defaultCaptureLockRoot();
  const policy = decideLockPolicy({
    captureLock: process.env.CAPTURE_LOCK,
    lockTimeoutMs: process.env.CAPTURE_LOCK_TIMEOUT_MS,
    othersAlive: detectCaptureConcurrency({ isProcessAlive, lockRoot }),
  });
  if (policy.mode === "none") {
    writeCaptureState({ captureLock: { detail: "no competing runner detected", mode: "none" } });
    return { release: async () => undefined };
  }
  // Emit queue visibility on change, not per poll — a contended 120 s wait must not spam stderr.
  let lastWaitingKey: string | undefined;
  return acquireCaptureLock({
    command: process.argv.slice(1).join(" ").slice(0, 200),
    isProcessAlive,
    lockRoot,
    onState: ({ holderSummary, mode, queueDepth }) => {
      if (mode === "waiting") {
        const key = `${holderSummary ?? ""}|${queueDepth}`;
        if (key === lastWaitingKey) return;
        lastWaitingKey = key;
      }
      writeCaptureState({ captureLock: mode === "held" ? { mode, queueDepth } : { holderSummary, mode, queueDepth } });
    },
    timeoutMs: policy.timeoutMs,
  });
}

export async function provideRunDisplay(): Promise<IProvidedDisplay> {
  const provided = await provideDisplay();
  writeCaptureState({
    captureDisplay: {
      ...(provided.compositor === undefined ? {} : { compositor: provided.compositor }),
      ...(provided.display === undefined ? {} : { display: provided.display }),
      ...(provided.strategy.kind === "private-xvfb" ? { screen: provided.strategy.screen } : {}),
      strategy: provided.strategy.kind,
    },
  });
  return provided;
}

export function writeCaptureState(payload: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export function isJudgeMarkerRequestFailure(method: string, url: string, judgeMarkerUrl: string | undefined): boolean {
  return method === "POST" && judgeMarkerUrl !== undefined && url === judgeMarkerUrl;
}

export function addPreflightDiagnostic(
  report: IStandalonePlaytestReport,
  diagnostic: IPlaytestDiagnostic | undefined,
): IStandalonePlaytestReport {
  return diagnostic === undefined ? report : { ...report, diagnostics: [diagnostic, ...report.diagnostics] };
}

/**
 * The console cascade a lost WebGPU device leaves behind: core's `TN_DEVICE_LOST` report, three's
 * own `WebGPU Device Lost` line, the `mapAsync` rejections from the timestamp-query pool once the
 * device is gone, and Chromium's `OperationError: Instance dropped` messages from three's WebGPU
 * backend when the fallback adapter's instance is dropped under SwiftShader. A device loss is one
 * event with several error lines, and they must be read as one so a declared software lane can
 * record it rather than fail on each derived line.
 */
const SOFTWARE_DEVICE_LOSS = /TN_DEVICE_LOST|WebGPU Device Lost|A valid external Instance reference no longer exists|Instance dropped (?:in popErrorScope|error in getCompilationInfo)/iu;

function isSoftwareDeviceLossEntry(entry: IRunnerConsoleEntry): boolean {
  return (entry.type === "error" || entry.type === "assert" || entry.type === "pageerror")
    && SOFTWARE_DEVICE_LOSS.test(entry.text);
}

export function buildReport(
  config: IStandalonePlaytestConfig,
  scenario: IPlaytestScenario,
  beforeSnapshot: IPlaytestObservationSnapshot | undefined,
  afterSnapshot: IPlaytestObservationSnapshot | undefined,
  consoleEntries: IRunnerConsoleEntry[],
  networkEntries: Array<{ method: string; url: string }>,
  pathLength: number | undefined = undefined,
  hud: Record<string, { after?: unknown; before?: unknown }> = {},
  runtimeReady = true,
  visual: IPlaytestObservations["visual"] = undefined,
  labeledSamples: readonly ILabeledPlaytestSample[] = [],
  framebufferCoverage: IPlaytestFramebufferCoverageObservation | undefined = undefined,
  capture: IPlaytestCaptureProvenance | undefined = undefined,
  captureFailure: { code: "TN_CAPTURE_BLANK"; label: string; reason: string } | undefined = undefined,
  movementSamples: readonly IMovementSampleInterval[] = [],
  setup: IPlaytestSetupApplication | undefined = undefined,
  deviceMetrics: IPlaytestDeviceMetricsObservation | undefined = undefined,
  movementBaselineSnapshot: IPlaytestObservationSnapshot | undefined = undefined,
  startup: IStandalonePlaytestReport["startup"] = undefined,
  deviceLifecycle: IPlaytestObservations["deviceLifecycle"] = undefined,
  tone: IPlaytestObservations["tone"] = undefined,
): IStandalonePlaytestReport {
  const movementSample = isAnonymousMovementScenario(scenario)
    ? observedMovementSample(movementSamples)
    : undefined;
  const entity = scenario.assert?.movement?.entity
    ?? scenario.subject
    ?? movementSample?.entity
    ?? "";
  // A named entity is measured across the whole run, and the run's first snapshot is taken after
  // warmup — before any step has executed. A scenario that opens on a menu therefore measures a
  // player who does not exist yet, and the answer used to be a fabricated distance of zero. When
  // the entity is missing from that window but the per-step samples did see it, measure it where
  // it existed: its first observation to its last. "The player moved at least this far during the
  // run" is the assertion, and this is the only window in which that question has an answer.
  const wholeRunObserved = isAnonymousMovementScenario(scenario)
    ? false
    : entityPosition(beforeSnapshot, entity) !== undefined
      && entityPosition(afterSnapshot, entity) !== undefined;
  const observedWindow = isAnonymousMovementScenario(scenario) || wholeRunObserved || entity === ""
    ? undefined
    : entityObservedWindow(movementSamples, entity);
  const movementBeforeSnapshot = movementSample?.before
    ?? observedWindow?.before
    ?? (isAnonymousMovementScenario(scenario) ? undefined : movementBaselineSnapshot ?? beforeSnapshot);
  const movementAfterSnapshot = movementSample?.after
    ?? observedWindow?.after
    ?? (isAnonymousMovementScenario(scenario) ? undefined : afterSnapshot);
  const beforePosition = entityPosition(movementBeforeSnapshot, entity);
  const afterPosition = entityPosition(movementAfterSnapshot, entity);
  const beforeRotation = entityRotation(movementBeforeSnapshot, entity);
  const afterRotation = entityRotation(movementAfterSnapshot, entity);
  const components = componentObservations(beforeSnapshot, afterSnapshot);
  const movementDelta = beforePosition === undefined || afterPosition === undefined
    ? undefined
    : subtract(afterPosition, beforePosition);
  const distance = movementDelta === undefined ? 0 : length(movementDelta);
  const performanceSeries = scenario.assert?.performance === undefined
      && scenario.assert?.parity === undefined
    ? undefined
    : afterSnapshot?.runtimeDiagnosticsSeries ?? beforeSnapshot?.runtimeDiagnosticsSeries;
  // A declared software lane is the one place a lost WebGPU device is an environment artifact
  // rather than a game defect: SwiftShader's fallback adapter drops the wire Instance under a slow
  // frame and Chromium restarts the GPU process behind it, which surfaces as a device-lost cascade
  // of console errors. The operator has already said out loud this run is not render evidence, and
  // the lane's scenarios assert simulation resources, so the cascade is recorded as a diagnostic
  // instead of failing `noConsoleErrors`. Nothing is hidden: `console.json` keeps every entry. A
  // hardware run, or any non-device-loss error on the software lane, still fails the assertion.
  const softwareAdapter =
    capture?.rendererKind === "webgpu" ? softwareAdapterName(capture.adapter) : undefined;
  const softwareLane = config.allowSoftwareAdapter === true && softwareAdapter !== undefined;
  const deviceLossEntries = softwareLane ? consoleEntries.filter(isSoftwareDeviceLossEntry) : [];
  const observedConsoleEntries = deviceLossEntries.length === 0
    ? consoleEntries
    : consoleEntries.filter((entry) => !isSoftwareDeviceLossEntry(entry));
  const diagnostics: IPlaytestDiagnostic[] = [];
  if (runtimeReady === false && scenario.assert?.diagnostics?.runtimeReady === true) {
    diagnostics.push({
      code: "TN_PLAYTEST_RUNTIME_NOT_READY",
      message: "The page did not expose a ready canvas after the warmup window.",
      severity: "error",
      suggestion: "Fix runtime startup so the page reaches DOM-ready state and creates a canvas before the playtest assertion.",
    });
  }
  const base: IPlaytestReport = {
    ...(afterPosition === undefined ? {} : { after: { frame: scenario.steps.length, position: afterPosition, ...(afterRotation === undefined ? {} : { rotation: afterRotation }), tick: afterSnapshot?.clock.tick ?? 0 } }),
    ...(beforePosition === undefined ? {} : { before: { frame: 0, position: beforePosition, ...(beforeRotation === undefined ? {} : { rotation: beforeRotation }), tick: beforeSnapshot?.clock.tick ?? 0 } }),
    // The harness's own `adapter.info` reading, carried on the report the assertions are evaluated
    // against. An assertion that selects its expectation per adapter class needs the provenance
    // here, not only in the written artifact — reading it after evaluation meant every such
    // assertion saw no adapter and failed closed on a run that had a real one.
    ...(capture === undefined ? {} : { capture }),
    diagnostics,
    diagnosticsPolicy: resolveDiagnosticsPolicy(scenario.assert?.diagnostics, config.target),
    distance,
    entity,
    expectMoved: scenario.assert?.movement?.minDistance !== undefined,
    // Count what runStep actually waits: hold + wait within a family (steps.ts sums them),
    // never one family member short-changed by a ?? chain.
    frames: scenario.steps.reduce((total, step) => {
      const frameCount = (step.holdFrames ?? 0) + (step.waitFrames ?? 0);
      const tickCount = (step.holdTicks ?? 0) + (step.waitTicks ?? 0);
      return total + Math.max(frameCount, tickCount, 1);
    }, 0),
    trivialityOptOuts: [],
    // The target the run executed on, so the evaluator knows which channels this lane can observe.
    ...(config.target === undefined ? {} : { target: config.target }),
    ...(movementDelta === undefined ? {} : { movementDelta }),
    ...(pathLength === undefined ? {} : { pathLength }),
    // Honest placement reporting: what the scenario asked to override, and what applied.
    ...(setup === undefined ? {} : { setup }),
    observations: buildObservations({
      ...(tone === undefined || tone.length === 0 ? {} : { tone }),
      console: observedConsoleEntries,
      ...(components === undefined
        ? {}
        : { components }),
      ...(labeledSamples.length === 0
        ? {}
        : {
            componentSeries: labeledSamples.map(({ label, snapshot }) => ({ label, snapshots: snapshot.components ?? {}, tick: snapshot.clock.tick ?? 0 })),
            resourceSeries: labeledSamples.map(({ label, snapshot }) => ({ label, snapshots: snapshot.resources ?? {}, tick: snapshot.clock.tick ?? 0 })),
            signalSeries: labeledSamples.map(({ label, signals, snapshot }) => ({ label, signals, tick: snapshot.clock.tick ?? 0 })),
            signals: labeledSamples.flatMap(({ signals }) => signals),
          }),
      hud,
      ...(deviceLifecycle === undefined ? {} : { deviceLifecycle }),
      ...(deviceMetrics === undefined ? {} : { deviceMetrics }),
      ...(framebufferCoverage === undefined ? {} : { framebufferCoverage }),
      network: networkEntries,
      ...(performanceSeries === undefined ? {} : { performanceSeries }),
      ...(afterSnapshot?.pipelineCensus === undefined && beforeSnapshot?.pipelineCensus === undefined
        ? {}
        : { pipelineCensus: afterSnapshot?.pipelineCensus ?? beforeSnapshot?.pipelineCensus }),
      // Like the pipeline census: a report about the frame it was requested on, kept whole. The
      // last sample wins, because a capture describes the world as the run left it.
      ...(afterSnapshot?.geometry === undefined && beforeSnapshot?.geometry === undefined
        ? {}
        : { geometry: afterSnapshot?.geometry ?? beforeSnapshot?.geometry }),
      ...(afterSnapshot?.renderChain === undefined && beforeSnapshot?.renderChain === undefined
        ? {}
        : { renderChain: afterSnapshot?.renderChain ?? beforeSnapshot?.renderChain }),
      resources: resourceObservations(beforeSnapshot, afterSnapshot),
      // The room as the run left it, falling back to how it started. A scene assertion is about
      // what the renderer was handed, and the last sample is the one a screenshot would match.
      ...(afterSnapshot?.scene === undefined && beforeSnapshot?.scene === undefined
        ? {}
        : { scene: afterSnapshot?.scene ?? beforeSnapshot?.scene }),
      // The node walk answers "where is it now", so the last sample wins for the same reason the
      // room does. Never merged with the first: a node that has since been removed is gone, and
      // reporting it from the earlier sample would assert against a scene that no longer exists.
      ...(afterSnapshot?.sceneNodes === undefined && beforeSnapshot?.sceneNodes === undefined
        ? {}
        : { sceneNodes: afterSnapshot?.sceneNodes ?? beforeSnapshot?.sceneNodes }),
      ...(startup === undefined ? {} : { startup }),
      ...(beforeSnapshot?.gameplay === undefined
        && afterSnapshot?.gameplay === undefined
        && labeledSamples.every(({ snapshot }) => snapshot.gameplay === undefined)
        ? {}
        : {
            runtimeObservations: {
              ...(beforeSnapshot?.gameplay === undefined ? {} : { gameplayBefore: beforeSnapshot.gameplay }),
              ...(afterSnapshot?.gameplay === undefined ? {} : { gameplay: afterSnapshot.gameplay }),
              ...(labeledSamples.every(({ snapshot }) => snapshot.gameplay === undefined)
                ? {}
                : {
                    gameplaySeries: labeledSamples.flatMap(({ label, snapshot }) => snapshot.gameplay === undefined
                      ? []
                      : [{ gameplay: snapshot.gameplay, label, tick: snapshot.clock.tick ?? 0 }]),
                  }),
            },
          }),
      ...(afterSnapshot?.physicsDebugSeries === undefined
        ? {}
        : { physicsDebugSeries: afterSnapshot.physicsDebugSeries }),
      ...(beforeSnapshot?.physicsDebugSeries?.[0]?.snapshot === undefined
        ? {}
        : { physicsDebugBefore: beforeSnapshot.physicsDebugSeries[0].snapshot }),
      runtimeDiagnostics: normalizedRuntimeDiagnostics(afterSnapshot, scenario, observedConsoleEntries),
      ...(beforeSnapshot === undefined
        ? {}
        : { runtimeDiagnosticsBefore: normalizedRuntimeDiagnostics(beforeSnapshot, scenario, observedConsoleEntries) }),
      ...(visual === undefined ? {} : { visual }),
    }),
  };
  if (scenario.assert?.camera !== undefined) {
    base.follow = cameraReport(scenario, beforeSnapshot, afterSnapshot);
  }
  const evaluated = evaluateRichPlaytestAssertions({ report: base, scenario });
  const cameraResult = evaluateCamera(scenario, afterSnapshot);
  const assertionResults = [...evaluated.assertions, ...(cameraResult === undefined ? [] : [cameraResult])];
  const trivialityOptOuts = collectTrivialityOptOuts(assertionResults);
  const allDiagnostics = [...diagnostics, ...evaluated.diagnostics];
  if (deviceLossEntries.length > 0) {
    allDiagnostics.push({
      code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST",
      message: `The software adapter '${softwareAdapter}' lost its WebGPU device during the run; ${deviceLossEntries.length} device-loss console error(s) were recorded instead of failing noConsoleErrors. This lane is not render evidence.`,
      severity: "warning",
      suggestion:
        "Expected on a CPU rasteriser when a frame outlasts the GPU process; rerun on a hardware adapter before reading any pixels.",
    });
  }
  // Scoped to WebGPU because that is where the fallback is silent: a WebGL context reports its
  // software renderer in the same provenance field, but the browser never pretends otherwise
  // and the repo already runs WebGL fixtures headless on purpose.
  if (softwareAdapter !== undefined && config.allowSoftwareAdapter !== true) {
    allDiagnostics.push({
      code: "TN_PLAYTEST_SOFTWARE_ADAPTER",
      message: `WebGPU was served by a software adapter: '${softwareAdapter}'. Nothing errored, so every result in this run is a CPU rasteriser's.`,
      severity: "error",
      suggestion:
        "Run with --headed under a display and --browser-recipe webgpu so Chromium reaches the GPU driver, or pass --allow-software to accept the fallback deliberately.",
    });
  }
  if (captureFailure !== undefined) {
    allDiagnostics.push({
      code: captureFailure.code,
      message: `Visual capture '${captureFailure.label}' was blank: ${captureFailure.reason}.`,
      severity: "error",
      suggestion: "Inspect the browser display and GPU adapter before treating this run as render evidence.",
    });
  }
  if (cameraResult?.pass === false) {
    allDiagnostics.push({
      code: "TN_PLAYTEST_CAMERA_ASSERTION_FAILED",
      message: "Camera did not satisfy the declared follow or viewport assertion.",
      severity: "error",
      suggestion: "Check camera registration, follow distance, and target framing.",
    });
  }
  return {
    ...base,
    artifactDirectory: config.artifactDirectory,
    ...(capture === undefined ? {} : { capture }),
    assertionResults,
    clock: config.liveClock === true ? "wall-clock" : "fixed-step",
    diagnostics: allDiagnostics,
    pass: assertionResults.every(({ pass }) => pass) && allDiagnostics.every(({ severity }) => severity !== "error"),
    runtime: "web",
    scenario: scenario.name,
    ...(startup === undefined ? {} : { startup }),
    target: scenario.target,
    trivialityOptOutCount: trivialityOptOuts.length,
    trivialityOptOuts,
    url: config.url,
  };
}

/**
 * The first and last per-step samples in which `entity` was actually present.
 *
 * Returns undefined unless both exist and differ, so a scenario whose subject never appears still
 * fails as unobserved rather than being handed a window it cannot measure.
 */
function entityObservedWindow(
  samples: readonly IMovementSampleInterval[],
  entity: string,
): { after: IPlaytestObservationSnapshot; before: IPlaytestObservationSnapshot } | undefined {
  const seen: IPlaytestObservationSnapshot[] = [];
  for (const sample of samples) {
    for (const snapshot of [sample.before, sample.after]) {
      if (snapshot !== undefined && entityPosition(snapshot, entity) !== undefined) seen.push(snapshot);
    }
  }
  const before = seen[0];
  const after = seen[seen.length - 1];
  if (before === undefined || after === undefined || before === after) return undefined;
  return { after, before };
}
