// The model pass's `reorder` stage, over the primitives whose vertex order nothing else owns.
//
// `reorder` from `@gltf-transform/functions` walks the whole document and renumbers the vertices
// of every primitive it finds, which is the cheapest transmission-size win in the cook — and it
// breaks every file that addresses a vertex by index. A MetaHuman sidecar names the head vertex
// each brow strand root rides and reads that position back every frame; after an unconditional
// reorder it indexes a different vertex (`brow root 0 indexes head vertex 11498, which is not where
// it was prepared`). The cook cannot know who holds an index, so the general rule is that any
// primitive whose indices can be addressed from outside is undeclarable, and *deforming* — skinned,
// morph-targeted, or joint-bound — is the measurable proxy: a rig is where index-addressed data
// comes from, and it is the one case detectable from the file alone.
//
// So the vertex-cache remap is applied per index-buffer group, and a group holding any deforming
// primitive is left exactly as authored. Compression is unaffected: `EXT_meshopt_compression` encodes
// whatever order it is handed, and `quantize` renumbers nothing.
//
// ponytail: the library's `reorder` has no per-primitive switch, so the remap is its own ~30 lines.
// Replace with the library's whole-document `reorder` the day it takes a predicate.

import { type Accessor, type Document, Primitive } from "@gltf-transform/core";
import type { MeshoptEncoder } from "meshoptimizer";
import { deforming, skinnedMeshes } from "../lod/eligibility.js";

/** One index buffer, the attributes that read through it, and the primitives that draw it. */
interface IVertexGroup {
  readonly attributes: Accessor[];
  readonly members: { readonly primitive: Primitive; readonly skinned: boolean }[];
}

/** meshoptimizer's own 16-bit index ceiling, as the library's `reorder` measures it. */
const MAX_UINT16 = 65534;

/**
 * Reorder every non-deforming primitive's vertices for transmission size, in place. Returns how
 * many index-buffer groups were rewritten.
 *
 * Grouped by shared index buffer rather than by primitive, because primitives sharing one index
 * buffer share the renumbering: remapping one and not the other desynchronises them. Mirrors the
 * library's own `reorder` for the groups it does touch, minus its cleanup prune — the pass's `prune`
 * runs before this stage, and the writer emits reachable properties only.
 */
export function reorderStaticPrimitives(
  document: Document,
  encoder: typeof MeshoptEncoder,
): number {
  let reordered = 0;
  for (const [indices, group] of vertexGroups(document)) {
    if (group.members.some((member) => deforming(member.primitive, member.skinned))) continue;
    remapGroup(indices, group, encoder);
    reordered += 1;
  }
  return reordered;
}

/** Every index buffer in the document, with the attributes and primitives that read through it. */
function vertexGroups(document: Document): Map<Accessor, IVertexGroup> {
  const skinned = skinnedMeshes(document);
  const groups = new Map<Accessor, IVertexGroup>();
  for (const mesh of document.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      if (indices === null) continue;
      const group = groups.get(indices) ?? { attributes: [], members: [] };
      group.members.push({ primitive, skinned: skinned.has(mesh) });
      for (const semantic of primitive.listSemantics()) {
        const attribute = primitive.getAttribute(semantic);
        if (attribute !== null && !group.attributes.includes(attribute))
          group.attributes.push(attribute);
      }
      groups.set(indices, group);
    }
  return groups;
}

/** Renumber one group's vertices, and every primitive that draws them, in place. */
function remapGroup(indices: Accessor, group: IVertexGroup, encoder: typeof MeshoptEncoder): void {
  const source = indices.getArray();
  const triangles = group.members.every(
    (member) => member.primitive.getMode() === Primitive.Mode.TRIANGLES,
  );
  // The encoder renumbers the array it is handed in place and returns the old-to-new table, so the
  // copy is the destination index buffer and `source` still reads the authored one.
  const remapped = source instanceof Uint32Array ? source.slice() : new Uint32Array(source);
  const [remap, unique] = encoder.reorderMesh(remapped, triangles, true);
  const dstIndices = indices
    .clone()
    .setArray(unique <= MAX_UINT16 ? new Uint16Array(remapped) : remapped);
  const dstAttributes = new Map<Accessor, Accessor>();
  for (const attribute of group.attributes)
    dstAttributes.set(attribute, compactAttribute(attribute, source, remap, unique));
  for (const member of group.members) {
    for (const semantic of member.primitive.listSemantics()) {
      const attribute = member.primitive.getAttribute(semantic);
      if (attribute === null) continue;
      member.primitive.setAttribute(semantic, dstAttributes.get(attribute) ?? attribute);
    }
    member.primitive.setIndices(dstIndices);
  }
  for (const attribute of group.attributes)
    if (attribute.listParents().length === 0) attribute.dispose();
  if (indices.listParents().length === 0) indices.dispose();
}

/** One attribute rewritten into the renumbered vertex stream, dropping what no triangle reaches. */
function compactAttribute(
  attribute: Accessor,
  source: ArrayLike<number>,
  remap: Uint32Array,
  unique: number,
): Accessor {
  const array = attribute.getArray();
  const width = attribute.getElementSize();
  const compact = new array.constructor(unique * width);
  // One write per destination vertex: a vertex several triangles reference is copied once.
  const written = new Uint8Array(unique);
  for (let index = 0; index < source.length; index += 1) {
    const from = source[index] ?? 0;
    const to = remap[from];
    if (to === undefined || written[to] === 1) continue;
    written[to] = 1;
    for (let component = 0; component < width; component += 1)
      compact[to * width + component] = array[from * width + (component ?? 0)];
  }
  // Sparse is cleared: it indexes the source's vertex stream and this one has been renumbered.
  return attribute.clone().setArray(compact).setSparse(false);
}
