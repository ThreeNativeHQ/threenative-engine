import type { Page } from "playwright";
import { softwareAdapterName } from "./browser.js";

// Literal source avoids tsx keepNames helpers crossing Playwright's serialization boundary.
export const resolutionScaleFrame = (page: Pick<Page, "evaluate">): Promise<void> =>
  page.evaluate("new Promise((resolve) => requestAnimationFrame(() => resolve()))");

/** Browser-only measurement seam; no renderer behavior is changed in the engine. */
export function assertResolutionScaleContext<
  T extends { renderer: { domElement: unknown }; startup: { phase: string } },
>(ctx: T | undefined, mountedCanvas: unknown): T {
  if (ctx === undefined)
    throw new Error("TN_RESOLUTION_CONTEXT_MISSING: ready bridge has no game context");
  if (ctx.startup?.phase !== "ready")
    throw new Error(`TN_PLAYTEST_STARTUP_NOT_READY: context phase ${ctx.startup?.phase}`);
  if (mountedCanvas == null || ctx.renderer.domElement !== mountedCanvas)
    throw new Error("TN_RESOLUTION_CONTEXT_IDENTITY: mounted canvas differs from game context");
  return ctx;
}

export function assertResolutionScalePreflight(
  kind: string,
  surface: { resolutionScale: number; scaleSource?: string; compiling?: boolean },
  census:
    | {
        complete: boolean;
        incompleteReasons?: readonly string[];
        backend: { kind: string };
        adapter: { identity: string };
      }
    | undefined,
): string {
  if (kind !== "webgpu" || (census !== undefined && census.backend.kind !== "webgpu"))
    throw new Error(`TN_RESOLUTION_WEBGPU_REQUIRED: kind=${kind}, backend=${census?.backend.kind}`);
  const observed = `resolutionScale=${surface.resolutionScale}, scaleSource=${surface.scaleSource}, compilingPresent=${Object.hasOwn(surface, "compiling")}, compiling=${surface.compiling}`;
  if (surface.compiling !== undefined && typeof surface.compiling !== "boolean")
    throw new Error(`TN_RESOLUTION_SURFACE_MALFORMED: ${observed}`);
  if (surface.resolutionScale !== 1 || surface.compiling === true)
    throw new Error(`TN_RESOLUTION_SURFACE_NOT_READY: ${observed}`);
  if (census?.complete !== true)
    throw new Error(
      `TN_RESOLUTION_CENSUS_INCOMPLETE: complete=${census?.complete}, incompleteReasons=${census?.incompleteReasons?.join(", ")}`,
    );
  const identity = census.adapter?.identity;
  let decoded: string;
  try {
    decoded = decodeURIComponent(identity);
  } catch {
    throw new Error(`TN_RESOLUTION_ADAPTER_MISSING: invalid encoded identity=${identity}`);
  }
  if (
    typeof identity !== "string" ||
    !/^webgpu:(architecture|description|device|vendor)=\S/.test(decoded)
  )
    throw new Error(`TN_RESOLUTION_ADAPTER_MISSING: identity=${identity}`);
  if (softwareAdapterName({ identity: decoded }))
    throw new Error(`TN_RESOLUTION_SOFTWARE_ADAPTER: ${decoded}`);
  return identity;
}

export async function qualifyResolutionScaleBudget(
  budgetPrototype: { beginFrame?(now: number, clock: number): void } | undefined,
  pump: () => Promise<void>,
): Promise<void> {
  const begin = budgetPrototype?.beginFrame;
  if (budgetPrototype === undefined || typeof begin !== "function")
    throw new Error("TN_RESOLUTION_FRAME_BUDGET_IDENTITY: imported prototype is missing");
  let receiver: object | undefined;
  budgetPrototype.beginFrame = function (...args: Parameters<typeof begin>) {
    receiver = this;
    return begin.apply(this, args);
  };
  try {
    await pump();
    if (receiver === undefined || Object.getPrototypeOf(receiver) !== budgetPrototype)
      throw new Error(
        "TN_RESOLUTION_FRAME_BUDGET_IDENTITY: imported prototype did not observe the running budget",
      );
  } finally {
    budgetPrototype.beginFrame = begin;
  }
}

export function resolutionScaleTextureBytes(
  textureUtils: { _getBytesPerTexel?(format: string): number } | undefined,
): (format: string) => number {
  if (typeof textureUtils?._getBytesPerTexel !== "function")
    throw new Error("TN_RESOLUTION_TEXTURE_UTILS_MISSING");
  return textureUtils._getBytesPerTexel.bind(textureUtils);
}

interface IResolutionTextureDescriptor {
  size: number[] | { width: number; height?: number; depthOrArrayLayers?: number };
  format?: string;
  mipLevelCount?: number;
  sampleCount?: number;
  dimension?: string;
}
export function textureDescriptorBytes(
  descriptor: IResolutionTextureDescriptor,
  bytesPerTexel: number,
): number {
  if (!Number.isFinite(bytesPerTexel) || bytesPerTexel <= 0)
    throw new Error(`Unmeasured texture format: ${descriptor.format}`);
  const size = descriptor.size;
  const [width, height = 1, layers = 1] = Array.isArray(size)
    ? size
    : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
  const levels = descriptor.mipLevelCount ?? 1;
  const samples = descriptor.sampleCount ?? 1;
  if (![width, height, layers, levels, samples].every((n) => Number.isInteger(n) && n! > 0))
    throw new Error("Invalid texture allocation dimensions");
  let bytes = 0;
  for (let mip = 0; mip < levels; mip++) {
    bytes +=
      Math.max(1, Math.floor(width! / 2 ** mip)) *
      Math.max(1, Math.floor(height / 2 ** mip)) *
      (descriptor.dimension === "3d" ? Math.max(1, Math.floor(layers / 2 ** mip)) : layers) *
      samples *
      bytesPerTexel;
  }
  return bytes;
}

interface IResolutionScaleCensus {
  incompleteReasons?: readonly string[];
  complete: boolean;
  counts: { deviceCreations?: number; failures: number; pending: number; droppedEvents: number };
}
export interface IResolutionScaleRow {
  scale: number;
  frames: {
    frame: number;
    frameMs: number;
    clockEpochStartMs?: number;
    clockEpochEndMs?: number;
    clockCalibration?: {
      performanceBeforeMs: number;
      wallEpochMs: number;
      performanceAfterMs: number;
      marker: string;
    };
    rafIntervalMs?: number;
    surface?: unknown;
  }[];
  allocations: { bytes: number; [key: string]: unknown }[];
  textureBytes: number;
  pipelineBuilds: number;
  censusBefore: IResolutionScaleCensus;
  stepCensusAfter: IResolutionScaleCensus;
  censusAfter: IResolutionScaleCensus;
  windowP50Ms: number;
  stepRatio: number;
}
export interface IResolutionScaleRun {
  run: number;
  rows: IResolutionScaleRow[];
}

/** PRD-564: only first-frame CPU work or attributed first-frame creations can earn continuation. */
export function resolutionScaleGate(runs: IResolutionScaleRun[], timingQualified: boolean) {
  const invalid = (reason: string): never => {
    throw new Error(`TN_RESOLUTION_GATE_INVALID: ${reason}`);
  };
  const count = (census: IResolutionScaleCensus, requireComplete: boolean): number => {
    if (!census || typeof census.complete !== "boolean" || !census.counts)
      return invalid("missing census");
    const { deviceCreations, failures, pending, droppedEvents } = census.counts;
    if (
      ![deviceCreations, failures, pending, droppedEvents].every(
        (value) => Number.isSafeInteger(value) && (value as number) >= 0,
      )
    )
      return invalid("malformed census counts");
    if (
      requireComplete &&
      (!census.complete || failures !== 0 || pending !== 0 || droppedEvents !== 0)
    )
      return invalid("incomplete window census");
    return deviceCreations as number;
  };
  if (typeof timingQualified !== "boolean" || !Array.isArray(runs) || runs.length !== 3)
    return invalid("expected three fresh contexts and explicit timing qualification");
  const steps = runs.flatMap((run, context) => {
    if (run?.run !== context + 1 || !Array.isArray(run.rows) || run.rows.length !== 3)
      return invalid("context/step coverage");
    return run.rows.map((row, step) => {
      if (
        !row ||
        row.scale !== [0.85, 0.61, 1][step] ||
        !Array.isArray(row.frames) ||
        row.frames.length !== 31
      )
        return invalid("expected step plus thirty following CPU frames");
      row.frames.forEach((frame, index) => {
        if (
          frame?.frame !== step * 31 + index ||
          !Number.isFinite(frame.frameMs) ||
          frame.frameMs < 0
        )
          invalid("missing/malformed CPU frame");
      });
      const before = count(row.censusBefore, true);
      const first = count(row.stepCensusAfter, false);
      const after = count(row.censusAfter, true);
      if (first < before || after < first || row.pipelineBuilds !== after - before)
        return invalid("inconsistent pipeline counts");
      if (
        !Array.isArray(row.allocations) ||
        !Number.isSafeInteger(row.textureBytes) ||
        row.textureBytes < 0 ||
        row.allocations.some(
          (allocation) => !Number.isSafeInteger(allocation?.bytes) || allocation.bytes < 0,
        ) ||
        row.allocations.reduce((sum, allocation) => sum + allocation.bytes, 0) !== row.textureBytes
      )
        return invalid("malformed descriptor payload bytes");
      const following = row.frames
        .slice(1)
        .map((frame) => frame.frameMs)
        .sort((a, b) => a - b);
      const p50Ms = following[14]!;
      const pipelineQualified =
        row.stepCensusAfter.complete &&
        row.stepCensusAfter.counts.failures === 0 &&
        row.stepCensusAfter.counts.pending === 0 &&
        row.stepCensusAfter.counts.droppedEvents === 0;
      return {
        run: run.run,
        scale: row.scale,
        stepCpuMs: row.frames[0]!.frameMs,
        windowP50Ms: p50Ms,
        timingQualified,
        cpuSpike: timingQualified ? row.frames[0]!.frameMs > 2 * p50Ms : null,
        pipelineQualified,
        stepPipelineBuilds: pipelineQualified ? first - before : null,
        windowPipelineBuilds: row.pipelineBuilds,
        descriptorBytes: row.textureBytes,
      };
    });
  });
  const earned = steps.some(
    (step) =>
      step.cpuSpike === true || (step.pipelineQualified && (step.stepPipelineBuilds as number) > 0),
  );
  return {
    verdict: earned
      ? "continue"
      : timingQualified && steps.every((step) => step.pipelineQualified)
        ? "decline"
        : "unqualified",
    timingQualified,
    steps,
    bytesMeaning: "texture descriptor payload; excludes driver padding/metadata",
  };
}

export function installResolutionScaleProbe(
  budgetPrototype: {
    beginFrame(now: number, clock: number): void;
    endFrame(now: number, wantSample: boolean): unknown;
  },
  renderer: {
    surface(): { resolutionScale: number; compiling?: boolean };
    pipelineCensus?(): IResolutionScaleCensus | undefined;
    setResolutionScale(scale: number, source: string): void;
  },
  devicePrototype: {
    createTexture(descriptor: IResolutionTextureDescriptor & { format: string }): unknown;
  },
  bytesPerTexel: (format: string) => number,
): Promise<IResolutionScaleRow[]> {
  const begin = budgetPrototype.beginFrame;
  const end = budgetPrototype.endFrame;
  const createTexture = devicePrototype.createTexture;
  const rows: IResolutionScaleRow[] = [];
  let frame = -120;
  let start = 0;
  let timestamp = 0;
  let previousTimestamp: number | undefined;
  let initialCensus: IResolutionScaleCensus;
  let stepCensusAfter: IResolutionScaleCensus;
  let allocations: IResolutionScaleRow["allocations"] = [];
  let frames: IResolutionScaleRow["frames"] = [];
  let step = -1;
  const scales = [0.85, 0.61, 1];
  const restore = () => {
    budgetPrototype.beginFrame = begin;
    budgetPrototype.endFrame = end;
    devicePrototype.createTexture = createTexture;
  };
  const census = () => {
    const value = renderer.pipelineCensus?.();
    if (!value?.complete || !Number.isInteger(value.counts.deviceCreations))
      throw new Error(`Incomplete pipeline census: ${JSON.stringify(value?.incompleteReasons)}`);
    return value;
  };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      restore();
      reject(new Error("Resolution measurement did not capture all 93 frames within 60s"));
    }, 60_000);
    const fail = (error: unknown) => {
      clearTimeout(timeout);
      restore();
      reject(error);
    };
    devicePrototype.createTexture = function (
      descriptor: IResolutionTextureDescriptor & { format: string },
    ) {
      // Descriptor payload bytes, using Three's format census; excludes driver padding/metadata.
      const bytes = textureDescriptorBytes(descriptor, bytesPerTexel(descriptor.format));
      const texture = createTexture.call(this, descriptor);
      if (frame >= 0) allocations.push({ frame, descriptor, bytes });
      return texture;
    };
    budgetPrototype.beginFrame = function (now: number, clock: number) {
      begin.call(this, now, clock);
      start = clock;
      timestamp = now;
      try {
        if (frame < 0) return;
        if (frame % 31 === 0) {
          frames = [];
          allocations = [];
          step++;
          const expected = step === 0 ? 1 : scales[step - 1];
          if (renderer.surface().resolutionScale !== expected || renderer.surface().compiling)
            throw new Error("Scale changed outside the forced step, or compile still active");
          renderer.setResolutionScale(scales[step]!, "auto-pinned");
        }
      } catch (error) {
        fail(error);
      }
    };
    budgetPrototype.endFrame = function (now: number, wantSample: boolean) {
      const result = end.call(this, now, wantSample);
      try {
        // Census collection must not charge observer work only to the forced-step frame.
        if (frame === -1) initialCensus = census();
        if (frame >= 0) {
          if (renderer.surface().resolutionScale !== scales[step])
            throw new Error("Forced scale was overridden");
          // End clock is already captured; marker/calibration must stay outside measured work.
          const performanceBeforeMs = performance.now();
          const wallEpochMs = Date.now();
          const performanceAfterMs = performance.now();
          const marker = `TN_RESOLUTION_FRAME:${frame}`;
          performance.mark(marker, { startTime: performanceAfterMs });
          performance.clearMarks(marker);
          frames.push({
            frame,
            frameMs: now - start,
            clockCalibration: { performanceBeforeMs, wallEpochMs, performanceAfterMs, marker },
            clockEpochStartMs: performance.timeOrigin + start,
            clockEpochEndMs: performance.timeOrigin + now,
            rafIntervalMs:
              previousTimestamp === undefined ? undefined : timestamp - previousTimestamp,
            surface: renderer.surface(),
          });
          if (frame % 31 === 0) stepCensusAfter = renderer.pipelineCensus?.()!;
          if (frame % 31 === 30) {
            const after = census();
            const next30 = frames
              .slice(1)
              .map((row) => row.frameMs)
              .sort((a, b) => a - b);
            const p50 = next30[Math.ceil(next30.length * 0.5) - 1];
            const row = {
              scale: scales[step]!,
              frames: [...frames],
              allocations: [...allocations],
              textureBytes: allocations.reduce((sum, value) => sum + value.bytes, 0),
              pipelineBuilds: after.counts.deviceCreations! - initialCensus.counts.deviceCreations!,
              censusBefore: initialCensus,
              stepCensusAfter,
              censusAfter: after,
              windowP50Ms: p50!,
              stepRatio: frames[0]!.frameMs / p50!,
            };
            rows.push(row);
            initialCensus = after;
            console.info(`TN_RESOLUTION_STEP:${JSON.stringify(row)}`);
            if (step === 2) {
              clearTimeout(timeout);
              restore();
              resolve(rows);
            }
          }
        }
        previousTimestamp = timestamp;
        frame++;
      } catch (error) {
        fail(error);
      }
      return result;
    };
  });
}

export async function preserveResolutionScaleFailure(
  error: unknown,
  record: () => Promise<void>,
): Promise<never> {
  await record();
  throw error;
}

// Await persistence before starting work so a hard deadline leaves the pending operation on disk.
export async function resolutionScalePending<T>(
  pendingOperation: string,
  persist: (pendingOperation: string) => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  await persist(pendingOperation);
  return operation();
}
