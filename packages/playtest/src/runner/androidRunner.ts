import { completionWindowEnvironment, completionWindowLabel, measureCompletionWindow, type ICompletionWindow } from "./steps.js";
import { cpuWindowLabels, measureCpuWindow, type ICpuWindow } from "./linuxCpuWindow.js";
import type { IPlaytestToneAssertion } from "../scenario/schema-base.js";
import type { IPlaytestToneCaptureObservation } from "../tone.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertCaptureNotBlank, assertDesktopCaptureNotBlank, collectRegionalTone } from "../capture.js";
import {
  loadPlaytestScenario,
  playtestDiagnostic,
  resolveDiagnosticsPolicy,
  playtestStepHoldTicks,
  playtestStepWaitTicks,
  type IPlaytestFramebufferCoverageObservation,
  type IPlaytestObservationSnapshot,
  type IPlaytestProtocolDiagnostic,
  type IPlaytestScenario,
  type IPlaytestSetupApplication,
  type PlaytestVec3,
} from "../index.js";
import {
  AdbAndroidDriver,
  type IAndroidAppState,
  type IAndroidDriver,
  type IAndroidLifecycleOperation,
  type IAndroidPointer,
  type IAndroidPointerInjection,
  type IPlaytestDeviceLifecycleObservation,
  type IPlaytestDeviceLifecyclePhase,
  type IPlaytestDeviceLifecycleSteps,
} from "./android.js";
import { withPerformanceBudget } from "./buildReport.js";
import {
  connectPlaytestBridgeTransport,
  PlaytestBridgeError,
  type IPlaytestBridgeClient,
} from "./bridgeClient.js";
import { alignScenarioStartTick } from "./runner-support.js";
import { waitForStartupReady } from "./startupReady.js";
import { waitForResource } from "./wait-for-resource.js";
import type { IStandalonePlaytestConfig } from "./config.js";
import { DeviceMetricsRecorder } from "./deviceMetrics.js";
import {
  androidMailboxPaths,
  DeviceBridgeTransport,
  DeviceMailboxTransport,
  deviceTimeoutDiagnostic,
  type IDeviceResponseObservation,
  type IDevicePlaytestTransport,
  type IDeviceMailbox,
} from "./deviceTransport.js";
import { withTargetAbortSignal } from "./deviceSignal.js";
import { buildReport, playtestStepDrivesMovement, writeObservationArtifacts } from "./runner.js";
import { analyzeFramebufferCoverageRecording } from "./videoAnalysis.js";
import { nativeCaptureProvenance } from "../evaluators/adapter-class.js";
import {
  accumulatedPathLength,
  appendPosition,
  failureReport,
  observedEntityIds,
  observedResourceIds,
  safePart,
  targetLabel,
  throwIfAborted,
} from "./shared.js";
import type { IStandalonePlaytestReport } from "./shared.js";

export interface IAndroidPlaytestDependencies {
  abortSignal?: AbortSignal;
  driver?: IAndroidDriver;
  transport?: IDevicePlaytestTransport;
}

export interface IDevicePlaytestDriver {
  readonly processId?: number;
  /** Send the app behind HOME and wait until the device reports it unfocused. */
  background?(): Promise<void>;
  captureConsole(): Promise<Array<{ text: string; type: string }>>;
  deviceSerial?(): string | undefined;
  /** Bring the launched app back to the foreground without force-stopping it. */
  foreground?(): Promise<void>;
  isAlive(): Promise<boolean>;
  /** What the device says about the app right now; the lifecycle phases are read from this. */
  lifecycleState?(): Promise<IAndroidAppState>;
  prepare(
    endpoint: string,
    mailboxRoot?: string,
    viewport?: { height: number; width: number },
  ): Promise<void>;
  readFile?(path: string): Promise<string | undefined>;
  removeFile?(path: string): Promise<void>;
  rotate?(rotation: number): Promise<void>;
  runAdb?(args: readonly string[]): Promise<string>;
  screenshot(path: string, onRequestAccepted?: () => Promise<void>): Promise<void>;
  setPointers?(pointers: readonly IAndroidPointer[]): Promise<IAndroidPointerInjection>;
  tap?(x: number, y: number): Promise<void>;
  hideKeyboard?(): Promise<boolean>;
  startScreenRecording?(): Promise<void>;
  stop(): Promise<void>;
  stopScreenRecording?(path: string): Promise<void>;
  writeFile?(path: string, contents: string): Promise<void>;
}

export interface IDevicePlaytestTarget {
  abortCleanup?: () => Promise<void>;
  abortSignal?: AbortSignal;
  driver: IDevicePlaytestDriver;
  mailboxPaths: ReturnType<typeof androidMailboxPaths>;
  name: "android" | "desktop" | "ios";
  processName: string;
  transport?: IDevicePlaytestTransport;
}

interface IDevicePlaytestCleanupState {
  error?: Error;
}

export async function runAndroidPlaytest(
  config: IStandalonePlaytestConfig,
  dependencies: IAndroidPlaytestDependencies = {},
): Promise<IStandalonePlaytestReport> {
  const endpoint = config.endpoint ?? "http://127.0.0.1:41777/playtest";
  const android = config.android ?? {
    activity: ".MystralActivity",
    packageName: "com.mystral.engine",
  };
  const driver = dependencies.driver ?? new AdbAndroidDriver({
    ...android,
    ...(config.adbPath === undefined ? {} : { adbPath: config.adbPath }),
    ...(config.touchRotation === undefined ? {} : { touchRotation: config.touchRotation }),
    ...(config.device === undefined ? {} : { serial: config.device }),
  });
  const mailboxRoot = config.mailboxRoot ?? `/sdcard/Android/data/${android.packageName}/files`;
  return withTargetAbortSignal("android", (abortSignal) => runDevicePlaytest({ ...config, mailboxRoot }, {
    abortSignal: abortSignal,
    driver,
    mailboxPaths: androidMailboxPaths(android.packageName, mailboxRoot),
    name: "android",
    processName: android.packageName,
    ...(dependencies.transport === undefined ? {} : { transport: dependencies.transport }),
  }), dependencies.abortSignal);
}

export async function runDevicePlaytest(
  config: IStandalonePlaytestConfig,
  target: IDevicePlaytestTarget,
): Promise<IStandalonePlaytestReport> {
  const cleanupState: IDevicePlaytestCleanupState = {};
  let report: IStandalonePlaytestReport;
  try {
    report = await runDevicePlaytestInternal(config, target, cleanupState);
  } catch (error) {
    if (cleanupState.error === undefined) throw error;
    throw cleanupFailure([error, cleanupState.error]);
  }
  if (cleanupState.error !== undefined) throw cleanupState.error;
  return report;
}

async function runDevicePlaytestInternal(
  config: IStandalonePlaytestConfig,
  target: IDevicePlaytestTarget,
  cleanupState: IDevicePlaytestCleanupState,
): Promise<IStandalonePlaytestReport> {
  const scenario = withPerformanceBudget(
    await loadPlaytestScenario(config.projectPath, config.scenarioPath),
    config.performanceBudget,
  );
  const cpuLabels = cpuWindowLabels(scenario, target.name, config.liveClock === true);
  const cpuWindows: ICpuWindow[] = [];
  const completionLabel = completionWindowLabel(scenario, target.name, config.liveClock === true);
  let completionWindow: ICompletionWindow | undefined;
  const completionDisplay = completionLabel === undefined ? undefined : completionWindowEnvironment("desktop", config.headless);
  let failureEvidenceCaptured = false;
  await throwIfAborted(target);
  await mkdir(config.artifactDirectory, { recursive: true });
  await throwIfAborted(target);
  const unsupported = unsupportedAssertion(
    scenario,
    target.name,
    typeof target.driver.tap === "function",
    canDriveAndroidLifecycle(target.driver),
  );
  if (unsupported !== undefined) return failureReport(config, scenario, unsupported, target.name);
  if (
    target.name === "android"
    && scenario.assert?.framebufferCoverage !== undefined
    && (typeof target.driver.startScreenRecording !== "function"
      || typeof target.driver.stopScreenRecording !== "function")
  ) {
    return failureReport(config, scenario, unsupportedDiagnostic(
      "framebuffer coverage recording",
      "Use the adb-backed Android driver; framebuffer coverage requires screenrecord and offline ffmpeg analysis.",
      target.name,
    ), target.name);
  }
  if (
    target.name === "android"
    && scenario.steps.some((step) => step.pointers !== undefined)
    && typeof target.driver.setPointers !== "function"
  ) {
    return failureReport(config, scenario, unsupportedDiagnostic(
      "complete held-pointer input",
      "Use the emulator-backed Android driver; multi-pointer steps cannot fall back to one-pointer bridge input.",
      target.name,
    ), target.name);
  }
  const endpoint = config.endpoint ?? "http://127.0.0.1:41777/playtest";
  const transport = target.transport ?? createDeviceTransport(
    target.driver,
    endpoint,
    target.mailboxPaths,
    config.timeoutMs,
  );
  let bridge: IPlaytestBridgeClient | undefined;
  let setupApplication: IPlaytestSetupApplication | undefined;
  let coverageRecordingStarted = false;
  let framebufferCoverage: IPlaytestFramebufferCoverageObservation | undefined;
  const coverageVideoPath = join(config.artifactDirectory, "framebuffer-coverage.mp4");
  const responseObservations: IDeviceResponseObservation[] = [];
  transport.setResponseObserver?.((observation) => responseObservations.push(observation));
  const metrics = deviceMetricsRecorder(target);
  try {
    await throwIfAborted(target);
    await transport.start();
    await throwIfAborted(target);
    // Sampled before prepare(): prepare force-stops the app and clears logcat, so this is the
    // only point at which the device's pre-launch thermal baseline is still readable.
    await metrics?.sampleNow("before").catch(() => undefined);
    metrics?.start();
    await target.driver.prepare(endpoint, config.mailboxRoot, scenario.viewport);
    await throwIfAborted(target);
    bridge = await connectPlaytestBridgeTransport(transport, scenario, config.timeoutMs, target.name);
    await throwIfAborted(target);
    if (bridge === undefined) {
      return failureReport(config, scenario, playtestDiagnostic(
        "TN_PLAYTEST_BRIDGE_MISSING",
        `${targetLabel(target.name)} application did not expose a playtest bridge.`,
        "Install playtest() or installThreePlaytestBridge() in the device build.",
      ), target.name);
    }
    if (!bridge.description.capabilities.includes("runtime.fixedStep")) {
      return failureReport(config, scenario, unsupportedDiagnostic(
        "deterministic frame steps",
        "Install a bridge with runtime.fixedStep; device scenarios never fall back to wall-clock sleeps.",
        target.name,
      ), target.name);
    }
    await throwIfAborted(target);
    setupApplication = bridge.setupApplication;
    await throwIfAborted(target);
    // Startup owns temporary operation timeouts during first-use compilation. Complete that
    // gate before the scenario's frame warmup against the ready world.
    const attached = bridge;
    // A counted desktop run's loop presents nothing between ticks, so its screenshot needs the
    // bridge's render-only operation. Gated on the advertised capability: a bridge that offers
    // none keeps the previous capture path rather than being handed an operation it lacks.
    const renderOnly = target.name === "desktop"
      && config.liveClock !== true
      && attached.description.capabilities.includes("runtime.renderOnly")
      ? () => attached.renderOnly()
      : undefined;
    const startupOutcome = scenario.awaitStartup === false
      ? undefined
      : await waitForStartupReady({
        bridge: attached,
        declaredSoftware: config.allowSoftwareAdapter === true,
        // A device host can die mid-launch, and its mailbox then simply stops answering. Without
        // this the wait reads that as a slow loading gate and burns its whole deadline; with it
        // the report names the exit and carries the console tail that says why.
        hostAlive: () => target.driver.isAlive().catch(() => undefined),
        pump: () => attached.advance(1),
      });
    await throwIfAborted(target);
    // Device requests are polled on animation frames; observe warmup draws, as the browser does,
    // without spending simulation ticks before the scenario starts.
    for (let frame = 0; frame < scenario.warmupFrames; frame += 1) {
      await bridge.sample({ entities: [], include: [] });
    }
    await throwIfAborted(target);

    await alignScenarioStartTick(bridge, scenario.startTick, config.liveClock === true);
    const entityIds = observedEntityIds(scenario);
    const sampleRequest = {
      ...(entityIds === undefined ? {} : { entities: entityIds }),
      include: [
        "components",
        "diagnostics",
        "entities",
        "resources",
        ...(scenario.assert?.aerodynamics === undefined &&
        scenario.assert?.contacts === undefined &&
        scenario.assert?.settled === undefined
          ? []
          : ["physicsDebugSeries"]),
        // The same two fields the browser lane requests, for the same reason: the bridge answers
        // only what it was asked for, so a `performance`, `parity` or `renderChain` assertion on a
        // device or desktop target used to evaluate against an empty series and fail as
        // "unobserved" even though the handshake advertises `runtime.performance` and
        // `runtime.renderChain`.
        ...(scenario.assert?.performance === undefined && scenario.assert?.parity === undefined
          ? []
          : ["runtimeDiagnosticsSeries"]),
        ...(scenario.assert?.renderChain === undefined ? [] : ["renderChain"]),
      ],
      resources: observedResourceIds(scenario),
      // One selector per assertion in scenario order: the evaluator reads observation `i` for
      // assertion `i`, so the mapping has to be positional and never deduplicated.
      ...(scenario.assert?.sceneNodes === undefined
        ? {}
        : { sceneNodes: scenario.assert.sceneNodes.map(({ select }) => select) }),
      // One armed capture per sample; absent means the bridge does no geometry work at all.
      ...(scenario.assert?.geometry === undefined ? {} : { geometry: scenario.assert.geometry }),
    } as const;
    const tone: IPlaytestToneCaptureObservation[] = [];
    const before = await bridge.sample(sampleRequest);
    if (completionLabel !== undefined && before.clock.mode !== "fixed-step") throw new Error("TN_PLAYTEST_COMPLETION_WINDOW_FAILED: prefix requires fixed-step clock");
    if (scenario.artifacts?.screenshots === "before-after" && config.captureArtifactScreenshots !== false) {
      await captureDeviceScreenshot(target, join(config.artifactDirectory, "before.png"), tone, "before.png", undefined, renderOnly, scenario.assert?.tone);
    }
    const pathEntity = scenario.assert?.movement?.pathLength === undefined
      ? undefined
      : scenario.assert.movement.entity ?? scenario.subject;
    const pathPositions: PlaytestVec3[] = [];
    appendPosition(pathPositions, before, pathEntity);
    const capturesAnonymousMovement = scenario.assert?.movement !== undefined
      && scenario.assert.movement.entity === undefined
      && scenario.subject === undefined;
    const movementSamples: Array<{ after: IPlaytestObservationSnapshot; before: IPlaytestObservationSnapshot; inputDriven: boolean }> = [];
    let movementCursor = before;
    const labeledSamples: Array<{ label: string; signals: unknown[]; snapshot: IPlaytestObservationSnapshot }> = [];
    const heldKeys = new Set<string>();
    let pointerButtons = 0;
    let pointerCount = 0;
    // Last viewport-pixel point the native host was told about. Release at the last point so the
    // native WebView receives the complete gesture; the host exposes no position to read back.
    let pointerX = 0;
    let pointerY = 0;
    // A buttons-0 move clears the mask but does not close the native gesture — only an explicit
    // `up` does. Track the open gesture separately from the button mask so a step that clears to
    // zero *and* asks for release still emits its close at the last point.
    let pointerHeld = false;
    const lifecycle = scenario.steps.some((step) => step.lifecycle !== undefined)
      ? new DeviceLifecycleRecorder(
        target.driver,
        // Only a build that installed a physics plugin owns a step counter, and it says so by
        // advertising the capability. Anything else is reported as unmeasured, never as zero.
        attached.description.capabilities.includes("runtime.physics"),
        // The step count is an observation like any other, read through the same sample request
        // the rest of the run uses rather than a channel of its own.
        () => attached.sample(sampleRequest),
      )
      : undefined;
    if (lifecycle !== undefined) await lifecycle.launch();
    for (const [index, step] of scenario.steps.entries()) {
      await throwIfAborted(target);
      if (step.lifecycle !== undefined) {
        // The only step kind the device performs itself, and the only one that skips the per-step
        // observation path: while the app is unfocused nothing is servicing the bridge, so a tick
        // or a sample here would read as a hung host. What it records instead is the device.
        await lifecycle?.run(step.lifecycle, () => attached.advance(1));
        continue;
      }
      const framebufferAssertion = scenario.assert?.framebufferCoverage;
      if (
        target.name === "android"
        && framebufferAssertion !== undefined
        && step.label === framebufferAssertion.window.startStep
      ) {
        try {
          await target.driver.startScreenRecording?.();
          coverageRecordingStarted = true;
          // Fixed-step calls can finish all eight scenario frames before Android's observed
          // ~15 fps recorder emits one. The opt-in pixel probe deliberately paces those renders.
          await delay(100);
        } catch (error) {
          framebufferCoverage = unreadableCoverageObservation(error);
        }
      }
      const pressed = step.press;
      const movementBefore = capturesAnonymousMovement ? movementCursor : undefined;
      let afterInput: IPlaytestObservationSnapshot;
      let afterStep: IPlaytestObservationSnapshot;
      let inputDriven = false;
      if (step.waitForResource !== undefined) {
        const wait = step.waitForResource;
        const timeoutMs = step.timeoutMs;
        if (timeoutMs === undefined) {
          throw new PlaytestBridgeError(playtestDiagnostic(
            "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
            `Resource wait for '${wait.id}.${wait.path}' has no timeout.`,
            "Validate the scenario with timeoutMs as a positive integer no greater than 120000.",
          ));
        }
        const attachedBridge = bridge;
        afterInput = await waitForResource({
          advance: () => attachedBridge.advance(1),
          id: wait.id,
          path: wait.path,
          predicate: wait,
          poll: () => attachedBridge.sample({ entities: [], include: ["resources"], resources: [wait.id] }),
          sample: () => attachedBridge.sample(sampleRequest),
          signal: target.abortSignal,
          timeoutMs,
        });
        afterStep = afterInput;
      } else {
        if (step.kind === "click") {
          await executeDeviceClickStep(target, bridge, step, scenario.viewport);
        }
        if (step.pointerPosition !== undefined) {
          const previousPointerButtons = pointerButtons;
          pointerButtons = step.pointerPosition.buttons ?? pointerButtons;
          if (pointerButtons !== 0) pointerHeld = true;
          pointerX = step.pointerPosition.x * scenario.viewport.width;
          pointerY = step.pointerPosition.y * scenario.viewport.height;
          await transport.call("input.pointer", {
            buttons: pointerButtons,
            type: pointerButtons === 0 ? "move" : previousPointerButtons === 0 ? "down" : "move",
            x: pointerX,
            y: pointerY,
          });
        }
        if (step.pointers !== undefined) {
          await setDevicePointers(target, transport, step.pointers, scenario.viewport);
          pointerCount = step.pointers.length;
        }
        if (step.media !== undefined) {
          await transport.call("input.media", {
            dark: step.media.colorScheme === undefined ? -1 : step.media.colorScheme === "dark" ? 1 : 0,
            reducedMotion: step.media.reducedMotion === undefined ? -1 : step.media.reducedMotion === "reduce" ? 1 : 0,
          });
        }
        if (step.wheel !== undefined) {
          // Viewport pixels, like every other device pointer; the centre when the step names no point,
          // which is where the browser lane turns the wheel too.
          await transport.call("input.wheel", {
            deltaX: step.wheel.deltaX ?? 0,
            deltaY: step.wheel.deltaY,
            x: (step.wheel.x ?? 0.5) * scenario.viewport.width,
            y: (step.wheel.y ?? 0.5) * scenario.viewport.height,
          });
        }
        if (typeof pressed === "string") {
          if (!heldKeys.has(pressed)) {
            await pressKey(target, transport, pressed);
            heldKeys.add(pressed);
          }
        } else if (pressed !== undefined) {
          for (const key of [...heldKeys]) {
            if (!pressed.includes(key)) {
              await transport.call("input.keyUp", { key });
              heldKeys.delete(key);
            }
          }
          for (const key of pressed) {
            if (!heldKeys.has(key)) {
              await pressKey(target, transport, key);
              heldKeys.add(key);
            }
          }
        }
        inputDriven = playtestStepDrivesMovement(
          step,
          heldKeys.size > 0 || pointerButtons !== 0 || pointerCount > 0,
        );
        const frames = Math.max(
          1,
          playtestStepHoldTicks(step, 0) + playtestStepWaitTicks(step),
          (step.holdFrames ?? 0) + (step.waitFrames ?? 0),
        );
        if (step.label === completionLabel && completionLabel !== undefined) {
          const setupSnapshot = await bridge.sample({ ...sampleRequest, include: [...new Set([...(sampleRequest.include ?? []), "scene", "resources"])], resources: [...new Set([...(sampleRequest.resources ?? []), "state", "hud"])] });
          if (setupSnapshot.clock.mode !== "fixed-step") throw new Error("TN_PLAYTEST_COMPLETION_WINDOW_FAILED: pose setup requires fixed-step clock");
          completionWindow = await measureCompletionWindow(completionLabel,
            (mode) => transport.call("_setClockMode", mode), () => transport.call("_presentationCompletions"), async () => {
              for (const key of heldKeys) await transport.call("input.keyUp", { key });
              heldKeys.clear();
              if (pointerButtons) await transport.call("input.pointer", { buttons: 0, type: "up", x: pointerX, y: pointerY });
              if (pointerCount) await transport.call("input.pointers", { pointers: [] });
              pointerButtons = 0; pointerCount = 0;
            });
          completionWindow.setupSnapshot = setupSnapshot;
        } else if (step.label !== undefined && cpuLabels.includes(step.label)) {
          const measuredBridge = bridge;
          if (frames > 1000) await measuredBridge.advance(frames - 1000);
          const profile: unknown = "profile" in measuredBridge.description ? measuredBridge.description.profile : undefined;
          const holdRender = target.name === "desktop" && typeof profile === "object" && profile !== null
            && "engine" in profile && profile.engine === "native";
          if (holdRender) await transport.call("_holdAutomaticRender", true);
          try {
            cpuWindows.push(await measureCpuWindow(step.label, async () => {
              const pid = target.driver.processId;
              if (pid === undefined) throw new Error("TN_PLAYTEST_CPU_WINDOW_FAILED: native child PID unavailable");
              return { rootPid: pid, pid, tid: pid };
            }, measuredBridge, () => measuredBridge.advance(1000)));
          } finally {
            if (holdRender) await transport.call("_holdAutomaticRender", false);
          }
        } else if (coverageRecordingStarted) {
          for (let frame = 0; frame < frames; frame += 1) {
            await bridge.advance(1);
            await delay(100);
          }
        } else {
          await bridge.advance(frames);
        }
        afterInput = await bridge.sample(sampleRequest);
        afterStep = afterInput;
      }
      appendPosition(pathPositions, afterInput, pathEntity);
      if (movementBefore !== undefined) {
        movementSamples.push({ after: afterInput, before: movementBefore, inputDriven });
      }
      if (step.label !== undefined) {
        const snapshot = await bridge.sample({ ...sampleRequest, label: step.label });
        const signals = bridge.description.capabilities.includes("runtime.events")
          ? await bridge.drainEvents()
          : [];
        labeledSamples.push({ label: step.label, signals, snapshot });
      }
      const wantsStepTone = step.label !== undefined && scenario.assert?.tone?.some(({ atStep }) => atStep === step.label) === true;
      if (step.screenshot !== undefined || wantsStepTone) {
        const label = step.screenshot === undefined ? `tone-${index}.png` : `${safePart(step.screenshot)}.png`;
        await captureDeviceScreenshot(target, join(config.artifactDirectory, label), tone, label, step.label, renderOnly, scenario.assert?.tone);
      }
      if (step.release && pressed !== undefined) {
        const released = typeof pressed === "string" ? [pressed] : [...pressed];
        for (const key of released) {
          await transport.call("input.keyUp", { key });
          heldKeys.delete(key);
        }
        if (index !== scenario.steps.length - 1) {
          await bridge.advance(1);
          if (capturesAnonymousMovement) afterStep = await bridge.sample(sampleRequest);
        }
      }
      // A pure `wait` advance never tears down a gesture it did not declare; its `release:true` is
      // the schema default, and the held aim has to survive the settles between its press and its
      // explicit release. Any other step closes the open gesture it carried or inherited.
      if (pointerHeld && step.release && step.kind !== "wait") {
        pointerButtons = 0;
        pointerHeld = false;
        await transport.call("input.pointer", { buttons: 0, type: "up", x: pointerX, y: pointerY });
      }
      if (step.pointers !== undefined && step.release) {
        await setDevicePointers(target, transport, [], scenario.viewport);
        pointerCount = 0;
        await bridge.advance(1);
        if (capturesAnonymousMovement) afterStep = await bridge.sample(sampleRequest);
      }
      if (
        movementBefore !== undefined
        && afterInput !== undefined
        && afterStep !== afterInput
      ) {
        movementSamples.push({ after: afterStep, before: afterInput, inputDriven: false });
      }
      if (capturesAnonymousMovement) movementCursor = afterStep;
      if (
        coverageRecordingStarted
        && target.name === "android"
        && framebufferAssertion !== undefined
        && step.label === framebufferAssertion.window.endStep
      ) {
        try {
          await target.driver.stopScreenRecording?.(coverageVideoPath);
          coverageRecordingStarted = false;
          framebufferCoverage = await analyzeFramebufferCoverageRecording(
            coverageVideoPath,
            config.artifactDirectory,
            framebufferAssertion,
            "scenario-steps",
          );
        } catch (error) {
          coverageRecordingStarted = false;
          framebufferCoverage = unreadableCoverageObservation(error);
        }
      }
    }
    const after = await bridge.sample(sampleRequest);
    appendPosition(pathPositions, after, pathEntity);
    metrics?.stop();
    await metrics?.sampleNow("after").catch(() => undefined);
    if (scenario.artifacts?.screenshots !== false || scenario.assert?.tone?.some(({ atStep }) => atStep === undefined) === true) {
      await captureDeviceScreenshot(target, join(config.artifactDirectory, "after.png"), tone, "after.png", undefined, renderOnly, scenario.assert?.tone);
    }
    if (!(await target.driver.isAlive())) {
      return failureReport(config, scenario, playtestDiagnostic(
        "TN_PLAYTEST_DEVICE_FAILED",
        `${targetLabel(target.name)} process '${target.processName}' exited before assertions were evaluated.`,
        `Inspect ${target.name === "android" ? "logcat" : "unified logs"}, fix the first native or JavaScript error, then rerun the same scenario.`,
      ), target.name);
    }
    const consoleEntries = await target.driver.captureConsole();
    const networkEntries = target.name === "desktop" && resolveDiagnosticsPolicy(scenario.assert?.diagnostics, target.name).noNetworkErrors
      ? desktopNetworkEntries(after)
      : [];
    const report = buildReport(
      config,
      scenario,
      before,
      after,
      consoleEntries,
      networkEntries,
      accumulatedPathLength(pathPositions),
      {},
      true,
      undefined,
      labeledSamples,
      framebufferCoverage,
      // The adapter this machine reported, read by the engine's own `adapter.info` probe and
      // carried in the census snapshot. Without it a device run reached `capture === undefined`,
      // so every `assert.renderChain.perAdapter` failed closed on a run that had a real adapter —
      // the flat expectation was used against a tier the software branch would have accepted.
      nativeCaptureProvenance(after?.pipelineCensus ?? before?.pipelineCensus, target.name, scenario.viewport),
      undefined,
      movementSamples,
      setupApplication,
      metrics?.observation(),
      undefined,
      startupOutcome === undefined
        ? undefined
        : { ...startupOutcome.startup, rule: startupOutcome.rule },
      lifecycle?.observation(),
      tone,
    );
    // Same artifacts as the browser target: a diagnostic that names console.json must find it
    // there whichever target produced the run.
    await writeObservationArtifacts(config.artifactDirectory, scenario.artifacts, {
      console: consoleEntries,
      network: networkEntries,
      runtimeTrace: undefined,
    });
    if (completionWindow !== undefined) completionWindow.provenance = { requestedDisplay: completionDisplay!, qualified: false, nativeVsync: process.env.TN_PLAYER_VSYNC };
    if (cpuWindows.length !== cpuLabels.length) throw new Error("TN_PLAYTEST_CPU_WINDOW_FAILED: missing requested CPU window");
    return {
      ...report,
      ...(completionWindow === undefined ? {} : { clock: "wall-clock" as const }),
      ...((cpuLabels.length === 0 && completionWindow === undefined) ? {} : { acquisition: { requestUrls: [],
        ...(cpuLabels.length === 0 ? {} : { cpuWindows }), ...(completionWindow === undefined ? {} : { completionWindow }) } }),
      runtime: "native",
      target: target.name,
      url: target.name === "desktop" ? config.desktop?.executable ?? target.processName : endpoint,
    };
  } catch (error) {
    if (error instanceof PlaytestBridgeError) {
      let diagnostic = error.diagnostic;
      failureEvidenceCaptured = true;
      // Preserve this failed host's output before stop/transport cleanup. Diagnostic
      // collection is best effort and must never replace the original failure.
      const consoleEntries = await target.driver.captureConsole().catch((captureError: unknown) => [
        {
          text: captureError instanceof Error ? captureError.message : String(captureError),
          type: "error",
        },
      ]);
      await writeFile(
        join(config.artifactDirectory, "console.json"),
        `${JSON.stringify(consoleEntries, null, 2)}\n`,
        "utf8",
      ).catch(() => undefined);
      if (
        diagnostic.code === "TN_PLAYTEST_OPERATION_TIMEOUT" ||
        diagnostic.code === "TN_PLAYTEST_STARTUP_HOST_EXITED"
      ) {
        // A timed-out operation must say what stopped answering: a host whose process exited is
        // a crash with evidence in its console tail, not a generic timeout (PRD-167).
        const hostAlive = await target.driver.isAlive().catch(() => undefined);
        const lastConsoleLines = hostAlive === false
          ? consoleEntries.slice(-6).map((entry) => entry.text)
          : [];
        diagnostic = deviceTimeoutDiagnostic(diagnostic, hostAlive, lastConsoleLines);
      }
      return { ...failureReport(config, scenario, diagnostic, target.name), observations: { console: consoleEntries, hud: {}, network: [], resources: {} } };
    }
    throw error;
  } finally {
    // The timed-out request remains available until close; retain it even if
    // console capture failed. An unavailable artifact must not mask the verdict.
    await Promise.resolve().then(async () => {
      const request = transport.getPendingRequest?.();
      if (request !== undefined) await writeFile(join(config.artifactDirectory, "device-request-context.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");
    }).catch(() => undefined);
    const cleanupErrors: unknown[] = [];
    const attemptCleanup = async (cleanup: () => Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await attemptCleanup(async () => {
      await writeFile(
        join(config.artifactDirectory, "device-response-observations.json"),
        `${JSON.stringify({
          responsePath: target.mailboxPaths.response,
          observations: responseObservations,
        }, null, 2)}\n`,
        "utf8",
      );
    });
    if (scenario.steps.some((step) => step.pointers !== undefined)) {
      await attemptCleanup(async () => {
        if (target.name === "ios") {
          await transport.call("input.pointers", { pointers: [] });
        } else if (target.name === "android") {
          await target.driver.setPointers?.([]);
        }
      });
    }
    await attemptCleanup(() => target.driver.stop());
    if (target.name === "desktop" && !failureEvidenceCaptured) {
      await attemptCleanup(async () => {
        await mkdir(config.artifactDirectory, { recursive: true });
        await writeObservationArtifacts(config.artifactDirectory, { console: true }, {
          console: await target.driver.captureConsole(), network: [], runtimeTrace: undefined,
        });
      });
    }
    await attemptCleanup(async () => {
      await bridge?.close();
    });
    await attemptCleanup(() => transport.close());
    metrics?.stop();
    if (cleanupErrors.length > 0) cleanupState.error = cleanupFailure(cleanupErrors);
  }
}

async function captureDeviceScreenshot(
  target: IDevicePlaytestTarget,
  path: string,
  tone: IPlaytestToneCaptureObservation[],
  label: string,
  atStep?: string,
  renderOnly?: () => Promise<void>,
  toneAssertions: readonly IPlaytestToneAssertion[] = [],
): Promise<void> {
  await target.driver.screenshot(path, renderOnly);
  const png = await readFile(path);
  // The browser bright-pixel floor rejected the native desktop frame panned-culled.png (PRD-569).
  // Its content ratio is at least 0.0044, so desktop takes the content floor.
  const stats = target.name === "desktop" ? assertDesktopCaptureNotBlank(png, path) : assertCaptureNotBlank(png, path);
  if (stats.tone !== undefined) tone.push({ code: "TN_TONE", label, ...(atStep === undefined ? {} : { atStep }), ...stats.tone });
  tone.push(...collectRegionalTone(png, toneAssertions, label, atStep));
}

/**
 * Only the Android lane can measure the device: desktop and iOS have no adb passthrough, and a
 * driver without `runAdb` (a test double, or a transport-only driver) reports nothing rather
 * than reporting invented zeros. A scenario that *asserts* device metrics never reaches here on
 * those targets — `unsupportedAssertion` fails it and names android first.
 */
function deviceMetricsRecorder(target: IDevicePlaytestTarget): DeviceMetricsRecorder | undefined {
  if (target.name !== "android") return undefined;
  const runAdb = target.driver.runAdb?.bind(target.driver);
  if (runAdb === undefined) return undefined;
  const serial = target.driver.deviceSerial?.();
  return new DeviceMetricsRecorder({
    adb: runAdb,
    ...(serial === undefined ? {} : { serial }),
  });
}

function cleanupFailure(errors: readonly unknown[]): Error {
  if (errors.length === 1) {
    const error = errors[0];
    return error instanceof Error ? error : new Error(String(error));
  }
  if (errors.length === 0) return new AggregateError(errors, "Device playtest cleanup failed.");
  const primary = errors[0];
  const detail = primary instanceof Error ? primary.message : String(primary);
  return new AggregateError(errors, `Device playtest cleanup failed. ${detail}`);
}

function createDeviceTransport(
  driver: IDevicePlaytestDriver,
  endpoint: string,
  paths: ReturnType<typeof androidMailboxPaths>,
  operationTimeoutMs: number,
): IDevicePlaytestTransport {
  if (isMailboxDriver(driver)) {
    const mailbox: IDeviceMailbox = {
      read: (path) => driver.readFile(path),
      remove: (path) => driver.removeFile(path),
      write: (path, contents) => driver.writeFile(path, contents),
    };
    return new DeviceMailboxTransport(mailbox, paths, operationTimeoutMs);
  }
  return new DeviceBridgeTransport(endpoint);
}

async function setDevicePointers(
  target: IDevicePlaytestTarget,
  transport: IDevicePlaytestTransport,
  pointers: NonNullable<IPlaytestScenario["steps"][number]["pointers"]>,
  viewport: IPlaytestScenario["viewport"],
): Promise<void> {
  if (target.name === "ios" || target.name === "desktop") {
    // iOS and desktop transports carry playtest requests into the native host, whose own hit
    // routing is the mechanism these scenarios test: the host dispatches each pointer to the UI
    // page or to the game exactly where the OS would. The held set is preserved without an
    // external HID injector, which the hosted macOS runner cannot use at all.
    await transport.call("input.pointers", {
      pointers: pointers.map((pointer) => ({
        ...(pointer.buttons === undefined ? {} : { buttons: pointer.buttons }),
        id: pointer.id,
        x: pointer.x * viewport.width,
        y: pointer.y * viewport.height,
      })),
    });
    return;
  }
  await target.driver.setPointers?.(pointers);
}

async function executeDeviceClickStep(
  target: IDevicePlaytestTarget,
  bridge: IPlaytestBridgeClient | undefined,
  step: IPlaytestScenario["steps"][number],
  viewport: IPlaytestScenario["viewport"],
): Promise<void> {
  if (target.name !== "android" || typeof target.driver.tap !== "function") {
    throw new PlaytestBridgeError(unsupportedDiagnostic(
      "click steps",
      "Run click steps on --target browser, or use an Android driver with OS pointer injection; native targets never fall back to keyboard input.",
      target.name,
    ));
  }
  const point = await deviceClickPoint(bridge, step);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0
    || point.x > viewport.width || point.y > viewport.height) {
    throw new PlaytestBridgeError(unsupportedDiagnostic(
      "click steps",
      `Resolve the click target inside the ${viewport.width}x${viewport.height} viewport; Android touch injection uses viewport pixels.`,
      target.name,
    ));
  }
  // The soft keyboard first, and never as a nicety. On a physical device, focusing a text field
  // opens an IME window over the bottom of the screen and the page reflows into what is left, so
  // the menu rides up and this coordinate now points at a key. The tap would not miss quietly —
  // it types into the field it was meant to submit. The emulator raises no IME, which is exactly
  // why this went unseen there.
  await target.driver.hideKeyboard?.();
  await target.driver.tap(point.x, point.y);
}

async function deviceClickPoint(
  bridge: IPlaytestBridgeClient | undefined,
  step: IPlaytestScenario["steps"][number],
): Promise<{ x: number; y: number }> {
  const target = step.at;
  if (target === undefined) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
      "Click step has no target.",
      "Declare at as viewport pixels ({ x, y }) or a registered entity ({ entity }).",
    ));
  }
  if ("element" in target) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
      "Click step targets a DOM element, which only the browser target can resolve.",
      "Run this click on --target browser, or target viewport pixels or a registered entity.",
    ));
  }
  if (!("entity" in target)) return { x: target.x, y: target.y };
  if (bridge === undefined) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
      `Click target entity '${target.entity}' cannot be resolved without a playtest bridge.`,
      "Install the playtest bridge and register the clickable entity, or use explicit viewport pixels.",
    ));
  }
  const snapshot = await bridge.sample({ entities: [target.entity] });
  const bounds = snapshot.entities?.find((candidate) => candidate.id === target.entity)?.bounds;
  if (bounds === undefined) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
      `Click target entity '${target.entity}' has no observed screen bounds.`,
      "Register a visible entity with the playtest bridge, or use explicit viewport pixels.",
    ));
  }
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/**
 * One key down through the mailbox, plus the OS key event a focused web-view input needs.
 *
 * A host whose native-css UI took the key says so (`consumedByUi`), and the OS event is then a
 * second delivery of the same key: a Space the UI already activated on, activated again by SDL's
 * own copy of it. A web-view overlay never consumes a mailbox key, so its OS event still goes out.
 */
async function pressKey(
  target: IDevicePlaytestTarget,
  transport: IDevicePlaytestTransport,
  key: string,
): Promise<void> {
  const reply = await transport.call<unknown>("input.keyDown", { key });
  const consumed = typeof reply === "object" && reply !== null
    && (reply as { consumedByUi?: unknown }).consumedByUi === true;
  if (!consumed) await sendAndroidTextInput(target, key);
}

async function sendAndroidTextInput(target: IDevicePlaytestTarget, key: string): Promise<void> {
  if (target.name !== "android" || target.driver.runAdb === undefined) return;
  const keyEvent = androidKeyEventCode(key);
  if (keyEvent === undefined) return;
  // The game mailbox still receives input.keyDown above. This OS-level text event is the
  // companion path for a focused WebView input; it never replaces the touch used to focus it.
  await target.driver.runAdb(["shell", "input", "keyevent", keyEvent]);
}

function androidKeyEventCode(key: string): string | undefined {
  if (key === " ") return "KEYCODE_SPACE";
  const normalized = key.toUpperCase();
  return /^[A-Z0-9]$/u.test(normalized) ? `KEYCODE_${normalized}` : undefined;
}

function isMailboxDriver(
  driver: IDevicePlaytestDriver,
): driver is IDevicePlaytestDriver & Required<Pick<IDevicePlaytestDriver, "readFile" | "removeFile" | "writeFile">> {
  return typeof driver.readFile === "function"
    && typeof driver.removeFile === "function"
    && typeof driver.writeFile === "function";
}

/** Whether this driver can background, foreground, rotate and then read the app back. */
function canDriveAndroidLifecycle(driver: IDevicePlaytestDriver): boolean {
  return typeof driver.background === "function"
    && typeof driver.foreground === "function"
    && typeof driver.rotate === "function"
    && typeof driver.lifecycleState === "function";
}

/** Bounded reads proving the platform's own frame count stopped while the app was unfocused. */
const ANDROID_LIFECYCLE_SETTLE_READS = 8;
/** The pause between settling reads: how often the counter is looked at while the app is away. */
const ANDROID_LIFECYCLE_SETTLE_POLL_MS = 250;
/** How long a backgrounded surface's counter must hold still before the runner calls it paused. */
const ANDROID_LIFECYCLE_PAUSE_HOLD_MS = 1_000;

/**
 * Drives a scenario's `lifecycle` steps and records what the device said at each one.
 *
 * Every value that reaches the report comes out of the driver — the pid from `pidof`, the focus
 * and window rotation from `dumpsys window`, the frames from `dumpsys gfxinfo` — and a reading
 * that is missing is a failed run rather than a zero. That is the whole reason this is runner-side:
 * a `GameState` resource is the game's own account of whether it went away and came back, which is
 * the one account that cannot be wrong in the direction anyone wants.
 */
class DeviceLifecycleRecorder {
  private readonly phases: IPlaytestDeviceLifecyclePhase[] = [];
  private readonly startedAt = Date.now();
  private readonly physicsSteps: IPlaytestDeviceLifecycleSteps = {
    afterAdvance: null,
    afterForeground: null,
    beforeBackground: null,
  };
  private pid = 0;

  constructor(
    private readonly driver: IDevicePlaytestDriver,
    /** Whether the build advertises `runtime.physics`, and so owns a step counter to read. */
    private readonly countsPhysicsSteps: boolean,
    /** One observation through the same sample request the rest of the run uses. */
    private readonly sample: () => Promise<IPlaytestObservationSnapshot>,
  ) {}

  /** The process the run launched, read before any step could change it. */
  async launch(): Promise<void> {
    const state = await this.readDevice();
    if (state.pid === undefined) {
      throw new PlaytestBridgeError(playtestDiagnostic(
        "TN_PLAYTEST_ANDROID_LIFECYCLE_UNOBSERVED",
        "`pidof` reports no process for the package this run launched, so there is no app session to follow.",
        "Launch the activity and confirm it is running before driving lifecycle steps; a lifecycle proof needs one live process to observe.",
      ));
    }
    this.pid = state.pid;
  }

  async run(
    step: NonNullable<IPlaytestScenario["steps"][number]["lifecycle"]>,
    advance: () => Promise<unknown>,
  ): Promise<void> {
    const operation = step.operation;
    const rotation = step.operation === "rotate" ? step.rotation : undefined;
    const driver = this.driver;
    // Read while the app can still answer. A backgrounded host is asleep, so this is the last
    // moment the count is readable, and the value the pause below is measured against.
    if (operation === "background") {
      this.physicsSteps.beforeBackground = await this.readPhysicsSteps();
    }
    try {
      if (operation === "background") await driver.background?.();
      else if (operation === "foreground") await driver.foreground?.();
      else await driver.rotate?.(rotation as number);
    } catch (error) {
      throw new PlaytestBridgeError(playtestDiagnostic(
        "TN_PLAYTEST_ANDROID_LIFECYCLE_NOT_APPLIED",
        `The device did not apply the '${operation}' lifecycle operation: ${error instanceof Error ? error.message : String(error)}`,
        "Inspect the device for an orientation lock, a permission prompt or a system dialog over the app, then rerun the same scenario.",
      ));
    }
    // The app is back and has not been advanced yet, so the count now is the count it returned
    // with. Reading it after the advance instead would fold the runner's own step into the value
    // the away period is supposed to be compared against.
    if (operation === "foreground") {
      this.physicsSteps.afterForeground = await this.readPhysicsSteps();
    }
    // A resumed app has to draw before its phase can claim it is drawing, and the host is asleep
    // until something asks it a question. One tick is the whole ask.
    if (operation !== "background") {
      await advance();
      this.physicsSteps.afterAdvance = await this.readPhysicsSteps();
    }
    const state = await this.read();
    this.requirePhaseEffect(operation, rotation, state);
    const settled = operation === "background" ? await this.readSettled(state) : undefined;
    const phase = settled?.state ?? state;
    this.phases.push({
      at: Date.now() - this.startedAt,
      focused: phase.focused,
      frames: phase.frames,
      ...(settled === undefined ? {} : { framesPaused: settled.framesPaused }),
      phase: operation,
      pid: phase.pid,
      ...(rotation === undefined ? {} : { requestedRotation: rotation }),
      ...(phase.windowRotation === undefined ? {} : { windowRotation: phase.windowRotation }),
    });
  }

  /**
   * The `background` phase's own claim: the surface stopped, so read the platform's frame counter
   * until it agrees. A backgrounded app that keeps rendering reports the truth —
   * `framesPaused: false`, for an assertion layer to bind to — rather than a settled value the
   * runner invented on its behalf.
   *
   * One unchanged count is not a paused surface. A renderer that is still drawing at 10 Hz answers
   * two quick reads with the same number, so a settling read followed by one equal read called a
   * live 10 Hz surface stopped — the exact claim this phase exists to make. The count therefore has
   * to hold still across a full second, and a count that moves resets the clock, so the settle is
   * bounded in wall time as well as in reads.
   */
  private async readSettled(initial: IAndroidAppState & { frames: number; pid: number }): Promise<{ framesPaused: boolean; state: IAndroidAppState & { frames: number; pid: number } }> {
    let state = initial;
    let heldSince = Date.now();
    for (let read = 0; read < ANDROID_LIFECYCLE_SETTLE_READS; read += 1) {
      await delay(ANDROID_LIFECYCLE_SETTLE_POLL_MS);
      const next = await this.read();
      if (next.frames !== state.frames) {
        heldSince = Date.now();
        state = next;
        continue;
      }
      if (Date.now() - heldSince >= ANDROID_LIFECYCLE_PAUSE_HOLD_MS) return { framesPaused: true, state: next };
      state = next;
    }
    return { framesPaused: false, state };
  }

  /**
   * The driver already waited for these readings; check them again here, because a phase is a
   * claim about the device and the claim is worth more than the command's exit code.
   */
  private requirePhaseEffect(
    operation: IAndroidLifecycleOperation,
    rotation: number | undefined,
    state: { focused: boolean; windowRotation?: number },
  ): void {
    if (state.focused !== (operation !== "background")) {
      throw new PlaytestBridgeError(playtestDiagnostic(
        "TN_PLAYTEST_ANDROID_LIFECYCLE_NOT_APPLIED",
        `After the '${operation}' operation the device still reports the app as ${state.focused ? "focused" : "unfocused"}.`,
        "Inspect the device for an orientation lock, a permission prompt or a system dialog over the app, then rerun the same scenario.",
      ));
    }
    if (rotation !== undefined && state.windowRotation !== rotation) {
      throw new PlaytestBridgeError(playtestDiagnostic(
        "TN_PLAYTEST_ANDROID_LIFECYCLE_NOT_APPLIED",
        `The '${operation}' operation asked for rotation ${rotation} and the device's window reports ${String(state.windowRotation)}.`,
        "Inspect the device for an orientation lock or a fixed-orientation activity, then rerun the same scenario.",
      ));
    }
  }

  observation(): IPlaytestDeviceLifecycleObservation {
    const background = this.phases.find(({ phase }) => phase === "background");
    const last = this.phases.at(-1);
    const { afterAdvance, afterForeground, beforeBackground } = this.physicsSteps;
    return {
      phases: this.phases,
      physics: this.countsPhysicsSteps
        ? {
            available: true,
            steps: { afterAdvance, afterForeground, beforeBackground },
            stepsAdvanced: afterForeground === null || afterAdvance === null
              ? null
              : afterAdvance > afterForeground,
            stepsPaused: beforeBackground === null || afterForeground === null
              ? null
              : afterForeground === beforeBackground,
          }
        : {
            available: false,
            reason: "the bridge does not advertise runtime.physics, so this build installs no physics plugin and nothing counts simulation steps; install rapier() to measure physics continuity across a lifecycle",
          },
      render: {
        framesAdvanced: background === undefined || last === undefined
          ? null
          : last.frames > background.frames,
        framesPaused: background?.framesPaused ?? null,
      },
      session: { pid: this.pid },
    };
  }

  /**
   * The runtime-owned simulation-step count, or nothing on a build that installs no physics plugin.
   *
   * Fails closed rather than reporting a zero: a bridge that advertises `runtime.physics` and
   * answers with no count, a string, or a negative number has not measured the simulation, and a
   * zero here would be indistinguishable from a game that genuinely never stepped.
   */
  private async readPhysicsSteps(): Promise<number | null> {
    if (!this.countsPhysicsSteps) return null;
    const value = (await this.sample()).physicsSteps;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new PlaytestBridgeError(playtestDiagnostic(
        "TN_PLAYTEST_ANDROID_LIFECYCLE_PHYSICS_UNOBSERVED",
        `The bridge advertises runtime.physics but reported ${JSON.stringify(value) ?? "no simulation-step count"} instead of one, so physics continuity cannot be recorded across the lifecycle.`,
        "Install rapier(), whose runtime.physics observation carries the step count taken at simulation.step, or drop the lifecycle steps. A count a game keeps in its own state is not a measurement, and an absent one is never read as a simulation that stood still.",
      ));
    }
    return value;
  }

  /** One device reading, in the process this run launched. A different pid is a failed run. */
  private async read(): Promise<IAndroidAppState & { frames: number; pid: number }> {
    const state = await this.readDevice();
    if (state.pid !== this.pid) {
      throw new PlaytestBridgeError(playtestDiagnostic(
        "TN_PLAYTEST_ANDROID_LIFECYCLE_SESSION_CHANGED",
        `The app process changed across the lifecycle: the run launched pid ${String(this.pid)} and the device now reports ${String(state.pid)}.`,
        "A lifecycle proof needs one process across background, foreground and rotation. Find what killed or relaunched the app before rerunning.",
      ));
    }
    return { ...state, pid: this.pid };
  }

  /** One complete device reading, or a named failure. Never a default. */
  private async readDevice(): Promise<IAndroidAppState & { frames: number }> {
    const state = await this.driver.lifecycleState?.();
    if (state?.frames === undefined) {
      throw new PlaytestBridgeError(playtestDiagnostic(
        "TN_PLAYTEST_ANDROID_LIFECYCLE_UNOBSERVED",
        "The device reported no frame count for this process, so a lifecycle phase cannot be recorded.",
        "Run against a device that answers `dumpsys gfxinfo <package>` with a frame counter, or drop the lifecycle steps; an absent counter is never read as a paused surface.",
      ));
    }
    return { ...state, frames: state.frames };
  }
}

function unsupportedAssertion(
  scenario: IPlaytestScenario,
  target: "android" | "desktop" | "ios",
  hasPointerTransport: boolean,
  canDriveLifecycle: boolean,
): IPlaytestProtocolDiagnostic | undefined {
  if (scenario.steps.some((step) => step.lifecycle !== undefined)
    && (target !== "android" || !canDriveLifecycle)) {
    return unsupportedDiagnostic(
      "lifecycle steps",
      "Run lifecycle steps on --target android with the adb-backed driver. The browser, desktop and iOS lanes cannot background, foreground or rotate the app, and the phases this step reports have to be read off the device — a game-authored GameState would only restate what the scenario already said.",
      target,
    );
  }
  // A wheel and a media step reach Android the way they reach desktop: `input.wheel` /
  // `input.media` over the mailbox, into `playtestInput` on the host, then `uiOverlayRouteWheel` /
  // `uiOverlaySetEnvironment` — all host-neutral (runtime.cpp, ui_overlay.cpp), and the Android
  // build attaches the same native-css document (`attachDesktopCssUi` from android_main.cpp). A
  // wheel a scroller did not take, and a media set on a build with no CSS UI attached, both fail
  // by name from the host itself (packages/playtest/src/three/device.ts), so nothing here has to
  // guess on the host's behalf. iOS keeps its refusal: its overlay is a WKWebView mirror
  // (`attachIosUiOverlay`), which has no native-css environment to emulate or scroll.
  if (target === "ios" && scenario.steps.some((step) => step.wheel !== undefined)) {
    return unsupportedDiagnostic(
      "wheel input steps",
      "Run wheel input steps on --target browser, --target desktop or --target android; the iOS overlay is a web-view mirror with no native-css scroller to turn, and will not skip the sample.",
      target,
    );
  }
  if (target === "ios" && scenario.steps.some((step) => step.media !== undefined)) {
    return unsupportedDiagnostic(
      "media steps",
      "Run media steps on --target browser, --target desktop or --target android (native-css UI); the iOS overlay is a web-view mirror with no native-css environment to emulate, and will not skip the step.",
      target,
    );
  }
  if (scenario.steps.some((step) => step.kind === "click")
    && (target !== "android" || !hasPointerTransport)) {
    return unsupportedDiagnostic(
      "click steps",
      "Run click steps on --target browser, or use an Android driver with OS pointer injection; native targets never fall back to keyboard input.",
      target,
    );
  }
  // Desktop now carries the complete held-pointer set through its mailbox host (see
  // `setDevicePointers`), which routes each pointer through the overlay's published hit regions,
  // so held-pointer steps are no longer unsupported there. Android still needs its emulator
  // driver, checked above.
  if (scenario.assert?.deviceMetrics !== undefined && target !== "android") {
    return unsupportedDiagnostic(
      "device thermal and power assertions",
      `Run this assertion on --target android; ${targetLabel(target)} has no battery, thermal or power-rail probe.`,
      target,
    );
  }
  // Desktop consumes the host fetch observation; the other device lanes still lack an observer.
  if (scenario.assert?.diagnostics?.noNetworkErrors === true && target !== "desktop") {
    return unsupportedDiagnostic(
      "network assertions",
      `Run this assertion on --target browser; ${targetLabel(target)} device transport has no CDP network observer. Remove the explicit network assertion, or declare "diagnostics": { "noNetworkErrors": false, "networkErrorsOptOutReason": "..." } to record a scenario-owned waiver.`,
      target,
    );
  }
  if ((scenario.assert?.hud?.length ?? 0) > 0 || (scenario.assert?.overlayNodes?.length ?? 0) > 0) {
    return unsupportedDiagnostic(
      "DOM assertions",
      `Use runtime resources/components for a cross-target scenario; ${targetLabel(target)} has no DOM observer.`,
      target,
    );
  }
  if ((scenario.assert?.visual?.length ?? 0) > 0) {
    return unsupportedDiagnostic(
      "visual assertions",
      `${targetLabel(target)} screenshots are captured as artifacts, but visual metric evaluation is not supported yet.`,
      target,
    );
  }
  if (scenario.assert?.framebufferCoverage !== undefined && target === "ios") {
    return unsupportedDiagnostic(
      "framebuffer coverage recording",
      "Run this assertion on --target browser or --target android; the iOS transport has no per-frame recorder observer.",
      target,
    );
  }
  if (scenario.assert?.framebufferCoverage !== undefined && target === "desktop") {
    return unsupportedDiagnostic(
      "framebuffer coverage recording",
      "Run this assertion on --target browser or --target android; the desktop mailbox exposes screenshots, not a per-frame recorder observer.",
      target,
    );
  }
  return undefined;
}

function unsupportedDiagnostic(
  subject: string,
  fix: string,
  target: "android" | "desktop" | "ios",
): IPlaytestProtocolDiagnostic {
  return playtestDiagnostic(
    "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
    `${targetLabel(target)} ${target === "desktop" ? "desktop" : "device"} target does not support ${subject}.`,
    fix,
  );
}

function unreadableCoverageObservation(error: unknown): IPlaytestFramebufferCoverageObservation {
  return {
    boundarySource: "scenario-steps",
    frameCount: 0,
    unreadableReason: error instanceof Error ? error.message : String(error),
    windowCompleted: false,
    windowStarted: false,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


function desktopNetworkEntries(snapshot: IPlaytestObservationSnapshot): Array<{ method: string; url: string }> {
  const network = snapshot.network;
  if (network === undefined || network === null || !Number.isSafeInteger(network.requests)
    || network.requests < 0 || !Array.isArray(network.entries) || network.entries.length > 256
    || network.requests < network.entries.length || network.entries.some((entry) =>
      entry === null || typeof entry !== "object" || typeof entry.method !== "string"
      || entry.method.length === 0 || typeof entry.url !== "string" || entry.url.length === 0)) {
    throw new Error("TN_PLAYTEST_NETWORK_UNOBSERVED: desktop host network observation is missing or malformed.");
  }
  return network.entries;
}
