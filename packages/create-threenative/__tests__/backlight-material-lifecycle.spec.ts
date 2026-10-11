import {
  BoxGeometry,
  Camera,
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Scene,
  Texture,
} from "three";
import { afterEach, expect, test, vi } from "vitest";
import { sampleEnvironment } from "../templates/starter/src/render/environmentSampling.js";
import { createMaterialLighting } from "../templates/starter/src/render/materialLighting.js";
import { materialLightingEnabled } from "../templates/starter/src/render/quality.js";
const desktop = { web: true, rendererKind: "webgpu", mobile: false, software: false };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function world() {
  const scene = new Scene();
  const camera = new Camera();
  const key = new DirectionalLight(0xfff1e0, 4.5);
  scene.add(key);
  return { scene, camera, key };
}
test("actual mesh arrays preserve sharing, maps, emissive and unsupported material slots", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const map = new Texture();
  const source = new MeshStandardMaterial({
    map,
    emissive: 0x123456,
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0.4,
  });
  const physical = new MeshPhysicalMaterial();
  const custom = new MeshStandardMaterial();
  custom.onBeforeCompile = () => {};
  const basic = new MeshBasicMaterial();
  const original = [source, physical, custom, basic];
  const mesh = new Mesh(new BoxGeometry(), original);
  const shared = new Mesh(new BoxGeometry(), source);
  scene.add(mesh, shared);
  const sourceDispose = vi.spyOn(source, "dispose");
  const textureDispose = vi.spyOn(map, "dispose");
  const controller = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  expect(mesh.material).not.toBe(original);
  const converted = shared.material as MeshStandardMaterial;
  expect((mesh.material as Material[])[0]).toBe(converted);
  expect((mesh.material as Material[]).slice(1)).toEqual([physical, custom, basic]);
  expect(converted.map).toBe(map);
  expect(converted.emissive.equals(source.emissive)).toBe(true);
  expect(converted.emissiveIntensity).toBe(0.7);
  expect(converted.opacity).toBe(0.4);
  expect(converted.transparent).toBe(true);
  expect(controller.debug()).toMatchObject({ convertedMaterials: 1, excludedSlots: 3 });
  const convertedDispose = vi.spyOn(converted, "dispose");
  controller.setEnabled(false);
  expect(mesh.material).toBe(original);
  expect(shared.material).toBe(source);
  expect(convertedDispose).not.toHaveBeenCalled();
  controller.setEnabled(true);
  expect(shared.material).toBe(converted);
  controller.dispose();
  controller.dispose();
  expect(mesh.material).toBe(original);
  expect(shared.material).toBe(source);
  expect(convertedDispose).toHaveBeenCalledTimes(1);
  expect(sourceDispose).not.toHaveBeenCalled();
  expect(textureDispose).not.toHaveBeenCalled();
});
test.each([
  { ...desktop, web: false },
  { ...desktop, mobile: true },
  { ...desktop, software: true },
  { ...desktop, rendererKind: "webgl" },
])("platform fallback keeps originals even when enabled requested %j", (environment) => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const source = new MeshStandardMaterial();
  const mesh = new Mesh(new BoxGeometry(), source);
  scene.add(mesh);
  const c = createMaterialLighting(scene, camera, key, { ...environment, enabled: true });
  expect(mesh.material).toBe(source);
  c.setEnabled(true);
  expect(mesh.material).toBe(source);
  expect(c.debug()).toMatchObject({ enabled: false, convertedMaterials: 0 });
  c.dispose();
});
test("NodeMaterial conversion preserves source alphaTest", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const source = new MeshStandardMaterial({ alphaTest: 0.5 });
  const mesh = new Mesh(new BoxGeometry(), source);
  scene.add(mesh);
  const c = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  const converted = mesh.material as MeshStandardMaterial;
  expect(converted).not.toBe(source);
  expect(converted.alphaTest).toBe(0.5);
  c.dispose();
});
test("quality gate only admits high web hardware desktop, including pinned fallback", () => {
  expect(materialLightingEnabled("high", desktop)).toBe(true);
  for (const tier of ["low", "medium"] as const)
    expect(materialLightingEnabled(tier, desktop)).toBe(false);
  expect(materialLightingEnabled("high", { ...desktop, software: true })).toBe(false);
});
test("borrowed authored material override is preserved on downshift and exit", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const original = new MeshStandardMaterial();
  const mesh = new Mesh(new BoxGeometry(), original);
  scene.add(mesh);
  const c = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  const authored = new MeshStandardMaterial();
  mesh.material = authored;
  c.setEnabled(false);
  c.setEnabled(true);
  c.dispose();
  expect(mesh.material).toBe(authored);
});
test("unknown environment suppresses fill, measured dark setter enables it, override still reports", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const image = new Texture({ width: 4, height: 2 } as never);
  scene.environment = image;
  scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
  const c = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  expect(c.controls.fillAdmitted).toBe(false);
  expect(c.debug()).toMatchObject({ environmentState: "unknown", meanRadiance: null });
  c.setEnvironmentMeasurement({
    status: "measured",
    meanRadiance: 0,
    meanRGB: [0, 0, 0],
    reason: "known GPU sample",
  });
  expect(c.controls.fillAdmitted).toBe(true);
  c.controls.rimGain = 0;
  // JavaScript callers can replace the readonly TypeScript property at runtime.
  Reflect.set(c.controls, "fillColor", new Color(0));
  const report = c.report();
  expect(report).toMatchObject({ rimGain: 0, analyticFill: { blackColorOverride: true } });
  expect(c.debug()).toMatchObject({ meanRadiance: 0 });
  scene.environment = new Texture();
  expect(c.controls.fillAdmitted).toBe(false);
  c.dispose();
});
test("missing environment admits directional fill and live controls remain game-owned", () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const c = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  expect(c.controls.rimGain).toBe(0.12);
  expect(c.controls.fillGain).toBe(1);
  expect(c.controls.fillAngularSize).toBe(0.7);
  expect(c.controls.fillColor.equals(new Color(0x667b9d))).toBe(true);
  expect(c.controls.fillAdmitted).toBe(true);
  c.controls.fillGain = 0;
  c.report();
  expect(logs).toHaveBeenCalledWith(expect.stringContaining("TN_ENVIRONMENT_CONTRIBUTION"));
  c.dispose();
});

test("authored array edits survive disposal while owned slots restore", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const source = new MeshStandardMaterial();
  const originals = [source, source];
  const mesh = new Mesh(new BoxGeometry(), originals);
  scene.add(mesh);
  const c = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  const authored = new MeshBasicMaterial();
  const current = mesh.material as Material[];
  current[1] = authored;
  c.dispose();
  expect(mesh.material).toEqual([source, authored]);
});
test("all-unsupported arrays retain their original identity", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const originals = [new MeshPhysicalMaterial(), new MeshBasicMaterial()];
  const mesh = new Mesh(new BoxGeometry(), originals);
  scene.add(mesh);
  const c = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  expect(mesh.material).toBe(originals);
  c.dispose();
  expect(mesh.material).toBe(originals);
});

function mockRenderer(read?: () => Promise<unknown>) {
  const oldTarget = { name: "borrowed target" };
  let target: unknown = oldTarget;
  let face = 3;
  let level = 2;
  const renderer = {
    isWebGPURenderer: true,
    toneMapping: 4,
    outputColorSpace: "srgb",
    autoClear: false,
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => level,
    setRenderTarget: vi.fn((next: unknown, nextFace = 0, nextLevel = 0) => {
      target = next;
      face = nextFace;
      level = nextLevel;
    }),
    render: vi.fn((..._args: unknown[]) => {}),
    readRenderTargetPixelsAsync: vi.fn((..._args: unknown[]) =>
      (
        read ??
        (async () => {
          const pixels = new Float32Array(64 * 32 * 4);
          for (let i = 0; i < pixels.length; i += 4) pixels.set([0.5, 0.5, 0.5, 1], i);
          return pixels;
        })
      )(),
    ),
  };
  return { renderer, oldTarget };
}
test("GPU sample restores renderer state before readback settles and preserves borrowed resources", async () => {
  const { scene } = world();
  const source = new Texture();
  source.mapping = EquirectangularReflectionMapping;
  scene.environment = source;
  scene.environmentIntensity = 2;
  const sourceDispose = vi.spyOn(source, "dispose");
  let resolvePixels: (value: Float32Array) => void = () => {};
  const { renderer, oldTarget } = mockRenderer(
    () =>
      new Promise((resolve) => {
        resolvePixels = resolve;
      }),
  );
  const pending = sampleEnvironment(renderer, scene, desktop);
  expect(renderer.getRenderTarget()).toBe(oldTarget);
  expect(renderer.getActiveCubeFace()).toBe(3);
  expect(renderer.getActiveMipmapLevel()).toBe(2);
  expect(renderer.toneMapping).toBe(4);
  expect(renderer.outputColorSpace).toBe("srgb");
  expect(renderer.autoClear).toBe(false);
  const scratch = renderer.readRenderTargetPixelsAsync.mock.calls[0]?.[0] as unknown as {
    dispose(): void;
  };
  const disposeTarget = vi.spyOn(scratch, "dispose");
  const quad = renderer.render.mock.calls[0]?.[0] as unknown as {
    material: { dispose(): void };
    geometry: { dispose(): void };
  };
  const disposeMaterial = vi.spyOn(quad.material, "dispose");
  const disposeGeometry = vi.spyOn(quad.geometry, "dispose");
  const pixels = new Float32Array(64 * 32 * 4).fill(0.5);
  resolvePixels(pixels);
  const sampled = await pending;
  expect(sampled.measurement.status).toBe("measured");
  expect(sampled.measurement.meanRadiance).toBeCloseTo(1, 12);
  expect(sampled.source).toBe(source);
  expect(sampled.intensity).toBe(2);
  expect(disposeTarget).toHaveBeenCalledTimes(1);
  expect(disposeMaterial).toHaveBeenCalledTimes(1);
  expect(disposeGeometry).not.toHaveBeenCalled();
  expect(sourceDispose).not.toHaveBeenCalled();
});
test("failed readback restores state and returns unknown", async () => {
  const { scene } = world();
  const source = new Texture();
  source.mapping = EquirectangularReflectionMapping;
  scene.environment = source;
  const { renderer, oldTarget } = mockRenderer(async () => {
    throw new Error("unsupported readback");
  });
  const result = await sampleEnvironment(renderer, scene, desktop);
  expect(result.measurement).toMatchObject({ status: "unknown", meanRadiance: null });
  expect(renderer.getRenderTarget()).toBe(oldTarget);
  expect(renderer.toneMapping).toBe(4);
});
test("environment source changes invalidate asynchronous samples and controller snapshot", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const source = new Texture();
  source.mapping = EquirectangularReflectionMapping;
  scene.environment = source;
  let resolvePixels: (value: Float32Array) => void = () => {};
  const { renderer } = mockRenderer(
    () =>
      new Promise((resolve) => {
        resolvePixels = resolve;
      }),
  );
  const pending = sampleEnvironment(renderer, scene, desktop);
  scene.environment = new Texture();
  resolvePixels(new Float32Array(64 * 32 * 4));
  const sampled = await pending;
  expect(sampled.measurement.status).toBe("unknown");
  const c = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  c.setEnvironmentMeasurement(
    { status: "measured", meanRadiance: 0, meanRGB: [0, 0, 0], reason: "stale" },
    source,
    1,
  );
  expect(c.controls.fillAdmitted).toBe(false);
  c.dispose();
});
test("sampler skips unsupported platform without rendering or inventing a mean", async () => {
  const { scene } = world();
  scene.environment = new Texture();
  const { renderer } = mockRenderer();
  const sampled = await sampleEnvironment(renderer, scene, { ...desktop, web: false });
  expect(sampled.measurement).toMatchObject({ status: "unknown", meanRadiance: null });
  expect(renderer.render).not.toHaveBeenCalled();
});

test("render failure also restores state and skips readback", async () => {
  const { scene } = world();
  const source = new Texture();
  source.mapping = EquirectangularReflectionMapping;
  scene.environment = source;
  const { renderer, oldTarget } = mockRenderer();
  renderer.render.mockImplementation(() => {
    throw new Error("pipeline unavailable");
  });
  const sampled = await sampleEnvironment(renderer, scene, desktop);
  expect(sampled.measurement.status).toBe("unknown");
  expect(renderer.getRenderTarget()).toBe(oldTarget);
  expect(renderer.getActiveCubeFace()).toBe(3);
  expect(renderer.getActiveMipmapLevel()).toBe(2);
  expect(renderer.outputColorSpace).toBe("srgb");
  expect(renderer.autoClear).toBe(false);
  expect(renderer.readRenderTargetPixelsAsync).not.toHaveBeenCalled();
});

test("shortened authored arrays stay shortened when owned slots restore", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const source = new MeshStandardMaterial();
  const mesh = new Mesh(new BoxGeometry(), [source, source]);
  scene.add(mesh);
  const c = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  (mesh.material as Material[]).pop();
  c.dispose();
  expect(mesh.material).toEqual([source]);
});
const sourceChanges = [
  (source: Texture) => {
    source.needsUpdate = true;
  },
  (source: Texture) => {
    source.colorSpace = "srgb";
  },
  (source: Texture) => {
    source.mapping = 300;
  },
];
test.each(sourceChanges)(
  "same texture content/interpretation changes invalidate fill",
  (change) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { scene, camera, key } = world();
    const source = new Texture();
    source.mapping = EquirectangularReflectionMapping;
    scene.environment = source;
    const c = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
    c.setEnvironmentMeasurement({
      status: "measured",
      meanRadiance: 0,
      meanRGB: [0, 0, 0],
      reason: "snapshot",
    });
    expect(c.controls.fillAdmitted).toBe(true);
    change(source);
    expect(c.controls.fillAdmitted).toBe(false);
    c.dispose();
  },
);
test.each(sourceChanges)("same texture changes invalidate pending GPU readback", async (change) => {
  const { scene } = world();
  const source = new Texture();
  source.mapping = EquirectangularReflectionMapping;
  scene.environment = source;
  let resolvePixels: (value: Float32Array) => void = () => {};
  const { renderer } = mockRenderer(
    () =>
      new Promise((resolve) => {
        resolvePixels = resolve;
      }),
  );
  const pending = sampleEnvironment(renderer, scene, desktop);
  change(source);
  resolvePixels(new Float32Array(64 * 32 * 4));
  expect((await pending).measurement.status).toBe("unknown");
});

test("hung GPU readback times out without disposing pending resources; late settlement cleans once", async () => {
  vi.useFakeTimers();
  const { scene } = world();
  const source = new Texture();
  source.mapping = EquirectangularReflectionMapping;
  scene.environment = source;
  let resolvePixels: (value: Float32Array) => void = () => {};
  const { renderer } = mockRenderer(
    () =>
      new Promise((resolve) => {
        resolvePixels = resolve;
      }),
  );
  const pending = sampleEnvironment(renderer, scene, desktop);
  let outcome: Awaited<typeof pending> | undefined;
  void pending.then((value) => {
    outcome = value;
  });
  const scratch = renderer.readRenderTargetPixelsAsync.mock.calls[0]?.[0] as unknown as {
    dispose(): void;
  };
  const disposeTarget = vi.spyOn(scratch, "dispose");
  const quad = renderer.render.mock.calls[0]?.[0] as unknown as { material: { dispose(): void } };
  const disposeMaterial = vi.spyOn(quad.material, "dispose");
  try {
    await vi.advanceTimersByTimeAsync(1001);
    expect(outcome?.measurement).toMatchObject({ status: "unknown", meanRadiance: null });
    expect(disposeTarget).not.toHaveBeenCalled();
    expect(disposeMaterial).not.toHaveBeenCalled();
  } finally {
    resolvePixels(new Float32Array(64 * 32 * 4));
    await pending;
    await Promise.resolve();
  }
  expect(disposeTarget).toHaveBeenCalledTimes(1);
  expect(disposeMaterial).toHaveBeenCalledTimes(1);
});

test("in-place original array edits during fallback survive tier recovery", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  const first = new MeshStandardMaterial();
  const second = new MeshStandardMaterial();
  const original: Material[] = [first, second];
  const mesh = new Mesh(new BoxGeometry(), original);
  scene.add(mesh);
  const controller = createMaterialLighting(scene, camera, key, { ...desktop, enabled: true });
  const convertedFirst = (mesh.material as Material[])[0];
  controller.setEnabled(false);
  expect(mesh.material).toBe(original);
  const authored = new MeshBasicMaterial();
  original[1] = authored;
  controller.setEnabled(true);
  expect((mesh.material as Material[])[1]).toBe(authored);
  expect((mesh.material as Material[])[0]).toBe(convertedFirst);
  controller.dispose();
  expect(mesh.material).toBe(original);
  expect(original).toEqual([first, authored]);
});

test("successful immutable source samples reuse cache but changed provenance resamples", async () => {
  const { scene } = world();
  const source = new Texture();
  source.mapping = EquirectangularReflectionMapping;
  scene.environment = source;
  const { renderer } = mockRenderer();
  const first = await sampleEnvironment(renderer, scene, desktop);
  const repeated = await sampleEnvironment(renderer, scene, desktop);
  expect(repeated.measurement).toEqual(first.measurement);
  expect(renderer.render).toHaveBeenCalledTimes(1);
  expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledTimes(1);
  source.needsUpdate = true;
  await sampleEnvironment(renderer, scene, desktop);
  expect(renderer.render).toHaveBeenCalledTimes(2);
  scene.environmentIntensity = 2;
  const stronger = await sampleEnvironment(renderer, scene, desktop);
  expect(stronger.measurement.meanRadiance).toBeCloseTo(1);
  expect(renderer.render).toHaveBeenCalledTimes(3);
  scene.environment = new Texture();
  scene.environment.mapping = EquirectangularReflectionMapping;
  await sampleEnvironment(renderer, scene, desktop);
  expect(renderer.render).toHaveBeenCalledTimes(4);
  await sampleEnvironment(renderer, scene, { ...desktop, software: true });
  expect(renderer.render).toHaveBeenCalledTimes(4);
  const other = mockRenderer();
  await sampleEnvironment(other.renderer, scene, desktop);
  expect(other.renderer.render).toHaveBeenCalledTimes(1);
});

test("unknown sample failures are retried rather than cached", async () => {
  const { scene } = world();
  scene.environment = new Texture();
  scene.environment.mapping = EquirectangularReflectionMapping;
  const { renderer } = mockRenderer(async () => {
    throw new Error("unavailable");
  });
  await sampleEnvironment(renderer, scene, desktop);
  await sampleEnvironment(renderer, scene, desktop);
  expect(renderer.render).toHaveBeenCalledTimes(2);
});

test("WebGPU wrapper with a WebGL backend preserves originals and skips sampling", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { scene, camera, key } = world();
  scene.environment = new Texture();
  scene.environment.mapping = EquirectangularReflectionMapping;
  const original = new MeshStandardMaterial();
  const mesh = new Mesh(new BoxGeometry(), original);
  scene.add(mesh);
  const { renderer } = mockRenderer();
  Reflect.set(renderer, "backend", { isWebGLBackend: true });
  const sample = await sampleEnvironment(renderer, scene, desktop);
  expect(sample.measurement.status).toBe("unknown");
  expect(renderer.render).not.toHaveBeenCalled();
  expect(renderer.readRenderTargetPixelsAsync).not.toHaveBeenCalled();
  const environment = { ...desktop, webglFallback: true };
  expect(materialLightingEnabled("high", environment)).toBe(false);
  const controller = createMaterialLighting(scene, camera, key, { ...environment, enabled: true });
  controller.setEnabled(true);
  expect(mesh.material).toBe(original);
  expect(controller.debug().convertedMaterials).toBe(0);
  controller.dispose();
});
