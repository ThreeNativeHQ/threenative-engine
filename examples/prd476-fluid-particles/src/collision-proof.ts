import { FluidParticles3D, type IFluidCollider } from "@threenative/core";
import { installThreePlaytestBridge } from "@threenative/playtest/three";
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
} from "three";
import { positionLocal } from "three/tsl";
import { MeshLambertNodeMaterial, WebGPURenderer } from "three/webgpu";

/** Draw the actual GPU position at the solver's collision radius, with readable surface shading. */
export function createParticleView(water: FluidParticles3D) {
  const material = new MeshLambertNodeMaterial({ color: 0x63d7ff });
  material.positionNode = positionLocal.add(water.positions.element(0).xyz);
  const particle = new Mesh(new SphereGeometry(water.spacing * 0.44, 24, 16), material);
  particle.frustumCulled = false;
  return particle;
}

async function start({ gateClosed = true, validationControl = false } = {}) {
  // The renderer consumes this exact device on both runtimes, so its adapter identity is observed.
  const gpu = (
    navigator as Navigator & {
      gpu: {
        requestAdapter(): Promise<{
          info: Record<string, string>;
          features: { has(name: string): boolean };
          requestDevice(descriptor: { requiredFeatures: string[] }): Promise<{
            createBuffer(descriptor: { size: number; usage: number }): unknown;
            pushErrorScope(filter: string): void;
            popErrorScope(): Promise<null | { message: string }>;
          }>;
        } | null>;
      };
    }
  ).gpu;
  const adapter = await gpu.requestAdapter();
  if (adapter === null) throw new Error("Fluid collision requires a WebGPU adapter.");
  // The probe uses f32 buffers and baseline write-only rgba16float storage, not optional f16
  // arithmetic, filtering, timestamps or indirect-first-instance. Preserve core mode when offered.
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has("core-features-and-limits")
      ? ["core-features-and-limits"]
      : [],
  });
  if (typeof device.pushErrorScope !== "function" || typeof device.popErrorScope !== "function")
    throw new Error("Fluid proof requires actual GPU error scopes.");
  const gpuHealth = { completedScopes: 0, errors: 0 };
  const gpuDiagnostics: { message: string }[] = [];
  function beginGPUObservation() {
    device.pushErrorScope("validation");
  }
  async function completeGPUObservation() {
    for (let scope = 0; scope < 1; scope++) {
      const error = await device.popErrorScope();
      if (error !== null) {
        gpuHealth.errors++;
        gpuDiagnostics.push({ message: String(error?.message ?? "Malformed GPU scope result") });
      }
    }
    gpuHealth.completedScopes++;
    if (gpuHealth.errors !== 0) throw new Error("Fluid GPU error scope reported an error.");
  }
  beginGPUObservation();
  // Deliberately invalid actual WebGPU usage verifies that the scope producer rejects errors.
  if (validationControl) device.createBuffer({ size: 4, usage: 0 });
  const adapterInfo = Object.fromEntries(
    (["architecture", "description", "device", "vendor"] as const).map((field) => [
      field,
      adapter.info[field] ?? "",
    ]),
  );
  const renderer = new WebGPURenderer({ antialias: false, device });
  renderer.setPixelRatio(1);
  renderer.setSize(960, 540);
  await renderer.init();

  const computeRenderer = {
    kind: "webgpu",
    compute: (node: unknown) => renderer.compute(node as Parameters<typeof renderer.compute>[0]),
    readback: (attribute: unknown) => renderer.getArrayBufferAsync(attribute as never),
  } as Parameters<FluidParticles3D["attachRenderer"]>[0];
  const gate = { kind: "box", center: [-0.9, 1, 0], halfExtents: [0.05, 0.5, 0.4] } as const;
  const start = [-1.05, 1, 0] as const;
  const arms = [
    { name: "collision", start, velocity: [18, 0, 0], colliders: gateClosed ? [gate] : [] },
    { name: "free", start, velocity: [18, 0, 0], colliders: [] },
    { name: "diagonal", start: [-1.05, 0.8, -0.2], velocity: [18, 18, 18], colliders: [] },
    {
      name: "ejection",
      start: [-0.9, 1, 0],
      velocity: [0, 0, 0],
      colliders: [{ kind: "box", center: [-0.9, 1, 0], halfExtents: [0.32, 0.45, 0.35] }],
    },
  ] as const satisfies readonly {
    name: string;
    start: readonly [number, number, number];
    velocity: readonly [number, number, number];
    colliders: readonly IFluidCollider[];
  }[];

  const cases = arms.map((arm) => ({
    arm,
    water: new FluidParticles3D({
      capacity: 1,
      bounds: { min: [-1.4, 0.5, -0.4], max: [-0.4, 1.5, 0.4] },
      gravity: 0,
      iterations: 0,
      viscosity: 0,
      cohesion: 0,
      vorticity: 0,
      readbackEvery: 1,
    }),
  }));
  const primary = cases[0]?.water;
  if (primary === undefined) throw new Error("Collision arm is missing.");

  async function readParticle(water: FluidParticles3D) {
    const [positions, velocities] = await Promise.all([
      renderer.getArrayBufferAsync(water.positions.value),
      renderer.getArrayBufferAsync(water.velocities.value),
    ]);
    const p = new Float32Array(positions);
    const v = new Float32Array(velocities);
    if (p.length !== 4 || v.length !== 4) throw new Error("Expected one GPU particle.");
    return { x: p[0] as number, speed: Math.hypot(...v.subarray(0, 3)), values: [...p, ...v] };
  }

  // One zero-velocity initialization step provides genuine GPU input bytes and the before image.
  for (const { arm, water } of cases) {
    water.attachRenderer(computeRenderer);
    water.emit(arm.start);
    water.process();
  }
  const before = await Promise.all(cases.map(({ water }) => readParticle(water)));
  const [initialCollision, initialFree, initialDiagonal] = before;
  if (initialCollision === undefined || initialFree === undefined || initialDiagonal === undefined)
    throw new Error("Initial GPU samples are missing.");
  const initialSteps = primary.steps;
  const scene = new Scene();
  scene.background = new Color(0x102539);
  const camera = new PerspectiveCamera(42, 960 / 540, 0.1, 10);
  camera.position.set(-0.9, 1.2, 2);
  camera.lookAt(-0.9, 1, 0);
  scene.add(createParticleView(primary));
  const keyLight = new DirectionalLight(0xffffff, 2);
  keyLight.position.set(-2, 3, 3);
  scene.add(keyLight, new AmbientLight(0xffffff, 0.6));
  const wall = new Mesh(
    new BoxGeometry(0.1, 1, 0.8),
    new MeshBasicMaterial({ color: gateClosed ? 0xef9a42 : 0x547489, wireframe: !gateClosed }),
  );
  wall.position.set(...gate.center);
  scene.add(wall);
  await renderer.renderAsync(scene, camera);
  await completeGPUObservation();
  // Native screenshot requests capture a future present; this loop never advances the solver.
  renderer.setAnimationLoop(() => renderer.render(scene, camera));

  let tick = 0;
  let results = {
    gateClosed,
    measuredSteps: 0,
    totalSteps: initialSteps,
    initialX: initialCollision.x,
    collisionX: initialCollision.x,
    collisionPassed: 0,
    freeX: initialFree.x,
    freeMotionPassed: 0,
    diagonalSpeed: 0,
    diagonalDistance: 0,
    diagonalDirectionPassed: 0,
    ejectionSpeed: 0,
    finite: 0,
  };
  installThreePlaytestBridge({
    camera,
    diagnostics: () => gpuDiagnostics,
    fixedStep: async (ticks) => {
      // Subsequent fixture ticks hold the single measured step for a stable after screenshot.
      const measured = results.measuredSteps === 0;
      if (measured) {
        beginGPUObservation();
        for (const { arm, water } of cases) {
          water.setColliders(arm.colliders);
          water.emit(arm.start, arm.velocity);
          water.process();
        }
        const after = await Promise.all(cases.map(({ water }) => readParticle(water)));
        const [collision, free, diagonal, ejection] = after;
        if (
          collision === undefined ||
          free === undefined ||
          diagonal === undefined ||
          ejection === undefined
        )
          throw new Error("Measured GPU samples are missing.");
        const diagonalDelta = diagonal.values
          .slice(0, 3)
          .map((value, axis) => value - (initialDiagonal.values[axis] as number));
        const collisionX = collision.x;
        const freeX = free.x;
        results = {
          ...results,
          measuredSteps: primary.steps - initialSteps,
          totalSteps: primary.steps,
          collisionX,
          collisionPassed:
            collisionX <= gate.center[0] - gate.halfExtents[0] - primary.spacing * 0.44 + 1e-5
              ? 1
              : 0,
          freeX,
          freeMotionPassed: Math.abs(freeX - -0.75) < 1e-5 ? 1 : 0,
          diagonalSpeed: diagonal.speed,
          diagonalDistance: Math.hypot(...diagonalDelta),
          diagonalDirectionPassed: diagonalDelta.every(
            (value) => Math.abs(value - 0.3 / Math.sqrt(3)) < 1e-5,
          )
            ? 1
            : 0,
          ejectionSpeed: ejection.speed,
          finite: [...before, ...after].flatMap((sample) => sample.values).every(Number.isFinite)
            ? 1
            : 0,
        };
      }
      tick += ticks;
      await renderer.renderAsync(scene, camera);
      if (measured) await completeGPUObservation();
      return ticks;
    },
    renderer,
    resources: {
      read: () => ({
        FluidCollision: results,
        FluidAdapter: adapterInfo,
        FluidGPU: { ...gpuHealth },
      }),
    },
    scene,
    tick: () => tick,
  });

  return renderer.domElement;
}

export default { start };
