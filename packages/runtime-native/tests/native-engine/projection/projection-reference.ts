/**
 * Records what the real `SceneRenderProjection` (packages/core/src/renderProjection.ts) decides for a
 * set of described scenes, as the JSON the native projection planner's test replays (PRD-519 phase 1,
 * PRD-518 phase 2): whether the frame projects or why not, and per lane how many objects batched,
 * how many batches of each kind it built, and every exact object's reason.
 *
 * A scene is a description both sides build: shared geometries and materials by id (batching keys on
 * object identity), meshes, skinned rigs, instanced meshes, lights and groups, with the transforms and
 * flags the eligibility rules read. Each scene is reconciled once, fresh, as the spec's cases are.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/projection/projection-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core module decides today)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as three from "three";
import { SceneRenderProjection } from "../../../../core/src/renderProjection.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "projection_reference.json");

export interface IGeometrySpec {
  id: string;
  kind: "box" | "sphere";
  /** A morph target on position: the geometry carries morph attributes. */
  morph?: boolean;
  /** skinIndex/skinWeight attributes for a rig. */
  skinned?: boolean;
  /** Drop the normal attribute. */
  noNormal?: boolean;
}
export interface IMaterialSpec {
  id: string;
  type: "MeshBasicMaterial" | "MeshLambertMaterial" | "MeshPhongMaterial" | "MeshStandardMaterial";
  color?: number;
  roughness?: number;
  transparent?: boolean;
}
export interface IObjectSpec {
  kind: "mesh" | "skinned" | "instanced" | "light" | "group";
  geometry?: string;
  material?: string;
  bones?: number;
  count?: number;
  position?: [number, number, number];
  scale?: [number, number, number];
  renderOrder?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** An onBeforeRender of the game's own. */
  hook?: boolean;
  /** How many identical copies of this object to add. */
  repeat?: number;
  children?: IObjectSpec[];
}
export interface ISceneSpec {
  name: string;
  minMeshes?: number;
  geometries: IGeometrySpec[];
  materials: IMaterialSpec[];
  objects: IObjectSpec[];
}

function geometryOf(spec: IGeometrySpec): three.BufferGeometry {
  const geometry =
    spec.kind === "box" ? new three.BoxGeometry() : new three.SphereGeometry(0.5, 8, 6);
  const count = geometry.attributes.position.count;
  if (spec.morph) geometry.morphAttributes.position = [geometry.attributes.position.clone()];
  if (spec.skinned) {
    geometry.setAttribute(
      "skinIndex",
      new three.Uint16BufferAttribute(new Uint16Array(count * 4), 4),
    );
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) weights[i * 4] = 1;
    geometry.setAttribute("skinWeight", new three.Float32BufferAttribute(weights, 4));
  }
  if (spec.noNormal) geometry.deleteAttribute("normal");
  return geometry;
}

function materialOf(spec: IMaterialSpec): three.Material {
  const Material = three[spec.type];
  const material = new Material();
  if (spec.color !== undefined) (material as three.MeshStandardMaterial).color.setHex(spec.color);
  if (spec.roughness !== undefined)
    (material as three.MeshStandardMaterial).roughness = spec.roughness;
  if (spec.transparent !== undefined) material.transparent = spec.transparent;
  return material;
}

function build(
  spec: IObjectSpec,
  geometries: Map<string, three.BufferGeometry>,
  materials: Map<string, three.Material>,
): three.Object3D {
  let object: three.Object3D;
  const geometry = spec.geometry ? geometries.get(spec.geometry) : undefined;
  const material = spec.material ? materials.get(spec.material) : undefined;
  if (spec.kind === "mesh") object = new three.Mesh(geometry, material);
  else if (spec.kind === "instanced")
    object = new three.InstancedMesh(geometry, material, spec.count ?? 4);
  else if (spec.kind === "light") object = new three.DirectionalLight(0xffffff, 1);
  else if (spec.kind === "group") object = new three.Group();
  else {
    const rig = new three.SkinnedMesh(geometry, material);
    const bones: three.Bone[] = [];
    for (let i = 0; i < (spec.bones ?? 2); i += 1) {
      const bone = new three.Bone();
      bone.position.y = i === 0 ? 0 : 0.5;
      (i === 0 ? rig : (bones[i - 1] as three.Bone)).add(bone);
      bones.push(bone);
    }
    rig.bind(new three.Skeleton(bones));
    object = rig;
  }
  if (spec.position) object.position.set(...spec.position);
  if (spec.scale) object.scale.set(...spec.scale);
  if (spec.renderOrder !== undefined) object.renderOrder = spec.renderOrder;
  if (spec.castShadow !== undefined) object.castShadow = spec.castShadow;
  if (spec.receiveShadow !== undefined) object.receiveShadow = spec.receiveShadow;
  if (spec.hook) object.onBeforeRender = () => {};
  for (const child of spec.children ?? [])
    for (let i = 0; i < (child.repeat ?? 1); i += 1)
      object.add(build(child, geometries, materials));
  return object;
}

/** Runs one described scene through a fresh projection and keeps the report's decisions. */
function decide(spec: ISceneSpec): Record<string, unknown> {
  const geometries = new Map(spec.geometries.map((g) => [g.id, geometryOf(g)]));
  const materials = new Map(spec.materials.map((m) => [m.id, materialOf(m)]));
  const scene = new three.Scene();
  for (const object of spec.objects)
    for (let i = 0; i < (object.repeat ?? 1); i += 1)
      scene.add(build(object, geometries, materials));
  scene.updateMatrixWorld(true);
  const projection = new SceneRenderProjection(
    scene,
    spec.minMeshes === undefined ? {} : { minMeshes: spec.minMeshes },
  );
  projection.reconcile();
  const r = projection.report;
  const exact = Object.fromEntries(Object.entries(r.exact).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    projecting: r.projecting,
    reasonCode: r.reasonCode,
    sourceRenderables: r.sourceRenderables,
    projectedObjects: r.projectedObjects,
    instancedBatches: r.instancedBatches,
    materialBatches: r.materialBatches,
    skinnedBatches: r.skinnedBatches,
    exactObjects: r.exactObjects,
    exact,
  };
}

// --------------------------------------------------------------------------------- the scenes

const box = (id = "box", extra: Partial<IGeometrySpec> = {}): IGeometrySpec => ({
  id,
  kind: "box",
  ...extra,
});
const std = (id = "std", extra: Partial<IMaterialSpec> = {}): IMaterialSpec => ({
  id,
  type: "MeshStandardMaterial",
  ...extra,
});
const props = (count: number, extra: Partial<IObjectSpec> = {}): IObjectSpec => ({
  kind: "mesh",
  geometry: "box",
  material: "std",
  repeat: count,
  ...extra,
});
const rigs = (count: number, extra: Partial<IObjectSpec> = {}): IObjectSpec => ({
  kind: "skinned",
  geometry: "rig",
  material: "skin",
  bones: 4,
  repeat: count,
  ...extra,
});
const crowdAssets = {
  geometries: [box(), box("rig", { skinned: true })],
  materials: [std(), std("skin")],
};

export const SCENES: ISceneSpec[] = [
  { name: "props-300", ...crowdAssets, objects: [props(300)] },
  { name: "props-below-floor", ...crowdAssets, objects: [props(150)] },
  { name: "props-floor-exact", ...crowdAssets, minMeshes: 50, objects: [props(50)] },
  { name: "props-with-hook", ...crowdAssets, objects: [props(299), props(1, { hook: true })] },
  { name: "crowd-8", ...crowdAssets, objects: [rigs(8)] },
  { name: "crowd-8-props", ...crowdAssets, objects: [rigs(8), props(300)] },
  {
    name: "crowd-8-bad-scales",
    ...crowdAssets,
    objects: [rigs(1, { scale: [1, 2, 1] }), rigs(1, { scale: [-1, 1, 1] }), rigs(6)],
  },
  { name: "crowd-3-props", ...crowdAssets, objects: [rigs(3), props(300)] },
  {
    name: "crowd-transparent",
    geometries: crowdAssets.geometries,
    materials: [std(), std("skin", { transparent: true })],
    objects: [rigs(8), props(300)],
  },
  {
    name: "crowd-no-normal",
    geometries: [box(), box("rig", { skinned: true, noNormal: true })],
    materials: crowdAssets.materials,
    objects: [rigs(8), props(300)],
  },
  {
    name: "crowd-two-bone-counts",
    ...crowdAssets,
    objects: [rigs(5, { bones: 4 }), rigs(5, { bones: 6 }), props(300)],
  },
  {
    name: "props-render-order",
    ...crowdAssets,
    objects: [props(290), props(10, { renderOrder: 2 })],
  },
  {
    name: "props-transparent",
    geometries: [box()],
    materials: [std(), std("glass", { transparent: true })],
    objects: [props(290), props(10, { material: "glass" })],
  },
  {
    name: "props-morph",
    geometries: [box(), box("morphed", { morph: true })],
    materials: [std()],
    objects: [props(290), props(10, { geometry: "morphed" })],
  },
  {
    name: "props-and-instanced",
    ...crowdAssets,
    objects: [
      props(290),
      { kind: "instanced", geometry: "box", material: "std", count: 16, repeat: 3 },
    ],
  },
  {
    name: "props-shadow-flags",
    ...crowdAssets,
    objects: [props(150), props(150, { castShadow: true }), props(3, { receiveShadow: true })],
  },
  {
    name: "uniform-colors",
    geometries: [box()],
    materials: [
      std("a", { color: 0xff0000 }),
      std("b", { color: 0x00ff00 }),
      std("c", { color: 0x0000ff }),
    ],
    objects: [
      props(100, { material: "a" }),
      props(2, { material: "a", castShadow: true }),
      props(2, { material: "b", castShadow: true }),
      props(2, { material: "c", castShadow: true }),
      props(100, { material: "b" }),
    ],
  },
  {
    name: "uniform-differ-in-roughness",
    geometries: [box()],
    materials: [std(), std("r1", { roughness: 0.2 }), std("r2", { roughness: 0.7 })],
    objects: [
      props(200),
      props(2, { material: "r1", castShadow: true }),
      props(2, { material: "r2", castShadow: true }),
    ],
  },
  {
    name: "material-groups",
    geometries: [box(), { id: "ball", kind: "sphere" }, { id: "ball2", kind: "sphere" }],
    materials: [std()],
    objects: [
      props(200),
      props(2, { geometry: "ball", castShadow: true }),
      props(2, { geometry: "ball2", castShadow: true }),
      props(1, { geometry: "ball", castShadow: true, scale: [-1, 1, 1] }),
    ],
  },
  {
    name: "nested-groups-and-lights",
    ...crowdAssets,
    objects: [
      { kind: "light" },
      { kind: "group", children: [props(100), { kind: "group", children: [props(150)] }] },
      { kind: "light", children: [props(10)] },
    ],
  },
  {
    name: "mixed-materials",
    geometries: [box()],
    materials: [
      std(),
      { id: "lam", type: "MeshLambertMaterial" },
      { id: "pho", type: "MeshPhongMaterial" },
      { id: "bas", type: "MeshBasicMaterial" },
    ],
    objects: [
      props(100),
      props(100, { material: "lam" }),
      props(50, { material: "pho" }),
      props(3, { material: "bas" }),
    ],
  },
  // Two hundred meshes that share nothing: every group has one member, so projecting would not
  // save draws (the draw-ratio rule).
  {
    name: "not-worthwhile",
    geometries: Array.from({ length: 200 }, (_, i) => box(`g${i}`)),
    materials: Array.from({ length: 200 }, (_, i) => std(`m${i}`, { roughness: i / 200 })),
    objects: Array.from({ length: 200 }, (_, i) =>
      props(1, { geometry: `g${i}`, material: `m${i}` }),
    ),
  },
];

const table = SCENES.map((scene) => ({ scene, decision: decide(scene) }));
const text = `${JSON.stringify({ three: "0.185.1", scenes: table }, null, 1)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      `TN_PROJECTION_REFERENCE_STALE: ${OUT} is not what the core module decides today`,
    );
    process.exit(1);
  }
  console.log(`projection reference current: ${table.length} scenes`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${table.length} scenes to ${OUT}`);
}
