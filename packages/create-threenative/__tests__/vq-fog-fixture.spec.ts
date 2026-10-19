import {
  type Color,
  DepthTexture,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  PointLight,
  RenderTarget,
  Scene,
} from "three";
import { describe, expect, it } from "vitest";
import {
  FogProbe,
  ROOM_BOUNDS,
  fogInsideShadowMap,
} from "../../../examples/abyss-framework/vq-fog/src/game.js";
import { Registry } from "../../core/src/entities.js";
import { createGameStore } from "../../core/src/state.js";

type Ctx = Parameters<FogProbe["enter"]>[0];
function fixture() {
  const probe = new FogProbe();
  const scene = new Scene();
  const state = createGameStore({ ...FogProbe.initialState });
  let action = "";
  const info = { frame: 0, render: { calls: 0 }, memory: { textures: 2 } };
  const sizes: number[][] = [];
  const transitions: string[] = [];
  // No GPU is available in a unit test. Use real scene/state/TSL ownership objects;
  // only the input edge and renderer installation boundary are replaced.
  const ctx = {
    scene,
    state,
    goto: (name: string) => transitions.push(name),
    camera: new PerspectiveCamera(52, 1.6, 0.1, 80),
    entities: new Registry(),
    add: <T extends Object3D>(object: T): T => {
      scene.add(object);
      return object;
    },
    input: { justPressed: (name: string) => name === action },
    renderer: {
      kind: "webgpu",
      info,
      setSize: (width: number, height: number) => sizes.push([width, height]),
      raw: {
        shadowMap: { enabled: false },
        readRenderTargetPixelsAsync: async () => new Float32Array([1, 0.1, 1, 1]),
      },
      setOutputNode: () => {},
      clearOutputNode: () => {},
    },
  } as unknown as Ctx;
  probe.enter(ctx);
  const sun = scene.children.find(
    (object): object is DirectionalLight => object instanceof DirectionalLight,
  );
  if (sun === undefined) throw new Error("Missing authored directional light");
  sun.shadow.map = new RenderTarget(16, 16);
  sun.shadow.map.depthTexture = new DepthTexture(16, 16);
  return {
    probe,
    ctx,
    transitions,
    info,
    sizes,
    camera: ctx.camera as PerspectiveCamera,
    scene,
    state,
    sun,
    select(mode: string) {
      action = mode;
      probe.update(ctx);
      action = "";
    },
  };
}

describe("fog qualification fixture", () => {
  it("counts completed exposure readbacks only from the current render generation", async () => {
    const f = fixture();
    f.select("exposureOn");
    const raw = f.ctx.renderer.raw as unknown as {
      readRenderTargetPixelsAsync: (...args: unknown[]) => Promise<Float32Array>;
    };
    const stale = raw.readRenderTargetPixelsAsync({}, 0, 0, 1, 1);
    f.select("resizeSmall");
    await stale;
    f.select("");
    expect(f.state.getState()).toMatchObject({ exposureFreshSamples: 0 });
    await raw.readRenderTargetPixelsAsync({}, 0, 0, 1, 1);
    f.select("");
    expect(f.state.getState()).toMatchObject({ exposureFreshSamples: 1 });
    f.probe.exit(f.ctx);
  });
  it("controls combined fog/exposure ownership and releases it before returning to off", () => {
    const f = fixture();
    f.select("exposureOn");
    expect(f.state.getState()).toMatchObject({ exposureEnabled: true, exposureApplied: true });
    f.select("fog");
    expect(f.state.getState()).toMatchObject({
      targets: 1,
      exposureEnabled: true,
      exposureApplied: true,
    });
    f.select("rebuild");
    expect(f.state.getState()).toMatchObject({ releasedExposures: 2, exposureApplied: true });
    f.select("exposureOff");
    expect(f.state.getState()).toMatchObject({
      targets: 1,
      exposureEnabled: false,
      exposureApplied: false,
      releasedExposures: 3,
    });
    f.select("off");
    expect(f.state.getState()).toMatchObject({ liveTargets: 0, exposureApplied: false });
    f.probe.exit(f.ctx);
  });
  it("isolates scattering with black unlit surfaces while retaining geometry and shadow casters", () => {
    const f = fixture();
    const meshes = f.scene.children.filter((object) => object instanceof Mesh);
    f.select("scatter");
    const calibration = f.scene.getObjectByName("fog-calibration");
    expect(calibration).toBeInstanceOf(Mesh);
    expect((calibration as Mesh).material).toBeInstanceOf(MeshBasicMaterial);
    expect(((calibration as Mesh).material as MeshBasicMaterial).allowOverride).toBe(false);
    expect(calibration?.castShadow).toBe(false);
    expect(calibration?.visible).toBe(true);
    expect(f.scene.overrideMaterial).toBeInstanceOf(MeshBasicMaterial);
    expect((f.scene.overrideMaterial as MeshBasicMaterial).color.getHex()).toBe(0);
    expect((f.scene.background as Color).getHex()).toBe(0);
    expect(meshes.every((mesh) => mesh.castShadow && mesh.visible)).toBe(true);
    f.select("scatterSunOff");
    expect(f.sun.intensity).toBe(0);
    expect(f.scene.children.find((object) => object instanceof PointLight)?.intensity).toBe(30);
    f.select("scatterPointOff");
    expect(f.sun.intensity).toBe(3);
    expect(f.scene.children.find((object) => object instanceof PointLight)?.intensity).toBe(0);
    f.select("blackOff");
    expect(f.state.getState().targets).toBe(0);
    expect((f.scene.background as Color).getHex()).toBe(0);
    f.select("fog");
    expect(f.scene.overrideMaterial).toBeNull();
    expect((f.scene.background as Color).getHex()).toBe(0x131e2a);
    f.probe.exit(f.ctx);
  });
  it("observes actual target/material release events across rebuild and off", () => {
    const f = fixture();
    for (const mode of ["fog", "inside", "off", "fog", "rebuild", "off"]) f.select(mode);
    expect(f.state.getState()).toMatchObject({
      createdTargets: 4,
      releasedTargets: 4,
      releasedMaterials: 4,
      liveTargets: 0,
      targets: 0,
    });
    f.probe.exit(f.ctx);
  });
});

it("resizes the live graph without rebuilding and restores camera projection", () => {
  const f = fixture();
  f.select("fog");
  f.select("resizeSmall");
  expect(f.sizes).toEqual([[320, 240]]);
  expect(f.camera.aspect).toBe(4 / 3);
  expect(f.state.getState()).toMatchObject({
    createdTargets: 1,
    releasedTargets: 0,
    liveTargets: 1,
  });
  f.select("resizeRestore");
  expect(f.sizes).toEqual([
    [320, 240],
    [640, 400],
  ]);
  expect(f.camera.aspect).toBe(1.6);
  expect(f.state.getState().builds).toBe(1);
  f.probe.exit(f.ctx);
});
it("counts texture stability only across observed completed render frames", () => {
  const f = fixture();
  f.select("fog");
  for (let i = 0; i < 5; i += 1) f.select("");
  expect(f.state.getState()).toMatchObject({ settledRenderFrames: 0, stableTextureFrames: 0 });
  for (let i = 1; i <= 3; i += 1) {
    f.info.render.calls = i * 4;
    f.select("");
  }
  expect(f.state.getState()).toMatchObject({
    settledRenderFrames: 3,
    stableTextureFrames: 3,
    textures: 2,
  });
  f.info.memory.textures = 3;
  f.info.render.calls = 16;
  f.select("");
  expect(f.state.getState().stableTextureFrames).toBe(1);
  f.select("off");
  expect(f.state.getState()).toMatchObject({ settledRenderFrames: 0, stableTextureFrames: 0 });
  f.probe.exit(f.ctx);
});

it("moves shadow coverage away while preserving the isolated light controls", () => {
  const f = fixture();
  f.select("scatterOutside");
  expect(f.sun.shadow.camera.left).toBe(30);
  expect(f.sun.shadow.camera.right).toBe(31);
  expect(f.state.getState()).toMatchObject({
    shadowOutside: true,
    scatteringOnly: true,
    sun: true,
  });
  f.select("scatterOutsideSunOff");
  expect(f.sun.intensity).toBe(0);
  expect(f.scene.children.find((object) => object instanceof PointLight)?.intensity).toBe(30);
  f.select("scatterOutsidePointOff");
  expect(f.sun.intensity).toBe(3);
  expect(f.scene.children.find((object) => object instanceof PointLight)?.intensity).toBe(0);
  f.select("fog");
  expect(f.sun.shadow.camera.left).toBe(-9);
  f.probe.exit(f.ctx);
});
it("observes real shadow-map coverage instead of the authored mode name", () => {
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(-3, 7, 1);
  sun.target.position.set(0, 0, -5);
  sun.target.updateMatrixWorld();
  sun.shadow.camera.updateProjectionMatrix();
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.1, far: 30 });
  sun.shadow.camera.updateProjectionMatrix();
  expect(fogInsideShadowMap(sun, ROOM_BOUNDS)).toBe(true);
  Object.assign(sun.shadow.camera, { left: 30, right: 31, top: 31, bottom: 30 });
  sun.shadow.camera.updateProjectionMatrix();
  expect(fogInsideShadowMap(sun, ROOM_BOUNDS)).toBe(false);
  const f = fixture();
  f.select("scatter");
  f.select("scatterOutside");
  expect(f.state.getState()).toMatchObject({ shadowOutside: true });
  f.select("fog");
  expect(f.state.getState()).toMatchObject({ shadowOutside: false });
  f.probe.exit(f.ctx);
});

it("sees a shadow map the volume wholly swallows, which no corner of the volume enters", () => {
  // The same transforms the renderer hands the shadow camera, so this is coverage and not intent.
  const sun = new DirectionalLight(0xffffff, 3);
  const aim = (z: number) => {
    sun.position.set(-4, 1.5, z);
    sun.target.position.set(-4, 1.5, z + 3);
    sun.updateMatrixWorld(true);
    sun.target.updateMatrixWorld(true);
    sun.shadow.updateMatrices(sun);
  };
  Object.assign(sun.shadow.camera, {
    left: -0.2,
    right: 0.2,
    top: 0.2,
    bottom: -0.2,
    near: 0.1,
    far: 3,
  });
  sun.shadow.camera.updateProjectionMatrix();
  // A 40 cm map inside a 9 m room: the map is entirely within the volume, and not one of the
  // volume's eight corners is within the map. A corner test calls this fog unshadowed.
  aim(-3);
  expect(fogInsideShadowMap(sun, ROOM_BOUNDS)).toBe(true);
  // The same map translated clear of the room. A conservative test may over-report, never miss.
  aim(-60);
  expect(fogInsideShadowMap(sun, ROOM_BOUNDS)).toBe(false);
});

it("cuts the camera and streams the wall on the same controller", () => {
  const f = fixture();
  f.select("fog");
  const outside = f.camera.position.clone();
  const wall = f.scene.getObjectByName("fog-wall");
  expect(wall).toBeInstanceOf(Mesh);
  f.select("cameraCut");
  expect(f.camera.position.toArray()).toEqual([0, 1.5, -1]);
  expect(f.state.getState()).toMatchObject({
    inside: true,
    builds: 1,
    createdTargets: 1,
    releasedTargets: 0,
  });
  f.select("cameraRestore");
  expect(f.camera.position.equals(outside)).toBe(true);
  f.select("streamWallOut");
  expect(wall?.parent).toBeNull();
  expect(f.state.getState()).toMatchObject({
    streamedWall: true,
    builds: 1,
    stableTextureFrames: 0,
  });
  f.select("streamWallIn");
  expect(wall?.parent).toBe(f.scene);
  expect(f.state.getState()).toMatchObject({
    streamedWall: false,
    builds: 1,
    createdTargets: 1,
    releasedTargets: 0,
  });
  f.probe.exit(f.ctx);
});
it("routes reentry through the scene owner and records actual exit releases", () => {
  const f = fixture();
  f.select("fog");
  f.select("reenter");
  expect(f.transitions).toEqual(["fog"]);
  f.probe.exit(f.ctx);
  expect(f.state.getState()).toMatchObject({
    sceneEntries: 1,
    sceneExits: 1,
    exitReleasedTargets: 1,
    exitReleasedMaterials: 1,
  });
});
