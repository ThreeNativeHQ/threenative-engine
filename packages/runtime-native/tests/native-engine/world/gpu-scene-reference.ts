/**
 * Records `cullAndSelect` / `cullAndSelectShadow` / `liveKeyInstances` over the `world-gpu-scene` CPU
 * oracle as a C++ table the native port rebuilds and compares bit for bit (PRD-521). Every f32 word
 * is recorded as its 32-bit pattern and every double as its 64-bit pattern, so the comparison is exact.
 *
 * Two scenes are recorded. The first is `world-gpu-scene.spec.ts`'s scripted camera path: two assets,
 * three level gates each, a cull distance on the second, six regions and a 50-pose walk (the first ten
 * poses are kept). The second is a shorter path that crosses the LOD gates, the impostor terminal
 * gates (scaled 0.5x, 1x and 3x), the cull distance and the region capacities in both directions, and
 * adds two shadow-map steps whose base is 0 and the coarsest level. A live-gate case then records the
 * `liveKeyInstances` runs.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/world/gpu-scene-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core module produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Frustum, Matrix4, PerspectiveCamera } from "three";
import { setLodBias } from "../../../../core/src/model-lod.js";

import {
  COARSEST_SHADOW_LEVEL,
  type IGpuPlacement,
  type IKernelInput,
  type ILiveAsset,
  type IRegion,
  cullAndSelect,
  cullAndSelectShadow,
  liveKeyInstances,
} from "../../../../core/src/world-gpu-scene.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "gpu_scene_reference.inc");

const f32bits = (value: number): number =>
  new Uint32Array(new Float32Array([value]).buffer)[0] as number;
const bits64 = (value: number): bigint =>
  new BigUint64Array(new Float64Array([value]).buffer)[0] as bigint;
const u32 = (value: number): string => `0x${(value >>> 0).toString(16).padStart(8, "0")}u`;
const f32 = (value: number): string => u32(f32bits(value));
const u64 = (value: number): string => `0x${bits64(value).toString(16).padStart(16, "0")}ull`;
const f32row = (values: ArrayLike<number>): string => Array.from(values, f32).join(", ");
const f64row = (values: readonly number[]): string => values.map(u64).join(", ");
const u32row = (values: ArrayLike<number>): string => Array.from(values, u32).join(", ");

interface ILevelSpec {
  firstKey: number;
  parts: number;
}
interface ISlotSpec {
  distances: number[];
  cull?: number;
  levels: ILevelSpec[];
  impostor?: boolean;
}
interface IRegionSpec {
  start: number;
  capacity: number;
  argsIndex: number;
  local: Float32Array;
  indexCount: number;
}
interface IPlacementSpec {
  matrix: Float32Array;
  centre: Float32Array;
  slot: number;
  scale: number;
}
interface ICameraSpec {
  planes: Float32Array;
  x: number;
  y: number;
  z: number;
}
interface IShadowSpec {
  planes: Float32Array;
  centreX: number;
  centreZ: number;
  gate: number;
  base: number;
}
interface IStepSpec {
  camera: ICameraSpec;
  shadow?: IShadowSpec;
  /** The adaptive LOD bias during the step (1 when absent); the main pass reads it, shadows never. */
  bias?: number;
}
interface ISceneSpec {
  slots: ISlotSpec[];
  regions: IRegionSpec[];
  placements: IPlacementSpec[];
  steps: IStepSpec[];
}

const LOCAL = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A camera whose frustum every placement in the fixture is inside, as the spec builds it. */
function cameraAt(x: number, z: number): Float32Array {
  const camera = new PerspectiveCamera(60, 1, 0.1, 10_000);
  camera.position.set(x, 0, z);
  camera.lookAt(x, 0, z + 1);
  camera.updateMatrixWorld(true);
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const planes = new Float32Array(24);
  for (const [index, plane] of frustum.planes.entries()) {
    const at = index * 4;
    planes[at] = plane.normal.x;
    planes[at + 1] = plane.normal.y;
    planes[at + 2] = plane.normal.z;
    planes[at + 3] = plane.constant;
  }
  return planes;
}

function placement(
  x: number,
  z: number,
  slot: number,
  radius: number,
  scale: number,
): IPlacementSpec {
  const matrix = new Matrix4().makeTranslation(x, 0, z);
  return {
    centre: new Float32Array([x, 0, z, radius]),
    matrix: new Float32Array(matrix.elements),
    scale,
    slot,
  };
}

/** A region with a part offset of its own, so `placement * local` is never a copy of the placement. */
function regionAt(index: number, start: number, capacity: number): IRegionSpec {
  const local = new Matrix4().makeTranslation((index % 3) * 0.5, (index % 2) * 0.25, index * 0.125);
  return {
    argsIndex: index,
    capacity,
    indexCount: 7 + index,
    local: new Float32Array(local.elements),
    start,
  };
}

/* ---- scene 0: the spec's scripted camera path ---- */

const DISTANCES = [0, 40, 120];
function specScene(): ISceneSpec {
  const slots: ISlotSpec[] = [
    {
      distances: DISTANCES,
      levels: [
        { firstKey: 0, parts: 1 },
        { firstKey: 1, parts: 1 },
        { firstKey: 2, parts: 1 },
      ],
    },
    {
      cull: 260,
      distances: DISTANCES,
      levels: [
        { firstKey: 3, parts: 1 },
        { firstKey: 4, parts: 1 },
        { firstKey: 5, parts: 1 },
      ],
    },
  ];
  const regions: IRegionSpec[] = [];
  let start = 0;
  for (let index = 0; index < 6; index += 1) {
    const region = regionAt(index, start, 4096);
    region.local = LOCAL;
    regions.push(region);
    start += 4096;
  }
  const placements: IPlacementSpec[] = [];
  for (let index = 0; index < 120; index += 1) {
    const x = -200 + (index % 20) * 20;
    const z = -200 + Math.floor(index / 20) * 20;
    placements.push(placement(x, z, index % 8 === 0 ? 1 : 0, 0.5, 1));
  }
  const steps: IStepSpec[] = [];
  for (let pose = 0; pose < 10; pose += 1) {
    const x = -180 + pose * 7;
    const z = -180 + (pose % 11) * 30;
    steps.push({ camera: { planes: cameraAt(x, z), x, y: 0, z } });
  }
  return { placements, regions, slots, steps };
}

/* ---- scene 1: gates, cull, capacities and impostor scales, both ways ---- */

function gateScene(): ISceneSpec {
  const slots: ISlotSpec[] = [
    {
      distances: [0, 30, 90],
      impostor: true,
      levels: [
        { firstKey: 0, parts: 2 },
        { firstKey: 2, parts: 2 },
        { firstKey: 4, parts: 2 },
      ],
    },
    {
      cull: 100,
      distances: [0, 50],
      levels: [
        { firstKey: 6, parts: 1 },
        { firstKey: 7, parts: 1 },
      ],
    },
  ];
  const capacities = [2, 2, 2, 2, 2, 2, 1, 1];
  const regions: IRegionSpec[] = [];
  let start = 0;
  capacities.forEach((capacity, index) => {
    regions.push(regionAt(index, start, capacity));
    start += capacity;
  });
  const rows: [number, number, number, number][] = [
    [0, 20, 0, 1],
    [5, 45, 0, 1],
    [-5, 70, 0, 1],
    [8, 110, 0, 1],
    [0, 150, 0, 0.5],
    [-8, 220, 0, 3],
    [3, 35, 1, 1],
    [-3, 60, 1, 1],
    [6, 95, 1, 1],
    [0, 130, 1, 1],
    [2, 12, 0, 1],
    [-2, 55, 0, 1],
    [4, 85, 1, 1],
    [0, 300, 0, 1],
  ];
  const placements = rows.map(([x, z, slot, scale], index) =>
    placement(x, z, slot, index % 3 === 0 ? 1 : 0.5, scale),
  );
  const steps: IStepSpec[] = [];
  // Forward through the gates, then back: a placement's distance to the eye crosses each switch in
  // both directions.
  const zs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((i) => -40 + i * 25);
  const back = [260, 235];
  for (const z of [...zs, ...back])
    steps.push({ camera: { planes: cameraAt(0, z), x: 0, y: 0, z } });
  // A coarsening bias moves every main-pass switch nearer the eye.
  for (const z of [10, 35, 60, 85])
    steps.push({ bias: 1.75, camera: { planes: cameraAt(0, z), x: 0, y: 0, z } });
  const shadowCamera = cameraAt(0, 80);
  steps.push({
    camera: { planes: shadowCamera, x: 0, y: 0, z: 80 },
    shadow: { base: 0, centreX: 0, centreZ: 80, gate: 0, planes: shadowCamera },
  });
  // The shadow pass selects on the unbiased distance whatever the bias.
  steps.push({
    bias: 1.75,
    camera: { planes: shadowCamera, x: 0, y: 0, z: 80 },
    shadow: { base: 0, centreX: 0, centreZ: 80, gate: 0, planes: shadowCamera },
  });
  steps.push({
    camera: { planes: shadowCamera, x: 0, y: 0, z: 80 },
    shadow: {
      base: COARSEST_SHADOW_LEVEL,
      centreX: 0,
      centreZ: 80,
      gate: 1.5,
      planes: shadowCamera,
    },
  });
  return { placements, regions, slots, steps };
}

/* ---- scene 2: a level the prewarm minted no key for ---- */

// Level 1 of the asset has no parts: a placement past its gate keeps level 0 (`drawableLevel`), and
// a shadow base that names it walks down the same way.
function gapScene(): ISceneSpec {
  const slots: ISlotSpec[] = [
    {
      distances: [0, 20, 60],
      levels: [
        { firstKey: 0, parts: 1 },
        { firstKey: 1, parts: 0 },
        { firstKey: 1, parts: 1 },
      ],
    },
  ];
  const regions = [regionAt(0, 0, 8), regionAt(1, 8, 8)];
  const placements = [10, 30, 45, 80].map((z, index) => placement(index - 2, z, 0, 0.5, 1));
  const camera = cameraAt(0, 0);
  const steps: IStepSpec[] = [{ camera: { planes: camera, x: 0, y: 0, z: 0 } }];
  for (const base of [0, 1, 2])
    steps.push({
      camera: { planes: camera, x: 0, y: 0, z: 0 },
      shadow: { base, centreX: 0, centreZ: 0, gate: 0, planes: camera },
    });
  return { placements, regions, slots, steps };
}

const scenes = [specScene(), gateScene(), gapScene()];

interface IStepResult {
  args: Uint32Array;
  counts: Uint32Array;
  drawn: Float32Array;
}
function runStep(scene: ISceneSpec, step: IStepSpec): IStepResult {
  const input: IKernelInput = {
    camera: { planes: step.camera.planes, x: step.camera.x, y: step.camera.y, z: step.camera.z },
    count: scene.placements.length,
    placements: scene.placements as unknown as readonly IGpuPlacement[],
    regionCount: scene.regions.length,
    regions: scene.regions as unknown as readonly IRegion[],
    slots: scene.slots as unknown as IKernelInput["slots"],
  };
  setLodBias(step.bias ?? 1);
  const result =
    step.shadow === undefined
      ? cullAndSelect(input)
      : cullAndSelectShadow(input, {
          base: step.shadow.base,
          centre: { x: step.shadow.centreX, z: step.shadow.centreZ },
          gate: step.shadow.gate,
          planes: step.shadow.planes,
        });
  setLodBias(1);
  return { args: result.args, counts: result.counts, drawn: result.drawn };
}

/* ---- a live-gate case for `liveKeyInstances` ---- */

function liveCase(): {
  placements: IPlacementSpec[];
  assets: ILiveAsset[];
  camera: ICameraSpec;
  runs: { key: string; words: Float32Array }[];
} {
  const pineParts = [
    new Float32Array(LOCAL),
    new Float32Array(new Matrix4().makeTranslation(0, 3, 0).elements),
  ];
  const pineCoarse = [new Float32Array(new Matrix4().makeTranslation(0, 1.5, 0).elements)];
  const rockParts = [new Float32Array(new Matrix4().makeTranslation(0, 0.5, 0).elements)];
  const assets: ILiveAsset[] = [
    {
      cull: undefined,
      distances: [0, 40],
      id: "pine",
      impostor: true,
      locals: [pineParts, pineCoarse],
    },
    { cull: 70, distances: [0], id: "rock", locals: [rockParts] },
  ];
  const placements = [
    placement(0, 20, 0, 0.5, 1),
    placement(4, 55, 0, 0.5, 2),
    placement(-4, 30, 1, 0.5, 1),
    placement(2, 120, 1, 0.5, 1),
    placement(-2, 15, 0, 0.5, 0.5),
  ];
  const camera: ICameraSpec = { planes: cameraAt(0, 0), x: 0, y: 0, z: 0 };
  const runs = Array.from(
    liveKeyInstances(
      placements as unknown as readonly IGpuPlacement[],
      (slot) => assets[slot],
      camera,
    ),
  );
  return { assets, camera, placements, runs: runs.map(([key, words]) => ({ key, words })) };
}

const live = liveCase();

/* ---- emit the C++ table ---- */

const lines = [
  "// Generated by packages/runtime-native/tests/native-engine/world/gpu-scene-reference.ts from",
  "// packages/core/src/world-gpu-scene.ts. Do not edit: rerun the generator. Every f32 is its 32-bit",
  "// pattern and every double its 64-bit pattern, so the comparison is exact.",
  "",
];

for (const [sceneIndex, scene] of scenes.entries()) {
  const s = `S${sceneIndex}`;
  scene.slots.forEach((slot, slotIndex) => {
    lines.push(
      `static const uint64_t kGpuScene${s}Dist${slotIndex}[] = {${f64row(slot.distances)}};`,
    );
    const levels = slot.levels.map((level) => `{${level.firstKey}u, ${level.parts}u}`).join(", ");
    lines.push(`static const RefLevel kGpuScene${s}Levels${slotIndex}[] = {${levels}};`);
  });
  lines.push(`static const RefSlot kGpuScene${s}Slots[] = {`);
  scene.slots.forEach((slot, slotIndex) => {
    lines.push(
      `    {kGpuScene${s}Dist${slotIndex}, ${slot.distances.length}, ${slot.cull !== undefined}, ` +
        `${u64(slot.cull ?? 0)}, kGpuScene${s}Levels${slotIndex}, ${slot.levels.length}, ${slot.impostor === true}},`,
    );
  });
  lines.push("};", "");
  lines.push(`static const RefPlacement kGpuScene${s}Placements[] = {`);
  for (const one of scene.placements)
    lines.push(
      `    {{${f32row(one.matrix)}}, {${f32row(one.centre)}}, ${one.slot}, ${u64(one.scale)}},`,
    );
  lines.push("};", "");
  lines.push(`static const RefRegion kGpuScene${s}Regions[] = {`);
  for (const one of scene.regions)
    lines.push(
      `    {${one.start}u, ${one.capacity}u, ${one.argsIndex}u, {${f32row(one.local)}}, ${one.indexCount}u},`,
    );
  lines.push("};", "");

  const stepResults = scene.steps.map((step) => runStep(scene, step));
  scene.steps.forEach((step, stepIndex) => {
    const result = stepResults[stepIndex] as IStepResult;
    lines.push(`static const uint32_t kGpuScene${s}Args${stepIndex}[] = {${u32row(result.args)}};`);
    lines.push(
      `static const uint32_t kGpuScene${s}Counts${stepIndex}[] = {${u32row(result.counts)}};`,
    );
    scene.regions.forEach((region, regionIndex) => {
      const count = result.counts[regionIndex] as number;
      if (count === 0) return;
      const words: number[] = [];
      for (let taken = 0; taken < count; taken += 1) {
        const at = (region.start + taken) * 16;
        for (let word = 0; word < 16; word += 1) words.push(result.drawn[at + word] as number);
      }
      lines.push(
        `static const uint32_t kGpuScene${s}Drawn${stepIndex}_${regionIndex}[] = {${f32row(words)}};`,
      );
    });
    lines.push(`static const RefRun kGpuScene${s}Runs${stepIndex}[] = {`);
    scene.regions.forEach((region, regionIndex) => {
      const count = result.counts[regionIndex] as number;
      lines.push(
        `    {${count}u, ${count === 0 ? "nullptr" : `kGpuScene${s}Drawn${stepIndex}_${regionIndex}`}},`,
      );
    });
    lines.push("};", "");
  });

  lines.push(`static const RefStep kGpuScene${s}Steps[] = {`);
  scene.steps.forEach((step, stepIndex) => {
    const camera = `{{${f32row(step.camera.planes)}}, ${u64(step.camera.x)}, ${u64(step.camera.y)}, ${u64(step.camera.z)}}`;
    const shadow =
      step.shadow === undefined
        ? "{0}"
        : `{{${f32row(step.shadow.planes)}}, ${u64(step.shadow.centreX)}, ${u64(step.shadow.centreZ)}, ` +
          `${u64(step.shadow.gate)}, ${step.shadow.base}}`;
    lines.push(
      `    {${camera}, ${step.shadow !== undefined}, ${shadow}, kGpuScene${s}Args${stepIndex}, ` +
        `kGpuScene${s}Counts${stepIndex}, kGpuScene${s}Runs${stepIndex}, ${u64(step.bias ?? 1)}},`,
    );
  });
  lines.push("};", "");
}

lines.push("static const RefScene kGpuSceneScenes[] = {");
for (const [sceneIndex, scene] of scenes.entries()) {
  const s = `S${sceneIndex}`;
  lines.push(
    `    {kGpuScene${s}Placements, std::size(kGpuScene${s}Placements), ${scene.placements.length}u, ` +
      `kGpuScene${s}Slots, std::size(kGpuScene${s}Slots), kGpuScene${s}Regions, ` +
      `std::size(kGpuScene${s}Regions), kGpuScene${s}Steps, std::size(kGpuScene${s}Steps)},`,
  );
}
lines.push("};", "");

live.assets.forEach((asset, assetIndex) => {
  lines.push(
    `static const uint64_t kGpuSceneLiveDist${assetIndex}[] = {${f64row(asset.distances)}};`,
  );
  asset.locals.forEach((parts, levelIndex) => {
    const words = parts.flatMap((part) => Array.from(part));
    lines.push(
      `static const uint32_t kGpuSceneLive${assetIndex}L${levelIndex}[] = {${f32row(words)}};`,
    );
  });
  const levels = asset.locals
    .map((parts, levelIndex) => `{kGpuSceneLive${assetIndex}L${levelIndex}, ${parts.length}}`)
    .join(", ");
  lines.push(`static const RefLiveLevel kGpuSceneLiveLevels${assetIndex}[] = {${levels}};`);
  lines.push(
    `static const RefLiveAsset kGpuSceneLiveAsset${assetIndex} = {"${asset.id}", ` +
      `kGpuSceneLiveDist${assetIndex}, ${asset.distances.length}, ${asset.cull !== undefined}, ` +
      `${u64(asset.cull ?? 0)}, ${asset.impostor === true}, kGpuSceneLiveLevels${assetIndex}, ` +
      `${asset.locals.length}};`,
  );
});
lines.push("static const RefLiveAsset kGpuSceneLiveAssets[] = {");
live.assets.forEach((asset, assetIndex) => {
  lines.push(`    kGpuSceneLiveAsset${assetIndex},`);
});
lines.push("};", "");

lines.push("static const RefPlacement kGpuSceneLivePlacements[] = {");
for (const one of live.placements)
  lines.push(
    `    {{${f32row(one.matrix)}}, {${f32row(one.centre)}}, ${one.slot}, ${u64(one.scale)}},`,
  );
lines.push("};", "");
live.runs.forEach((run, runIndex) => {
  lines.push(`static const uint32_t kGpuSceneLiveWords${runIndex}[] = {${f32row(run.words)}};`);
});
lines.push("static const RefLiveRun kGpuSceneLiveRuns[] = {");
live.runs.forEach((run, runIndex) => {
  lines.push(`    {"${run.key}", kGpuSceneLiveWords${runIndex}, ${run.words.length}},`);
});
lines.push("};", "");
lines.push(
  `static const RefLiveCase kGpuSceneLive = {kGpuSceneLivePlacements, std::size(kGpuSceneLivePlacements), kGpuSceneLiveAssets, std::size(kGpuSceneLiveAssets), {{${f32row(live.camera.planes)}}, ${u64(live.camera.x)}, ${u64(live.camera.y)}, ${u64(live.camera.z)}}, kGpuSceneLiveRuns, std::size(kGpuSceneLiveRuns)};`,
  "",
);

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error("TN_FIXTURE_STALE: gpu_scene_reference.inc is not what the core module produces");
    process.exit(1);
  }
  console.log("current: gpu_scene_reference.inc");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
