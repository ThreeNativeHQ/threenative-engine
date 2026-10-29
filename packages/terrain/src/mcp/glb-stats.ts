const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const INSTANCING = "EXT_mesh_gpu_instancing";
// Primitive modes that draw triangles: TRIANGLES, TRIANGLE_STRIP, TRIANGLE_FAN.
const TRIANGLE_MODES = new Set([4, 5, 6]);

interface IGltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
}

interface IGltfNode {
  children?: number[];
  mesh?: number;
  extensions?: Record<string, { attributes?: Record<string, number> } | undefined>;
}

interface IGltfJson {
  accessors?: { count: number }[];
  meshes?: { primitives: IGltfPrimitive[] }[];
  nodes?: IGltfNode[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
}

/** What the default scene of a GLB puts on screen, counted from the file itself. */
export interface IGlbStats {
  /** Primitives drawn, an instanced primitive counting once however many instances it has. */
  draws: number;
  /** Instances declared by `EXT_mesh_gpu_instancing` nodes. */
  instances: number;
  /** Triangles of the default scene with every instance counted in full, before LOD and culling. */
  triangles: number;
}

function jsonChunk(bytes: Uint8Array): IGltfJson {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error("glb-stats: not a GLB, the glTF binary header is missing.");
  }
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + length > bytes.byteLength) {
    throw new Error("glb-stats: the first GLB chunk is not a complete JSON chunk.");
  }
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as IGltfJson;
}

/**
 * Counts the default scene of a GLB. Only the JSON chunk is read: every count lives in an accessor
 * header, so no buffer is decoded. Alternate scenes (the LOD levels a cook writes beside the
 * default one) are not counted, because a loader draws one scene.
 */
export function measureGlb(bytes: Uint8Array): IGlbStats {
  const gltf = jsonChunk(bytes);
  const nodes = gltf.nodes ?? [];
  const accessorCount = (index: number | undefined): number => {
    const count = index === undefined ? undefined : gltf.accessors?.[index]?.count;
    if (count === undefined) throw new Error(`glb-stats: accessor ${index} is missing.`);
    return count;
  };
  const stats: IGlbStats = { draws: 0, instances: 0, triangles: 0 };
  const seen = new Set<number>();
  const visit = (index: number): void => {
    const node = nodes[index];
    if (node === undefined) throw new Error(`glb-stats: node ${index} is missing.`);
    if (seen.has(index)) return;
    seen.add(index);
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes?.[node.mesh];
      if (mesh === undefined) throw new Error(`glb-stats: mesh ${node.mesh} is missing.`);
      const attributes = node.extensions?.[INSTANCING]?.attributes;
      const copies = attributes === undefined ? 1 : accessorCount(Object.values(attributes)[0]);
      if (attributes !== undefined) stats.instances += copies;
      for (const primitive of mesh.primitives) {
        stats.draws += 1;
        if (!TRIANGLE_MODES.has(primitive.mode ?? 4)) continue;
        const vertices = accessorCount(primitive.indices ?? primitive.attributes.POSITION);
        stats.triangles +=
          (primitive.mode === 5 || primitive.mode === 6
            ? Math.max(vertices - 2, 0)
            : Math.floor(vertices / 3)) * copies;
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const root of scene?.nodes ?? (gltf.scenes === undefined ? nodes.keys() : [])) visit(root);
  return stats;
}
