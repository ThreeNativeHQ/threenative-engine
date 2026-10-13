import type { ICtx } from "@threenative/core";
import type { Material, Texture } from "three";
import type { MeshPhysicalNodeMaterial, Node } from "three/webgpu";

// These are the texture inputs used by Strata's ordinary and node-based prop surfaces.
const mapInputs = [
  "map",
  "normalMap",
  "alphaMap",
  "aoMap",
  "roughnessMap",
  "metalnessMap",
  "emissiveMap",
  "lightMap",
  "bumpMap",
  "displacementMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "transmissionMap",
  "thicknessMap",
  "specularIntensityMap",
  "specularColorMap",
  "envMap",
] as const;
const nodeInputs = [
  "colorNode",
  "normalNode",
  "opacityNode",
  "alphaTestNode",
  "aoNode",
  "roughnessNode",
  "emissiveNode",
  "positionNode",
  "castShadowPositionNode",
  "envNode",
] as const;

function materialInputs(materials: Iterable<Material>, textures: Set<Texture>): Node[] {
  const nodes: Node[] = [];
  for (const material of new Set(materials)) {
    const surface = material as Material & Partial<MeshPhysicalNodeMaterial>;
    for (const key of mapInputs) {
      const value = surface[key];
      if (value?.isTexture) textures.add(value);
    }
    for (const key of nodeInputs) {
      const node = surface[key];
      if (node?.isNode) nodes.push(node);
    }
  }
  return nodes;
}

function sampledTextures(nodes: Node[], textures: Set<Texture>): Node[] {
  const seen = new Set<Node>();
  const sampledNodes: Node[] = [];
  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);
    const sampled = node as Node & { isTextureNode?: boolean; value?: Texture };
    if (sampled.isTextureNode && sampled.value?.isTexture) {
      textures.add(sampled.value);
      sampledNodes.push(node);
    }
    for (const child of node.getChildren()) nodes.push(child);
  }
  return sampledNodes;
}

/** Points every borrowed material map and TSL texture node at its prepared replacement. */
function applyReplacements(
  materials: Iterable<Material>,
  sampledNodes: Node[],
  replacements: Map<Texture, Texture>,
): number {
  if (replacements.size === 0) return 0;
  const applied = new Set<Texture>();
  for (const material of new Set(materials)) {
    const surface = material as Material &
      Partial<MeshPhysicalNodeMaterial> &
      Record<string, unknown>;
    for (const key of mapInputs) {
      const value = surface[key] as Texture | undefined;
      const prepared = value?.isTexture === true ? replacements.get(value) : undefined;
      if (value?.isTexture && prepared?.isTexture && prepared !== value) {
        surface[key] = prepared;
        if ((value as Texture & { isCompressedTexture?: boolean }).isCompressedTexture)
          applied.add(value);
      }
    }
  }
  for (const node of sampledNodes) {
    const sampled = node as Node & { value?: Texture };
    if (sampled.value === undefined) continue;
    const prepared = replacements.get(sampled.value);
    if (prepared?.isTexture && prepared !== sampled.value) {
      if ((sampled.value as Texture & { isCompressedTexture?: boolean }).isCompressedTexture)
        applied.add(sampled.value);
      sampled.value = prepared;
    }
  }
  return applied.size;
}

/**
 * Borrow actual material texture identities; asset loading continues to own their lifetime. The
 * renderer prepares copies it owns and this call swaps every map and TSL texture node reference
 * for its prepared replacement, so a compressed material samples uploaded GPU data. The numeric
 * completion count, progress callback and errors keep the renderer's contract. Compressed completion
 * reports distinct compressed inputs actually replaced after preparation succeeds.
 */
export async function preparePropTextures(
  renderer: Pick<ICtx["renderer"], "prepareTextures">,
  materials: Iterable<Material>,
  signal?: AbortSignal,
  onProgress?: (completed: number) => void,
  onCompressedPrepared?: (completed: number) => void,
): Promise<number> {
  // Snapshot the iterable once so a generator is not consumed before replacements are applied.
  const materialList = [...new Set(materials)];
  const textures = new Set<Texture>();
  const nodes = materialInputs(materialList, textures);
  const sampledNodes = sampledTextures(nodes, textures);
  if (!renderer.prepareTextures)
    throw new Error("Renderer lacks bounded prop texture preparation.");
  const replacements = new Map<Texture, Texture>();
  const completed = await renderer.prepareTextures(textures, signal, onProgress, replacements);
  const compressedPrepared = applyReplacements(materialList, sampledNodes, replacements);
  onCompressedPrepared?.(compressedPrepared);
  return completed;
}
