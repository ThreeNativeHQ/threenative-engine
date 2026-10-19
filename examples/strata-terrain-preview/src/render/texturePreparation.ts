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

function sampledTextures(nodes: Node[], textures: Set<Texture>): void {
  const seen = new Set<Node>();
  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);
    const sampled = node as Node & { isTextureNode?: boolean; value?: Texture };
    if (sampled.isTextureNode && sampled.value?.isTexture) textures.add(sampled.value);
    for (const child of node.getChildren()) nodes.push(child);
  }
}

/** Borrow actual material texture identities; asset loading continues to own their lifetime. */
export async function preparePropTextures(
  renderer: Pick<ICtx["renderer"], "prepareTextures">,
  materials: Iterable<Material>,
  signal?: AbortSignal,
  onProgress?: (completed: number) => void,
): Promise<number> {
  const textures = new Set<Texture>();
  sampledTextures(materialInputs(materials, textures), textures);
  if (!renderer.prepareTextures)
    throw new Error("Renderer lacks bounded prop texture preparation.");
  return renderer.prepareTextures(textures, signal, onProgress);
}
