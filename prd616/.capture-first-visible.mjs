import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { chromium } from "../../packages/playtest/node_modules/playwright/index.mjs";
import { captureVisualSurface, withBrowserCapture } from "../../packages/playtest/dist/runner/index.js";

const execFileAsync = promisify(execFile);
const root = resolve(".");
const beforeProject = resolve("..", "prd616-before");
const scenarioRelative = "examples/abyss-framework/playtests/warm-up-reuse.playtest.json";
const expectedBaseline = "1d056cec3d84ad0a6aebd89a97d3bd66b8d04de9";
const runTimeoutMs = 900_000;
const nativeGatesMarker = resolve(root, "..", "..", ".linchpin/prd616-native-gates.running");
const nativeGatesWaitLimitMs = 900_000;
const browserRecipe = "webgpu";
const visibleWorldFrames = 5;
let nativeGatesWaitLogged = false;

/** Installed before navigation by the orchestrator; the same function is exercised by --selfcheck. */
function createFirstVisibleFrameController(host) {
  const requestAnimationFrame = host.requestAnimationFrame;
  const cancelAnimationFrame = host.cancelAnimationFrame;
  if (typeof requestAnimationFrame !== "function" || typeof cancelAnimationFrame !== "function")
    throw new Error("TN_STARTUP_PROOF_RAF_UNAVAILABLE");
  const originalRequestAnimationFrame = requestAnimationFrame.bind(host);
  const originalCancelAnimationFrame = cancelAnimationFrame.bind(host);
  let currentCallback;
  let heldCallback;
  let pendingHeld;
  let stepPending;

  const invoke = (callback, time) => {
    const previous = currentCallback;
    currentCallback = callback;
    try {
      callback(time);
    } finally {
      currentCallback = previous;
    }
  };
  const invokeHeld = (time) => {
    const callback = heldCallback;
    if (callback === undefined) throw new Error("TN_STARTUP_PROOF_HELD_CALLBACK_MISSING");
    if (pendingHeld !== undefined && pendingHeld !== callback)
      throw new Error("TN_STARTUP_PROOF_PENDING_CALLBACK_CHANGED");
    pendingHeld = undefined;
    const pending = stepPending;
    stepPending = undefined;
    if (pending?.scheduledId !== undefined) originalCancelAnimationFrame(pending.scheduledId);
    try {
      invoke(callback, time);
      pending?.resolve();
    } catch (error) {
      pending?.reject(error);
      throw error;
    }
  };
  const wrappedRequestAnimationFrame = (callback) => {
    if (typeof callback !== "function") throw new TypeError("requestAnimationFrame callback must be a function");
    return originalRequestAnimationFrame((time) => {
      if (callback === heldCallback) {
        pendingHeld = callback;
        if (stepPending === undefined) return;
        invokeHeld(time);
        return;
      }
      invoke(callback, time);
    });
  };
  const wrappedCancelAnimationFrame = (handle) => originalCancelAnimationFrame(handle);
  const holdCurrentCallback = () => {
    if (currentCallback === undefined) throw new Error("TN_STARTUP_PROOF_ACTIVE_CALLBACK_MISSING");
    if (heldCallback !== undefined && heldCallback !== currentCallback)
      throw new Error("TN_STARTUP_PROOF_WORLD_CALLBACK_CHANGED");
    heldCallback = currentCallback;
  };
  const step = () => {
    if (heldCallback === undefined) throw new Error("TN_STARTUP_PROOF_WORLD_CALLBACK_UNHELD");
    if (stepPending !== undefined) throw new Error("TN_STARTUP_PROOF_STEP_ALREADY_PENDING");
    return new Promise((resolveStep, rejectStep) => {
      stepPending = { reject: rejectStep, resolve: resolveStep };
      stepPending.scheduledId = originalRequestAnimationFrame((time) => {
        if (stepPending === undefined) return;
        invokeHeld(time);
      });
    });
  };
  const paint = (callback) => {
    if (typeof callback !== "function") throw new TypeError("paint callback must be a function");
    return originalRequestAnimationFrame(callback);
  };
  const state = () => ({
    current: currentCallback !== undefined,
    held: heldCallback !== undefined,
    pending: pendingHeld !== undefined,
    stepPending: stepPending !== undefined,
  });
  const controller = { holdCurrentCallback, paint, state, step };
  Object.defineProperty(host, "requestAnimationFrame", {
    configurable: true,
    value: wrappedRequestAnimationFrame,
    writable: true,
  });
  Object.defineProperty(host, "cancelAnimationFrame", {
    configurable: true,
    value: wrappedCancelAnimationFrame,
    writable: true,
  });
  Object.defineProperty(host, "__TN_STARTUP_PROOF_CONTROLLER__", {
    configurable: true,
    value: controller,
    writable: false,
  });
  return controller;
}

async function runSelfcheck() {
  const { installStartupProof } = await import("../../examples/abyss-framework/src/replay-proof.ts");
  const installerCallbacks = new Map();
  let installerNextHandle = 1;
  const installerHost = {
    cancelAnimationFrame(handle) {
      installerCallbacks.delete(handle);
    },
    requestAnimationFrame(callback) {
      const handle = installerNextHandle++;
      installerCallbacks.set(handle, callback);
      return handle;
    },
  };
  const installerController = createFirstVisibleFrameController(installerHost);
  const installerFlush = () => {
    const next = installerCallbacks.entries().next();
    if (next.done) throw new Error("TN_STARTUP_PROOF_INSTALLER_QUEUE_EMPTY");
    installerCallbacks.delete(next.value[0]);
    next.value[1](Date.now());
  };
  const pendingMicrotasks = [];
  const label = {
    dataset: {},
    remove() {
      this.removed = true;
    },
    style: { cssText: "" },
    textContent: "",
  };
  const previousGlobals = new Map(
    ["document", "location", "queueMicrotask", "__TN_STARTUP_READY__", "__TN_STARTUP_PROOF_CONTROLLER__", "__TN_STARTUP_PROOF_RECORD__", "__TN_STARTUP_FIRST_WORLD_CPU__"].map((name) => [
      name,
      { present: Object.hasOwn(globalThis, name), value: globalThis[name] },
    ]),
  );
  try {
    globalThis.document = {
      body: { append(element) { assert.equal(element, label); } },
      createElement(tag) {
        assert.equal(tag, "div");
        return label;
      },
    };
    globalThis.location = { search: "?startupProof=before" };
    globalThis.queueMicrotask = (callback) => pendingMicrotasks.push(callback);
    globalThis.__TN_STARTUP_READY__ = false;
    globalThis.__TN_STARTUP_PROOF_CONTROLLER__ = installerController;
    let hook;
    let unregistered = false;
    let drawStarted = false;
    const ctx = {
      beforeRender(callback) {
        hook = callback;
        return () => { unregistered = true; };
      },
    };
    let diagnosticsEnabled = false;
    let warmBoundary = false;
    let tick = 7;
    let phases = { render: 29 };
    let series = [{ frameMs: 11, phases }];
    const runtime = {
      enableRuntimeDiagnostics: () => {
        assert.equal(drawStarted, false, "diagnostics enabled after first draw");
        diagnosticsEnabled = true;
      },
      pipelineCensus: () => ({ complete: true, ...(warmBoundary ? { warmUpSettled: { boundaryMs: 1 } } : {}) }),
      runtimeDiagnosticsSeries: () => series,
      startupTimeline: () => ({ readyMs: 1 }),
      tick: () => tick,
    };
    const unregister = installStartupProof(ctx, runtime);
    assert.equal(typeof unregister, "function");
    assert.equal(diagnosticsEnabled, true, "installer did not enable runtime diagnostics");
    const invokeHook = () => {
      drawStarted = true;
      hook();
    };
    installerHost.requestAnimationFrame(invokeHook);
    installerFlush();
    assert.equal(pendingMicrotasks.length, 0, "prewarm callback was treated as the first world draw");
    warmBoundary = true;
    installerHost.requestAnimationFrame(invokeHook);
    installerFlush();
    assert.equal(pendingMicrotasks.length, 1, "installer did not queue its first post-warm read");
    phases = { render: 29 };
    series = [{ frameMs: 29, phases }];
    pendingMicrotasks.shift()();
    assert.equal(globalThis.__TN_STARTUP_FIRST_WORLD_CPU__.ready, false);
    assert.equal(globalThis.__TN_STARTUP_FIRST_WORLD_CPU__.tick, 7);
    assert.equal(globalThis.__TN_STARTUP_FIRST_WORLD_CPU__.census.warmUpSettled.boundaryMs, 1);
    assert.equal(globalThis.__TN_STARTUP_FIRST_WORLD_CPU__.renderMs, 29);
    globalThis.__TN_STARTUP_READY__ = true;
    tick = 8;
    installerHost.requestAnimationFrame(invokeHook);
    installerFlush();
    assert.equal(pendingMicrotasks.length, 1, "installer did not queue its post-draw read");
    phases = { render: 12 };
    series = [{ frameMs: 12, phases }];
    pendingMicrotasks.shift()();
    installerFlush();
    assert.equal(globalThis.__TN_STARTUP_PROOF_RECORD__.frame, 1);
    assert.equal(globalThis.__TN_STARTUP_PROOF_RECORD__.painted, true);
    assert.equal(globalThis.__TN_STARTUP_PROOF_RECORD__.tick, 8);
    assert.equal(globalThis.__TN_STARTUP_PROOF_RECORD__.frameBudget.phases.render, 12);
    assert.equal(globalThis.__TN_STARTUP_FIRST_WORLD_CPU__.renderMs, 29);
    const secondStep = installerController.step();
    installerFlush();
    await secondStep;
    assert.throws(() => pendingMicrotasks.shift()(), /TN_STARTUP_PROOF_FRAME_BUDGET_STALE/);
    unregister();
    assert.equal(unregistered, true);
    assert.equal(label.removed, true);
    console.log("TN_STARTUP_PROOF_INSTALLER_SELFCHECK: pass");
  } finally {
    for (const [name, previous] of previousGlobals) {
      if (previous.present) globalThis[name] = previous.value;
      else delete globalThis[name];
    }
  }

  let nextHandle = 1;
  const callbacks = new Map();
  const host = {
    cancelAnimationFrame(handle) {
      callbacks.delete(handle);
    },
    requestAnimationFrame(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
  };
  const controller = createFirstVisibleFrameController(host);
  let worldFrames = 0;
  let harnessFrames = 0;
  let cancelledFrames = 0;
  const world = () => {
    worldFrames += 1;
    if (worldFrames === 1) controller.holdCurrentCallback();
    host.requestAnimationFrame(world);
  };
  const flush = () => {
    const next = callbacks.entries().next();
    if (next.done) throw new Error("TN_STARTUP_PROOF_SELFCHECK_QUEUE_EMPTY");
    callbacks.delete(next.value[0]);
    next.value[1](Date.now());
  };
  host.requestAnimationFrame(world);
  const cancelled = host.requestAnimationFrame(() => { cancelledFrames += 1; });
  host.cancelAnimationFrame(cancelled);
  host.requestAnimationFrame(() => { harnessFrames += 1; });
  flush();
  flush();
  flush();
  assert.equal(worldFrames, 1, "unsolicited held world callback ran");
  assert.equal(harnessFrames, 1, "harness RAF did not continue");
  assert.equal(cancelledFrames, 0, "cancelAnimationFrame did not cancel");
  const firstStep = controller.step();
  flush();
  await firstStep;
  assert.equal(worldFrames, 2, "first explicit step did not run exactly one world frame");
  const secondStep = controller.step();
  flush();
  await secondStep;
  assert.equal(worldFrames, 3, "second explicit step did not run exactly one world frame");
  host.requestAnimationFrame(() => { harnessFrames += 1; });
  flush();
  flush();
  assert.equal(harnessFrames, 2, "harness RAF stopped while world was held");
  host.requestAnimationFrame(() => controller.holdCurrentCallback());
  assert.throws(flush, /TN_STARTUP_PROOF_WORLD_CALLBACK_CHANGED/);
  const auxiliaryStateBefore = controller.state();
  const worldFramesBeforeAuxiliary = worldFrames;
  let auxiliaryPaints = 0;
  controller.paint(() => controller.paint(() => { auxiliaryPaints += 1; }));
  flush();
  flush();
  assert.equal(auxiliaryPaints, 1, "two auxiliary paint RAFs did not settle");
  assert.equal(worldFrames, worldFramesBeforeAuxiliary, "auxiliary paint advanced held world callback");
  assert.deepEqual(controller.state(), auxiliaryStateBefore, "auxiliary paint changed controller state");
  console.log("TN_STARTUP_PROOF_SELFCHECK: pass");
}

async function runSelfcheckCli() {
  const loaderFlag = "TN_STARTUP_PROOF_SELFCHECK_TSX";
  if (process.env[loaderFlag] === "1") return runSelfcheck();
  const result = await execFileAsync(
    "pnpm",
    ["exec", "tsx", fileURLToPath(import.meta.url), "--selfcheck"],
    { cwd: root, env: { ...process.env, [loaderFlag]: "1" } },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function gitHead(projectPath) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath, encoding: "utf8" }).trim();
}

async function waitForNativeGates() {
  const startedAt = Date.now();
  while (true) {
    try {
      await access(nativeGatesMarker);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!nativeGatesWaitLogged) {
      console.log(`TN_STARTUP_PROOF_WAITING_FOR_NATIVE_GATES:${nativeGatesMarker}`);
      nativeGatesWaitLogged = true;
    }
    if (Date.now() - startedAt >= nativeGatesWaitLimitMs)
      throw new Error(`TN_STARTUP_PROOF_NATIVE_GATES_WAIT_TIMEOUT:${nativeGatesMarker}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
}

function parseArm(argv) {
  const indexes = argv.flatMap((value, index) => value === "--arm" ? [index] : []);
  if (argv.some((value) => value.startsWith("--arm=")) || indexes.length > 1)
    throw new Error("TN_STARTUP_PROOF_ARM_INVALID: use at most one --arm before|after");
  if (indexes.length === 0) return undefined;
  const arm = argv[indexes[0] + 1];
  if (arm !== "before" && arm !== "after")
    throw new Error("TN_STARTUP_PROOF_ARM_INVALID: use --arm before or --arm after");
  return arm;
}

function captureConfig(projectPath, artifactDirectory, arm) {
  return {
    artifactDirectory,
    headless: false,
    projectPath,
    scenarioPath: join(projectPath, scenarioRelative),
    server: {
      command: "pnpm --filter abyss-framework dev --host 127.0.0.1 --port $PORT --strictPort",
      cwd: projectPath,
      timeoutMs: 120_000,
    },
    target: "browser",
    timeoutMs: runTimeoutMs,
    trace: false,
    url: "http://127.0.0.1:0/?startupProof=" + arm,
    port: 0,
  };
}

async function withInjectedBrowserCapture(config, capture) {
  const originalLaunch = chromium.launch;
  const launch = originalLaunch.bind(chromium);
  chromium.launch = async (...launchArguments) => {
    const browser = await launch(...launchArguments);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...contextArguments) => {
      const context = await newContext(...contextArguments);
      await context.addInitScript({ content: `(${createFirstVisibleFrameController.toString()})(globalThis);` });
      return context;
    };
    return browser;
  };
  try {
    return await withBrowserCapture(config, capture);
  } finally {
    chromium.launch = originalLaunch;
  }
}

async function waitForRecord(page, frame) {
  const handle = await page.waitForFunction(
    (expectedFrame) => {
      const record = globalThis.__TN_STARTUP_PROOF_RECORD__;
      return record?.frame === expectedFrame ? record : undefined;
    },
    frame,
    { timeout: 30_000 },
  );
  return handle.jsonValue();
}

async function readState(page, bridge) {
  const snapshot = await bridge.sample({ entities: ["player"] });
  const player = snapshot.entities?.find(({ id }) => id === "player");
  const position = player?.transform?.position;
  const seed = snapshot.gameplay?.world?.seed;
  if (!Array.isArray(position) || position.length !== 3 || position.some((value) => typeof value !== "number" || !Number.isFinite(value)))
    throw new Error("TN_STARTUP_PROOF_PLAYER_POSE_MISSING");
  if (seed !== 90210) throw new Error(`TN_STARTUP_PROOF_SEED_MISMATCH:${String(seed)}`);
  return { position: [...position], seed };
}

async function readCaptureBoundary(page, bridge) {
  const proof = await page.evaluate(() => {
    const record = globalThis.__TN_STARTUP_PROOF_RECORD__;
    if (record?.painted !== true || !Number.isInteger(record.frame) || !Number.isInteger(record.tick))
      throw new Error("TN_STARTUP_PROOF_CAPTURE_BOUNDARY_RECORD_MISSING");
    const phases = record.frameBudget?.phases;
    if (phases === null || typeof phases !== "object" || typeof phases.render !== "number")
      throw new Error("TN_STARTUP_PROOF_CAPTURE_BOUNDARY_CPU_MISSING");
    const controller = globalThis.__TN_STARTUP_PROOF_CONTROLLER__;
    if (typeof controller?.state !== "function")
      throw new Error("TN_STARTUP_PROOF_CAPTURE_BOUNDARY_CONTROLLER_MISSING");
    const controllerState = controller.state();
    if (controllerState.held !== true || controllerState.stepPending !== false)
      throw new Error("TN_STARTUP_PROOF_CAPTURE_BOUNDARY_CONTROLLER_NOT_HELD");
    const staticText = document.body?.textContent;
    if (typeof staticText !== "string") throw new Error("TN_STARTUP_PROOF_CAPTURE_BOUNDARY_DOM_MISSING");
    return {
      controllerState,
      cpuPhases: phases,
      staticText,
      simulationTick: record.tick,
      worldOrdinal: record.frame,
    };
  });
  const state = await readState(page, bridge);
  return { ...proof, pose: state.position, seed: state.seed };
}

async function waitForAuxiliaryPaints(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const controller = globalThis.__TN_STARTUP_PROOF_CONTROLLER__;
    if (typeof controller?.paint !== "function")
      throw new Error("TN_STARTUP_PROOF_AUXILIARY_PAINT_CONTROLLER_MISSING");
    controller.paint(() => controller.paint(() => resolve()));
  }));
}

function censusMetadata(census) {
  if (census?.complete !== true || census?.overflowed === true || census?.unsupported === true)
    throw new Error("TN_STARTUP_PROOF_CENSUS_INCOMPLETE");
  if (census.counts?.droppedEvents !== 0 || census.incompleteReasons?.length !== 0)
    throw new Error("TN_STARTUP_PROOF_CENSUS_DROPPED_OR_INCOMPLETE");
  const boundary = census.warmUpSettled;
  if (boundary === undefined) throw new Error("TN_STARTUP_PROOF_WARM_BOUNDARY_MISSING");
  const events = Array.isArray(census.events) ? census.events : [];
  const warmPrograms = new Set(
    events.filter((event) => event.beforeWarmUpSettled === true).map((event) => event.programIdentity),
  );
  const postEvents = events.filter((event) => event.beforeWarmUpSettled === false);
  const warmedWorld = postEvents.filter((event) => warmPrograms.has(event.programIdentity) && event.provenance?.object !== undefined);
  const postProcessing = postEvents.filter((event) => !warmPrograms.has(event.programIdentity));
  const unknown = postEvents.filter((event) => event.provenance?.unknown === true || typeof event.programIdentity !== "string");
  if (unknown.length > 0) throw new Error("TN_STARTUP_PROOF_CENSUS_UNKNOWN_PROVENANCE");
  return {
    globalCounts: census.counts,
    postEvents: postEvents.length,
    postProcessing: {
      graphs: new Set(postProcessing.map((event) => event.programIdentity)).size,
      pipelines: postProcessing.filter((event) => event.kind === "render" && event.status === "created").length,
    },
    warmBoundary: boundary,
    warmedWorld: {
      graphs: new Set(warmedWorld.map((event) => event.programIdentity)).size,
      nodeBuilds: warmedWorld.reduce((total, event) => total + (event.nodeBuilds ?? 0), 0),
      pipelines: warmedWorld.filter((event) => event.kind === "render" && event.status === "created").length,
      positiveNodeBuilds: warmedWorld.some((event) => (event.nodeBuilds ?? 0) > 0),
    },
  };
}

async function annotate(rawPath, annotatedPath, label) {
  await execFileAsync("magick", [
    rawPath,
    "-bordercolor", "#101828",
    "-border", "0x96",
    "-fill", "#ffffff",
    "-font", "DejaVu-Sans-Bold",
    "-pointsize", "48",
    "-gravity", "South",
    "-annotate", "+0+18", label,
    annotatedPath,
  ]);
}

async function captureRun({ arm, projectPath, run }) {
  await waitForNativeGates();
  const artifactDirectory = resolve(`artifacts/prd616/first-visible/${arm}-${run}`);
  await mkdir(artifactDirectory, { recursive: true });
  const result = await withInjectedBrowserCapture(captureConfig(projectPath, artifactDirectory, arm), async (session) => {
    const firstWorldCpu = await session.page.waitForFunction(
      () => globalThis.__TN_STARTUP_READY__ === true && globalThis.__TN_STARTUP_FIRST_WORLD_CPU__,
      undefined,
      { timeout: 30_000 },
    ).then((handle) => handle.jsonValue());
    if (firstWorldCpu?.error !== undefined)
      throw new Error(`TN_STARTUP_PROOF_FIRST_WORLD_CPU:${String(firstWorldCpu.error)}`);
    if (typeof firstWorldCpu?.renderMs !== "number" || !Number.isFinite(firstWorldCpu.renderMs) || firstWorldCpu.renderMs <= 0)
      throw new Error("TN_STARTUP_PROOF_FIRST_WORLD_CPU_SAMPLE_MISSING");
    if (typeof firstWorldCpu.ready !== "boolean" || typeof firstWorldCpu.tick !== "number")
      throw new Error("TN_STARTUP_PROOF_FIRST_WORLD_CPU_METADATA_MISSING");
    const firstWorldCensusMetadata = censusMetadata(firstWorldCpu.census);
    const frames = [];
    for (let frame = 1; frame <= visibleWorldFrames; frame += 1) {
      if (frame > 1) {
        await session.bridge.advance(1);
        await session.page.evaluate(() => globalThis.__TN_STARTUP_PROOF_CONTROLLER__.step());
      }
      const record = await waitForRecord(session.page, frame);
      if (record.frame !== frame || record.painted !== true) throw new Error(`TN_STARTUP_PROOF_FRAME_IDENTITY:${String(frame)}`);
      if (
        typeof record.frameBudget?.frameMs !== "number" ||
        !Number.isFinite(record.frameBudget.frameMs) ||
        typeof record.frameBudget.phases?.render !== "number" ||
        !Number.isFinite(record.frameBudget.phases.render)
      )
        throw new Error(`TN_STARTUP_PROOF_CPU_SAMPLE_MISSING:${String(frame)}`);
      const state = await readState(session.page, session.bridge);
      const labelVisibility = await session.page.evaluate(() => {
        const label = document.querySelector("[data-tn-startup-proof]");
        if (!(label instanceof HTMLElement)) throw new Error("TN_STARTUP_PROOF_LABEL_MISSING");
        const previous = label.style.visibility;
        label.style.visibility = "hidden";
        return previous;
      });
      let raw;
      try {
        const boundaryBeforePaint = await readCaptureBoundary(session.page, session.bridge);
        await waitForAuxiliaryPaints(session.page);
        const boundaryAfterPaint = await readCaptureBoundary(session.page, session.bridge);
        assert.deepEqual(
          boundaryAfterPaint,
          boundaryBeforePaint,
          `auxiliary paint changed held world state at frame ${String(frame)}`,
        );
        raw = await captureVisualSurface(session.page);
      } finally {
        await session.page.evaluate((previous) => {
          const label = document.querySelector("[data-tn-startup-proof]");
          if (!(label instanceof HTMLElement)) throw new Error("TN_STARTUP_PROOF_LABEL_MISSING");
          label.style.visibility = previous;
        }, labelVisibility);
        await waitForAuxiliaryPaints(session.page);
      }
      if (raw === undefined) throw new Error(`TN_STARTUP_PROOF_CANVAS_MISSING:${String(frame)}`);
      const image = PNG.sync.read(raw);
      if (image.width !== 1280 || image.height !== 720)
        throw new Error(`TN_STARTUP_PROOF_CANVAS_SIZE:${String(image.width)}x${String(image.height)}`);
      const rawPath = join(artifactDirectory, `frame-${String(frame)}.png`);
      const annotatedPath = join(artifactDirectory, `frame-${String(frame)}-annotated.png`);
      await writeFile(rawPath, raw);
      await annotate(rawPath, annotatedPath, `${arm.toUpperCase()}  FIRST-VISIBLE-WORLD  FRAME ${String(frame)}`);
      const afterCapture = await session.page.evaluate(() => globalThis.__TN_STARTUP_PROOF_RECORD__);
      if (afterCapture?.frame !== frame || afterCapture?.painted !== true)
        throw new Error(`TN_STARTUP_PROOF_FRAME_CHANGED_DURING_CAPTURE:${String(frame)}`);
      frames.push({
        frame,
        image: { annotated: annotatedPath, raw: rawPath },
        record,
        state,
        censusMetadata: censusMetadata(record.census),
      });
    }
    const controllerState = await session.page.evaluate(() => globalThis.__TN_STARTUP_PROOF_CONTROLLER__.state());
    if (controllerState.held !== true || controllerState.stepPending !== false)
      throw new Error("TN_STARTUP_PROOF_CONTROLLER_NOT_HELD");
    const firstVisibleRenderMs = frames[0]?.record.frameBudget.phases.render;
    if (typeof firstVisibleRenderMs !== "number" || !Number.isFinite(firstVisibleRenderMs))
      throw new Error("TN_STARTUP_PROOF_FIRST_RENDER_SAMPLE_MISSING");
    return {
      adapter: session.provenance.adapter,
      browserRecipe,
      frames,
      firstWorldCpu,
      firstWorldCensusMetadata,
      firstWorldRenderMs: firstWorldCpu.renderMs,
      firstVisibleRenderMs,
    };
  });
  await writeFile(join(artifactDirectory, "first-visible.json"), `${JSON.stringify({
    arm,
    browserRecipe,
    commit: gitHead(projectPath),
    firstWorld: {
      adapter: result.adapter,
      censusMetadata: result.firstWorldCensusMetadata,
      readiness: result.firstWorldCpu.ready,
      renderMs: result.firstWorldRenderMs,
      tick: result.firstWorldCpu.tick,
      timing: "first game-loop world draw after warmUpSettled; runtimeDiagnosticsSeries phases.render",
    },
    firstVisible: {
      adapter: result.adapter,
      readiness: true,
      renderMs: result.firstVisibleRenderMs,
      tick: result.frames[0].record.tick,
      timing: "first post-readiness visible world frame; frameBudget phases.render",
    },
    firstWorldRenderMs: result.firstWorldRenderMs,
    firstVisibleRenderMs: result.firstVisibleRenderMs,
    run,
    ...result,
  }, null, 2)}\n`);
  console.log(JSON.stringify({
    adapter: result.adapter,
    arm,
    frames: result.frames.map(({ frame, record, state }) => ({
      frame,
      frameMs: record.frameBudget.frameMs,
      renderMs: record.frameBudget.phases.render,
      seed: state.seed,
      tick: record.tick,
    })),
    firstWorldRenderMs: result.firstWorldRenderMs,
    firstVisibleRenderMs: result.firstVisibleRenderMs,
    run,
  }));
  return result;
}

async function main() {
  const requestedArm = parseArm(process.argv.slice(2));
  if (process.argv.includes("--selfcheck")) return runSelfcheckCli();
  const baselineHead = gitHead(beforeProject);
  assert.equal(baselineHead, expectedBaseline, `baseline HEAD must remain ${expectedBaseline}`);
  const fullMatrix = [
    { arm: "before", projectPath: beforeProject, run: "run1" },
    { arm: "before", projectPath: beforeProject, run: "run2" },
    { arm: "after", projectPath: root, run: "run1" },
    { arm: "after", projectPath: root, run: "run2" },
    { arm: "after", projectPath: root, run: "run3-cpu" },
  ];
  const matrix = requestedArm === undefined ? fullMatrix : fullMatrix.filter(({ arm }) => arm === requestedArm);
  assert.equal(matrix.filter(({ arm }) => arm === "before").length, requestedArm === "after" ? 0 : 2);
  assert.equal(matrix.filter(({ arm }) => arm === "after").length, requestedArm === "before" ? 0 : 3);
  const results = [];
  for (const entry of matrix) results.push({ ...entry, result: await captureRun(entry) });
  for (const arm of ["before", "after"]) {
    const runs = results.filter((entry) => entry.arm === arm);
    if (runs.length === 0) continue;
    const first = runs[0].result.frames;
    for (const run of runs.slice(1)) {
      assert.deepEqual(run.result.frames.map(({ state }) => state), first.map(({ state }) => state), `${arm} pose/seed repeatability`);
    }
  }
  if (requestedArm !== "after") assert.equal(results.filter(({ arm }) => arm === "before").length, 2);
  if (requestedArm !== "before") assert.equal(results.filter(({ arm }) => arm === "after").length, 3);
  const afterFirstWorldRenderMs = results
    .filter(({ arm }) => arm === "after")
    .map(({ result }) => result.firstWorldRenderMs);
  const afterFirstWorldMedianMs = afterFirstWorldRenderMs.length === 0
    ? undefined
    : [...afterFirstWorldRenderMs].sort((left, right) => left - right)[Math.floor(afterFirstWorldRenderMs.length / 2)];
  if (afterFirstWorldRenderMs.length > 0 && afterFirstWorldRenderMs.length !== 3)
    throw new Error("TN_STARTUP_PROOF_AFTER_FIRST_WORLD_SAMPLE_COUNT");
  const metadataName = requestedArm === undefined ? "matrix.json" : `${requestedArm}-matrix.json`;
  const metadataPath = resolve(`artifacts/prd616/first-visible/${metadataName}`);
  await writeFile(metadataPath, `${JSON.stringify({
    baseline: { commit: baselineHead, projectPath: beforeProject },
    browserRecipe,
    candidate: { commit: gitHead(root), projectPath: root },
    selection: requestedArm ?? "full",
    afterFirstWorldMedianMs,
    matrix: results.map(({ arm, result, run }) => ({ arm, run, adapter: result.adapter, samples: {
      firstWorld: {
        adapter: result.adapter,
        censusMetadata: result.firstWorldCensusMetadata,
        readiness: result.firstWorldCpu.ready,
        renderMs: result.firstWorldRenderMs,
        tick: result.firstWorldCpu.tick,
        timing: "first game-loop world draw after warmUpSettled; runtimeDiagnosticsSeries phases.render",
      },
      firstVisible: {
        adapter: result.adapter,
        readiness: true,
        renderMs: result.firstVisibleRenderMs,
        tick: result.frames[0].record.tick,
        timing: "first post-readiness visible world frame; frameBudget phases.render",
      },
    }, frames: result.frames.map(({ censusMetadata, frame, record }) => ({
      censusMetadata,
      frame,
      frameBudget: { phases: { render: record.frameBudget.phases.render } },
    })) })),
    timing: "firstWorldRenderMs is the first game-loop world draw after warmUpSettled; firstVisibleRenderMs is separate; no FPS or screenshot duration",
  }, null, 2)}\n`);
  console.log(`TN_STARTUP_PROOF_PREPARED:${metadataPath}`);
}

await main();
