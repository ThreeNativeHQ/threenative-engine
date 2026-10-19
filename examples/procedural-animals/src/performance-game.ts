import { FRAME_HITCH_MARKER, type IFrameBudgetWindow, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { Mesh } from "three";
import { type AnimalMode, Animals, type IAnimalsState } from "./Animals.js";
import { releaseAll } from "./cleanup.js";
import { observeAnimalSubmissions } from "./observe-submissions.js";
import {
  type AnimalPerformanceClock,
  readAnimalPerformanceClock,
  requireAnimalClockSpan,
  requireAnimalTickCoverage,
} from "./performance-clock.js";
import { AnimalPerformanceCollector, type GpuFrameObservation } from "./performance-collector.js";
import { performanceProjection } from "./render/performance-camera.js";

// The runner retains console text; preserve AggregateError causes rather than only its label.
function errorMessage(error: unknown): string {
  return error instanceof AggregateError
    ? `${String(error)}: [${error.errors.map(errorMessage).join("; ")}]`
    : String(error);
}

function readDiagnostic<T>(read: () => T, errors: unknown[]): T | undefined {
  try {
    return read();
  } catch (error) {
    errors.push(error);
    return undefined;
  }
}

export function makeAnimalPerformanceGame(mode: Exclude<AnimalMode, "qualification">) {
  class Workload extends Animals {
    constructor() {
      super(mode);
    }
  }
  let requested = false;
  let consumeReport: ((message: string) => void) | undefined;
  let consumeWindow: ((window: IFrameBudgetWindow) => void) | undefined;
  return defineGame<IAnimalsState, IPhysicsContext>({
    assets: { basePath: "" },
    input: { benchmark: { keys: ["KeyB"] } },
    plugins: [
      rapier(),
      playtest(),
      {
        beforeUpdate(ctx) {
          if (ctx.startup.phase === "ready" && ctx.input.justPressed("benchmark")) requested = true;
        },
        setup(ctx, runtime) {
          let live = true;
          let admitting = false;
          let clockStart: AnimalPerformanceClock | undefined;
          let previousWindowTick = runtime?.tick();
          let measurementStartTick: number | undefined;
          let measurementEndTick: number | undefined;
          let finished = false;
          let startedAt = 0;
          let compileCount: number | undefined;
          let surface: string | undefined;
          let collector: AnimalPerformanceCollector | undefined;
          let observer: GpuFrameObservation | undefined;
          let restoreSubmissions: (() => void) | undefined;
          const expected = mode === "baseline" ? 0 : mode === "high" ? 1 : 32;
          const release = () =>
            releaseAll([
              () => {
                restoreSubmissions?.();
                restoreSubmissions = undefined;
              },
              () => {
                collector?.dispose();
                collector = undefined;
              },
              () => {
                observer?.dispose();
                observer = undefined;
              },
            ]);
          const fail = (error: unknown) => {
            if (finished || !live) return;
            finished = true;
            const diagnosticErrors: unknown[] = [];
            const partialRows =
              readDiagnostic(() => collector?.recordedRows(), diagnosticErrors) ?? [];
            // Read only the already-resolved CPU queue; never wait for pending GPU work.
            const partialGpu = readDiagnostic(() => observer?.take(), diagnosticErrors) ?? [];
            const observerStatusBeforeCleanup = readDiagnostic(
              () => observer?.status(),
              diagnosticErrors,
            );
            let failure = diagnosticErrors.length
              ? new AggregateError(
                  [error, ...diagnosticErrors],
                  "TN_ANIMAL_PERFORMANCE_DIAGNOSTICS",
                )
              : error;
            let cleanupError: unknown;
            try {
              release();
            } catch (cleanup) {
              cleanupError = cleanup;
              failure = new AggregateError([failure, cleanup], "TN_ANIMAL_PERFORMANCE_CLEANUP");
            }
            ctx.state.set({
              performanceFinished: true,
              performanceDone: false,
              performanceError: errorMessage(failure),
            });
            // Cleanup ends measurement before any diagnostic I/O; partial rows never qualify.
            console.log(
              `TN_ANIMAL_PERFORMANCE_ABORT ${JSON.stringify({ mode, wolves: expected, recordedFrames: partialRows.length, resolvedGpuFrames: partialGpu.length, observerStatusBeforeCleanup, error: errorMessage(error), diagnosticErrors: diagnosticErrors.map(errorMessage), cleanupError: cleanupError === undefined ? undefined : errorMessage(cleanupError) })}`,
            );
            for (const [index, row] of partialRows.entries())
              console.log(`TN_ANIMAL_PERFORMANCE_PARTIAL_ROW ${JSON.stringify({ index, ...row })}`);
            for (const [index, sample] of partialGpu.entries())
              console.log(
                `TN_ANIMAL_PERFORMANCE_PARTIAL_GPU ${JSON.stringify({ index, ...sample })}`,
              );
            console.error(failure);
          };
          consumeReport = (message) => {
            if (!live || finished || !collector || !message.startsWith(`${FRAME_HITCH_MARKER}:`))
              return;
            fail(new Error(`TN_ANIMAL_PERFORMANCE_FRAME_HITCH:${message}`));
          };
          consumeWindow = (window) => {
            const previousTick = previousWindowTick;
            const tick = runtime?.tick();
            previousWindowTick = tick;
            if (!live || finished || !collector) return;
            try {
              const now = performance.now();
              if (now - startedAt > 600000)
                throw new Error("TN_ANIMAL_PERFORMANCE_OVERALL_TIMEOUT");
              if (ctx.renderer.compiling || ctx.renderer.compileCount !== compileCount)
                throw new Error("TN_ANIMAL_PERFORMANCE_COMPILATION_CHANGED");
              const drawn = window.surface;
              if (
                !drawn ||
                drawn.resolutionScale !== 1 ||
                drawn.scaleSource !== "pinned" ||
                drawn.compiling === true ||
                !Number.isSafeInteger(drawn.drawingBufferWidth) ||
                drawn.drawingBufferWidth <= 0 ||
                !Number.isSafeInteger(drawn.drawingBufferHeight) ||
                drawn.drawingBufferHeight <= 0 ||
                !Number.isSafeInteger(drawn.sampleCount) ||
                drawn.sampleCount <= 0
              )
                throw new Error("TN_ANIMAL_PERFORMANCE_SURFACE_UNAVAILABLE");
              const signature = JSON.stringify({
                scale: drawn.resolutionScale,
                source: drawn.scaleSource,
                width: drawn.drawingBufferWidth,
                height: drawn.drawingBufferHeight,
                samples: drawn.sampleCount,
              });
              if (surface !== undefined && signature !== surface)
                throw new Error("TN_ANIMAL_PERFORMANCE_SURFACE_CHANGED");
              surface = signature;
              if (previousTick === undefined || tick === undefined)
                throw new Error("TN_ANIMAL_PERFORMANCE_TICK_UNAVAILABLE");
              requireAnimalTickCoverage(previousTick, tick, window.substeps.mean);
              collector.cpu(window, now);
              if (collector.renderedFrames === 2100 && measurementEndTick === undefined)
                measurementEndTick = tick;
              const receipt = collector.poll(now);
              if (collector.renderedFrames % 300 === 0)
                ctx.state.set({ performanceFrames: collector.renderedFrames });
              if (!receipt) return;
              if (
                !clockStart ||
                measurementStartTick === undefined ||
                measurementEndTick === undefined
              )
                throw new Error("TN_ANIMAL_PERFORMANCE_CLOCK_UNAVAILABLE");
              requireAnimalTickCoverage(
                measurementStartTick,
                measurementEndTick,
                receipt.simulationSubsteps,
              );
              finished = true;
              const admitted = clockStart;
              const measuredSurface = JSON.parse(surface);
              void readAnimalPerformanceClock()
                .then((clockEnd) => {
                  if (!live) return;
                  requireAnimalClockSpan(admitted, clockEnd);
                  // Full rows are emitted only after measurement and bounded resolver drain complete.
                  console.log(
                    `TN_ANIMAL_PERFORMANCE_HEADER ${JSON.stringify({ mode, wolves: expected, vertices: ctx.state.getState().vertices, bones: ctx.state.getState().bones, surface: measuredSurface, renderer: ctx.renderer.kind, projection: performanceProjection, clock: { start: clockStart, end: clockEnd, measurementStartTick, measurementEndTick }, timestampInterval: 1, pixelRatio: 1, warmupFrames: receipt.warmupFrames, measuredFrames: receipt.measuredFrames, cpuRoundingUncertaintyMs: receipt.cpuRoundingUncertaintyMs })}`,
                  );
                  for (const [index, row] of [...receipt.warmup, ...receipt.measurement].entries())
                    console.log(`TN_ANIMAL_PERFORMANCE_ROW ${JSON.stringify({ index, ...row })}`);
                  console.log(
                    `TN_ANIMAL_PERFORMANCE_END ${JSON.stringify({ cpuP95Ms: receipt.cpuP95Ms, gpuP95Ms: receipt.gpuP95Ms, simulationSubsteps: receipt.simulationSubsteps, measuredSimulationSubsteps: receipt.measuredSimulationSubsteps, ignoredGpuFrames: receipt.ignoredGpuFrames, observerStatus: receipt.observerStatus })}`,
                  );
                  release();
                  ctx.state.set({
                    performanceFinished: true,
                    performanceDone: true,
                    performanceFrames: 2100,
                    performanceMeasuredFrames: 1800,
                    performanceCpuP95Ms: receipt.cpuP95Ms,
                    performanceGpuP95Ms: receipt.gpuP95Ms,
                    performanceError: null,
                  });
                })
                .catch((error: unknown) => {
                  finished = false;
                  fail(error);
                });
            } catch (error) {
              finished = false;
              fail(error);
            }
          };
          const remove = ctx.beforeRender(() => {
            if (
              !live ||
              finished ||
              collector ||
              !requested ||
              ctx.startup.phase !== "ready" ||
              ctx.renderer.compiling
            )
              return;
            if (!clockStart) {
              if (admitting) return;
              admitting = true;
              void readAnimalPerformanceClock()
                .then((clock) => {
                  if (live && !finished) clockStart = clock;
                  admitting = false;
                })
                .catch((error: unknown) => {
                  admitting = false;
                  fail(error);
                });
              return;
            }
            try {
              if (previousWindowTick === undefined)
                throw new Error("TN_ANIMAL_PERFORMANCE_TICK_UNAVAILABLE");
              measurementStartTick = previousWindowTick;
              const surfaces = new Map<number, Mesh>();
              ctx.scene.traverse((object) => {
                if (!object.name.startsWith("wolf-surface-")) return;
                const index = Number(object.name.slice("wolf-surface-".length));
                if (
                  !(object instanceof Mesh) ||
                  !Number.isSafeInteger(index) ||
                  index < 0 ||
                  index >= expected ||
                  surfaces.has(index) ||
                  !object.visible ||
                  !object.frustumCulled ||
                  !object.castShadow
                )
                  throw new Error("TN_ANIMAL_PERFORMANCE_SURFACES");
                surfaces.set(index, object);
              });
              if (surfaces.size !== expected) throw new Error("TN_ANIMAL_PERFORMANCE_SURFACES");
              const observe = ctx.renderer.observeGpuFrames;
              if (!observe) throw new Error("TN_ANIMAL_PERFORMANCE_GPU_OBSERVER_UNAVAILABLE");
              observer = observe.call(ctx.renderer, { maxFrames: 4096, maxQueries: 16384 });
              collector = new AnimalPerformanceCollector(expected, observer);
              const ordered = Array.from({ length: expected }, (_, index) => {
                const mesh = surfaces.get(index);
                if (!mesh) throw new Error("TN_ANIMAL_PERFORMANCE_SURFACES");
                return mesh;
              });
              restoreSubmissions = observeAnimalSubmissions(
                ctx.scene,
                ctx.camera,
                ordered,
                collector,
                () => live && !finished,
              );
              compileCount = ctx.renderer.compileCount;
              startedAt = performance.now();
              ctx.state.set({
                performanceStarted: true,
                performanceFinished: false,
                performanceDone: false,
                performanceFrames: 0,
                performanceError: null,
              });
            } catch (error) {
              fail(error);
            }
          });
          return () => {
            live = false;
            consumeWindow = undefined;
            consumeReport = undefined;
            releaseAll([remove, release]);
          };
        },
      },
    ],
    renderer: {
      preferWebGPU: true,
      pixelRatio: 1,
      resolutionScale: 1,
      gpuTimestampFrameInterval: 1,
    },
    camera: performanceProjection,
    frameBudget: {
      reportEvery: 1,
      report: (message) => consumeReport?.(message),
      onWindow: (window) => consumeWindow?.(window),
    },
    scenes: { animals: Workload },
    start: "animals",
    seed: 7,
  });
}
