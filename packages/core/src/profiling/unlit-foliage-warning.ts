/**
 * The engine telling the agent that built the scene what a human finds by playing it once.
 *
 * Imported foliage drawn with no image-based light looks like cardboard, and nothing in the build
 * says so. A GLB's leaf card is `MeshStandardMaterial` (or its Node twin), `alphaTest` above zero,
 * `side: DoubleSide`; with `scene.environment === null` and no `envMap` on the material, `envMapIntensity`
 * has nothing to apply — three r185's WebGPU path only uses it when the material carries its own
 * `envMap`, and `scene.environmentIntensity` only reaches a scene that has an environment. What is
 * left is a hemisphere fill, so a shaded needle card and its back face land on one flat dark value
 * and the author compensates with a tint or a fake emissive, which is the paperboard.
 *
 * So the rule is derived from the scene graph, never from a constant: cutout PBR, counted by
 * material, with no environment anywhere in the scene. It fires once per scene entry, warns, and
 * changes nothing — the fix is the game's own `scene.environment`, which is appearance and therefore
 * the game's to set.
 */

import type { Object3D } from "three";

/** Marker printed once per scene entry, for a log reader and a harness to grep. */
export const UNLIT_FOLIAGE_MARKER = "TN_UNLIT_FOLIAGE";

/** The one line that says what to change. Never a second sentence: the fix is one decision. */
export const UNLIT_FOLIAGE_FIX =
  "set scene.environment (an HDRI or a sky texture) or give these materials an envMap; do not tint or flatten their normals to compensate";

/** How many examples the line carries before it stops being readable. */
const MAX_EXAMPLES = 5;

/**
 * The part of a `THREE.Material` this reads. Structural, like the alpha-antialiasing convention's,
 * so a native adapter, a Node material and a test stub are all the same input.
 */
interface IUnlitFoliageMaterial {
  alphaHash?: boolean;
  alphaTest?: number;
  alphaToCoverage?: boolean;
  envMap?: unknown;
  name?: string;
  type?: string;
  userData?: Record<string, unknown>;
}

/** The verdict: what is affected, and enough names to find it in the scene graph. */
export interface IUnlitFoliageWarning {
  /** Distinct materials with no image-based light, the number an author can act on. */
  readonly materials: number;
  /** Meshes drawn with them, so one shared material is not mistaken for a scene-wide one. */
  readonly meshes: number;
  readonly examples: readonly string[];
}

/**
 * PBR lit by an environment, in three's own spelling. The Node variants are named separately and
 * set no `isMeshStandardMaterial`, so the type name is the one test that covers web and WebGPU.
 */
const LIT_PBR = /^(?:MeshStandard|MeshPhysical)(?:Node)?Material$/u;

/** A material whose silhouette an alpha test carves, whatever mechanism the game chose. */
function isCutout(material: IUnlitFoliageMaterial): boolean {
  return (
    (typeof material.alphaTest === "number" && material.alphaTest > 0) ||
    material.alphaHash === true ||
    material.alphaToCoverage === true
  );
}

/**
 * The one condition: cutout PBR with no environment of its own, in a scene with none either.
 *
 * A game that means to render its cutouts unlit says so — `material.userData.tnUnlitOk = true`,
 * the same `userData.tn*` naming the alpha and impostor conventions already use — and is silent.
 */
function isUnlitFoliage(value: unknown): value is IUnlitFoliageMaterial {
  if (typeof value !== "object" || value === null) return false;
  const material = value as IUnlitFoliageMaterial;
  if (material.userData?.tnUnlitOk === true) return false;
  if (material.envMap != null) return false;
  return LIT_PBR.test(material.type ?? "") && isCutout(material);
}

/**
 * Walk what the scene actually draws.
 *
 * `Object3D.traverse` would visit hidden subtrees too, and three does not draw them, so the walk
 * prunes on `visible` — otherwise a cutout the author disabled would be reported as paperboard.
 * One walk, every node kind: an `InstancedMesh`, a `BatchedMesh` and a `SkinnedMesh` are all an
 * object with a `material`.
 */
function eachDrawnNode(node: Object3D, visit: (object: Object3D) => void): void {
  if (node.visible === false) return;
  visit(node);
  const children = (node as { children?: readonly Object3D[] }).children;
  if (children === undefined) return;
  for (const child of children) eachDrawnNode(child, visit);
}

/** The material's own name first, then the mesh's, then something a reader can search for. */
function example(object: Object3D, material: IUnlitFoliageMaterial): string {
  if (material.name !== undefined && material.name !== "") return material.name;
  if (object.name !== "") return object.name;
  return material.type ?? "unnamed material";
}

/** The walk's running tally: the materials counted once each, and the meshes that drew them. */
interface IUnlitTally {
  readonly examples: string[];
  readonly materials: Set<object>;
  meshes: number;
}

function countNode(tally: IUnlitTally, object: Object3D): void {
  const slot = (object as { material?: unknown }).material;
  if (slot === undefined || slot === null) return;
  const materials = Array.isArray(slot) ? slot : [slot];
  let drawn = false;
  for (const material of materials) {
    if (!isUnlitFoliage(material)) continue;
    drawn = true;
    if (tally.materials.has(material)) continue;
    tally.materials.add(material);
    if (tally.examples.length < MAX_EXAMPLES) tally.examples.push(example(object, material));
  }
  if (drawn) tally.meshes += 1;
}

/**
 * The warning for one scene entry, or `undefined` when nothing in it is unlit.
 *
 * Fails closed on the reading it needs: a scene with an environment, or a material carrying its own
 * `envMap`, gets no warning, because the absence of an image-based light is the whole claim and
 * anything else is speculation. Materials are counted once however many meshes share them, because
 * a hundred instances of one imported atlas are one decision, not a hundred.
 */
export function unlitFoliageWarning(
  scene: Object3D & { environment?: unknown },
): IUnlitFoliageWarning | undefined {
  if (typeof scene !== "object" || scene === null) return undefined;
  if (scene.environment != null) return undefined;
  const tally: IUnlitTally = { examples: [], materials: new Set(), meshes: 0 };
  eachDrawnNode(scene, (object) => countNode(tally, object));
  if (tally.materials.size === 0) return undefined;
  return { examples: tally.examples, materials: tally.materials.size, meshes: tally.meshes };
}

/** The marker line. */
export function formatUnlitFoliageWarning(warning: IUnlitFoliageWarning): string {
  return `${UNLIT_FOLIAGE_MARKER}:${JSON.stringify(warning)}`;
}
