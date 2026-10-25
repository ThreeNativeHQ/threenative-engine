import {
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Vector3,
  WebGPUCoordinateSystem,
} from "three";
import {
  Scene as GameScene,
  type ICtx,
  WorldEnvironment,
  defineGame,
} from "../../../../packages/core/src/index.js";
import { playtest } from "../../../../packages/core/src/playtest.js";
import { createVolumetricFog } from "../../../../packages/create-threenative/templates/starter/src/render/volumetricFog.js";

import { exposureSettings } from "../../../../packages/create-threenative/template-assets/exposure.js";

export const ROOM_BOUNDS = new Box3(new Vector3(-4.5, 0, -9.5), new Vector3(4.5, 4, 3));

// Coverage, not intent: does the fog volume reach this light's shadow-map bounds? A bounding volume
// can enclose the whole shadow box with no corner of itself inside it, so sampling corners answers
// `false` for an overlap that is really there. Project the volume by the shadow camera's own
// view-projection and intersect the conservative clip-space AABB — never false "outside". The depth
// range is the camera's, not a constant: Three maps near/far to 0..1 on WebGPU and -1..1 on WebGL.
export function fogInsideShadowMap(light: DirectionalLight, bounds: Box3): boolean {
  const camera = light.shadow.camera;
  camera.updateMatrixWorld(true);
  const viewProjection = new Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  const clip = new Box3(
    new Vector3(-1, -1, camera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1),
    new Vector3(1, 1, 1),
  );
  return bounds.clone().applyMatrix4(viewProjection).intersectsBox(clip);
}

const initialState = {
  exposureFreshSamples: 0,
  exposureEnabled: false,
  exposureApplied: false,
  exposureMeasured: false,
  exposureSettled: false,
  exposureLuminance: 0,
  exposureStops: 0,
  releasedExposures: 0,
  mode: "off",
  ready: false,
  builds: 0,
  disposedGraphs: 0,
  createdTargets: 0,
  releasedTargets: 0,
  releasedMaterials: 0,
  liveTargets: 0,
  scatteringOnly: false,
  textures: -1,
  settledRenderFrames: 0,
  stableTextureFrames: 0,
  targetWidth: 0,
  targetHeight: 0,
  targets: 0,
  pixels: 0,
  steps: 0,
  inside: false,
  sun: true,
  point: true,
  overlaps: false,
  shadowOutside: false,
  streamedWall: false,
  sceneEntries: 0,
  sceneExits: 0,
  exitReleasedTargets: 0,
  exitReleasedMaterials: 0,
};
type FogState = typeof initialState;
type FogCtx = ICtx<FogState>;
interface IProbeInfo {
  render: { calls: number };
  memory: { textures: number };
}
const modes = [
  "fog",
  "off",
  "zero",
  "inside",
  "sunOff",
  "pointOff",
  "overlap",
  "half",
  "wallOff",
  "scatter",
  "scatterSunOff",
  "scatterPointOff",
  "blackOff",
  "scatterOutside",
  "scatterOutsideSunOff",
  "scatterOutsidePointOff",
] as const;
type Mode = (typeof modes)[number];

export class FogProbe extends GameScene<FogState> {
  static override readonly initialState = initialState;
  #geometry = new BoxGeometry();
  #material = new MeshStandardMaterial({ color: 0x7c8a91, roughness: 0.85 });
  #black = new MeshBasicMaterial({ color: 0x000000 });
  #background = new Color(0x131e2a);
  #blackBackground = new Color(0x000000);
  #calibration = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ vertexColors: true }));
  #sun = new DirectionalLight(0xffedce, 3);
  #point = new PointLight(0xffad60, 30, 8);
  #wall: Mesh | undefined;
  #fog: ReturnType<typeof createVolumetricFog>;
  #release: (() => void) | undefined;
  #mode: Mode = "off";
  #exposureEnabled = false;
  #readbackGeneration = 0;
  #freshSamples = 0;
  #restoreReadback = () => {};
  #exposure: ReturnType<WorldEnvironment["apply"]>["exposure"];
  #releasedExposures = 0;
  #cameraCut = false;
  #streamedWall = false;
  #applied: Mode | undefined;
  #builds = 0;
  #disposedGraphs = 0;
  #createdTargets = 0;
  #releasedTargets = 0;
  #releasedMaterials = 0;
  #lastRenderCalls = -1;
  #lastTextures = -1;
  #settledRenderFrames = 0;
  #stableTextureFrames = 0;

  override enter(ctx: FogCtx): void {
    ctx.state.set({ sceneEntries: ctx.state.getState().sceneEntries + 1 });
    ctx.scene.background = this.#background;
    ctx.scene.fog = null;
    // Same calibration card in every scattering-control arm, outside the measured room ROI.
    // It satisfies the ordinary nonblank capture guard without altering any proof threshold.
    this.#calibration.name = "fog-calibration";
    this.#calibration.material.allowOverride = false;
    this.#calibration.geometry.setAttribute(
      "color",
      new Float32BufferAttribute([0.3, 0.3, 0.3, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.9, 0.9, 0.9], 3),
    );
    // This card must cost zero draws outside the scattering controls, whose arms assert renderer draw
    // and texture counts; a zero-opacity visible card would add a draw to every measured arm.
    // engine-override: a hidden calibration reference, never a rendered surface to prewarm
    this.#calibration.visible = false;
    ctx.camera.add(this.#calibration);
    ctx.add(ctx.camera);
    const box = (position: Vector3, scale: Vector3): Mesh => {
      const mesh = new Mesh(this.#geometry, this.#material);
      mesh.position.copy(position);
      mesh.scale.copy(scale);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      ctx.add(mesh);
      return mesh;
    };
    box(new Vector3(0, -0.2, -3), new Vector3(14, 0.4, 18));
    box(new Vector3(0, 2, -10), new Vector3(10, 4, 0.3));
    box(new Vector3(-5, 2, -5), new Vector3(0.3, 4, 10));
    box(new Vector3(-2.9, 4, -5), new Vector3(4, 0.3, 10));
    box(new Vector3(3.6, 4, -5), new Vector3(2.8, 0.3, 10));
    box(new Vector3(-1.4, 1, -5), new Vector3(1, 2, 1));
    this.#wall = box(new Vector3(0.4, 1.6, 3.6), new Vector3(2, 3.2, 0.4));
    this.#wall.name = "fog-wall";
    this.#sun.name = "fog-directional";
    this.#point.name = "fog-point";
    this.#sun.position.set(-3, 7, 1);
    this.#sun.target.position.set(0, 0, -5);
    this.#sun.castShadow = true;
    Object.assign(this.#sun.shadow.camera, {
      left: -9,
      right: 9,
      top: 9,
      bottom: -9,
      near: 0.1,
      far: 30,
    });
    this.#sun.shadow.mapSize.set(512, 512);
    this.#sun.shadow.bias = -0.0002;
    this.#point.position.set(2, 1.3, -3);
    ctx.add(this.#sun);
    ctx.add(this.#sun.target);
    ctx.add(this.#point);
    ctx.add(new HemisphereLight(0xb3cced, 0x201d1a, 0.35));
    const raw = ctx.renderer.raw as { shadowMap: { enabled: boolean } };
    raw.shadowMap.enabled = true;
    // Observe the public renderer readback boundary without changing its result or render policy.
    const gpu = ctx.renderer.raw as typeof raw & {
      readRenderTargetPixelsAsync?: (...args: unknown[]) => Promise<unknown>;
    };
    const originalReadback = gpu.readRenderTargetPixelsAsync;
    if (originalReadback !== undefined) {
      const observedReadback = async (...args: unknown[]) => {
        const generation = this.#readbackGeneration;
        const values = await originalReadback.apply(gpu, args);
        if (
          generation === this.#readbackGeneration &&
          args[3] === 1 &&
          args[4] === 1 &&
          values instanceof Float32Array &&
          values.length >= 4 &&
          Array.from(values).every(Number.isFinite) &&
          (values[1] ?? 0) > 0
        )
          this.#freshSamples += 1;
        return values;
      };
      gpu.readRenderTargetPixelsAsync = observedReadback;
      this.#restoreReadback = () => {
        if (gpu.readRenderTargetPixelsAsync === observedReadback)
          gpu.readRenderTargetPixelsAsync = originalReadback;
      };
    }
    ctx.entities.add("fog", { object: new Group(), debug: () => ({ ...ctx.state.getState() }) });
    this.#positionCamera(ctx);
  }

  override update(ctx: FogCtx): void {
    if (ctx.input.justPressed("reenter")) {
      ctx.goto("fog");
      return;
    }
    for (const action of ["cameraCut", "cameraRestore", "streamWallOut", "streamWallIn"]) {
      if (!ctx.input.justPressed(action)) continue;
      if (action === "cameraCut" || action === "cameraRestore")
        this.#cameraCut = action === "cameraCut";
      else {
        this.#streamedWall = action === "streamWallOut";
        if (this.#streamedWall) this.#wall?.removeFromParent();
        else if (this.#wall !== undefined) ctx.add(this.#wall);
      }
      this.#resetObservation(ctx);
    }
    for (const action of ["exposureOn", "exposureOff"]) {
      if (!ctx.input.justPressed(action)) continue;
      this.#exposureEnabled = action === "exposureOn";
      this.#applied = undefined;
    }
    for (const mode of modes) if (ctx.input.justPressed(mode)) this.#mode = mode;
    if (ctx.input.justPressed("rebuild")) this.#applied = undefined;
    if (ctx.input.justPressed("resizeSmall")) this.#resize(ctx, 320, 240);
    if (ctx.input.justPressed("resizeRestore")) this.#resize(ctx, 640, 400);
    this.#positionCamera(ctx);
    const scatteringOnly = this.#mode.startsWith("scatter") || this.#mode === "blackOff";
    ctx.scene.overrideMaterial = scatteringOnly ? this.#black : null;
    this.#calibration.visible = scatteringOnly;
    ctx.scene.background = scatteringOnly ? this.#blackBackground : this.#background;
    const outsideShadowMap = this.#mode.startsWith("scatterOutside");
    Object.assign(
      this.#sun.shadow.camera,
      outsideShadowMap
        ? { left: 30, right: 31, top: 31, bottom: 30 }
        : { left: -9, right: 9, top: 9, bottom: -9 },
    );
    this.#sun.shadow.camera.updateProjectionMatrix();
    this.#sun.intensity = this.#mode === "sunOff" || this.#mode.endsWith("SunOff") ? 0 : 3;
    this.#point.intensity = this.#mode === "pointOff" || this.#mode.endsWith("PointOff") ? 0 : 30;
    if (this.#wall !== undefined) this.#wall.visible = this.#mode !== "wallOff";
    // Warm the ordinary directional shadow map with the first real scene frame before composing.
    if (this.#applied !== this.#mode && this.#sun.shadow.map !== null) this.#compose(ctx);
    const observation = this.#fog?.diagnostics();
    const info = ctx.renderer.info as IProbeInfo;
    // Three's info.frame is driven by its Animation loop; this game owns the loop instead.
    // A new cumulative render.calls value at update means the previous render interval returned.
    // Count one observation boundary regardless of the number of internal passes in that interval.
    if (info.render.calls !== this.#lastRenderCalls) {
      this.#lastRenderCalls = info.render.calls;
      this.#settledRenderFrames += 1;
      this.#stableTextureFrames =
        info.memory.textures === this.#lastTextures ? this.#stableTextureFrames + 1 : 1;
      this.#lastTextures = info.memory.textures;
    }
    const exposure = this.#exposure?.getObservation();
    ctx.state.set({
      exposureFreshSamples: this.#freshSamples,
      exposureEnabled: this.#exposureEnabled,
      exposureApplied: exposure?.applied === true,
      exposureMeasured: exposure?.measured === true,
      exposureSettled: exposure?.settled === true,
      exposureLuminance: Number(exposure?.luminance ?? 0),
      exposureStops: Number(exposure?.exposureStops ?? 0),
      releasedExposures: this.#releasedExposures,
      mode: this.#mode,
      ready: this.#applied === this.#mode,
      builds: this.#builds,
      disposedGraphs: this.#disposedGraphs,
      createdTargets: this.#createdTargets,
      releasedTargets: this.#releasedTargets,
      releasedMaterials: this.#releasedMaterials,
      liveTargets: this.#createdTargets - this.#releasedTargets,
      scatteringOnly,
      textures: info.memory.textures,
      settledRenderFrames: this.#settledRenderFrames,
      stableTextureFrames: this.#stableTextureFrames,
      targetWidth: this.#fog?.target?.width ?? 0,
      targetHeight: this.#fog?.target?.height ?? 0,
      targets: observation?.renderTargets ?? 0,
      pixels: observation?.pixels ?? 0,
      steps: observation?.steps ?? 0,
      inside: this.#mode === "inside" || this.#cameraCut,
      shadowOutside: !fogInsideShadowMap(this.#sun, ROOM_BOUNDS),
      streamedWall: this.#streamedWall,
      sun: this.#sun.intensity > 0,
      point: this.#point.intensity > 0,
      overlaps: this.#mode === "overlap",
    });
  }

  #positionCamera(ctx: FogCtx): void {
    if (this.#mode === "inside" || this.#cameraCut) ctx.camera.position.set(0, 1.5, -1);
    else ctx.camera.position.set(6.5, 3, 11);
    ctx.camera.lookAt(0, 1.4, -5);
    const camera = ctx.camera as PerspectiveCamera;
    const halfHeight = Math.tan((camera.fov * Math.PI) / 360);
    const halfWidth = halfHeight * camera.aspect;
    this.#calibration.position.set(
      ((570 / 640) * 2 - 1) * halfWidth,
      (1 - (80 / 400) * 2) * halfHeight,
      -1,
    );
    this.#calibration.scale.set((120 / 640) * 2 * halfWidth, (120 / 400) * 2 * halfHeight, 1);
  }

  #resetObservation(ctx: FogCtx): void {
    this.#readbackGeneration += 1;
    this.#freshSamples = 0;
    this.#lastRenderCalls = (ctx.renderer.info as IProbeInfo).render.calls;
    this.#lastTextures = -1;
    this.#settledRenderFrames = 0;
    this.#stableTextureFrames = 0;
  }

  #resize(ctx: FogCtx, width: number, height: number): void {
    ctx.renderer.setSize(width, height);
    const camera = ctx.camera as PerspectiveCamera;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    this.#resetObservation(ctx);
  }

  #compose(ctx: FogCtx): void {
    this.#resetObservation(ctx);
    this.#disposeGraph();
    const volumes = [
      {
        bounds: ROOM_BOUNDS,
        density: this.#mode === "zero" ? 0 : 0.18,
        baseHeight: 0.5,
        heightFalloff: 0.35,
      },
    ];
    // The overlap control's second bound is pinned to the room's whole lit interior, not a sliver:
    // a nested volume that hides behind one prop measures nothing about composition. Nested inside
    // ROOM_BOUNDS on every axis, denser and slower-falling than the primary bound above.
    if (this.#mode === "overlap")
      volumes.push({
        bounds: new Box3(new Vector3(-4.2, 0, -9.2), new Vector3(4.2, 3, 2.6)),
        density: 0.28,
        baseHeight: 0.5,
        heightFalloff: 0.32,
      });
    const raw = ctx.renderer.raw as {
      logarithmicDepthBuffer?: boolean;
      reversedDepthBuffer?: boolean;
    };
    const fog = createVolumetricFog(ctx.scene, ctx.camera as PerspectiveCamera, {
      enabled: this.#mode !== "off" && this.#mode !== "blackOff",
      renderer: ctx.renderer.kind,
      logarithmicDepth: raw.logarithmicDepthBuffer,
      reversedDepth: raw.reversedDepthBuffer,
      steps: 48,
      resolutionScale: this.#mode === "half" ? 0.5 : 1,
      volumes,
      albedo: new Color(0.86, 0.9, 0.95),
      ambient: new Color(0.055, 0.075, 0.11),
      anisotropy: 0.35,
      sun: this.#sun,
      points: [this.#point],
      environment: { aerialPerspective: false, godRays: false },
    });
    const world = new WorldEnvironment({
      autoExposureEnabled: this.#exposureEnabled,
      exposurePolicy: { ...exposureSettings, enabled: true },
      // Keep this qualification fixture isolated from the core scene look.
      finalGatherMethod: "none",
      gtaoEnabled: false,
      localExposureEnabled: false,
      motionBlurEnabled: false,
      ssrEnabled: false,
      temporalAA: false,
      unrealBloomEnabled: false,
      vignetteAmount: 0,
      bloomEnabled: false,
      screenSpaceAA: "disabled",
      tonemapMode: "neutral",
      exposure: 1,
    });
    const applied = world.apply(
      ctx.renderer,
      ctx.scene,
      ctx.camera,
      fog === undefined ? {} : { baseColour: (scenePass) => fog.compose(scenePass) },
    );
    this.#exposure = applied.exposure;
    this.#fog = fog;
    const target = fog?.target;
    const material = fog?.material;
    if (target !== undefined) this.#createdTargets += 1;
    this.#release = () => {
      applied.dispose?.();
      if (applied.exposure !== undefined) this.#releasedExposures += 1;
      // Count actual teardown events, not resize-driven RenderTarget invalidations.
      const onTarget = () => {
        this.#releasedTargets += 1;
      };
      const onMaterial = () => {
        this.#releasedMaterials += 1;
      };
      target?.addEventListener("dispose", onTarget);
      material?.addEventListener("dispose", onMaterial);
      fog?.dispose();
      target?.removeEventListener("dispose", onTarget);
      material?.removeEventListener("dispose", onMaterial);
    };
    this.#builds += 1;
    this.#applied = this.#mode;
  }

  #disposeGraph(): void {
    if (this.#release === undefined) return;
    this.#release();
    this.#release = undefined;
    this.#fog = undefined;
    this.#exposure = undefined;
    this.#disposedGraphs += 1;
  }
  override exit(ctx: FogCtx): void {
    this.#disposeGraph();
    this.#readbackGeneration += 1;
    this.#restoreReadback();
    ctx.state.set({
      sceneExits: ctx.state.getState().sceneExits + 1,
      exitReleasedTargets: this.#releasedTargets,
      exitReleasedMaterials: this.#releasedMaterials,
    });
    this.#geometry.dispose();
    this.#material.dispose();
    this.#black.dispose();
    this.#calibration.removeFromParent();
    this.#calibration.geometry.dispose();
    this.#calibration.material.dispose();
    this.#sun.dispose();
    this.#point.dispose();
  }
}

export default defineGame<FogState>({
  camera: { far: 80, near: 0.1, fov: 52, projection: "perspective" },
  initialState,
  frameBudget: { reportEvery: 30, minFrames: 30 },
  input: {
    exposureOn: { keys: ["Digit9"] },
    exposureOff: { keys: ["Digit0"] },
    fog: { keys: ["KeyF"] },
    off: { keys: ["KeyO"] },
    zero: { keys: ["KeyZ"] },
    inside: { keys: ["KeyI"] },
    sunOff: { keys: ["KeyS"] },
    pointOff: { keys: ["KeyP"] },
    overlap: { keys: ["KeyB"] },
    half: { keys: ["KeyH"] },
    wallOff: { keys: ["KeyW"] },
    scatter: { keys: ["KeyL"] },
    scatterSunOff: { keys: ["KeyK"] },
    scatterPointOff: { keys: ["KeyJ"] },
    blackOff: { keys: ["KeyN"] },
    resizeSmall: { keys: ["KeyR"] },
    resizeRestore: { keys: ["KeyT"] },
    rebuild: { keys: ["KeyC"] },
    scatterOutside: { keys: ["Digit1"] },
    scatterOutsideSunOff: { keys: ["Digit2"] },
    scatterOutsidePointOff: { keys: ["Digit3"] },
    cameraCut: { keys: ["Digit4"] },
    cameraRestore: { keys: ["Digit5"] },
    streamWallOut: { keys: ["Digit6"] },
    streamWallIn: { keys: ["Digit7"] },
    reenter: { keys: ["Digit8"] },
  },
  plugins: [playtest<FogState>()],
  renderer: { preferWebGPU: true, resolutionScale: 1, pixelRatio: 1 },
  scenes: { fog: FogProbe },
  seed: 20261002,
  start: "fog",
});
