/**
 * Records the discrete-LOD selection functions and the scripted per-frame decisions of
 * packages/core/src/model-lod.ts as a C++ table the native test compares against bit for bit
 * (PRD-519). Every float is recorded as its binary64 bit pattern, so the comparison is exact.
 *
 * The pure functions (lodPixelScale, projectedLodError, conservativeViewDepth, worldSphere and the
 * bias) run over deterministic argument sets, including the cases that throw: a refusal is
 * classified into the named native code it maps to. selectLodLevel runs over constructed chains,
 * budgets, hysteresis and views, and a scripted camera path approaches and recedes across switch
 * distances so hysteresis keeps a level on the way back and a bias moves the switches.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/lod/model-lod-reference.ts
 *   ... -- --check   (fails when the committed table is not what model-lod.ts produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Camera, Object3D, OrthographicCamera, PerspectiveCamera, Sphere, Vector3 } from "three";
import {
  type ILodView,
  biasedLodDistance,
  conservativeViewDepth,
  lodBias,
  lodPixelScale,
  projectedLodError,
  selectLodLevel,
  setLodBias,
  worldSphere,
} from "../../../../core/src/model-lod.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "model_lod_reference.inc");

const f64 = (x: number) => {
  const words = new Uint32Array(new Float64Array([x]).buffer);
  return (BigInt(words[1] as number) << 32n) | BigInt(words[0] as number);
};
const hex64 = (bits: bigint) => `0x${bits.toString(16).padStart(16, "0")}ull`;
const bits = (x: number) => hex64(f64(x));

/* ---- outcomes: a reference throw is classified into the named native refusal ---- */
const OK = 0;
const VIEWPORT = 1;
const ORTHO = 2;
const CAMERA = 3;

function outcomeOf(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("positive viewport height")) return VIEWPORT;
  if (message.includes("orthographic")) return ORTHO;
  if (message.includes("perspective camera")) return CAMERA;
  throw new Error(`unclassified refusal: ${message}`);
}

/* ---- camera specs, reconstructable in C++ ---- */
interface ICamSpec {
  kind: number; // 0 perspective, 1 orthographic, 2 plain Camera
  fov: number;
  top: number;
  bottom: number;
  zoom: number;
}
const persp = (fov: number, zoom = 1): ICamSpec => ({ kind: 0, fov, top: 0, bottom: 0, zoom });
const ortho = (top: number, bottom: number, zoom = 1): ICamSpec => ({
  kind: 1,
  fov: 0,
  top,
  bottom,
  zoom,
});
const base: ICamSpec = { kind: 2, fov: 0, top: 0, bottom: 0, zoom: 0 };

function makeCamera(spec: ICamSpec): Camera {
  if (spec.kind === 0) {
    const camera = new PerspectiveCamera(spec.fov, 1, 0.1, 1000);
    camera.zoom = spec.zoom;
    camera.updateMatrixWorld(true);
    return camera;
  }
  if (spec.kind === 1) {
    const camera = new OrthographicCamera(-1, 1, spec.top, spec.bottom, 0.1, 100);
    camera.zoom = spec.zoom;
    camera.updateMatrixWorld(true);
    return camera;
  }
  return new Camera();
}

/* ---- lodPixelScale ---- */
interface IPixelScaleRec {
  spec: ICamSpec;
  viewportHeight: number;
  depth: number;
  outcome: number;
  value: number;
}
const pixelCases: IPixelScaleRec[] = [];
function pushPixel(spec: ICamSpec, viewportHeight: number, depth: number): void {
  let outcome = OK;
  let value = 0;
  try {
    value = lodPixelScale(makeCamera(spec), viewportHeight, depth);
  } catch (error) {
    outcome = outcomeOf(error);
  }
  pixelCases.push({ depth, outcome, spec, value, viewportHeight });
}

{
  const FOVS = [60, 30, 89.999, 1.5, 179];
  const ZOOMS = [1, 2, 0.5, 3.25];
  for (const fov of FOVS) for (const zoom of ZOOMS) pushPixel(persp(fov, zoom), 1080, 10);
  for (const viewport of [1, 720, 2160, 0, -5, Number.NaN]) pushPixel(persp(60), viewport, 10);
  for (const depth of [0, -3, 1e-6, 1000, 1e6, Number.POSITIVE_INFINITY, Number.NaN])
    pushPixel(persp(60), 1080, depth);
  const TOPS = [10, 1, 0.5, -1, 0, Number.NaN];
  const BOTTOMS = [-10, -1, -0.5, 2, 0, Number.NaN];
  for (let i = 0; i < TOPS.length; i += 1)
    for (const zoom of [1, 2])
      pushPixel(ortho(TOPS[i] as number, BOTTOMS[i] as number, zoom), 1080, 10);
  for (const viewport of [1, 0, -5, Number.NaN]) pushPixel(ortho(10, -10, 2), viewport, 10);
  for (const depth of [0, 100, Number.NaN, Number.POSITIVE_INFINITY])
    pushPixel(ortho(10, -10), 1080, depth);
  for (const viewport of [1080, 0]) for (const depth of [10, 0]) pushPixel(base, viewport, depth);
}

/* ---- projectedLodError ---- */
interface IErrorRec {
  worldError: number;
  spec: ICamSpec;
  viewportHeight: number;
  depth: number;
  outcome: number;
  value: number;
}
const errorCases: IErrorRec[] = [];
function pushError(
  worldError: number,
  spec: ICamSpec,
  viewportHeight: number,
  depth: number,
): void {
  let outcome = OK;
  let value = 0;
  try {
    value = projectedLodError(worldError, makeCamera(spec), viewportHeight, depth);
  } catch (error) {
    outcome = outcomeOf(error);
  }
  errorCases.push({ depth, outcome, spec, value, viewportHeight, worldError });
}

for (const worldError of [0, -1, -0.5, Number.NaN, 0.02, 0.5, 3.25]) {
  for (const depth of [1, 10, 100]) pushError(worldError, persp(60), 1080, depth);
  pushError(worldError, ortho(20, -20), 1080, depthOf(10));
  pushError(worldError, base, 1080, 10);
}
for (const viewport of [1, 0, -5, Number.NaN]) pushError(0.02, persp(60), viewport, 10);
for (const depth of [0, -3, Number.NaN, Number.POSITIVE_INFINITY])
  pushError(0.02, persp(60), 1080, depth);

function depthOf(value: number): number {
  return value;
}

/* ---- conservativeViewDepth ---- */
interface IDepthRec {
  camX: number;
  camY: number;
  camZ: number;
  nearPlane: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  expectedDepth: number;
  expectedDegenerate: boolean;
}
const depthCases: IDepthRec[] = [];
{
  const CAMERAS: [number, number, number, number][] = [
    [0, 0, 10, 0.1],
    [0, 0, 1, 0.1],
    [3.5, -2.25, 40, 0.5],
    [0, 0, 100, 0.1],
    [0, 0, 0, 0],
    [-1, 2, -3.5, 1],
  ];
  const SPHERES: [number, number, number, number][] = [
    [0, 0, 0, 2],
    [0, 0, 0, 5],
    [1.5, -0.5, 2.25, 0.75],
    [0, 0, -100, 10],
    [0, 0, 0, 0],
    [0, 0, 0, Number.NaN],
  ];
  for (const [camX, camY, camZ, nearPlane] of CAMERAS) {
    for (const [centerX, centerY, centerZ, radius] of SPHERES) {
      const camera = new PerspectiveCamera(60, 1, nearPlane, 5000);
      camera.position.set(camX, camY, camZ);
      camera.updateMatrixWorld(true);
      const { depth, degenerate } = conservativeViewDepth(
        camera,
        new Vector3(centerX, centerY, centerZ),
        radius,
        nearPlane,
      );
      depthCases.push({
        camX,
        camY,
        camZ,
        centerX,
        centerY,
        centerZ,
        expectedDegenerate: degenerate,
        expectedDepth: depth,
        nearPlane,
        radius,
      });
    }
  }
}

/* ---- worldSphere ---- */
interface ISphereRec {
  localX: number;
  localY: number;
  localZ: number;
  localRadius: number;
  posX: number;
  posY: number;
  posZ: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
}
const sphereCases: ISphereRec[] = [];
{
  const LOCALS: [number, number, number, number][] = [
    [0, 0, 0, 1],
    [0.5, -0.25, 0.75, 1.25],
    [-3, 2, -1, 0.5],
    [0, 0, 0, 0],
  ];
  const OBJECTS: [number, number, number, number, number, number][] = [
    [0, 0, 0, 1, 1, 1],
    [5, 0, 0, 2, 2, 2],
    [0, 0, 0, 1.5, 0.5, 3],
    [-2, 4, -6, 0.25, 4, 1],
    [1, 2, 3, -1, 2, 1],
  ];
  for (const [localX, localY, localZ, localRadius] of LOCALS) {
    for (const [posX, posY, posZ, scaleX, scaleY, scaleZ] of OBJECTS) {
      const object = new Object3D();
      object.position.set(posX, posY, posZ);
      object.scale.set(scaleX, scaleY, scaleZ);
      object.updateMatrixWorld(true);
      const world = worldSphere(
        new Sphere(new Vector3(localX, localY, localZ), localRadius),
        object,
      );
      sphereCases.push({
        centerX: world.center.x,
        centerY: world.center.y,
        centerZ: world.center.z,
        localRadius,
        localX,
        localY,
        localZ,
        posX,
        posY,
        posZ,
        radius: world.radius,
        scaleX,
        scaleY,
        scaleZ,
      });
    }
  }
}

/* ---- bias ---- */
interface IBiasRec {
  bias: number;
  distance: number;
  expectedBias: number;
  expectedDistance: number;
}
const biasCases: IBiasRec[] = [];
for (const bias of [
  1,
  2,
  1.5,
  0.5,
  0.999,
  0,
  -3,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  -Number.NEGATIVE_INFINITY,
]) {
  setLodBias(bias);
  const expectedBias = lodBias();
  for (const distance of [0, 1, 10.5, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    biasCases.push({ bias, distance, expectedBias, expectedDistance: biasedLodDistance(distance) });
  }
}
setLodBias(1);

/* ---- selectLodLevel ---- */
interface IViewSpec {
  spec: ICamSpec;
  viewportHeight: number;
  depth: number;
  degenerate: boolean;
  finest: boolean;
}
interface ISelectRec {
  errors: number[];
  current: number;
  budgetPixels: number;
  hysteresis: number;
  views: IViewSpec[];
  outcome: number;
  expected: number;
}
const selectCases: ISelectRec[] = [];
function pushSelect(
  errors: number[],
  current: number,
  budgetPixels: number,
  hysteresis: number,
  views: IViewSpec[],
): void {
  const built: ILodView[] = views.map((view) => ({
    camera: makeCamera(view.spec),
    degenerate: view.degenerate,
    depth: view.depth,
    finest: view.finest,
    viewportHeight: view.viewportHeight,
  }));
  let outcome = OK;
  let expected = 0;
  try {
    expected = selectLodLevel(errors, current, budgetPixels, hysteresis, built);
  } catch (error) {
    outcome = outcomeOf(error);
  }
  selectCases.push({ budgetPixels, current, errors, expected, hysteresis, outcome, views });
}
const pView = (depth: number, extra: Partial<IViewSpec> = {}): IViewSpec => ({
  degenerate: false,
  depth,
  finest: false,
  spec: persp(60),
  viewportHeight: 1080,
  ...extra,
});
const oView = (depth: number, extra: Partial<IViewSpec> = {}): IViewSpec => ({
  degenerate: false,
  depth,
  finest: false,
  spec: ortho(20, -20),
  viewportHeight: 1080,
  ...extra,
});

{
  const LEVELS = [0, 0.005, 0.02];
  const MARGINAL = [0, 0.0095, 0.02];
  const ZERO = [0, 0, 0.02];
  const LONG = [0, 0.05, 0.2, 1];
  pushSelect([], 2, 1, 0.15, [pView(10)]);
  pushSelect(LEVELS, 2, 0, 0.15, [pView(10)]);
  pushSelect(LEVELS, 2, 1, 0.15, []);
  pushSelect(LEVELS, 0, 1, 0.15, [pView(10)]);
  pushSelect(MARGINAL, 0, 1, 0.15, [pView(10)]);
  pushSelect(MARGINAL, 0, 1, 0, [pView(10)]);
  pushSelect(LEVELS, 2, 1, 0.15, [pView(10)]);
  pushSelect(LEVELS, 1, 1, 0.15, [pView(10), pView(2)]);
  pushSelect(LEVELS, 2, 1, 0.15, [pView(0, { degenerate: true })]);
  pushSelect(LEVELS, 0, 1, 0.15, [pView(10, { finest: true })]);
  pushSelect(ZERO, 0, 1, 0.15, [pView(10)]);
  pushSelect(LONG, 2, 1, 0.15, [pView(5)]);
  pushSelect(LEVELS, 0, 1, 0.15, [oView(1)]);
  pushSelect(LEVELS, 0, 1, 0.15, [oView(100)]);
  pushSelect(LEVELS, 0, 1, 0.15, [pView(10, { viewportHeight: 0 })]);
  pushSelect(LEVELS, 0, 1, 0.15, [oView(10, { spec: ortho(1, 2) })]);
  pushSelect(LEVELS, 0, 1, 0.15, [pView(10, { spec: base })]);
  pushSelect(LEVELS, 0, 1, 0.15, [pView(10), pView(10, { degenerate: true })]);
  pushSelect(LEVELS, 1, 1, 0.15, [pView(10), oView(3)]);
  // Systematic sweep: levels, currents, budgets, hysteresis and depths.
  for (const errors of [LEVELS, MARGINAL, ZERO, LONG]) {
    for (const current of [0, 2]) {
      for (const hysteresis of [0.15, 0]) {
        for (const depth of [2, 10, 40, 300]) {
          pushSelect(errors, current, 1, hysteresis, [pView(depth)]);
        }
      }
    }
  }
}

/* ---- scripted discrete decisions: approach and recede across switch distances ---- */
interface IPathRec {
  bias: number;
  errors: number[];
  budgetPixels: number;
  hysteresis: number;
  local: [number, number, number, number];
  position: [number, number, number];
  scale: [number, number, number];
  fov: number;
  nearPlane: number;
  viewportHeight: number;
  cameraZ: number[];
  levels: number[];
}
const pathCases: IPathRec[] = [];
function recordPath(
  bias: number,
  errors: number[],
  budgetPixels: number,
  hysteresis: number,
  local: [number, number, number, number],
  position: [number, number, number],
  scale: [number, number, number],
  fov: number,
  nearPlane: number,
  viewportHeight: number,
  cameraZ: number[],
): void {
  setLodBias(bias);
  const camera = new PerspectiveCamera(fov, 1, nearPlane, 5000);
  const object = new Object3D();
  object.position.set(position[0], position[1], position[2]);
  object.scale.set(scale[0], scale[1], scale[2]);
  object.updateMatrixWorld(true);
  const localSphere = new Sphere(new Vector3(local[0], local[1], local[2]), local[3]);
  let current = 0;
  const levels: number[] = [];
  for (const z of cameraZ) {
    camera.position.set(0, 0, z);
    camera.updateMatrixWorld(true);
    const world = worldSphere(localSphere, object);
    const { depth, degenerate } = conservativeViewDepth(
      camera,
      world.center,
      world.radius,
      camera.near ?? 0,
    );
    const view: ILodView = {
      camera,
      degenerate,
      depth: biasedLodDistance(depth),
      viewportHeight,
    };
    current = selectLodLevel(errors, current, budgetPixels, hysteresis, [view]);
    levels.push(current);
  }
  pathCases.push({
    bias,
    budgetPixels,
    cameraZ,
    errors,
    fov,
    hysteresis,
    levels,
    local,
    nearPlane,
    position,
    scale,
    viewportHeight,
  });
}

{
  const SWITCHES = [0, 0.02, 0.08, 0.3, 1.2];
  const LOCAL: [number, number, number, number] = [0.5, -0.25, 0.75, 1.25];
  const POSITION: [number, number, number] = [0, 0, -3];
  const SCALE: [number, number, number] = [1.5, 1.5, 1.5];
  const approach: number[] = [];
  for (let i = 0; i <= 60; i += 1) approach.push(300 - i * 4.7);
  const recede: number[] = [];
  for (let i = 1; i <= 60; i += 1) recede.push(18 + i * 4.7);
  const sweep = [...approach, ...recede];
  recordPath(1, SWITCHES, 2, 0.15, LOCAL, POSITION, SCALE, 60, 0.1, 1080, sweep);
  recordPath(2, SWITCHES, 2, 0.15, LOCAL, POSITION, SCALE, 60, 0.1, 1080, sweep);
  recordPath(1, SWITCHES, 2, 0.5, LOCAL, POSITION, SCALE, 60, 0.1, 1080, sweep);
  const near: number[] = [];
  for (let i = 0; i <= 20; i += 1) near.push(20 - i * 1);
  for (let i = 1; i <= 20; i += 1) near.push(0 + i * 1);
  recordPath(1, SWITCHES, 2, 0.15, LOCAL, POSITION, SCALE, 60, 0.1, 1080, near);
}
setLodBias(1);

/* ---- emit ---- */
const lines: string[] = [
  "// Generated by packages/runtime-native/tests/native-engine/lod/model-lod-reference.ts from",
  "// packages/core/src/model-lod.ts. Do not edit: rerun the generator. Floats are binary64 bit",
  "// patterns; a refusal is 0 ok, 1 TN_LOD_VIEWPORT, 2 TN_LOD_ORTHO, 3 TN_LOD_CAMERA. Camera kind:",
  "// 0 perspective, 1 orthographic, 2 plain Camera.",
  "",
];

lines.push("static const PixelScaleCase kPixelScaleCases[] = {");
for (const c of pixelCases)
  lines.push(
    `    {${c.spec.kind}, ${bits(c.spec.fov)}, ${bits(c.spec.top)}, ${bits(c.spec.bottom)}, ${bits(c.spec.zoom)}, ${bits(c.viewportHeight)}, ${bits(c.depth)}, ${c.outcome}, ${bits(c.value)}},`,
  );
lines.push("};", "");

lines.push("static const ErrorCase kErrorCases[] = {");
for (const c of errorCases)
  lines.push(
    `    {${bits(c.worldError)}, ${c.spec.kind}, ${bits(c.spec.fov)}, ${bits(c.spec.top)}, ${bits(c.spec.bottom)}, ${bits(c.spec.zoom)}, ${bits(c.viewportHeight)}, ${bits(c.depth)}, ${c.outcome}, ${bits(c.value)}},`,
  );
lines.push("};", "");

lines.push("static const DepthCase kDepthCases[] = {");
for (const c of depthCases)
  lines.push(
    `    {${bits(c.camX)}, ${bits(c.camY)}, ${bits(c.camZ)}, ${bits(c.nearPlane)}, ${bits(c.centerX)}, ${bits(c.centerY)}, ${bits(c.centerZ)}, ${bits(c.radius)}, ${bits(c.expectedDepth)}, ${c.expectedDegenerate ? "true" : "false"}},`,
  );
lines.push("};", "");

lines.push("static const SphereCase kSphereCases[] = {");
for (const c of sphereCases)
  lines.push(
    `    {${bits(c.localX)}, ${bits(c.localY)}, ${bits(c.localZ)}, ${bits(c.localRadius)}, ${bits(c.posX)}, ${bits(c.posY)}, ${bits(c.posZ)}, ${bits(c.scaleX)}, ${bits(c.scaleY)}, ${bits(c.scaleZ)}, ${bits(c.centerX)}, ${bits(c.centerY)}, ${bits(c.centerZ)}, ${bits(c.radius)}},`,
  );
lines.push("};", "");

lines.push("static const BiasCase kBiasCases[] = {");
for (const c of biasCases)
  lines.push(
    `    {${bits(c.bias)}, ${bits(c.distance)}, ${bits(c.expectedBias)}, ${bits(c.expectedDistance)}},`,
  );
lines.push("};", "");

for (const [i, c] of selectCases.entries()) {
  lines.push(
    `static const uint64_t kSelectErrors${i}[] = {${
      c.errors.length === 0 ? "0ull" : c.errors.map((value) => bits(value)).join(", ")
    }};`,
    `static const SelectViewRow kSelectViews${i}[] = {${
      c.views.length === 0
        ? "{2, 0ull, 0ull, 0ull, 0ull, 0ull, 0ull, false, false}"
        : c.views
            .map(
              (view) =>
                `{${view.spec.kind}, ${bits(view.spec.fov)}, ${bits(view.spec.top)}, ${bits(view.spec.bottom)}, ${bits(view.spec.zoom)}, ${bits(view.viewportHeight)}, ${bits(view.depth)}, ${view.degenerate ? "true" : "false"}, ${view.finest ? "true" : "false"}}`,
            )
            .join(", ")
    }};`,
  );
}
lines.push("static const SelectCase kSelectCases[] = {");
for (const [i, c] of selectCases.entries())
  lines.push(
    `    {kSelectErrors${i}, ${c.errors.length === 0 ? 0 : c.errors.length}, ${c.current}, ${bits(c.budgetPixels)}, ${bits(c.hysteresis)}, kSelectViews${i}, ${c.views.length}, ${c.outcome}, ${c.expected}},`,
  );
lines.push("};", "");

for (const [i, c] of pathCases.entries()) {
  lines.push(
    `static const uint64_t kPathErrors${i}[] = {${c.errors.map((value) => bits(value)).join(", ")}};`,
    `static const uint64_t kPathLocal${i}[4] = {${c.local.map((value) => bits(value)).join(", ")}};`,
    `static const uint64_t kPathPosition${i}[3] = {${c.position.map((value) => bits(value)).join(", ")}};`,
    `static const uint64_t kPathScale${i}[3] = {${c.scale.map((value) => bits(value)).join(", ")}};`,
    `static const uint64_t kPathCameraZ${i}[] = {${c.cameraZ.map((value) => bits(value)).join(", ")}};`,
    `static const int kPathLevels${i}[] = {${c.levels.join(", ")}};`,
  );
}
lines.push("static const LodPathCase kPathCases[] = {");
for (const [i, c] of pathCases.entries())
  lines.push(
    `    {${bits(c.bias)}, ${bits(c.budgetPixels)}, ${bits(c.hysteresis)}, ${bits(c.fov)}, ${bits(c.nearPlane)}, ${bits(c.viewportHeight)}, kPathErrors${i}, ${c.errors.length}, kPathLocal${i}, kPathPosition${i}, kPathScale${i}, kPathCameraZ${i}, ${c.cameraZ.length}, kPathLevels${i}},`,
  );
lines.push("};", "");

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error("TN_FIXTURE_STALE: model_lod_reference.inc is not what model-lod.ts produces");
    process.exit(1);
  }
  console.log("current: model_lod_reference.inc");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
