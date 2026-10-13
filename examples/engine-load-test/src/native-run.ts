// Native entry for the PRD-117 ThreeNative desktop/device arms. It drives the same ladder as the
// web entry against the same `game.ts`, and prints the §5.1 run report between two markers because
// a native host has no `window` for the collector to read.
import { MatrixWorldPass } from "../../../packages/core/src/matrix-world.js";
import { RenderCameraCull } from "../../../packages/core/src/render-camera-cull.js";
import { SceneRenderProjection } from "../../../packages/core/src/renderProjection.js";
import { downscaleFrame, drawnFrameReader } from "./frame-read.js";
import { type ICharacterCrowd, createLoadTestHarness } from "./game.js";
import { ladderRank } from "./ladder.js";
import {
  PHASES,
  createPhaseRecorder,
  crossingReader,
  threadCpuClock,
  topCrossings,
} from "./phases.js";
import {
  type RenderMode,
  isProjectedRung,
  isRealisticRung,
  parseAxesRecord,
  percentile,
} from "./workload.js";

declare global {
  var canvas: HTMLCanvasElement | undefined;
}

// "desktop" and "android" run the legacy host; "engine-desktop" runs the owned engine player (arm
// `tn-engine-desktop`), which draws through the same harness and the same workload.
declare const __TN_PLATFORM__: string;

declare const __TN_BENCH_CONFIG__: Readonly<{
  animate: boolean;
  axes: Record<string, string | undefined>;
  frames: number;
  height: number;
  refreshHz: number;
  ladder: number[];
  modes: RenderMode[];
  /** Per-frame phase telemetry, which the pair bench turns on for both arms (`TN_BENCH_PHASES=1`). */
  phases?: boolean;
  /** `renderer.projection: "js"`, the named override that forces core's mirror on the engine player (`TN_BENCH_PROJECTION=js`). */
  projection?: "js";
  repeats: number;
  sourceSha?: string;
  warmup: number;
  width: number;
}>;

const config = __TN_BENCH_CONFIG__;
const axes = parseAxesRecord(config.axes);
const onEngine = __TN_PLATFORM__ === "engine-desktop";

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame((timestamp) => resolve(timestamp)));
}

export async function runNative(createFoxCrowd: () => Promise<ICharacterCrowd>): Promise<void> {
  try {
    await main(createFoxCrowd);
  } catch (error: unknown) {
    console.log(`ENGINE_LOAD_TEST_FAILED ${String(error)}`);
  }
}

async function main(createFoxCrowd: () => Promise<ICharacterCrowd>): Promise<void> {
  const presentMode =
    (globalThis as { __THREENATIVE_NATIVE__?: { presentMode?: string } }).__THREENATIVE_NATIVE__
      ?.presentMode ?? "fifo";
  // The desktop collector requests immediate presentation. The host's separate 60 FPS ceiling
  // otherwise still paces the run, so require its existing diagnostic uncapped mode as well.
  if (__TN_PLATFORM__ === "desktop" && presentMode !== "fifo") {
    const presentationCap = (globalThis as { __tnPresentationCap?: (hz: number) => number })
      .__tnPresentationCap;
    if (typeof presentationCap !== "function" || presentationCap(0) !== 0)
      throw new Error("TN_BENCH_PRESENTATION_CAP_NOT_DISABLED");
  }
  const surface = globalThis.canvas;
  if (surface === undefined) throw new Error("TN_BENCH_NO_CANVAS");
  // The characters are decoded before the harness exists, and only when a ladder rung asked for
  // them, so R3's first measured frame is a skinning frame rather than a decode frame.
  // Only R3 and above draw the crowd, so R1 and R2 do not pay to build 50 rigs they never attach.
  const characters = config.modes.some(
    (mode) => isRealisticRung(mode) && ladderRank(mode) >= ladderRank("R3"),
  )
    ? await createFoxCrowd()
    : undefined;
  // The projection is passed in rather than imported by `game.ts`, so the `plain-three-webgpu`
  // control can drive the same harness without the framework in its graph. This arm has one, and
  // L3 is a native cell. The other two passes a shipped `defineGame` installs around the draw go
  // with it, at the same defaults `defineGame` resolves (`renderer.matrixWorld` is `"visible"`,
  // `renderer.minimumProjectedPixels` is 0.5), because an L3 that kept three's own world-matrix
  // walk and no projected-size cull would time a pipeline no ThreeNative game ever draws with.
  const phases = config.phases === true ? createPhaseRecorder(threadCpuClock()) : undefined;
  const crossings = phases === undefined ? undefined : crossingReader();
  const readDrawn = (globalThis as { tn?: { readFrame?: () => Promise<Uint8Array> } }).tn
    ?.readFrame;
  const harness = await createLoadTestHarness(
    surface,
    "native host surface",
    config.animate,
    axes,
    (scene, options) =>
      new SceneRenderProjection(
        scene,
        config.projection === "js" ? { ...options, projection: "js" } : options,
      ),
    { cameraCull: new RenderCameraCull(), matrixWorld: new MatrixWorldPass() },
    characters,
    readDrawn === undefined ? undefined : drawnFrameReader(nextFrame, readDrawn),
    phases,
  );
  const rungs: unknown[] = [];

  for (const objectCount of config.ladder) {
    for (const mode of config.modes) {
      for (let repeat = 0; repeat < config.repeats; repeat += 1) {
        console.log(`begin ${mode}@${objectCount}`);
        harness.setRung({ mode, objectCount });
        if (isProjectedRung(mode)) {
          harness.beginCollapse();
          for (let settle = 0; settle < 5_000 && harness.collapseStatus() === "pending"; settle++) {
            // See the web entry: drawing one settle frame in eight keeps the host's frame pump
            // alive without paying the un-collapsed scene every iteration.
            harness.step(settle);
            if (settle % 8 === 0) await harness.render();
            // A settle that never finishes is otherwise indistinguishable from a slow one: the run
            // just never reports. Say where it is often enough to tell those apart.
            if (settle % 200 === 0) {
              console.log(
                `settle ${settle} status=${harness.collapseStatus()} moving=${harness.collapseMovingParts()}`,
              );
            }
            await nextFrame();
          }
          // L4 measures what the shipped default costs on a scene nothing may batch, so the
          // projection declining is that row's answer and `drawCalls` is what records it. The
          // realistic-scene rungs are L3's authoring, so they keep L3's two guards.
          if (mode === "L3" || isRealisticRung(mode)) {
            // `projected` is the projection's applied state. The pass this replaced said `applied`;
            // both mean the same thing here, that the optimizer took the scene rather than handing
            // the frame back, and a rung that measured an un-optimized scene must still refuse to
            // report rather than publish L1 timings under an L3 label.
            if (
              harness.collapseStatus() !== "projected" &&
              harness.collapseStatus() !== "hostProjected"
            )
              throw new Error(`TN_BENCH_COLLAPSE_${harness.collapseStatus().toUpperCase()}`);
            // Fail closed on the frozen scene: see the web entry for why a fast still picture is the
            // dangerous outcome here, not the good one.
            const moving = harness.collapseMovingParts();
            if (moving < objectCount)
              throw new Error(`TN_BENCH_COLLAPSE_FROZE:${moving}/${objectCount}`);
          }
        }
        const frameMs: number[] = [];
        // Split the frame in two: `stepMs` is the game-side transform loop, the remainder is the
        // renderer. Without the split a mobile regression cannot be attributed to either.
        const stepMs: number[] = [];
        const collapseMs: number[] = [];
        // The rAF timestamp the host handed this frame's callback, aligned one-to-one with
        // frameMs/stepMs/collapseMs so a budget sample can be joined to the host-gap meter's
        // rafTimestampMs without inferring it from wall time.
        const rafTimestampMs: number[] = [];
        const phaseMs: number[][] = PHASES.map(() => []);
        let crossingsAtOpen: Record<string, number> | undefined;
        let ladder: unknown;
        let foxMeasurement: unknown;
        let renderCheck: unknown;
        let drawCalls = 0;
        let triangles = 0;
        let visibleObjects = 0;
        let previous = performance.now();
        let compilesAtWindowStart = 0;
        const statsFrame = Math.floor((config.frames + config.warmup) / 2);
        for (let frameIndex = 0; frameIndex < config.frames; frameIndex += 1) {
          if (frameIndex === config.warmup) {
            compilesAtWindowStart = harness.pipelineCompiles();
            // Where the timed window opens: the runner reads the process's CPU time here and at `rung`.
            console.log(`window ${mode}@${objectCount}`);
            // Phases opened before this frame (the settle, the warmup probe) are not the window's.
            phases?.take();
            crossingsAtOpen = crossings?.();
          }
          harness.step(frameIndex);
          await harness.render();
          const taken = phases?.take();
          if (taken !== undefined && frameIndex >= config.warmup)
            taken.forEach((ms, index) => phaseMs[index]?.push(Math.round(ms * 1000) / 1000));
          if (frameIndex === statsFrame) {
            const stats = harness.stats();
            drawCalls = stats.drawCalls;
            triangles = stats.triangles;
            visibleObjects = stats.visibleObjects;
            // The rung's asserted scene cost, read at the same frame as the counters.
            ladder = harness.ladderCounts();
            foxMeasurement = harness.foxMeasurement();
          }
          // PRD-464: the rung's own read-back, on the last warmup frame so the GPU stall the
          // read-back causes never lands inside a measured frame. See the web entry.
          if (frameIndex === config.warmup - 1 && isRealisticRung(mode))
            renderCheck = await harness.probeFrame();
          const rafTimestamp = await nextFrame();
          const now = performance.now();
          const interval = now - previous;
          previous = now;
          if (frameIndex >= config.warmup) {
            frameMs.push(Math.round(interval * 1000) / 1000);
            stepMs.push(Math.round(harness.stepMs * 1000) / 1000);
            collapseMs.push(Math.round(harness.collapseMs * 1000) / 1000);
            rafTimestampMs.push(Math.round(rafTimestamp * 1000) / 1000);
          }
        }
        const crossingTop =
          crossingsAtOpen === undefined || crossings === undefined
            ? undefined
            : topCrossings(crossingsAtOpen, crossings(), frameMs.length);
        rungs.push({
          collapseMs,
          drawCalls,
          frameMs,
          ...(foxMeasurement === undefined ? {} : { foxMeasurement }),
          ...(ladder === undefined ? {} : { ladder }),
          ...(renderCheck === undefined ? {} : { renderCheck }),
          ...(phases === undefined
            ? {}
            : { phases: Object.fromEntries(PHASES.map((name, index) => [name, phaseMs[index]])) }),
          ...(crossingTop === undefined ? {} : { crossingTop }),
          pipelineCompiles: harness.pipelineCompiles() - compilesAtWindowStart,
          stepMs,
          mode,
          objectCount,
          positionHash: harness.positionHash,
          rafTimestampMs,
          repeat,
          triangles,
          visibleObjects,
        });
        console.log(
          `rung ${mode}@${objectCount} frame p50 ${percentile(frameMs, 0.5).toFixed(2)} | step p50 ${percentile(stepMs, 0.5).toFixed(2)} | collapse p50 ${percentile(collapseMs, 0.5).toFixed(2)} | game p50 ${(percentile(stepMs, 0.5) - percentile(collapseMs, 0.5)).toFixed(2)} ms | movingParts ${harness.collapseMovingParts()}`,
        );
        // Close the CPU marker before the existing read-back stalls the GPU. No scene step follows the last measured draw.
        const lastRung = rungs[rungs.length - 1] as Record<string, unknown>;
        await harness.probeFrame((fullPixels, width, height) => {
          const pixels = downscaleFrame(fullPixels, width, height);
          const chunks: string[] = [];
          for (let offset = 0; offset < pixels.length; offset += 4096)
            chunks.push(
              Array.from({ length: Math.min(4096, pixels.length - offset) }, (_, index) =>
                (pixels[offset + index] as number).toString(16).padStart(2, "0"),
              ).join(""),
            );
          lastRung.frameRgba = { width: 160, height: 90, data: chunks.join("") };
        });
      }
    }
  }

  // Declared, not read off `globalThis`: vite's `define` substitutes the bare identifier, so a
  // property access like `scope.__TN_PLATFORM__` is never replaced and silently reads undefined —
  // which filed every phone run as `tn-desktop`.
  const onAndroid = __TN_PLATFORM__ === "android";
  const report = {
    arm: onAndroid ? "tn-android" : onEngine ? "tn-engine-desktop" : "tn-desktop",
    axes,
    build: {
      notes: onEngine
        ? "owned C++ engine player (V8), facade renderer; defineGame loop not in the measured path"
        : "owned C++ runtime, three/webgpu render path; defineGame loop not in the measured path",
      type: "release",
    },
    // Labelled from the target the binary was built for, not hardcoded. A phone run that files
    // itself as `desktop-native-linux @ 60 Hz` is mislabelled evidence, and `refreshHz` is not
    // cosmetic — the scorer refuses to compare two arms whose displays disagree.
    device: { battery: null, label: onAndroid ? "android-native" : "desktop-native-linux" },
    display: {
      // The host surface this run was given, not the drawing buffer a rung drew into: R1-R4 render
      // at 1280x720 inside the 1920x1080 window the ladder is run with, and the per-rung
      // `ladder.resolution` is the field that says so.
      height: config.height,
      refreshHz: __TN_BENCH_CONFIG__.refreshHz,
      // Read back from the surface, never assumed: the host reports `fifo`, `immediate` or
      // `mailbox`, and only `fifo` pins frames to the display. Reporting `true` unconditionally is
      // how an uncapped run still described itself as display-bound.
      vsync: presentMode === "fifo",
      width: config.width,
    },
    driver: {
      adapter: harness.adapterLabel,
      renderer: onEngine
        ? "native engine player (V8) with the three/webgpu facade"
        : "three/webgpu WebGPURenderer (native host)",
    },
    engine: { name: "threenative", version: "workspace" },
    // Only the one field the host can know: the module graph and adapter identity the web arm
    // derives need an HTTP server this target has none of, and a partial identity is read as
    // "not an accepted baseline" rather than as a claim.
    ...(config.sourceSha === undefined ? {} : { identity: { sourceSha: config.sourceSha } }),
    rungs,
  };
  // Android's logcat truncates a line at ~1 KB, which silently cut every report this arm emitted
  // until the collector tried to parse one. The payload goes out in chunks and is rejoined.
  const payload = JSON.stringify(report);
  // The log is not a reliable transport for a payload this size and the collector must not depend
  // on it alone. At 600 frames across a full ladder the report is well over a megabyte and goes out
  // in one burst; Android's logd rate-limits a single uid and silently discards most of it,
  // including the terminating marker the collector waits for. Enlarging the ring buffer does not
  // help, because the drop happens at write time rather than through eviction.
  //
  // So the report is also written to storage, where the collector can read it whole. The chunked
  // log emission below stays: it is the only path on hosts without persistent storage, and it is
  // what desktop already parses.
  try {
    globalThis.localStorage?.setItem("TN_BENCH_REPORT", payload);
  } catch {
    // Best effort. A host without storage still has the log path below.
  }
  console.log("ENGINE_LOAD_TEST_JSON_BEGIN");
  for (let offset = 0; offset < payload.length; offset += 800) {
    console.log(`TNJSON:${payload.slice(offset, offset + 800)}`);
  }
  console.log("ENGINE_LOAD_TEST_JSON_END");
  harness.dispose();
}
