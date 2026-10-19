// The model pass's `quantize` stage, over the primitives whose positions nothing else may move.
//
// `quantize` from `@gltf-transform/functions` walks the whole document and rewrites POSITION into
// 16-bit integers snapped to a grid whose step is the mesh's own bounding volume — the largest size
// win in the cook — and then compensates by folding that shift into the node holding the mesh, the
// skin's inverse bind matrices, GPU instancing batches and any volumetric material.
//
// That is exact for static geometry. For geometry a rig drives it breaks the invariant this repo
// holds: one metre is one metre. The metahuman-lab's `brows.skin.json` names the head vertex each
// brow strand root rides and reads its position back every frame, prepared against the source file
// to within 1e-5 m; a head snapped onto a 16-bit grid over its own volume is micrometres away from
// every vertex the sidecar recorded, and the shift that would undo it lives in a node transform the
// sidecar never sees.
//
// So a deforming mesh is held in source space across the stage: POSITION and the morph-target
// deltas riding it keep the exact values their author wrote, and the mesh spends the stage detached
// from its nodes, so there is no compensation to undo — the skin, the node matrices, the instancing
// batch and a volume material's thickness are simply never touched. Everything else still quantizes,
// and `EXT_meshopt_compression` still encodes whatever the accessors hold.
//
// ponytail: the library's `quantize` takes one document-wide pattern with no per-mesh switch, and
// its node compensation is inseparable from the positions it shifts, so holding is its own ~60
// lines. Replace with the library's own `quantize` the day it takes a deforming predicate.

import type {
  Accessor,
  Document,
  ExtensionProperty,
  Material,
  Mesh,
  Primitive,
  PrimitiveTarget,
  TypedArray,
} from "@gltf-transform/core";
import { Node } from "@gltf-transform/core";
import { deformingMesh, skinnedMeshes } from "../lod/eligibility.js";

/** What a primitive and a morph target both expose for one attribute, so one call serves both. */
type IAttributeOwner = {
  getAttribute(semantic: string): Accessor | null;
  setAttribute(semantic: string, accessor: Accessor | null): unknown;
};

/** One attribute's authored values, copied out before the stage overwrites them. */
interface IHeldAttribute {
  readonly array: TypedArray;
  readonly normalized: boolean;
}

/** One primitive's authored positions, kept while the stage tries to rewrite them. */
interface IHeldPrimitive {
  readonly primitive: Primitive;
  /** The index buffer as authored: a remap here would renumber what a sidecar addresses. */
  readonly indices: Accessor | null;
  readonly position: IHeldAttribute | null;
  readonly targets: readonly {
    readonly target: PrimitiveTarget;
    readonly position: IHeldAttribute | null;
  }[];
}

/** One deforming mesh: how it was held, and how to put it back. */
interface IHeldMesh {
  readonly mesh: Mesh;
  readonly nodes: readonly Node[];
  readonly primitives: readonly IHeldPrimitive[];
  readonly volumes: readonly { readonly material: Material; readonly volume: ExtensionProperty }[];
}

/**
 * Runs `quantize` with every deforming mesh held in the metre space its author wrote it in, and
 * puts the held geometry back whether the stage returns or throws.
 */
export async function quantizeStaticGeometry(
  document: Document,
  quantize: () => unknown,
): Promise<void> {
  const held = holdDeformingMeshes(document);
  try {
    await quantize();
  } finally {
    releaseDeformingMeshes(held);
  }
}

function holdDeformingMeshes(document: Document): IHeldMesh[] {
  const skinned = skinnedMeshes(document);
  const held: IHeldMesh[] = [];
  for (const mesh of document.getRoot().listMeshes()) {
    // The mesh is the unit of source space, because the compensation is per mesh: one deforming
    // primitive in it holds the whole thing, or the shift would land on half of it.
    if (!deformingMesh(mesh, skinned)) continue;
    const nodes: Node[] = [];
    for (const parent of mesh.listParents()) {
      if (!(parent instanceof Node)) continue;
      nodes.push(parent);
      parent.setMesh(null);
    }
    const primitives = mesh.listPrimitives().map((primitive) => ({
      primitive,
      indices: primitive.getIndices(),
      position: holdAttribute(primitive.getAttribute("POSITION")),
      targets: primitive.listTargets().map((target) => ({
        target,
        position: holdAttribute(target.getAttribute("POSITION")),
      })),
    }));
    const volumes: { material: Material; volume: ExtensionProperty }[] = [];
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      const volume = material?.getExtension("KHR_materials_volume") ?? null;
      if (material === null || volume === null) continue;
      // Thickness is given in local units, so the stage would scale it by the shift it is not
      // applying to this mesh's positions.
      material.setExtension("KHR_materials_volume", null);
      volumes.push({ material, volume });
    }
    held.push({ mesh, nodes, primitives, volumes });
  }
  return held;
}

function releaseDeformingMeshes(held: readonly IHeldMesh[]): void {
  for (const { mesh, nodes, primitives, volumes } of held) {
    for (const node of nodes) node.setMesh(mesh);
    for (const { material, volume } of volumes)
      material.setExtension("KHR_materials_volume", volume);
    for (const { primitive, indices, position, targets } of primitives) {
      // The stage may rewrite what a sidecar already addresses, but never renumber it: an index
      // buffer it replaced means the held positions no longer line up, so fail instead of shipping
      // a mesh whose every vertex has quietly moved.
      if (primitive.getIndices() !== indices)
        throw new Error(
          "TN_ASSETS_MODEL_DEFORMING_RENUMBERED: quantization rewrote the index buffer of a deforming primitive; its positions were held in source space and can no longer be addressed by index.",
        );
      releaseAttribute(primitive, position);
      for (const { target, position: delta } of targets) releaseAttribute(target, delta);
    }
  }
}

function holdAttribute(accessor: Accessor | null): IHeldAttribute | null {
  const array = accessor?.getArray() ?? null;
  if (accessor === null || array === null) return null;
  // A copy, because the stage replaces this accessor with its own and prunes the original: a
  // disposed property cannot be re-attached, and the values have to outlive the stage.
  const copy = array.slice();
  return { array: copy, normalized: accessor.getNormalized() };
}

/**
 * Writes the authored values back over whatever the stage left in the attribute. The accessor the
 * stage installed is reused rather than replaced, so the mesh keeps the attribute it was drawn
 * with and no orphan is left for the writer to emit.
 */
function releaseAttribute(owner: IAttributeOwner, held: IHeldAttribute | null): void {
  const accessor = owner.getAttribute("POSITION");
  if (held === null || accessor === null) return;
  accessor.setArray(held.array).setNormalized(held.normalized).setSparse(false);
}
