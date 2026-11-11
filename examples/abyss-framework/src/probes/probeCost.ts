import { GPUSceneBVH, type ICtx, ProbeVolume } from "@threenative/core";
import { Box3, type Color, type DirectionalLight, type HemisphereLight, Vector3 } from "three";

/**
 * PRD-603 Phase 1: what one probe refresh costs on the `?world` fixture, by cube capture and by trace.
 *
 * `?world&probeCost=capture|trace` builds the PRD's 24 x 6 x 24 m volume at 0.5 probes a metre (13 x 4 x 13 =
 * 676 probes) around the camera's start, once the streamed cells are resident. The camera holds still. The
 * probe records what the volume reports each frame (`bakeCostMs`, probes traced) and what the renderer
 * reports (draw calls, GPU compute ms), first for 30 frames with no volume work, then while it refreshes.
 */
/** What the probe reads of a scene context: any game's `ctx`. */
type ProbeCostCtx = Pick<ICtx, "add" | "camera" | "renderer" | "scene">;

export type ProbeCostMode = "capture" | "trace";

export interface IProbeCostReport extends Record<string, unknown> {
  mode: ProbeCostMode | "off";
  phase: "waiting" | "baseline" | "refresh" | "done";
  probeCount: number;
  workItemsPerProbe: number;
  /** Frames from the refresh request to every probe refreshed (trace), or the frames sampled (capture). */
  refreshFrames: number;
  /** The first slice with work: the compute pipeline compiles in it, once. */
  sliceMsFirst: number;
  sliceMsMean: number;
  /** The slowest slice after the first. */
  sliceMsMax: number;
  /** Capture: the mean slice cost times the work items of one probe. */
  msPerProbe: number;
  drawCallsBaseline: number;
  drawCallsRefresh: number;
  /** Mean draw calls a refresh frame adds over the still baseline: the scene draws the volume costs. */
  drawCallsAdded: number;
  gpuComputeMsBaseline: number;
  gpuComputeMsRefresh: number;
  probesPerFrame: number;
  bvhTriangles: number;
  bvhBuildMs: number;
  raysPerProbe: number;
}

const BASELINE_FRAMES = 30;
/** A capture pass of 676 probes is 5,408 frames; a sample of whole probes is enough for a per-probe cost. */
const CAPTURE_SAMPLE_FRAMES = 240;

export function probeCostMode(): ProbeCostMode | undefined {
  const value = new URLSearchParams(globalThis.location?.search ?? "").get("probeCost");
  return value === "capture" || value === "trace" ? value : undefined;
}

/** `?probeRays=32` traces 32 x 32 = 1,024 rays a probe; the default is the engine's 8 x 8 = 64, the PRD's gate spike. */
function probeResolution(): number | undefined {
  const value = Number(new URLSearchParams(globalThis.location?.search ?? "").get("probeRays"));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** `?probeBudgetMs=8` sets the traced refresh's GPU budget; the engine default is 2 ms. */
function probeBudgetMs(): number | undefined {
  const value = Number(new URLSearchParams(globalThis.location?.search ?? "").get("probeBudgetMs"));
  return value > 0 ? value : undefined;
}

interface IRendererInfo {
  readonly info?: { readonly render?: { readonly calls?: number; readonly drawCalls?: number } };
}

export class ProbeCostProbe {
  readonly report: IProbeCostReport;
  readonly #ctx: ProbeCostCtx;
  readonly #mode: ProbeCostMode;
  readonly #sun: DirectionalLight;
  readonly #sky: HemisphereLight;
  #volume: ProbeVolume | undefined;
  #frames = 0;
  #baseline = { calls: 0, gpu: 0, gpuSamples: 0 };
  #refresh = { calls: 0, gpu: 0, gpuSamples: 0, slices: 0, sliceSum: 0, traced: 0 };

  constructor(ctx: ICtx, mode: ProbeCostMode, sun: DirectionalLight, sky: HemisphereLight) {
    this.#ctx = ctx;
    this.#mode = mode;
    this.#sun = sun;
    this.#sky = sky;
    this.report = {
      bvhBuildMs: 0,
      bvhTriangles: 0,
      drawCallsAdded: 0,
      drawCallsBaseline: 0,
      drawCallsRefresh: 0,
      gpuComputeMsBaseline: 0,
      gpuComputeMsRefresh: 0,
      mode,
      msPerProbe: 0,
      phase: "waiting",
      probeCount: 0,
      probesPerFrame: 0,
      raysPerProbe: 0,
      refreshFrames: 0,
      sliceMsFirst: 0,
      sliceMsMax: 0,
      sliceMsMean: 0,
      workItemsPerProbe: 0,
    };
  }

  /** The report as flat `probeCost*` fields, so a playtest reads each one as a world component. */
  debug(): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.report).map(([key, value]) => [
        `probeCost${key.charAt(0).toUpperCase()}${key.slice(1)}`,
        value,
      ]),
    );
  }

  /** Call once a frame from the scene's render hook, with `ready` true once the streamed cells settled. */
  sample(ready: boolean): void {
    const report = this.report;
    if (report.phase === "done") return;
    if (report.phase === "waiting") {
      if (ready) report.phase = "baseline";
      return;
    }
    const renderer = this.#ctx.renderer;
    const calls = drawCalls(renderer);
    const gpu = renderer.gpuComputeMs?.();
    this.#frames += 1;
    if (report.phase === "baseline") {
      this.#baseline.calls += calls;
      if (gpu !== undefined)
        Object.assign(this.#baseline, {
          gpu: this.#baseline.gpu + gpu,
          gpuSamples: this.#baseline.gpuSamples + 1,
        });
      if (this.#frames >= BASELINE_FRAMES) this.#start();
      return;
    }
    this.#sampleRefresh(calls, gpu);
  }

  #start(): void {
    const ctx = this.#ctx;
    const camera = ctx.camera.position;
    const bounds = new Box3(
      new Vector3(camera.x - 12, 0, camera.z - 12),
      new Vector3(camera.x + 12, 6, camera.z + 12),
    );
    const options = { bounds, density: 0.5 };
    if (this.#mode === "trace") {
      // The packed scene is what the probes can see: the streamed meshes within reach of the volume.
      const reach = bounds.clone().expandByScalar(48);
      const box = new Box3();
      const bvh = new GPUSceneBVH(ctx.scene, {
        include: (mesh) => box.setFromObject(mesh).intersectsBox(reach),
      });
      ctx.add(bvh);
      this.report.bvhTriangles = bvh.triangleCount;
      this.report.bvhBuildMs = bvh.buildMs;
      const resolution = probeResolution();
      this.#volume = new ProbeVolume({
        ...options,
        ...(resolution === undefined ? {} : { probeResolution: resolution }),
        ...(probeBudgetMs() === undefined ? {} : { bakeBudgetMs: probeBudgetMs() }),
        trace: {
          bvh,
          camera: ctx.camera,
          sky: skyRadiance(this.#sky),
          sun: {
            color: this.#sun.color,
            direction: this.#sun.position.clone().sub(this.#sun.target.position).normalize(),
            intensity: this.#sun.intensity,
          },
        },
      });
      this.report.raysPerProbe = (resolution ?? 8) ** 2;
      this.report.workItemsPerProbe = 1;
    } else {
      // The capture's own fail-closed budget would stop the bake at the first slow face; the measurement
      // needs every face's real cost, so the budget is lifted and the cost is reported instead.
      this.#volume = new ProbeVolume({ ...options, bakeBudgetMs: 1_000 });
      this.report.workItemsPerProbe = 8;
    }
    ctx.add(this.#volume);
    this.report.probeCount = this.#volume.probeCount;
    void this.#volume.requestBake(ctx.scene);
    this.report.phase = "refresh";
    this.#frames = 0;
    const baselineFrames = BASELINE_FRAMES;
    this.report.drawCallsBaseline = this.#baseline.calls / baselineFrames;
    this.report.gpuComputeMsBaseline =
      this.#baseline.gpuSamples === 0 ? 0 : this.#baseline.gpu / this.#baseline.gpuSamples;
  }

  #sampleRefresh(calls: number, gpu: number | undefined): void {
    const volume = this.#volume;
    if (volume === undefined) return;
    const observation = volume.observation;
    const refresh = this.#refresh;
    refresh.calls += calls;
    if (gpu !== undefined)
      Object.assign(refresh, { gpu: refresh.gpu + gpu, gpuSamples: refresh.gpuSamples + 1 });
    if (observation.bakeCostMs > 0) {
      refresh.slices += 1;
      if (refresh.slices === 1) {
        this.report.sliceMsFirst = observation.bakeCostMs;
      } else {
        refresh.sliceSum += observation.bakeCostMs;
        this.report.sliceMsMax = Math.max(this.report.sliceMsMax, observation.bakeCostMs);
      }
    }
    refresh.traced += observation.probesTraced ?? 0;
    const report = this.report;
    report.refreshFrames = this.#frames;
    report.sliceMsMean = refresh.slices < 2 ? 0 : refresh.sliceSum / (refresh.slices - 1);
    report.msPerProbe = report.sliceMsMean * report.workItemsPerProbe;
    report.drawCallsRefresh = refresh.calls / this.#frames;
    report.drawCallsAdded = report.drawCallsRefresh - report.drawCallsBaseline;
    report.gpuComputeMsRefresh = refresh.gpuSamples === 0 ? 0 : refresh.gpu / refresh.gpuSamples;
    report.probesPerFrame =
      this.#mode === "trace" ? refresh.traced / Math.max(1, refresh.slices) : 1 / 8;
    const done =
      this.#mode === "trace"
        ? observation.status === "ready"
        : this.#frames >= CAPTURE_SAMPLE_FRAMES;
    if (done) {
      report.phase = "done";
      console.log(`TN_PROBE_COST:${JSON.stringify(report)}`);
    }
  }
}

function drawCalls(renderer: ICtx["renderer"]): number {
  const render = (renderer.raw as IRendererInfo).info?.render;
  return render?.drawCalls ?? render?.calls ?? 0;
}

/** A hemisphere light's sky colour as the radiance a ray that leaves the scene carries: E = pi L. */
function skyRadiance(sky: HemisphereLight): Color {
  return sky.color.clone().multiplyScalar(sky.intensity / Math.PI);
}
