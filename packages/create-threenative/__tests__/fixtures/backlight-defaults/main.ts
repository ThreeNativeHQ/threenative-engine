// Qualification only: no shipped default or starter source is changed.
import {
  AnimationMixer,
  BoxGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  EquirectangularReflectionMapping,
  FloatType,
  Material,
  Mesh,
  MeshStandardMaterial,
  type PerspectiveCamera,
  RGBAFormat,
  SphereGeometry,
  TextureLoader,
  type Scene as ThreeScene,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { type ICtx, Scene, defineGame } from "../../../../core/dist/index.js";
import { playtest } from "../../../../core/dist/playtest.js";
import { sampleEnvironment } from "../../../templates/starter/src/render/environmentSampling.js";
import { qualityPreset } from "../../../templates/starter/src/render/quality.js";
import { setupSky } from "../../../templates/starter/src/render/sky.js";
import { WorldEnvironment } from "../../../templates/starter/src/render/worldEnvironment.js";
import { reportEnvironmentContribution } from "./environment.js";
import { type BacklightControls, backlightMaterial } from "./material.js";
const params = new URLSearchParams(location.search);
const arm = params.get("arm") ?? "baseline";
const shot = params.get("shot") ?? "backlit";
const liveCost = params.get("liveCost") === "1";
const omitReport = params.get("omitReport") === "1";
if (!["baseline", "enabled", "rim-zero", "fill-black"].includes(arm))
  throw new Error("Unknown backlight arm");
if (!["backlit", "backlit-black-ibl", "frontlit", "dark", "missing"].includes(shot))
  throw new Error("Unknown backlight shot");
function qualificationReport(
  scene: ThreeScene,
  controls: Parameters<typeof reportEnvironmentContribution>[1],
) {
  const original = console.info;
  try {
    // Deliberate missing-marker mutation only; measurements and material controls remain intact.
    if (omitReport) console.info = () => {};
    return reportEnvironmentContribution(scene, controls);
  } finally {
    console.info = original;
  }
}
function convertSceneMaterials(
  scene: ThreeScene,
  controls: BacklightControls,
  converted: Map<Material, Material>,
  excluded: string[],
  enabled: boolean,
) {
  if (!enabled) return;
  const convert = (source: Material): Material => {
    const cached = converted.get(source);
    if (cached) return cached;
    if (
      !(source instanceof MeshStandardMaterial) ||
      "isMeshPhysicalMaterial" in source ||
      source.onBeforeCompile !== Material.prototype.onBeforeCompile
    ) {
      excluded.push(source.type);
      return source;
    }
    const material = backlightMaterial(source, controls);
    converted.set(source, material);
    return material;
  };
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(convert)
      : convert(object.material);
  });
}
const captures: Array<Record<string, unknown>> = [];
class QualificationScene extends Scene {
  #model: Awaited<ReturnType<GLTFLoader["loadAsync"]>> | undefined;
  #sky: Awaited<ReturnType<TextureLoader["loadAsync"]>> | undefined;
  #dispose = () => {};
  override async load(ctx: ICtx) {
    [this.#model, this.#sky] = await Promise.all([
      new GLTFLoader().loadAsync(
        "/packages/create-threenative/template-assets/assets/mannequin.glb",
      ),
      new TextureLoader().loadAsync("/packages/create-threenative/template-assets/assets/sky.jpg"),
    ]);
    if (params.get("gpuSample") === "1") {
      setupSky(ctx.scene, this.#sky);
      const started = performance.now();
      const sample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
        web: true,
        rendererKind: ctx.renderer.kind,
        mobile: false,
        software: ctx.renderer.softwareAdapter !== undefined,
      });
      const result = {
        measurement: sample.measurement,
        elapsedMs: performance.now() - started,
        sourceWidth: this.#sky.image.width,
        sourceHeight: this.#sky.image.height,
        intensity: sample.intensity,
      };
      (
        globalThis as unknown as { __BACKLIGHT_SOURCE_SAMPLE__: unknown }
      ).__BACKLIGHT_SOURCE_SAMPLE__ = result;
      console.info(`TN_ACTUAL_ENVIRONMENT_GPU_SAMPLE:${JSON.stringify(result)}`);
    }
  }
  override enter(ctx: ICtx) {
    if (!this.#model || !this.#sky) throw new Error("Backlight fixture assets not loaded");
    const camera = ctx.camera as PerspectiveCamera;
    camera.position.set(0, 1.35, 6);
    camera.lookAt(0, 1, 0);
    setupSky(ctx.scene, this.#sky);
    ctx.scene.fog = null;
    const darkEnvironment = new DataTexture(
      new Float32Array(4 * 2 * 4),
      4,
      2,
      RGBAFormat,
      FloatType,
    );
    darkEnvironment.mapping = EquirectangularReflectionMapping;
    if (shot === "dark" || shot === "backlit-black-ibl") ctx.scene.environment = darkEnvironment;
    if (shot === "missing") ctx.scene.environment = null;
    const key = new DirectionalLight(0xffeed0, 4.5);
    key.position.set(0, 2, shot === "frontlit" ? 3 : -3);
    if (shot === "backlit" || shot === "backlit-black-ibl" || shot === "frontlit")
      ctx.scene.add(key);
    const controls: BacklightControls = {
      key,
      scene: ctx.scene,
      camera,
      rimGain: arm === "rim-zero" ? 0 : 0.12,
      fillGain: 1,
      fillColor: new Color(arm === "fill-black" ? 0 : 0x667b9d),
      fillDirection: new Vector3(-1, 1, 1),
      fillAngularSize: 0.7,
      fillAdmitted: arm !== "baseline" && (shot === "dark" || shot === "missing"),
    };
    const report = qualificationReport(ctx.scene, {
      darkThreshold: 0.001,
      rimGain: arm === "baseline" ? 0 : controls.rimGain,
      fillGain: arm === "baseline" ? 0 : controls.fillGain,
      fillAdmitted: controls.fillAdmitted,
      fillColor: controls.fillColor,
      maxSourceTexels: 65536,
    });
    const model = this.#model.scene;
    ctx.add(model);
    const mixer = new AnimationMixer(model);
    const clip = this.#model.animations.find((clip) => clip.name === "Jog_Fwd_Loop");
    if (!clip) throw new Error("Actual starter mannequin jog clip missing");
    mixer.clipAction(clip).play();
    const primitives = [
      new Mesh(
        new SphereGeometry(0.5, 32, 16),
        new MeshStandardMaterial({ color: 0x8290a1, metalness: 1, roughness: 0.3 }),
      ),
      new Mesh(
        new SphereGeometry(0.5, 32, 16),
        new MeshStandardMaterial({ color: 0x7e8eb3, roughness: 0.7 }),
      ),
    ] as const;
    primitives[0].position.set(-1.5, 0.5, 0);
    primitives[1].position.set(1.5, 0.5, 0);
    const floor = new Mesh(
      new BoxGeometry(8, 0.1, 8),
      new MeshStandardMaterial({ color: 0x424955, roughness: 0.8 }),
    );
    floor.position.y = -0.05;
    for (const mesh of [...primitives, floor]) ctx.add(mesh);
    const ownedSources = [...primitives, floor].map((mesh) => mesh.material);
    const converted = new Map<Material, Material>();
    const excluded: string[] = [];
    convertSceneMaterials(ctx.scene, controls, converted, excluded, arm !== "baseline");
    const applied = new WorldEnvironment(qualityPreset("high")).apply(
      ctx.renderer,
      ctx.scene,
      camera,
    );
    let animationTicks = 0;
    let animationRunning = false;
    ctx.entities.add("qualification", {
      debug: () => ({
        arm,
        shot,
        animationTicks,
        animationSeconds: Math.round(mixer.time * 1e9) / 1e9,
        convertedMaterials: converted.size,
        excluded,
        environmentState: report.environmentState,
        bufferWidth: ctx.renderer.domElement.width,
        bufferHeight: ctx.renderer.domElement.height,
        cameraPosition: camera.position.toArray(),
        cameraMatrixWorld: camera.matrixWorld.toArray(),
        cameraMatrixWorldInverse: camera.matrixWorldInverse.toArray(),
        cameraProjectionMatrix: camera.projectionMatrix.toArray(),
      }),
    });
    console.info("TN_BACKLIGHT_QUALIFICATION", {
      arm,
      shot,
      controls: {
        rimGain: controls.rimGain,
        fillGain: controls.fillGain,
        fillColor: controls.fillColor.toArray(),
        fillDirection: controls.fillDirection.toArray(),
        fillAngularSize: controls.fillAngularSize,
        fillAdmitted: controls.fillAdmitted,
      },
      report,
      camera: camera.position.toArray(),
      convertedMaterials: converted.size,
      excluded,
      stages: applied.stages,
    });
    this.#dispose = () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      applied.dispose?.();
      for (const material of converted.values()) material.dispose();
      for (const material of ownedSources) material.dispose();
      for (const mesh of [...primitives, floor]) mesh.geometry.dispose();
      darkEnvironment.dispose();
      this.#sky?.dispose();
    };
    return (frameCtx: ICtx, dt: number) => {
      if (frameCtx.input.justPressed("pose")) {
        animationTicks = 0;
        animationRunning = true;
        mixer.setTime(0);
      }
      if (!animationRunning || animationTicks >= 90) return;
      animationTicks += 1;
      mixer.update(dt);
    };
  }
  override exit() {
    this.#dispose();
  }
}
if (liveCost) Object.assign(globalThis, { __BACKLIGHT_BUDGET_WINDOWS__: captures });
const game = defineGame({
  camera: { projection: "perspective", fov: 40, near: 0.1, far: 100 },
  renderer: { preferWebGPU: true, resolutionScale: 1 },
  display: { maxFps: 60 },
  input: { pose: { keys: ["KeyP"] } },
  initialState: {},
  seed: 345,
  assets: {
    manifest:
      "/packages/create-threenative/__tests__/fixtures/backlight-defaults/assets.manifest.json",
  },
  frameBudget: {
    reportEvery: 60,
    onWindow: (window) => {
      captures.push(window as unknown as Record<string, unknown>);
    },
  },
  scenes: { qualification: QualificationScene },
  start: "qualification",
  plugins: [playtest({ holdUntilAttached: !liveCost })],
});
void game
  .start()
  .then(() => {
    if (!game.ctx) throw new Error("Backlight fixture ctx missing");
    document.body.append(game.ctx.renderer.domElement);
  })
  .catch((error: unknown) => console.error(error));
