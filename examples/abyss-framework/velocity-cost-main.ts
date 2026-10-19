import { motionBlur } from "three/addons/tsl/display/MotionBlur.js";
import { pass } from "three/tsl";
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  type Node,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  WebGPURenderer,
} from "three/webgpu";
import { FrameBudget } from "../../packages/core/src/frame-budget.js";
import { RenderChain } from "../../packages/core/src/render/chain.js";
import {
  readVelocityPreviousBoneMatrices,
  readVelocityPreviousMatrices,
  readVelocityPreviousWorldMatrix,
} from "../../packages/core/src/render/velocity.js";
import { SceneRenderProjection } from "../../packages/core/src/renderProjection.js";
import { installThreePlaytestBridge } from "../../packages/playtest/dist/three/index.js";
import { evaluateTemporalOffCost, velocityCostSamples } from "./src/render/velocityCost.js";

const renderer = new WebGPURenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(640, 360);
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new Scene();
scene.background = new Color(0x172034);
const camera = new PerspectiveCamera(50, 640 / 360, 0.1, 100);
camera.position.set(0, 0, 16);
scene.add(new HemisphereLight(0xb8d7ff, 0x263349, 2));
const light = new DirectionalLight(0xffffff, 3);
light.position.set(-2, 4, 5);
scene.add(light);
const geometry = new BoxGeometry(0.7, 0.7, 0.7);
const materials = [
  new MeshStandardMaterial({ color: 0x69c5ff, roughness: 0.5 }),
  new MeshStandardMaterial({ color: 0xf6ab55, roughness: 0.5 }),
];
for (let index = 0; index < 80; index += 1) {
  const mesh = new Mesh(geometry, materials[index % 2]);
  mesh.position.set((index % 10) - 4.5, Math.floor(index / 10) - 3.5, 0);
  mesh.rotation.set(0.2, 0.25, 0.1);
  scene.add(mesh);
}
const scenePass = pass(scene, camera);
const pipeline = new RenderPipeline(renderer);
pipeline.outputNode = scenePass.getTextureNode("output");
let velocityEnabled = false;
const adapter = {
  kind: "webgpu" as const,
  raw: renderer,
  setOutputNode(node: unknown) {
    if (typeof node !== "object" || node === null || Reflect.get(node, "isNode") !== true)
      throw new Error("Temporal-off cost chain produced an invalid output node.");
    pipeline.outputNode = node as Node;
    pipeline.needsUpdate = true;
  },
  clearOutputNode() {
    pipeline.outputNode = scenePass.getTextureNode("output");
    pipeline.needsUpdate = true;
  },
  setRenderChainVelocityEnabled(enabled: boolean) {
    velocityEnabled = enabled;
  },
};
function makeChain(temporal: boolean) {
  return new RenderChain({
    renderer: adapter,
    input: scenePass.getTextureNode("output"),
    request: { stages: temporal ? ["motionBlur"] : [], velocity: { pass: scenePass } },
    stages: [
      {
        name: "motionBlur",
        build: (_input, context) => {
          if (context.velocityNode === undefined)
            throw new Error("Motion blur has no velocity source.");
          return motionBlur(
            scenePass.getTextureNode("output"),
            (context.velocityNode as Node<"vec4">).xy,
          );
        },
      },
    ],
    report: () => undefined,
  });
}
let chain = makeChain(false);
const projection = new SceneRenderProjection(scene, {
  projection: false,
  velocity: () => velocityEnabled,
  onReport: () => undefined,
});
const arms = ["baselineA", "baselineB", "temporalOff"] as const;
type Arm = (typeof arms)[number];
const meters = Object.fromEntries(
  arms.map((arm) => [
    arm,
    new FrameBudget({
      capacity: velocityCostSamples,
      reportEvery: 100_000,
      hitchMs: 1_000_000,
      report: () => undefined,
    }),
  ]),
) as Record<Arm, FrameBudget>;
const phaseSamples: Record<Arm, number[]> = { baselineA: [], baselineB: [], temporalOff: [] };
let frames = 0;
let cycles = 0;
let velocityTargets = 0;
let historyObjects = 0;
let activeVelocityTargets = 0;
let transitions = 0;

function clockQuantum(): number {
  let before = performance.now();
  let minimum = Number.POSITIVE_INFINITY;
  let changes = 0;
  for (let attempts = 0; attempts < 1_000_000 && changes < 16; attempts += 1) {
    const after = performance.now();
    if (after > before) {
      minimum = Math.min(minimum, after - before);
      before = after;
      changes += 1;
    }
  }
  if (changes !== 16) throw new Error("Could not observe sixteen monotonic clock ticks.");
  // Normalize subtraction residue only; this does not increase the measured clock resolution.
  return Math.round(minimum * 1e6) / 1e6;
}
const clockQuantumMs = clockQuantum();

function observeResources(): void {
  velocityTargets = Math.max(
    velocityTargets,
    scenePass.renderTarget.textures.filter((texture) => texture.name === "velocity").length,
  );
  let count = 0;
  scene.traverse((object) => {
    if (
      readVelocityPreviousWorldMatrix(object) !== undefined ||
      readVelocityPreviousMatrices(object) !== undefined ||
      readVelocityPreviousBoneMatrices(object) !== undefined
    )
      count += 1;
  });
  historyObjects = Math.max(historyObjects, count);
}

async function draw(arm: Arm, measured: boolean): Promise<void> {
  const timestamp = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
  const budget = meters[arm];
  if (measured) {
    budget.beginFrame(timestamp, performance.now());
    budget.markSimulationEnd(performance.now(), 0);
  }
  const start = performance.now();
  if (arm === "temporalOff") projection.reconcile();
  pipeline.render();
  if (arm === "temporalOff") projection.commit();
  const duration = performance.now() - start;
  if (measured) {
    budget.addRender(duration);
    const sample = budget.endFrame(performance.now());
    if (sample === undefined)
      throw new Error("Temporal-off cost cannot omit a render-phase sample.");
    phaseSamples[arm].push(sample.render);
    if (phaseSamples[arm].length > velocityCostSamples) phaseSamples[arm].shift();
  }
  frames += 1;
  if (velocityEnabled) {
    activeVelocityTargets = Math.max(
      activeVelocityTargets,
      scenePass.renderTarget.textures.filter((texture) => texture.name === "velocity").length,
    );
  } else observeResources();
  // A real one-pixel readback drains the actual draw outside the timed CPU render phase.
  await renderer.readRenderTargetPixelsAsync(scenePass.renderTarget, 0, 0, 1, 1);
}

async function triplet(measured: boolean, index: number): Promise<void> {
  // Rotate the first arm and reverse every other triplet, balancing all six orders.
  const order = [arms[index % 3], arms[(index + 1) % 3], arms[(index + 2) % 3]];
  if (Math.floor(index / 3) % 2 !== 0) order.reverse();
  for (const arm of order) {
    if (arm === undefined) throw new Error("Temporal-off cost arm is missing.");
    await draw(arm, measured);
  }
}
if (new URLSearchParams(location.search).has("from-temporal")) {
  for (let index = 0; index < 3; index += 1) {
    chain.dispose();
    chain = makeChain(true);
    await draw("temporalOff", false);
    await draw("temporalOff", false);
    chain.dispose();
    chain = makeChain(false);
    projection.reconcile();
    observeResources();
    transitions += 1;
  }
}
for (let index = 0; index < 30; index += 1) await triplet(false, index);

function observation() {
  const summaries = {
    baselineA: { ...meters.baselineA.window().phases.render },
    baselineB: { ...meters.baselineB.window().phases.render },
    temporalOff: { ...meters.temporalOff.window().phases.render },
  };
  const ready = cycles >= velocityCostSamples;
  const compared = ready
    ? evaluateTemporalOffCost(
        summaries.baselineA,
        summaries.baselineB,
        summaries.temporalOff,
        clockQuantumMs,
      )
    : undefined;
  return {
    frames,
    cycles,
    velocityTargets,
    historyObjects,
    activeVelocityTargets,
    transitions,
    clockQuantumMs,
    temporalStages: chain.applied.stages.length,
    velocityProvisioned: Number(chain.applied.velocity.provisioned),
    samples: compared?.samples ?? 0,
    p50NoiseExcessMs: compared?.p50.noiseExcessMs ?? 1,
    p50OverheadExcessMs: compared?.p50.overheadExcessMs ?? 1,
    p95NoiseExcessMs: compared?.p95.noiseExcessMs ?? 1,
    p95OverheadExcessMs: compared?.p95.overheadExcessMs ?? 1,
    summaries,
    phaseSamples,
    comparison: compared ?? null,
  };
}
installThreePlaytestBridge({
  camera,
  scene,
  renderer,
  diagnostics: () => [],
  fixedStep: async (ticks) => {
    for (let index = 0; index < ticks; index += 1) {
      await triplet(true, cycles);
      cycles += 1;
    }
    return ticks;
  },
  resources: { read: () => ({ cost: observation() }) },
  tick: () => cycles,
});
