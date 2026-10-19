// PRD-377 §4.1 — who is allowed to have a discrete chain, and the stable reason why not.
//
// Conservative by construction: anything the simplifier cannot be proven to leave visually and
// structurally intact is declined with a named reason rather than forced to a triangle target. An
// inability to reduce safely is a normal skip, not a failure.

import {
  type Document,
  type Material,
  type Mesh,
  Node,
  type Primitive,
} from "@gltf-transform/core";

/** The stable reason codes reported for a primitive that gets no automatic discrete chain. */
export type DiscreteLodSkipReason =
  | "already-cooked"
  | "animated"
  | "authored-lod"
  | "boundary-unsafe"
  | "deforming"
  | "disabled"
  | "explicit-legacy-simplify"
  | "insufficient-reduction"
  | "material-unsupported"
  | "too-small"
  | "unsupported-attributes"
  | "unsupported-topology"
  | "virtual-none"
  | "virtual-owned";

/**
 * What the `minTriangles` pre-filter is measured against.
 *
 * `"primitive"` compares each primitive on its own; `"asset"` compares the whole source asset's
 * total. The asset total is the evidence-backed default: a carrier can be 347,497 triangles split
 * over 300 primitives of ~1,200, where an absolute per-primitive floor measures how the artist
 * happened to split the mesh rather than whether simplification would pay. Whichever is chosen, the
 * floor is only a cheap pre-filter — the measured saving rule below is the gate.
 */
export type LodMinTrianglesScope = "primitive" | "asset";

/** Attribute semantics an index-only chain can share without reconstructing them. */
const SUPPORTED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "COLOR_0",
  "NORMAL",
  "POSITION",
  "TANGENT",
  "TEXCOORD_0",
  "TEXCOORD_1",
]);

/**
 * True when every level can draw the base's copy of this attribute. glTF reserves the `_` prefix
 * for application data (a baked wind weight, say); a level only swaps the index buffer over the
 * base vertices, so it shares that data exactly as it shares COLOR_0.
 */
function sharedByLevels(semantic: string): boolean {
  return SUPPORTED_ATTRIBUTES.has(semantic) || semantic.startsWith("_");
}

const DEFORMING_ATTRIBUTES: ReadonlySet<string> = new Set(["JOINTS_0", "WEIGHTS_0"]);

/**
 * Whether a primitive is deforming: skinned, morph-targeted, or carrying per-vertex joint data.
 *
 * The one definition of the word, shared by every rule that declines to rewrite geometry a rig
 * drives — no discrete chain, no joined far rung, and no vertex reordering in the cook. A vertex
 * index into deforming geometry is an address something outside the file may already hold, and a
 * rig is where index-addressed data is most likely to come from: a MetaHuman sidecar records the
 * head vertex each brow strand root rides and reads its position back every frame.
 */
export function deforming(primitive: Primitive, skinned: boolean): boolean {
  if (skinned || primitive.listTargets().length > 0) return true;
  return primitive.listSemantics().some((semantic) => DEFORMING_ATTRIBUTES.has(semantic));
}

/** The mesh-level half of {@link deforming}: the node compensation quantization applies is per mesh,
 * so one deforming primitive is enough to hold every position the mesh carries. */
export function deformingMesh(mesh: Mesh, skinned: ReadonlySet<Mesh>): boolean {
  const isSkinned = skinned.has(mesh);
  return isSkinned || mesh.listPrimitives().some((primitive) => deforming(primitive, isSkinned));
}

/** The meshes a skin is bound to, shared by every rule that asks whether a rig drives a mesh. */
export function skinnedMeshes(document: Document): Set<Mesh> {
  const skinned = new Set<Mesh>();
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh !== null && node.getSkin() !== null) skinned.add(mesh);
  }
  return skinned;
}

const TRIANGLES_MODE = 4;

const TRIANGLE = 3;

export interface IEligibilityFlags {
  /** The primitive already carries a `TN_discrete_lod` payload from an earlier cook. */
  readonly alreadyCooked: boolean;
  /** The asset is an authored chain: two or more of its nodes carry a level name (`hull_LOD1`). */
  readonly authoredLod: boolean;
  /** `assets.models.simplify` is declared for this asset. */
  readonly legacySimplify: boolean;
  /** `assets.models.virtual` is `"none"` and the new policy did not explicitly override it. */
  readonly legacyVirtualNone: boolean;
  /** Total triangles in the whole source asset, compared against the floor when it scopes to asset. */
  readonly assetTriangles: number;
  /** Cheap pre-filter floor in triangles; the measured saving rule, not this, is the real gate. */
  readonly minTriangles: number;
  /** Whether the floor is measured against this primitive or the whole asset. */
  readonly minTrianglesScope: LodMinTrianglesScope;
  /** The owning node has a skin. */
  readonly skinned: boolean;
  /** The primitive already carries a virtual-geometry DAG (or the bake will attach one). */
  readonly virtualOwned: boolean;
}

export interface IEligibility {
  readonly eligible: boolean;
  readonly reason?: DiscreteLodSkipReason;
}

function triangleCount(primitive: Primitive): number {
  const position = primitive.getAttribute("POSITION");
  const drawn = primitive.getIndices()?.getCount() ?? position?.getCount() ?? 0;
  return Math.floor(drawn / TRIANGLE);
}

function finitePositions(primitive: Primitive): boolean {
  const position = primitive.getAttribute("POSITION");
  if (position === null) return false;
  const array = position.getArray();
  if (array === null) return false;
  for (let index = 0; index < array.length; index += 1) {
    if (!Number.isFinite(array[index] as number)) return false;
  }
  const min = position.getMin([0, 0, 0]);
  const max = position.getMax([0, 0, 0]);
  return min.every(Number.isFinite) && max.every(Number.isFinite);
}

function validIndices(primitive: Primitive): boolean {
  const position = primitive.getAttribute("POSITION");
  const indices = primitive.getIndices();
  if (indices === null) return position !== null && position.getCount() > 0;
  const array = indices.getArray();
  if (array === null || array.length === 0 || array.length % TRIANGLE !== 0) return false;
  const vertices = position?.getCount() ?? 0;
  for (let index = 0; index < array.length; index += 1) {
    const value = array[index] as number;
    if (!Number.isInteger(value) || value < 0 || value >= vertices) return false;
  }
  return true;
}

/**
 * A material whose appearance index-only geometry cannot preserve.
 *
 * `MASK` is admitted, and that admission is the whole of the foliage path (PRD-458 §4): an
 * alpha-tested material draws a *subset* of the LOD0 fragments — the ones above the cutoff — so a
 * chain that keeps every border vertex, with UVs weighted, keeps the silhouette. `BLEND` is not,
 * because a simplified card blends with whatever is behind it and a dropped triangle there is a
 * visible hole. Everything that is really translucent (transmission, volume, displacement) keeps
 * its refusal whatever its alpha mode, because no index reduction preserves it.
 */
function unsupportedMaterial(material: Material | null): boolean {
  if (material === null) return false;
  const alphaMode = material.getAlphaMode();
  if (alphaMode !== "OPAQUE" && alphaMode !== "MASK") return true;
  for (const extension of material.listExtensions()) {
    const name = extension.extensionName.toLowerCase();
    if (name.includes("transmission") || name.includes("displacement") || name.includes("volume"))
      return true;
  }
  return false;
}

/**
 * Non-manifold edges (`> 2` triangles on one edge) are the shape where independent simplification
 * of one primitive against a neighbour can open a crack. Manifold borders are handled by locking
 * the border in the simplifier; a non-manifold fan is declined outright.
 */
function nonManifold(primitive: Primitive): boolean {
  const indices = primitive.getIndices();
  if (indices === null) return false;
  const array = indices.getArray();
  if (array === null) return false;
  const seen = new Map<number, number>();
  for (let index = 0; index + 2 < array.length; index += 3) {
    const a = array[index] as number;
    const b = array[index + 1] as number;
    const c = array[index + 2] as number;
    if (a === b || b === c || a === c) continue;
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const low = Math.min(u, v);
      const high = Math.max(u, v);
      const key = low * 0x1_0000_0000 + high;
      const count = (seen.get(key) ?? 0) + 1;
      if (count > 2) return true;
      seen.set(key, count);
    }
  }
  return false;
}

/**
 * The eligibility decision order of PRD-377 §4.1/§4.2. Ownership and opt-out reasons are checked
 * before geometry, because a virtual-owned or explicitly-authored primitive must never be silently
 * simplified just because it happens to be dense.
 */
export function classifyPrimitive(primitive: Primitive, flags: IEligibilityFlags): IEligibility {
  if (flags.alreadyCooked) return { eligible: false, reason: "already-cooked" };
  if (flags.virtualOwned) return { eligible: false, reason: "virtual-owned" };
  if (flags.legacySimplify) return { eligible: false, reason: "explicit-legacy-simplify" };
  if (flags.legacyVirtualNone) return { eligible: false, reason: "virtual-none" };
  if (flags.authoredLod) return { eligible: false, reason: "authored-lod" };
  if (flags.skinned) return { eligible: false, reason: "deforming" };

  if (primitive.getMode() !== TRIANGLES_MODE)
    return { eligible: false, reason: "unsupported-topology" };
  if (primitive.listTargets().length > 0) return { eligible: false, reason: "deforming" };

  const semantics = primitive.listSemantics();
  for (const semantic of semantics) {
    if (DEFORMING_ATTRIBUTES.has(semantic)) return { eligible: false, reason: "deforming" };
    if (!sharedByLevels(semantic)) return { eligible: false, reason: "unsupported-attributes" };
  }
  if (!semantics.includes("POSITION")) return { eligible: false, reason: "unsupported-topology" };
  if (!finitePositions(primitive) || !validIndices(primitive))
    return { eligible: false, reason: "unsupported-topology" };
  if (unsupportedMaterial(primitive.getMaterial()))
    return { eligible: false, reason: "material-unsupported" };

  // Cheap pre-filter only: skip units where the simplifier's fixed per-call cost would dominate
  // any reduction. Asset scope is the default because an absolute per-primitive floor measures the
  // artist's mesh split, not whether simplification pays; the measured saving rule is the real gate.
  const measured =
    flags.minTrianglesScope === "asset" ? flags.assetTriangles : triangleCount(primitive);
  if (measured < flags.minTriangles) return { eligible: false, reason: "too-small" };
  if (nonManifold(primitive)) return { eligible: false, reason: "boundary-unsafe" };
  return { eligible: true };
}

export interface IJoinEligibilityFlags {
  /** The primitive already carries a `TN_discrete_lod` payload from an earlier cook. */
  readonly alreadyCooked: boolean;
  /** A node in the primitive's ancestry is targeted by an animation channel. */
  readonly animated: boolean;
  /** The owning node has a skin. */
  readonly skinned: boolean;
  /** The primitive already carries a virtual-geometry DAG. */
  readonly virtualOwned: boolean;
}

/**
 * Whether a primitive may be merged into an opt-in joined far rung (PRD-377 §4.4 extension).
 *
 * Deliberately stricter than {@link classifyPrimitive} in the ways a join cares about: no triangle
 * floor (joining pays regardless of density) and no material check (a join never crosses a
 * material), but skinned, morph-target and animated geometry is refused outright because a joined
 * rung has no rig to drive it.
 */
export function classifyJoinCandidate(
  primitive: Primitive,
  flags: IJoinEligibilityFlags,
): IEligibility {
  if (flags.skinned) return { eligible: false, reason: "deforming" };
  if (flags.animated) return { eligible: false, reason: "animated" };
  if (flags.alreadyCooked) return { eligible: false, reason: "already-cooked" };
  if (flags.virtualOwned) return { eligible: false, reason: "virtual-owned" };
  if (primitive.getMode() !== TRIANGLES_MODE)
    return { eligible: false, reason: "unsupported-topology" };
  if (primitive.listTargets().length > 0) return { eligible: false, reason: "deforming" };
  const semantics = primitive.listSemantics();
  for (const semantic of semantics) {
    if (DEFORMING_ATTRIBUTES.has(semantic)) return { eligible: false, reason: "deforming" };
    if (!sharedByLevels(semantic)) return { eligible: false, reason: "unsupported-attributes" };
  }
  if (!semantics.includes("POSITION")) return { eligible: false, reason: "unsupported-topology" };
  if (!finitePositions(primitive) || !validIndices(primitive))
    return { eligible: false, reason: "unsupported-topology" };
  return { eligible: true };
}
/**
 * Authored LOD detection: a node or mesh whose name carries a level suffix (`hull_LOD1`,
 * `hull-lod2`) is a hand-authored variant, and generating on top of it would stack two owners on
 * one primitive (PRD-377 §4.2). The cook counts it as authored only when the asset holds two or
 * more level-named nodes; a lone one is that asset's LOD0.
 */
export function authoredLodName(name: string): boolean {
  return /(^|[_\-.\s])lod[0-9]+($|[_\-.\s])/i.test(name);
}

export { triangleCount as primitiveTriangleCount };
