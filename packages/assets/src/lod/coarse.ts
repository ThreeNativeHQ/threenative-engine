// The coarse companion of a model with a `TN_discrete_lod` chain (PRD-860 Phase 3): every chained
// primitive draws only its coarsest level, over its own compacted vertices. A chain's levels share
// the base level's vertex buffers, so the chain itself cannot arrive coarse first; this file can,
// and a streaming loader draws it while the full model downloads.

import { type Document, PropertyType } from "@gltf-transform/core";
import { cloneDocument, compactPrimitive, prune } from "@gltf-transform/functions";

import { type DiscreteLod, TN_DISCRETE_LOD } from "./extension.js";

/** The coarse copy, or undefined when no primitive carries a chain. Textures keep their order. */
export async function coarseDocument(document: Document): Promise<Document | undefined> {
  const coarse = cloneDocument(document);
  let chained = 0;
  for (const mesh of coarse.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const chain = primitive.getExtension<DiscreteLod>(TN_DISCRETE_LOD);
      if (chain === null) continue;
      const coarsest = chain.getIndices().at(-1);
      primitive.setExtension(TN_DISCRETE_LOD, null);
      if (coarsest === undefined) continue;
      primitive.setIndices(coarsest);
      compactPrimitive(primitive);
      chained += 1;
    }
  if (chained === 0) return undefined;
  for (const extension of coarse.getRoot().listExtensionsUsed())
    if (extension.extensionName === TN_DISCRETE_LOD) extension.dispose();
  // Accessors only: the shared-image writer maps textures to their stored files by index.
  await coarse.transform(prune({ propertyTypes: [PropertyType.ACCESSOR] }));
  return coarse;
}
