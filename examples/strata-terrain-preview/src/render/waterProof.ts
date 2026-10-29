import { debugFlag } from "@threenative/core";
// Game-owned coastal water-contribution proof. Opt-in, default off, so ordinary `pnpm dev` keeps
// the beauty/perf path and no diagnostic attachment. When `?waterproof=1|foam` is present the
// coastal world pass gains one resolved RGBA16F diagnostic attachment; the ocean material writes
// `W = 1 - (shoreFoam + swash)` into R and a water identity into G, and this module reads it back
// from the GPU so a hidden shader failure is a number, not a blue-pixel guess.
import { DataUtils, HalfFloatType, RGBAFormat } from "three";
import type { Camera, RenderTarget, Texture } from "three";

/** URL proof mode; native opts in through TN_DEBUG_WATERPROOF[_FOAM]=1. Default off. */
export type WaterProofMode = "off" | "water" | "foam";

export function readWaterProofMode(search: string | undefined): WaterProofMode {
  const value = new URLSearchParams(search ?? "").get("waterproof");
  if (value === "foam" || debugFlag("waterproofFoam")) return "foam";
  if (value === "1" || debugFlag("waterproof")) return "water";
  return "off";
}

const WATER_PROOF = { mode: readWaterProofMode(globalThis.location?.search) };
const WATER_PROOF_MARKER = "TN_WATER_PROOF:";
const WATER_PROOF_TIMEOUT_MS = 5_000;

export const waterProofEnabled = (): boolean => WATER_PROOF.mode !== "off";
/** The forced opaque-foam control: real `shoreFoam = 1` and `swash = 0`, beauty and mask alike. */
export const waterProofForcedFoam = (): boolean => WATER_PROOF.mode === "foam";
export const waterProofMode = (): WaterProofMode => WATER_PROOF.mode;

/**
 * The sheltered pool, exactly as `verify-ocean.mjs` authored it: a 1280-wide reference region in
 * the shared 16:9 coastal view. Both the probe and the capture check scale from this one constant.
 */
export const WATER_PROOF_ROI = {
  x: 940,
  y: 600,
  width: 280,
  height: 100,
  referenceWidth: 1280,
} as const;

/** The one gate: coverage `R/G` at or above 0.5 over at least 70% of the resolved water area. */
const WATER_PROOF_THRESHOLD = 0.5;
const WATER_PROOF_MIN_FRACTION = 0.7;

export interface IWaterProofRoi {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface IWaterProofStatistics {
  readonly area: number;
  readonly considered: number;
  readonly fraction: number;
  readonly passes: boolean;
  readonly qualifying: number;
  readonly threshold: number;
  readonly minFraction: number;
}

function clampIndex(value: number, limit: number): number {
  return Math.max(0, Math.min(limit, value));
}

/** Clip and scale the reference region into a render-target rectangle; never grows the target. */
export function clipWaterProofRoi(width: number, height: number, scale: number): IWaterProofRoi {
  const x0 = clampIndex(Math.round(WATER_PROOF_ROI.x * scale), width);
  const y0 = clampIndex(Math.round(WATER_PROOF_ROI.y * scale), height);
  const x1 = clampIndex(Math.round((WATER_PROOF_ROI.x + WATER_PROOF_ROI.width) * scale), width);
  const y1 = clampIndex(Math.round((WATER_PROOF_ROI.y + WATER_PROOF_ROI.height) * scale), height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) {
    throw new Error("TN_WATER_PROOF_ROI: the diagnostic region clips to nothing");
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * RGBA16F is the one diagnostic format this proof writes, so its bytes per texel never vary.
 * `WebGPUTextureUtils.copyTextureToBuffer` pads each copied row to a 256-byte boundary but leaves
 * the last row unpadded (three r185, `copyTextureToBuffer`), so the returned typed array is
 * `(height - 1)` padded Uint16 rows plus one `width * 4`-element row. A readback of any other
 * length is a wiring error, never something to re-derive: it fails instead of classifying.
 */
const DIAGNOSTIC_BYTES_PER_TEXEL = 8;
const DIAGNOSTIC_ROW_ALIGNMENT = 256;

function diagnosticRowElements(width: number): number {
  const bytesPerRow =
    Math.ceil((width * DIAGNOSTIC_BYTES_PER_TEXEL) / DIAGNOSTIC_ROW_ALIGNMENT) *
    DIAGNOSTIC_ROW_ALIGNMENT;
  return bytesPerRow / 2;
}

function expectedDiagnosticLength(width: number, height: number): number {
  return (height - 1) * diagnosticRowElements(width) + width * 4;
}

/**
 * Classify the resolved diagnostic mask. `R` is W averaged over the covered multisamples and `G`
 * averages the water identity, so `R / G` recovers the resolved coverage and `G` weights the water
 * area. The gate is the fraction of that area whose coverage reaches the threshold. W itself can be
 * negative — the foam blend `1 - (shoreFoam + swash)` can fall below zero — and a negative coverage
 * simply fails the gate; it is never clamped or skipped.
 */
export function classifyWaterProof(
  samples: Uint16Array,
  roi: IWaterProofRoi,
): IWaterProofStatistics {
  if (!(samples instanceof Uint16Array)) {
    throw new Error("TN_WATER_PROOF_FORMAT: readback is not Uint16 half-float bits");
  }
  const expected = expectedDiagnosticLength(roi.width, roi.height);
  if (samples.length !== expected) {
    throw new Error(
      `TN_WATER_PROOF_LENGTH: the readback is not the copyTextureToBuffer layout (${samples.length} != ${expected})`,
    );
  }
  const rowElements = diagnosticRowElements(roi.width);
  let area = 0;
  let considered = 0;
  let qualifying = 0;
  for (let y = 0; y < roi.height; y++) {
    const base = y * rowElements;
    for (let x = 0; x < roi.width; x++) {
      const i = base + x * 4;
      const r = DataUtils.fromHalfFloat(samples[i] as number);
      const g = DataUtils.fromHalfFloat(samples[i + 1] as number);
      if (!Number.isFinite(r) || !Number.isFinite(g)) {
        throw new Error("TN_WATER_PROOF_NONFINITE: the diagnostic sample is not finite");
      }
      if (g < 0 || g > 1) {
        throw new Error(`TN_WATER_PROOF_IDENTITY: the water identity is outside [0, 1] (${g})`);
      }
      if (g === 0) {
        if (r !== 0) {
          throw new Error("TN_WATER_PROOF_IDENTITY: nonzero coverage without a water identity");
        }
        continue;
      }
      const coverage = Math.min(1, r / g);
      area += g;
      considered += 1;
      if (coverage >= WATER_PROOF_THRESHOLD) qualifying += g;
    }
  }
  if (!Number.isFinite(area) || area <= 0) {
    throw new Error("TN_WATER_PROOF_AREA: the region holds no resolved water area");
  }
  const fraction = qualifying / area;
  return {
    area,
    considered,
    fraction,
    passes: fraction >= WATER_PROOF_MIN_FRACTION,
    qualifying,
    threshold: WATER_PROOF_THRESHOLD,
    minFraction: WATER_PROOF_MIN_FRACTION,
  };
}

interface IWaterProofDevice {
  readonly limits?: unknown;
}

interface IWaterProofRenderer {
  readonly backend?: { readonly device?: IWaterProofDevice };
  readonly device?: IWaterProofDevice;
  readRenderTargetPixelsAsync(
    target: RenderTarget,
    x: number,
    y: number,
    width: number,
    height: number,
    textureIndex?: number,
    faceIndex?: number,
  ): Promise<unknown>;
}

interface IWaterProofWorld {
  readonly renderTarget: RenderTarget;
  updateBefore(frame: unknown): unknown;
  getMRT?(): { readonly outputNodes?: Readonly<Record<string, unknown>> } | null;
}

export interface IWaterProofOptions {
  readonly world: IWaterProofWorld;
  readonly worldName: string;
  readonly mode: WaterProofMode;
  readonly renderer: unknown;
  readonly camera: Camera;
  readonly texture: Texture;
}

const MAX_COLOR_ATTACHMENTS = "maxColorAttachments";
const MAX_COLOR_ATTACHMENT_BYTES = "maxColorAttachmentBytesPerSample";

/** Every attachment in this proof is RGBA16F; any other format is a wiring error, not a guess. */
function attachmentBytes(texture: Texture): number {
  if (texture.format !== RGBAFormat || texture.type !== HalfFloatType) {
    throw new Error("TN_WATER_PROOF_LIMITS: the MRT is not the expected RGBA16F layout");
  }
  return DIAGNOSTIC_BYTES_PER_TEXEL;
}

function readColorAttachmentLimits(renderer: unknown): {
  maxColorAttachments: number;
  maxColorAttachmentBytesPerSample: number;
} {
  const typed = renderer as IWaterProofRenderer;
  const limits = (typed.backend?.device ?? typed.device)?.limits;
  if (limits === null || typeof limits !== "object") {
    throw new Error("TN_WATER_PROOF_LIMITS: the device color-attachment limits are unavailable");
  }
  const record = limits as Record<string, unknown>;
  const maxColorAttachments = record[MAX_COLOR_ATTACHMENTS];
  const maxColorAttachmentBytesPerSample = record[MAX_COLOR_ATTACHMENT_BYTES];
  if (
    typeof maxColorAttachments !== "number" ||
    !Number.isSafeInteger(maxColorAttachments) ||
    maxColorAttachments <= 0
  ) {
    throw new Error("TN_WATER_PROOF_LIMITS: maxColorAttachments is unavailable");
  }
  if (
    typeof maxColorAttachmentBytesPerSample !== "number" ||
    !Number.isSafeInteger(maxColorAttachmentBytesPerSample) ||
    maxColorAttachmentBytesPerSample <= 0
  ) {
    throw new Error("TN_WATER_PROOF_LIMITS: maxColorAttachmentBytesPerSample is unavailable");
  }
  return { maxColorAttachments, maxColorAttachmentBytesPerSample };
}

/**
 * Fail closed before the proof draws: the MRT's real attachment count and per-sample byte cost
 * must fit the device, and a missing device, limit or layout is an error, never a default guess.
 */
function assertColorAttachmentLimits(
  world: IWaterProofWorld,
  renderer: unknown,
  diagnostic: Texture,
): { maxColorAttachments: number; maxColorAttachmentBytesPerSample: number } {
  const limits = readColorAttachmentLimits(renderer);
  const target = world.renderTarget;
  const names = Object.keys(world.getMRT?.()?.outputNodes ?? {});
  if (names.length === 0) {
    throw new Error("TN_WATER_PROOF_LIMITS: the world pass exposes no MRT layout");
  }
  if (names.length > limits.maxColorAttachments) {
    throw new Error(
      `TN_WATER_PROOF_LIMITS: ${names.length} color attachments exceed the device limit ${limits.maxColorAttachments}`,
    );
  }
  let bytes = 0;
  for (const name of names) {
    const texture =
      name === "diagnostic"
        ? diagnostic
        : (target.textures.find((candidate) => candidate.name === name) ?? target.texture);
    bytes += attachmentBytes(texture);
  }
  if (bytes > limits.maxColorAttachmentBytesPerSample) {
    throw new Error(
      `TN_WATER_PROOF_LIMITS: ${bytes} bytes per sample exceed the device limit ${limits.maxColorAttachmentBytesPerSample}`,
    );
  }
  return limits;
}

interface IWaterProofWaiter {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

interface IPendingWaterProof {
  readonly id: number;
  readonly generation: number;
  readonly label: string | undefined;
  readonly waiters: IWaterProofWaiter[];
  timer: ReturnType<typeof setTimeout>;
  copying: boolean;
}

/** The frozen metadata captured when a copy is issued, applied to the resolved observation. */
interface IWaterProofCopyContext {
  readonly roi: IWaterProofRoi;
  readonly scale: number;
  readonly pose: { matrixWorld: number[]; position: [number, number, number] };
  readonly format: { color: string; samples: number; attachments: number };
  readonly dimensions: { width: number; height: number };
  readonly generation: number;
  readonly frame: number;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readTime(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * One request and one copy stay open until they settle. A second ask while a copy is in flight
 * joins the same request instead of starting a second copy; the timeout spans the whole operation,
 * from the first ask through the resolved readback; and every waiter is settled on timeout, stale
 * pass, resize, rejection or dispose, so no promise is ever left hanging. `RenderTarget.setSize`
 * disposes and reuses the same object on a resize, so a listener on that object invalidates every
 * in-flight readback at once. Modelled on the generated `ExposureReadback`.
 */
export class WaterProofProbe {
  #pending: IPendingWaterProof | undefined;
  #generation = 0;
  #requestId = 0;
  #frame = 0;
  #disposed = false;
  readonly #world: IWaterProofWorld;
  readonly #worldName: string;
  readonly #mode: WaterProofMode;
  readonly #renderer: IWaterProofRenderer;
  readonly #camera: Camera;
  readonly #texture: Texture;
  readonly #limits: { maxColorAttachments: number; maxColorAttachmentBytesPerSample: number };

  constructor(options: IWaterProofOptions) {
    this.#world = options.world;
    this.#worldName = options.worldName;
    this.#mode = options.mode;
    this.#renderer = options.renderer as IWaterProofRenderer;
    this.#camera = options.camera;
    this.#texture = options.texture;
    this.#limits = assertColorAttachmentLimits(this.#world, options.renderer, options.texture);
  }

  onRenderTargetDispose = (): void => {
    this.#generation += 1;
    const pending = this.#pending;
    if (pending !== undefined) {
      this.#settle(
        pending,
        new Error("TN_WATER_PROOF_STALE: the world pass was resized or disposed"),
      );
    }
  };

  sample(label?: string): Promise<Record<string, unknown>> {
    if (this.#disposed) {
      return Promise.reject(new Error("TN_WATER_PROOF_DISPOSED: the world pass is gone"));
    }
    const pending = this.#pending;
    if (pending !== undefined) {
      // Only the same explicit label may join the open pose: a different step must not silently
      // receive another step's readback, so it is rejected busy and may retry on a later frame.
      if (label === undefined || pending.label !== label) {
        return Promise.reject(
          new Error(
            `TN_WATER_PROOF_BUSY: the open observation is '${pending.label ?? "(unlabelled)"}', not '${label ?? "(unlabelled)"}'`,
          ),
        );
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.waiters.push({ resolve, reject });
      });
    }
    const id = ++this.#requestId;
    const generation = this.#generation;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const next: IPendingWaterProof = {
        id,
        generation,
        label,
        waiters: [{ resolve, reject }],
        copying: false,
        timer: setTimeout(() => {
          this.#settle(
            next,
            new Error("TN_WATER_PROOF_TIMEOUT: no world pass was presented for the observation"),
          );
        }, WATER_PROOF_TIMEOUT_MS),
      };
      this.#pending = next;
    });
  }

  /** Called after the pass has drawn: issue exactly one copy for the one open request. */
  afterWorldPass(): void {
    const pending = this.#pending;
    if (pending === undefined || pending.copying) return;
    // One physical GPU copy stays busy until its readback actually settles, across a logical
    // timeout, resize or reinstall. A new logical request waits for the next frame; it never starts
    // a second copy while the first is unsettled.
    if (physicalCopy !== undefined) return;
    pending.copying = true;
    if (pending.generation !== this.#generation) {
      this.#settle(
        pending,
        new Error("TN_WATER_PROOF_STALE: the world pass changed before the copy"),
      );
      return;
    }
    const target = this.#world.renderTarget;
    const index = target.textures.indexOf(this.#texture);
    if (index < 0) {
      this.#settle(
        pending,
        new Error("TN_WATER_PROOF_ATTACHMENT: the diagnostic attachment is missing"),
      );
      return;
    }
    const scale = target.width / WATER_PROOF_ROI.referenceWidth;
    let roi: IWaterProofRoi;
    try {
      roi = clipWaterProofRoi(target.width, target.height, scale);
    } catch (error) {
      this.#settle(pending, asError(error));
      return;
    }
    const context: IWaterProofCopyContext = {
      roi,
      scale,
      pose: capturePose(this.#camera),
      format: Object.freeze({
        color: "RGBA16F",
        samples: target.samples,
        attachments: target.textures.length,
      }),
      dimensions: Object.freeze({ width: target.width, height: target.height }),
      generation: this.#generation,
      frame: ++this.#frame,
    };
    let readback: Promise<unknown>;
    try {
      readback = this.#renderer.readRenderTargetPixelsAsync(
        target,
        roi.x,
        roi.y,
        roi.width,
        roi.height,
        index,
      );
    } catch (error) {
      this.#settle(pending, asError(error));
      return;
    }
    // A raw rejection, a synchronous throw or a success-path classification/publication error all
    // settle every waiter; the physical copy clears only when the readback chain is finally done.
    const settled = Promise.resolve(readback).then(
      (samples) => {
        try {
          this.#complete(pending, samples as Uint16Array, context);
        } catch (error) {
          this.#settle(pending, asError(error));
        }
      },
      (error) => {
        this.#settle(pending, asError(error));
      },
    );
    physicalCopy = settled;
    void settled.finally(() => {
      if (physicalCopy === settled) physicalCopy = undefined;
    });
  }

  #complete(
    pending: IPendingWaterProof,
    samples: Uint16Array,
    context: IWaterProofCopyContext,
  ): void {
    if (this.#pending !== pending) return;
    if (this.#disposed || context.generation !== this.#generation) {
      this.#settle(
        pending,
        new Error("TN_WATER_PROOF_STALE: the copy resolved after the pass changed"),
      );
      return;
    }
    const statistics = Object.freeze(classifyWaterProof(samples, context.roi));
    const observation = Object.freeze({
      available: true,
      requestId: pending.id,
      label: pending.label ?? null,
      mode: this.#mode,
      world: this.#worldName,
      frame: context.frame,
      time: readTime(),
      camera: context.pose,
      format: context.format,
      dimensions: context.dimensions,
      limits: Object.freeze({ ...this.#limits }),
      roi: Object.freeze({
        ...context.roi,
        scale: context.scale,
        referenceWidth: WATER_PROOF_ROI.referenceWidth,
      }),
      statistics,
      // The one field the verifier reads: after the readback, the values can never change.
      frozen: true,
    });
    this.#publish(observation);
    this.#settle(pending, undefined, { waterProof: observation });
  }

  #settle(
    pending: IPendingWaterProof,
    error: Error | undefined,
    value?: Record<string, unknown>,
  ): void {
    if (this.#pending !== pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    for (const waiter of pending.waiters) {
      if (error === undefined) waiter.resolve(value ?? {});
      else waiter.reject(error);
    }
  }

  #publish(observation: Record<string, unknown>): void {
    console.info(`${WATER_PROOF_MARKER}${JSON.stringify(observation)}`);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    const pending = this.#pending;
    if (pending !== undefined) {
      this.#settle(pending, new Error("TN_WATER_PROOF_DISPOSED: the world pass was removed"));
    }
    this.#world.renderTarget.removeEventListener("dispose", this.onRenderTargetDispose);
  }
}

function capturePose(camera: Camera): {
  matrixWorld: number[];
  position: [number, number, number];
} {
  const e = camera.matrixWorld.elements;
  return {
    matrixWorld: Array.from(e),
    position: [e[12] as number, e[13] as number, e[14] as number],
  };
}

let activeProbe: WaterProofProbe | undefined;

/**
 * The one physical GPU copy that may be in flight, shared across probes so a reinstall cannot start
 * a second copy before the first readback settles. Cleared in a `finally` when that copy is done.
 */
let physicalCopy: Promise<void> | undefined;

/**
 * The observation contribution's entry point. A missing probe is an explicit unavailability, not
 * an empty success: the verifier requires an available observation at the sheltered step, so this
 * cannot pass empty. The request's own scenario-step label is echoed into the observation so the
 * verifier binds the readback to the exact step that captured `coastal-horizon-sea`.
 */
export function sampleActiveWaterProof(request?: {
  readonly label?: string;
}): Record<string, unknown> | Promise<Record<string, unknown>> {
  if (request?.label !== "horizon-sea") {
    return { waterProof: { available: false, reason: "requested only at horizon-sea" } };
  }
  if (activeProbe === undefined) {
    return { waterProof: { available: false, reason: "no proof-mode world pass is active" } };
  }
  return activeProbe
    .sample(request?.label)
    .catch((error: unknown) => ({ waterProof: { available: false, reason: String(error) } }));
}

/**
 * Install the proof on a world pass whose MRT already carries a `diagnostic` attachment. It wraps
 * the pass's own `updateBefore`, calling it with the original receiver and arguments first and
 * copying after it, so the pass's own result and `this` are preserved and no new render is added.
 */
export function installWaterProof(options: IWaterProofOptions): () => void {
  const probe = new WaterProofProbe(options);
  const world = options.world;
  const original = world.updateBefore;
  const wrapped = function (this: unknown, ...frame: [frame: unknown]): unknown {
    const result = original.apply(this, frame);
    probe.afterWorldPass();
    return result;
  };
  world.updateBefore = wrapped;
  world.renderTarget.addEventListener("dispose", probe.onRenderTargetDispose);
  activeProbe = probe;
  return () => {
    probe.dispose();
    if (world.updateBefore === wrapped) world.updateBefore = original;
    if (activeProbe === probe) activeProbe = undefined;
  };
}
