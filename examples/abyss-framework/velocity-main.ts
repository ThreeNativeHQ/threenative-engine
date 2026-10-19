import { abs, float, mix, mrt, pass, step, uv, vec2, vec4 } from "three/tsl";
import {
  BatchedMesh,
  Bone,
  Color,
  DataUtils,
  DirectionalLight,
  DynamicDrawUsage,
  Float32BufferAttribute,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RenderPipeline,
  Scene,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  Uint16BufferAttribute,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { setBatchedMeshPreviousMatrices } from "../../packages/core/src/render/batched-velocity.js";
import {
  ensureVelocityOutput,
  readVelocityPreviousBoneMatrices,
  readVelocityPreviousMatrices,
  readVelocityPreviousWorldMatrix,
} from "../../packages/core/src/render/velocity.js";
import { SceneRenderProjection } from "../../packages/core/src/renderProjection.js";
import { installThreePlaytestBridge } from "../../packages/playtest/dist/three/index.js";
import {
  velocityCoverageNode,
  velocityFixturePositions,
  velocityFixtureRadius,
} from "./src/render/velocityCoverage.js";
import {
  measureMovingColourFootprint,
  summarizeCoveredVelocity,
  summarizeVelocityPixels,
} from "./src/render/velocityReadback.js";

const width = 960;
const height = 540;
const renderer = new WebGPURenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(width, height);
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new Scene();
scene.background = new Color(0x172034);
const camera = new OrthographicCamera(-3, 3, 3.375, -3.375, 0.1, 20);
camera.position.z = 8;
scene.add(new HemisphereLight(0xb8d7ff, 0x263349, 2));
const key = new DirectionalLight(0xffffff, 3);
key.position.set(-2, 4, 5);
scene.add(key);
const geometry = new SphereGeometry(velocityFixtureRadius, 32, 24);
const query = new URLSearchParams(location.search);
const instanced = query.has("instanced");
const dynamic = query.has("dynamic");
const skinned = query.has("skinned");
const aggregateHistory = query.has("aggregate-history");
const currentAsPrevious = query.has("current-as-previous");
const lateWrite = query.has("late-write");
const prematureCommit = query.has("premature-commit");
const recompile = query.has("recompile");
const worldMotion = query.has("world-motion");
const currentWorldHistory = query.has("current-world-history");
const material = new MeshStandardMaterial({ color: 0x69c5ff, roughness: 0.38 });
let mesh: BatchedMesh | InstancedMesh | SkinnedMesh;
if (skinned) {
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4);
  for (let index = 0; index < count; index += 1) weights[index * 4] = 1;
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
  mesh = new SkinnedMesh(geometry, material);
  mesh.position.x = 1.5;
  const bone = new Bone();
  mesh.add(bone);
  mesh.bind(new Skeleton([bone]));
  const still = new Mesh(geometry, material);
  still.position.x = -1.5;
  scene.add(still);
  const wall = new Mesh(new PlaneGeometry(6, 6.75), new MeshBasicMaterial({ color: 0x242424 }));
  wall.position.z = -1;
  scene.add(wall);
} else {
  mesh = instanced
    ? new InstancedMesh(geometry, material, 2)
    : new BatchedMesh(
        2,
        geometry.getAttribute("position").count,
        geometry.getIndex()?.count,
        material,
      );
  if (mesh instanceof BatchedMesh) {
    const shape = mesh.addGeometry(geometry);
    mesh.addInstance(shape);
    mesh.addInstance(shape);
  } else if (dynamic) mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.setMatrixAt(0, new Matrix4().makeTranslation(-1.5, 0, 0));
  mesh.setMatrixAt(1, new Matrix4().makeTranslation(1.5, 0, 0));
}
scene.add(mesh);
// Removes the scheduler, exercising the actual accessor fallback; readbacks are never overridden.
const withoutHistory = query.has("without-history");
const projection = new SceneRenderProjection(scene, {
  projection: false,
  velocity: !withoutHistory,
});
const scenePass = pass(scene, camera);
scenePass.setMRT(
  ensureVelocityOutput(scenePass).merge(mrt({ coverage: velocityCoverageNode(mesh, width) })),
);
scenePass.getTexture("coverage");
const imageUv = vec2(uv().x.mul(2).fract(), uv().y);
const beauty = scenePass.getTextureNode("output").sample(imageUv);
const velocity = scenePass.getTextureNode("velocity").sample(imageUv);
// Left: actual colour. Right: absolute x/y velocity, amplified 20x over a dark blue zero point.
const motion = vec4(
  abs(velocity.x).mul(20).add(0.035),
  abs(velocity.y).mul(20).add(0.045),
  float(0.09),
  1,
);
const pipeline = new RenderPipeline(renderer);
pipeline.outputNode = mix(beauty, motion, step(0.5, uv().x));
let frame = 0;
let firstFrameMax = -1;
let metrics = { staticMax: 0, stationaryMax: 0, movingMax: 0, movingPixels: 0 };
let colourMaxErrorPixels = 0;
let lateWrites = 0;
let recompiles = 0;
let oracleMaxErrorPixels = 0;
let stoppedMax = -1;
let footprintPixels = Number.POSITIVE_INFINITY;
let footprintMaxErrorPixels = 0;
let outsideFootprintMax = 0;
let darkFootprintPixels = Number.POSITIVE_INFINITY;
let currentX = 1.5;
const samples: {
  frame: number;
  expectedX: number;
  actualX: number;
  actualY: number;
  errorPixels: number;
  colourCentroidX: number;
  colourErrorPixels: number;
}[] = [];
// Includes reversals, unequal steps, a stop and a restart. One-frame-old data cannot agree by coincidence.
const positions = velocityFixturePositions;

async function renderFrame() {
  // Three's NodeFrame is driven by RAF; synchronous render loops cannot prove frame history.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const previousX = currentX;
  currentX = positions[frame % positions.length] ?? 1.5;
  if (lateWrite && frame > 0) {
    projection.reconcile();
    lateWrites += 1;
  }
  moveGeometry(currentX);
  if (!lateWrite || frame === 0) projection.reconcile();
  if (prematureCommit && frame > 0) {
    // Original ordering mutation: save the new colour pose before this draw reads previous data.
    projection.commit();
    projection.reconcile();
  }
  mutateHistory();
  if (recompile && frame === 3) {
    renderer.contextNode.needsUpdate = true;
    recompiles += 1;
  }
  if (projection.root !== scene || projection.report.reasonCode !== "disabled")
    throw new Error("Velocity fixture must render the authored, opted-out scene.");
  pipeline.render();
  const target = scenePass.renderTarget;
  const data = await readAttachment("velocity");
  const colour = await readAttachment("output");
  const coverage = await readAttachment("coverage");
  const currentPoint = new Vector3(currentX, 0, 0).project(camera);
  const previousPoint = new Vector3(previousX, 0, 0).project(camera);
  const expectedX = currentPoint.x - previousPoint.x;
  const masked = summarizeCoveredVelocity(
    data,
    colour,
    target.width,
    target.height,
    expectedX,
    coverage,
  );
  footprintPixels = Math.min(footprintPixels, masked.footprintPixels);
  footprintMaxErrorPixels = Math.max(footprintMaxErrorPixels, masked.footprintMaxErrorPixels);
  outsideFootprintMax = Math.max(outsideFootprintMax, masked.outsideFootprintMax);
  darkFootprintPixels = Math.min(darkFootprintPixels, masked.darkFootprintPixels);
  const px = Math.floor((currentPoint.x * 0.5 + 0.5) * target.width);
  const py = Math.floor(target.height / 2);
  const currentMetrics = summarizeVelocityPixels(data, target.width, target.height, {
    left: px - (target.width * 0.8) / 6 - 2,
    right: px + (target.width * 0.8) / 6 + 2,
    top: py - (target.height * 0.8) / 6.75 - 2,
    bottom: py + (target.height * 0.8) / 6.75 + 2,
  });
  metrics = {
    ...currentMetrics,
    staticMax: Math.max(metrics.staticMax, currentMetrics.staticMax),
    stationaryMax: Math.max(metrics.stationaryMax, currentMetrics.stationaryMax),
  };
  if (frame === 0) firstFrameMax = Math.max(metrics.staticMax, metrics.movingMax);
  if (frame === 6) stoppedMax = metrics.movingMax;
  const colourFootprint = measureMovingColourFootprint(colour, target.width, target.height);
  const colourErrorPixels = Math.abs(
    colourFootprint.centroidX - (currentPoint.x * 0.5 + 0.5) * target.width,
  );
  colourMaxErrorPixels = Math.max(colourMaxErrorPixels, colourErrorPixels);
  // Interior of the actually rendered moving sphere. Translation in this orthographic camera
  // has the same velocity at every vertex, so the centre has an independent analytic oracle.
  const offset = (py * target.width + px) * 4;
  const actualX = data[offset];
  const actualY = data[offset + 1];
  if (actualX === undefined || actualY === undefined) throw new Error("Oracle sample is missing.");
  const errorPixels = Math.hypot(
    ((actualX - expectedX) * target.width) / 2,
    (actualY * target.height) / 2,
  );
  oracleMaxErrorPixels = Math.max(oracleMaxErrorPixels, errorPixels);
  samples.push({
    frame: frame + 1,
    expectedX,
    actualX,
    actualY,
    errorPixels,
    colourCentroidX: colourFootprint.centroidX,
    colourErrorPixels,
  });
  projection.commit();
  frame += 1;
}
function moveGeometry(x: number): void {
  if (mesh instanceof SkinnedMesh) {
    const bone = mesh.skeleton.bones[0];
    if (bone === undefined) throw new Error("Fixture bone is missing.");
    if (worldMotion) mesh.position.x = x;
    else bone.position.x = x - 1.5;
  } else {
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(x, 0, 0));
    if (mesh instanceof InstancedMesh) mesh.instanceMatrix.needsUpdate = true;
  }
}

function mutateHistory(): void {
  if (frame === 0) return;
  if (currentWorldHistory) mutateWorldHistory();
  if (aggregateHistory) {
    // Original per-instance mutation: one moving-instance transform is broadcast to both slots.
    const history = readVelocityPreviousMatrices(mesh);
    if (history === undefined)
      throw new Error("Aggregate mutation has no scheduled instance history.");
    history.set(history.slice(16, 32), 0);
    if (mesh instanceof BatchedMesh) setBatchedMeshPreviousMatrices(mesh, history);
  }
  if (currentAsPrevious) {
    if (!(mesh instanceof SkinnedMesh)) throw new Error("Bone mutation requires a skinned mesh.");
    const history = readVelocityPreviousBoneMatrices(mesh);
    if (history === undefined) throw new Error("Bone mutation has no scheduled history.");
    const current = mesh.skeleton.boneMatrices;
    if (current === null) throw new Error("Bone mutation has no current pose.");
    history.set(current);
  }
}

function mutateWorldHistory(): void {
  if (!(mesh instanceof SkinnedMesh) || !worldMotion)
    throw new Error("World-history mutation requires a world-moving skinned mesh.");
  const history = readVelocityPreviousWorldMatrix(mesh);
  if (history === undefined) throw new Error("World mutation has no scheduled history.");
  history.copy(mesh.matrixWorld);
}

async function readAttachment(name: string): Promise<Float32Array> {
  const target = scenePass.renderTarget;
  const index = target.textures.indexOf(scenePass.getTexture(name));
  if (index < 0) throw new Error(`MRT attachment '${name}' is missing.`);
  const raw = await renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    target.width,
    target.height,
    index,
  );
  const data = raw instanceof Uint16Array ? Float32Array.from(raw, DataUtils.fromHalfFloat) : raw;
  if (!(data instanceof Float32Array))
    throw new Error(`MRT attachment '${name}' has an unsupported format.`);
  return data;
}
await renderFrame();
installThreePlaytestBridge({
  camera,
  scene,
  renderer,
  diagnostics: () => [],
  fixedStep: async (ticks) => {
    for (let index = 0; index < ticks; index += 1) await renderFrame();
    return ticks;
  },
  resources: {
    read: () => ({
      motion: {
        ...metrics,
        firstFrameMax,
        frame,
        withoutHistory,
        instanced,
        dynamic,
        geometryKind:
          mesh instanceof SkinnedMesh
            ? "SkinnedMesh"
            : mesh instanceof BatchedMesh
              ? "BatchedMesh"
              : "InstancedMesh",
        skinned,
        aggregateHistory,
        currentAsPrevious,
        lateWrite,
        prematureCommit,
        lateWrites,
        recompile,
        recompiles,
        worldMotion,
        currentWorldHistory,
        footprintPixels,
        footprintMaxErrorPixels,
        outsideFootprintMax,
        darkFootprintPixels,
        colourMaxErrorPixels,
        oracleMaxErrorPixels,
        stoppedMax,
        samples,
      },
    }),
  },
  tick: () => frame,
});
