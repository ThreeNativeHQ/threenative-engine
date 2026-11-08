import {
  GPUSceneBVH,
  type ICtx,
  type IProbeVolumeObservation,
  ProbeVolume,
  Scene,
  type SceneFrame,
  defineGame,
} from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  Box3,
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene as ThreeScene,
  Vector3,
} from "three";
import { color, normalWorld, positionWorld } from "three/tsl";
// PRD-603: `?update=trace` refreshes the same volume by tracing the packed scene; KeyL switches the lamp.
import { FloatType, MeshBasicNodeMaterial, NearestFilter, RenderTarget } from "three/webgpu";

const BOUNDS = new Box3(new Vector3(-1, -1, -0.8), new Vector3(1, 1, 0.8));

export interface IProbeVolumeFixtureState extends Record<string, unknown> {
  probe: {
    atlasBytes: number;
    bakeCostMs: number;
    bakeFrames: number;
    completed: number;
    fraction: number;
    probeCount: number;
    sampleNodeInstalled: boolean;
    sampleHueRatio: number;
    sampleRed: number;
    stale: boolean;
    status: string;
    update: string;
    probesTraced: number;
    maxBakeCostMs: number;
    lampOn: boolean;
    /** Frames from the lamp switch to a field that every probe refreshed into, -1 until then. */
    lampRefreshFrames: number;
    sampleRedLampOff: number;
    /** A 10 degree sun sweep (`?sunSweep=1`): frames swept, frames the volume spent refreshing, and their ratio. */
    sweepFrames: number;
    sweepRefreshFrames: number;
    sweepSteps: number;
    sweepDuty: number;
  };
  volumeEnabled: boolean;
}

const initialState: IProbeVolumeFixtureState = {
  probe: {
    atlasBytes: 0,
    bakeCostMs: 0,
    bakeFrames: 0,
    completed: 0,
    fraction: 0,
    probeCount: 0,
    sampleNodeInstalled: false,
    sampleHueRatio: 0,
    sampleRed: 0,
    stale: true,
    status: "off",
    update: "off",
    probesTraced: 0,
    maxBakeCostMs: 0,
    lampOn: true,
    lampRefreshFrames: -1,
    sampleRedLampOff: -1,
    sweepFrames: 0,
    sweepRefreshFrames: 0,
    sweepSteps: 0,
    sweepDuty: 0,
  },
  volumeEnabled: false,
};

function updateMode(): "capture" | "trace" {
  return new URLSearchParams(globalThis.location?.search ?? "").get("update") === "trace"
    ? "trace"
    : "capture";
}

/** `?sunSweep=1` turns the sun 10 degrees over 600 frames once the field is ready, to measure the refresh duty cycle. */
const SWEEP_FRAMES = 600;
const SWEEP_DEGREES = 10;

function sunSweeps(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? "").get("sunSweep") === "1";
}

function volumeIsEnabled(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? "").get("volume") !== "off";
}

class ProbeVolumeFixture extends Scene<IProbeVolumeFixtureState> {
  static override readonly initialState = initialState;
  #sampleReadback: (() => void) | undefined;

  override enter(ctx: ICtx<IProbeVolumeFixtureState>): SceneFrame<IProbeVolumeFixtureState> {
    const volumeEnabled = volumeIsEnabled();
    const update = updateMode();
    ctx.camera.position.set(0, 0.05, 3.8);
    ctx.camera.lookAt(0, 0, -0.35);

    const wallMaterial = new MeshBasicNodeMaterial();
    const wall = new Mesh(new PlaneGeometry(1.8, 1.45), wallMaterial);
    wall.name = "neutral-wall-inside-frustum";
    wall.position.set(0, 0, -0.35);

    // The emitter's colour is a material value, so the traced refresh reads it from its flat table.
    const lampColor = new Color(0xff0030).multiplyScalar(12);
    const emitterMaterial = new MeshBasicNodeMaterial({ color: lampColor.clone() });
    const emitter = new Mesh(new BoxGeometry(0.8, 1.45, 0.8), emitterMaterial);
    emitter.name = "off-screen-emitter";
    emitter.position.set(4.2, 0, 1.8);

    const floor = new Mesh(new PlaneGeometry(5.5, 4.5), new MeshBasicMaterial({ color: 0x11182a }));
    floor.name = "fixture-floor";
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.76, -0.35);
    const side = new Mesh(
      new BoxGeometry(0.08, 1.7, 1.8),
      new MeshBasicMaterial({ color: 0x28334d }),
    );
    side.name = "fixture-side-marker";
    side.position.set(-1.15, 0, -0.35);
    ctx.add(wall);
    ctx.add(emitter);
    ctx.add(floor);
    ctx.add(side);

    const options = {
      bounds: BOUNDS,
      bakeBudgetMs: 16,
      cubemapSize: 8,
      density: 0.5,
      maxWorkItemsPerFrame: 1,
    };
    const sweeping = sunSweeps();
    const sun = {
      color: new Color(1, 1, 1),
      direction: new Vector3(0, 1, 0),
      intensity: sweeping ? 1 : 0,
    };
    const sweep = { duty: 0, frames: 0, refreshing: 0, steps: 0, wasBaking: false };
    let volume: ProbeVolume | undefined;
    if (volumeEnabled && update === "trace") {
      const bvh = new GPUSceneBVH(ctx.scene);
      ctx.add(bvh);
      volume = new ProbeVolume({
        ...options,
        // The lamp is a small emitter, 0.55% of the sphere from a probe: 1,024 rays hit it, 64 mostly miss.
        probeResolution: 32,
        trace: {
          bvh,
          camera: ctx.camera,
          sky: new Color(0, 0, 0),
          sun,
        },
      });
    } else if (volumeEnabled) {
      volume = new ProbeVolume(options);
    }
    if (volume !== undefined) ctx.add(volume);
    const sampleNodeInstalled = volume !== undefined;
    wallMaterial.colorNode =
      volume?.sampleNode(positionWorld, normalWorld).mul(8) ?? color(0x202020);

    const bake = volume === undefined ? undefined : volume.requestBake(ctx.scene);
    let lampOn = true;
    let frame = 0;
    const samples = { sampleHueRatio: 0, sampleRed: 0, sampleRedLampOff: -1 };
    if (volume !== undefined) {
      const sampleScene = new ThreeScene();
      const sampleCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 4);
      sampleCamera.position.z = 2;
      const sampleMaterial = new MeshBasicNodeMaterial();
      sampleMaterial.colorNode = volume.sampleNode(positionWorld, normalWorld);
      const samplePlane = new Mesh(new PlaneGeometry(2, 2), sampleMaterial);
      samplePlane.position.z = -0.35;
      sampleScene.add(samplePlane);
      // One readback per lamp state: the field with the lamp on, then the field after it switched off.
      let sampledFor: boolean | undefined;
      this.#sampleReadback = () => {
        if (volume.observation.status !== "ready" || sampledFor === lampOn) return;
        if (!lampOn && ctx.state.getState().probe.lampRefreshFrames < 0) return;
        sampledFor = lampOn;
        const lampWasOn = lampOn;
        void readSampleIrradiance(ctx.renderer.raw, sampleScene, sampleCamera)
          .then(({ hueRatio, red }) => {
            // The frame callback publishes these: a write from here would race its status fields.
            if (lampWasOn) Object.assign(samples, { sampleHueRatio: hueRatio, sampleRed: red });
            else samples.sampleRedLampOff = red;
          })
          .catch((error: unknown) => {
            console.log(`TN_PROBE_SAMPLE_ERROR:${String(error)}`);
          });
      };
    }
    const lamp = { frames: -1, on: true, switchedAt: -1 };
    // The lamp switches off in game code. The traced field notices the material by itself; the cube
    // capture has no such watch, so it is asked for a new bake.
    const switchLampOff = () => {
      Object.assign(lamp, { on: false, switchedAt: frame });
      lampOn = false;
      emitterMaterial.color.setRGB(0, 0, 0);
      if (update === "capture") void volume?.requestBake(ctx.scene);
    };
    let bakeFrames = 0;
    let maxBakeCostMs = 0;
    return (frameCtx) => {
      frame += 1;
      if (volume !== undefined && lamp.on && frameCtx.input.justPressed("lamp")) switchLampOff();
      const observation = volume?.observation;
      if (observation?.status === "baking") bakeFrames += 1;
      maxBakeCostMs = Math.max(maxBakeCostMs, observation?.bakeCostMs ?? 0);
      trackLampRefresh(lamp, frame, observation, update);
      if (sweeping) advanceSweep(sweep, sun, observation);
      frameCtx.state.set({
        probe: {
          ...fixtureProbeState(observation, sampleNodeInstalled, bakeFrames, samples),
          lampOn: lamp.on,
          lampRefreshFrames: lamp.frames,
          maxBakeCostMs,
          sweepDuty: sweep.duty,
          sweepFrames: sweep.frames,
          sweepRefreshFrames: sweep.refreshing,
          sweepSteps: sweep.steps,
          probesTraced: observation?.probesTraced ?? 0,
          update: volume === undefined ? "off" : update,
        },
        volumeEnabled: observation?.status === "ready" && volumeEnabled,
      });
      if (bake !== undefined && observation?.status === "ready") frameCtx.state.flush();
    };
  }

  override render(_ctx: ICtx<IProbeVolumeFixtureState>): void {
    this.#sampleReadback?.();
  }
}

interface ISunSweep {
  frames: number;
  refreshing: number;
  steps: number;
  duty: number;
  wasBaking: boolean;
}

/** One frame of the sweep: it starts once the first refresh is ready, then turns the sun and counts refresh frames. */
function advanceSweep(
  sweep: ISunSweep,
  sun: { direction: Vector3 },
  observation: IProbeVolumeObservation | undefined,
): void {
  if (observation === undefined || sweep.frames >= SWEEP_FRAMES) return;
  if (sweep.frames === 0 && observation.status !== "ready") return;
  sweep.frames += 1;
  const radians = ((sweep.frames / SWEEP_FRAMES) * SWEEP_DEGREES * Math.PI) / 180;
  sun.direction.set(Math.sin(radians), Math.cos(radians), 0);
  // The readback may land between two frames, so a refresh frame is one that traced probes, not one that reads "baking".
  const baking = (observation.probesTraced ?? 0) > 0;
  if (baking) sweep.refreshing += 1;
  if (baking && !sweep.wasBaking) sweep.steps += 1;
  sweep.wasBaking = baking;
  sweep.duty = sweep.refreshing / sweep.frames;
}

/** The frames from the lamp switch to the first frame the volume reports every probe refreshed again. */
function trackLampRefresh(
  lamp: { frames: number; on: boolean; switchedAt: number },
  frame: number,
  observation: IProbeVolumeObservation | undefined,
  update: string,
): void {
  if (lamp.on || lamp.frames >= 0 || frame <= lamp.switchedAt + 1) return;
  if (observation?.status !== "ready") return;
  lamp.frames = frame - lamp.switchedAt;
  console.log(`TN_PROBE_LAMP_REFRESH:${JSON.stringify({ frames: lamp.frames, update })}`);
}

function fixtureProbeState(
  observation: IProbeVolumeObservation | undefined,
  sampleNodeInstalled: boolean,
  bakeFrames: number,
  sample: { sampleHueRatio: number; sampleRed: number; sampleRedLampOff: number },
): Pick<
  IProbeVolumeFixtureState["probe"],
  | "atlasBytes"
  | "bakeCostMs"
  | "bakeFrames"
  | "completed"
  | "fraction"
  | "probeCount"
  | "sampleHueRatio"
  | "sampleNodeInstalled"
  | "sampleRed"
  | "sampleRedLampOff"
  | "stale"
  | "status"
> {
  const exposed = observation?.status === "ready";
  return {
    ...sample,
    atlasBytes: exposed ? (observation?.atlasBytes ?? 0) : 0,
    bakeCostMs: observation?.bakeCostMs ?? 0,
    bakeFrames,
    completed: observation?.bakeProgress.completed ?? 0,
    fraction: observation?.bakeProgress.fraction ?? 0,
    probeCount: observation?.probeCount ?? 0,
    sampleNodeInstalled: exposed && sampleNodeInstalled,
    sampleHueRatio: sample.sampleHueRatio,
    sampleRed: sample.sampleRed,
    stale: observation?.stale ?? true,
    status: observation?.status ?? "off",
  };
}

interface IProbeReadbackRenderer {
  readonly readRenderTargetPixelsAsync?: (
    target: RenderTarget,
    x: number,
    y: number,
    width: number,
    height: number,
    textureIndex?: number,
    faceIndex?: number,
  ) => Promise<ArrayLike<number>>;
  readonly render: (scene: ThreeScene, camera: OrthographicCamera) => void;
  readonly setRenderTarget: (target: RenderTarget | null) => void;
}

async function readSampleIrradiance(
  rendererValue: unknown,
  sampleScene: ThreeScene,
  sampleCamera: OrthographicCamera,
): Promise<{ readonly hueRatio: number; readonly red: number }> {
  const sampleTarget = new RenderTarget(1, 1, {
    depthBuffer: false,
    magFilter: NearestFilter,
    minFilter: NearestFilter,
    type: FloatType,
  });
  const renderer = rendererValue as IProbeReadbackRenderer;
  if (renderer.readRenderTargetPixelsAsync === undefined) {
    throw new Error("WebGPU render-target readback is unavailable.");
  }
  renderer.setRenderTarget(sampleTarget);
  try {
    renderer.render(sampleScene, sampleCamera);
    const pixels = await renderer.readRenderTargetPixelsAsync(sampleTarget, 0, 0, 1, 1);
    const red = Math.max(0, pixels[0] ?? 0);
    const green = Math.max(0, pixels[1] ?? 0);
    const blue = Math.max(0, pixels[2] ?? 0);
    const hueRatio = red / Math.max(green, blue, 0.000001);
    console.log(
      `TN_PROBE_SAMPLE:${JSON.stringify({
        hueRatio,
        sample: [red, green, blue],
      })}`,
    );
    return { hueRatio, red };
  } finally {
    renderer.setRenderTarget(null);
    sampleTarget.dispose();
  }
}

const game = defineGame<IProbeVolumeFixtureState>({
  // The page's own canvas: without it the game mounts a second one below it, off-screen.
  canvas: (globalThis.document?.getElementById("game") as HTMLCanvasElement | null) ?? undefined,
  input: { lamp: { keys: ["KeyL"] } },
  inputTarget: globalThis,
  plugins: [playtest()],
  renderer: { preferWebGPU: true },
  scenes: { probeVolume: ProbeVolumeFixture },
  start: "probeVolume",
});

export default game;
