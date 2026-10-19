import { Vector2 } from "three";
import { type NodeBuilder, NodeFrame } from "three/webgpu";
import type { ICtx } from "../../../../core/dist/index.js";
import { AutoExposureNode } from "../../../template-assets/autoExposure.js";

/** Only the fixture's adaptation input is controlled; the renderer's shared frame stays real. */
export function exposureFrameSnapshot(frame: NodeFrame): NodeFrame {
  return Object.assign(new NodeFrame(), frame, { deltaTime: 1 / 60 });
}

/** Diagnostic instrumentation around the actual generated GPU graph, never a CPU exposure model. */
export class ObservedExposureNode {
  readonly node: AutoExposureNode;
  readonly #setup: AutoExposureNode["setup"];
  readonly #updateBefore: AutoExposureNode["updateBefore"];
  readonly #dispose: AutoExposureNode["dispose"];

  constructor(node: AutoExposureNode);
  constructor(...args: ConstructorParameters<typeof AutoExposureNode>);
  constructor(...args: [AutoExposureNode] | ConstructorParameters<typeof AutoExposureNode>) {
    this.node = args.length === 1 ? args[0] : new AutoExposureNode(...args);
    this.#setup = this.node.setup.bind(this.node);
    this.#updateBefore = this.node.updateBefore.bind(this.node);
    this.#dispose = this.node.dispose.bind(this.node);
    this.node.setup = this.setup.bind(this);
    this.node.updateBefore = this.updateBefore.bind(this);
    this.node.dispose = this.dispose.bind(this);
  }

  get settings() {
    return this.node.settings;
  }
  get exposureNode() {
    return this.node.exposureNode;
  }
  reset(...args: Parameters<AutoExposureNode["reset"]>) {
    this.node.reset(...args);
  }
  setEnabled(enabled: boolean) {
    this.node.setEnabled(enabled);
  }
  getObservation() {
    return this.node.getObservation();
  }
  setupCount = 0;
  setup(builder: NodeBuilder) {
    const result = this.#setup(builder);
    this.setupCount++;
    console.info(
      `TN_EXPOSURE_SETUP:${JSON.stringify({ ...this.timing, setupCount: this.setupCount })}`,
    );
    return result;
  }

  deterministic = false;
  coldBoot = false;
  capturePose: (() => unknown) | undefined;
  onProgress = () => {};
  timing = {
    updates: 0,
    consumedSeconds: 0,
    realConsumedSeconds: 0,
    nodeFrameId: 0,
    nodeTime: 0,
    deltaSeconds: 0,
    clock: "live",
  };
  #cutStart: number | undefined;
  #sampleUpdates = 0;
  #pending = false;
  #disposed = false;
  #releaseWarmup: ((sample: Record<string, unknown>) => void) | undefined;
  readonly #warmupCheckpoints = new Map<number, () => void>();

  holdStartup(startup: Pick<ICtx["startup"], "hold" | "whenReady">): void {
    if (!this.deterministic || this.#disposed)
      throw new Error("Only an active controlled arm may hold exposure startup.");
    const started = performance.now();
    let warmupComplete = false;
    startup.hold(
      "exposure-warmup",
      new Promise<void>((resolve) => {
        this.#releaseWarmup = (sample) => {
          warmupComplete = true;
          console.info(
            `TN_EXPOSURE_WARMUP:${JSON.stringify({ ...sample, elapsedMs: performance.now() - started })}`,
          );
          resolve();
        };
      }),
      60_000,
    );
    // Hold completion is startup's measured progress. Register every checkpoint now against
    // the same deadline; a fresh accepted GPU readback, never a clock tick, releases it.
    for (const updates of [30, 60, 90, 120, 150]) {
      startup.hold(
        `exposure-warmup-${updates}`,
        new Promise<void>((resolve) => this.#warmupCheckpoints.set(updates, resolve)),
        60_000 - (performance.now() - started),
      );
    }
    void startup.whenReady().then(() => {
      if (!this.#disposed)
        console.info(
          `TN_EXPOSURE_READY:${JSON.stringify({ warmupComplete, elapsedMs: performance.now() - started })}`,
        );
    });
  }

  observeColdBootStartup(startup: Pick<ICtx["startup"], "whenReady">): void {
    if (!this.coldBoot || this.deterministic || this.#disposed)
      throw new Error("Cold-boot observation requires an active live-clock arm.");
    void startup.whenReady().then(() => {
      if (!this.#disposed)
        console.info(
          `TN_EXPOSURE_BOOT_READY:${JSON.stringify({ ...this.timing, ...this.getProgress() })}`,
        );
    });
  }

  beginCut(): void {
    this.#cutStart = this.timing.updates;
    this.onProgress();
  }

  getProgress() {
    return {
      sampleFrames: this.#sampleUpdates,
      cutSampleFrames:
        this.#cutStart === undefined ? 0 : Math.max(0, this.#sampleUpdates - this.#cutStart),
    };
  }

  updateBefore(frame: NodeFrame): undefined {
    if (this.#disposed) return;
    // Bound each deterministic pose to exactly 180 actual graph updates. Wait for its real
    // GPU readback before the next update, including the terminal update; then hold that history.
    const bounded = this.deterministic || this.coldBoot;
    const limit = this.coldBoot ? 3 : 180;
    if (bounded && (this.#pending || this.timing.updates - (this.#cutStart ?? 0) >= limit)) return;
    const input = this.deterministic ? exposureFrameSnapshot(frame) : frame;
    const renderer = frame.renderer;
    if (renderer === null) throw new Error("Exposure fixture renderer missing.");
    const size = renderer.getDrawingBufferSize(new Vector2());
    const next = {
      width: size.x,
      height: size.y,
      setupCount: this.setupCount,
      updates: this.timing.updates + 1,
      consumedSeconds:
        this.timing.consumedSeconds + Math.min(input.deltaTime, this.settings.maxDelta),
      realConsumedSeconds: this.timing.realConsumedSeconds + frame.deltaTime,
      nodeFrameId: frame.frameId,
      nodeTime: frame.time,
      deltaSeconds: input.deltaTime,
      clock: this.deterministic ? "deterministic-per-render" : "live",
    };
    const read = renderer.readRenderTargetPixelsAsync;
    let sampleRead: ReturnType<typeof read> | undefined;
    if (bounded) {
      renderer.readRenderTargetPixelsAsync = (...args) => {
        this.#pending = true;
        sampleRead = read.apply(renderer, args);
        return sampleRead;
      };
    }
    try {
      this.#updateBefore(input);
      this.timing = next;
      console.info(`TN_EXPOSURE_TIMING:${JSON.stringify(this.timing)}`);
      if (sampleRead !== undefined) {
        // Subscribe after the node has attached its production acceptance callback. Returning the
        // original promise preserves that order even for an already resolved GPU readback.
        void sampleRead
          .then(
            (values) => {
              if (this.#disposed) return;
              const measurement = this.getObservation();
              if (
                !(values instanceof Float32Array) ||
                values.length < 4 ||
                !Array.from(values).every(Number.isFinite) ||
                measurement.measured !== true ||
                measurement.luminance !== values[1] ||
                measurement.targetStops !== values[2] ||
                measurement.settled !== (values[3] === 1) ||
                (measurement.applied === true && measurement.exposureStops !== values[0])
              )
                return;
              this.#sampleUpdates = next.updates;
              const sample = {
                ...next,
                measurement,
                ...(this.capturePose === undefined ? {} : { cameraPose: this.capturePose() }),
              };
              console.info(`TN_EXPOSURE_SAMPLE:${JSON.stringify(sample)}`);
              this.#warmupCheckpoints.get(next.updates)?.();
              this.#warmupCheckpoints.delete(next.updates);
              if (this.coldBoot && next.updates === 3)
                console.info(`TN_EXPOSURE_BOOT_FROZEN:${JSON.stringify(sample)}`);
              if (next.updates === 180) {
                this.#releaseWarmup?.(sample);
                this.#releaseWarmup = undefined;
              }
            },
            () => {},
          )
          .finally(() => {
            if (this.#disposed) return;
            this.#pending = false;
            this.onProgress();
          });
      }
      this.onProgress();
    } finally {
      renderer.readRenderTargetPixelsAsync = read;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#warmupCheckpoints.clear();
    this.#releaseWarmup = undefined;
    this.#dispose();
  }
}
