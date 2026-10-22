import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Frustum,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  Sphere,
  Vector3,
} from "three";
import { markStatic } from "./static-transform.js";

export const CHUNK_NAME = "world-chunk";

/**
 * The layer the level shadow cameras render and the main camera does not; see
 * `VirtualShadowNode`'s `VIRTUAL_SHADOW_CASTER_LAYER`. Duplicated from `index.ts` rather than
 * imported, because the world chunk is separate from the main one and this is the one value the two
 * halves of the cascade have to agree on.
 */
export const VIRTUAL_SHADOW_CASTER_LAYER = 28;
/**
 * The layer the wide shadow levels render and the fine ones do not: one caster mesh per
 * `asset:level:part` holding every cell's records, for a level whose window covers the whole
 * resident ring, where a cluster per square is a draw per square for the same pixels. Duplicated
 * from `index.ts` like the layer above, and a bit of its own so a level camera renders one caster
 * granularity or the other and never both.
 */
export const VIRTUAL_SHADOW_WIDE_CASTER_LAYER = 27;

/**
 * The one surface each `side` of a chunk shadow proxy draws with, world-wide.
 *
 * A depth pass cannot tell one material from another: it reads `side`, `alphaTest` and position,
 * and a proxy covers only opaque, non-alphaTest meshes, so every covered material with the same
 * `side` produces the same shadow pipeline. Borrowing one per covered group built a new one for
 * every chunk that loaded — 23 shadow draws over 125 ms and a 18 ms worst case on the walk this
 * measured, each one compiling a pipeline the one before it had already proven was identical. The
 * first covered material seen for a side is the world's, and every later proxy of that side borrows
 * it, so a world pays at most one shadow pipeline per side over its whole life.
 *
 * The materials are the world's own, so `disposeModel` must not release them with the chunk that
 * happened to contribute them.
 */
export const worldOwned = new WeakSet<Material>();

/**
 * A depth pass cannot tell one material from another, so a chunk's shadow bill is its material
 * count, not its triangle count: ~100 shadow draws a level render on the map, each a per-material
 * mesh walked through the light's frustum. Positions are all it needs, and a position-only geometry
 * grouped by `side` — the one thing a depth material does read — collapses that bill to one draw per
 * side.
 *
 * Every proxy sits on both caster halves: covered originals no longer cast, so choosing
 * key-wide scatter must retain the buildings, towers and fences represented by the proxy.
 * Either way it is counted by the same `#probe` window test as the scatter caster
 * clusters, so a level whose window does not reach the chunk drops it for free. Nothing here decides
 * how anything looks: the covered meshes keep the game's own materials and keep drawing the main pass
 * with them, and the proxy carries the world's material for its `side` by reference — the group it
 * was grouped *by* is the material's own `side`, so the depth pass reads exactly what the covered
 * mesh's own depth material would have read, and this file still constructs no material.
 *
 * Alpha-tested and transparent meshes keep casting themselves. Retained static instances use
 * separate per-side proxies, so their per-part gates do not change the existing merged proxies.
 */
export function buildChunkShadowProxies(
  chunk: Object3D,
  merged: readonly Mesh[],
  label: string,
  proxyMaterials: Map<number, Material>,
  selectParts = false,
): { readonly covered: Mesh[]; readonly proxies: Mesh[] } {
  const sides = new Map<number, { material: Material; meshes: Mesh[] }>();
  for (const mesh of merged) {
    const material = mesh.material;
    if (Array.isArray(material) || material.transparent === true || material.alphaTest > 0)
      continue;
    const side = material.side;
    const group = sides.get(side);
    if (group === undefined) sides.set(side, { material, meshes: [mesh] });
    else group.meshes.push(mesh);
  }
  const covered: Mesh[] = [];
  const proxies: Mesh[] = [];
  for (const [side, group] of sides) {
    // Three's sides occupy 0..2; retained sources have their own compatible material pool.
    const key = side + (selectParts ? 3 : 0);
    const held = proxyMaterials.get(key);
    const material = held ?? group.material;
    if (held === undefined) {
      proxyMaterials.set(key, material);
      worldOwned.add(material);
    }
    const proxy = new Mesh(shadowProxyGeometry(group.meshes, label, chunk), material);
    if (selectParts) selectChunkShadowParts(proxy, group.meshes);
    proxy.name = `${CHUNK_NAME}-shadow`;
    // The origin a draw of this mesh is counted under (`RenderPassBudget`). A proxy on the caster
    // layers never reaches the main pass, so this only says anything where the world's own cull
    // left one on layer 0 — and it is written here rather than inferred, so the tag cannot rot.
    proxy.userData.tnDrawSource = "proxies";
    proxy.layers.set(VIRTUAL_SHADOW_CASTER_LAYER);
    proxy.layers.enable(VIRTUAL_SHADOW_WIDE_CASTER_LAYER);
    proxy.castShadow = true;
    proxy.receiveShadow = false;
    chunk.add(proxy);
    markStatic(proxy);
    proxies.push(proxy);
    for (const mesh of group.meshes) {
      mesh.castShadow = false;
      covered.push(mesh);
    }
  }
  return { covered, proxies };
}

/**
 * One position-only geometry holding every covered mesh's vertices, indices preserved.
 *
 * Read through the attribute's own accessors, because a cooked model's positions can be quantized
 * and interleaved (`KHR_mesh_quantization`) and the raw array behind them is not what three would
 * have drawn. One pass at load time; the result is a depth buffer's whole input.
 */
/**
 * One mesh's vertices, placed into `positions` from `vertexAt`.
 *
 * A merged mesh's positions came out of `mergeByMaterial` as one plain float array, so that is three
 * reads, three multiplies and three writes per vertex. The arithmetic is three's, term for term and
 * including `applyMatrix4`'s homogeneous divide, so a proxy holds the vertices it held before. A
 * retained source can still be quantized and interleaved (`KHR_mesh_quantization`), and it takes the
 * accessor loop, which is what that arithmetic resolves to.
 */
function placeVertices(
  position: BufferAttribute,
  matrix: Matrix4,
  positions: Float32Array,
  vertexAt: number,
): void {
  if (
    position.array instanceof Float32Array &&
    !position.normalized &&
    !("isInterleavedBufferAttribute" in position)
  ) {
    const values = position.array as Float32Array;
    const e = matrix.elements;
    for (let index = 0; index < position.count; index += 1) {
      const x = values[index * 3] as number;
      const y = values[index * 3 + 1] as number;
      const z = values[index * 3 + 2] as number;
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
      const out = (vertexAt + index) * 3;
      positions[out] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
      positions[out + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
      positions[out + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    }
    return;
  }
  const vertex = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index).applyMatrix4(matrix);
    vertex.toArray(positions, (vertexAt + index) * 3);
  }
}

function shadowProxyGeometry(
  meshes: readonly Mesh[],
  label: string,
  chunk: Object3D,
): BufferGeometry {
  chunk.updateMatrixWorld(true);
  const toRoot = chunk.matrixWorld.clone().invert();
  const place = new Matrix4();
  const instance = new Matrix4();
  const matrix = new Matrix4();
  let vertices = 0;
  let drawn = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    if (position === undefined)
      throw new Error(`Chunk shadow proxy (${label}): a merged mesh carries no position.`);
    const copies = mesh instanceof InstancedMesh ? mesh.count : 1;
    const total = mesh.geometry.getIndex()?.count ?? position.count;
    const start = Math.min(total, Math.max(0, mesh.geometry.drawRange.start));
    vertices += position.count * copies;
    drawn += Math.max(0, Math.min(total, start + mesh.geometry.drawRange.count) - start) * copies;
  }
  const positions = new Float32Array(vertices * 3);
  const indices = new Uint32Array(drawn);
  let vertexAt = 0;
  let indexAt = 0;
  const geometry = new BufferGeometry();
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    if (position === undefined)
      throw new Error(`Chunk shadow proxy (${label}): a merged mesh carries no position.`);
    const source = mesh.geometry.getIndex();
    const total = source?.count ?? position.count;
    const start = Math.min(total, Math.max(0, mesh.geometry.drawRange.start));
    const end = Math.min(total, start + mesh.geometry.drawRange.count);
    const groupAt = indexAt;
    place.multiplyMatrices(toRoot, mesh.matrixWorld);
    for (let copy = 0; copy < (mesh instanceof InstancedMesh ? mesh.count : 1); copy += 1) {
      if (mesh instanceof InstancedMesh) mesh.getMatrixAt(copy, instance);
      else instance.identity();
      matrix.multiplyMatrices(place, instance);
      placeVertices(position as BufferAttribute, matrix, positions, vertexAt);
      for (let index = start; index < end; index += 1)
        indices[indexAt++] = (source?.getX(index) ?? index) + vertexAt;
      vertexAt += position.count;
    }
    geometry.addGroup(groupAt, indexAt - groupAt);
  }
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Keep retained sources' visibility, frustum and texel decisions on each level's single draw. */
function selectChunkShadowParts(proxy: Mesh, sources: readonly Mesh[]): void {
  const caster = proxy as Mesh & { chunkShadowProxy?: boolean; casterMinDiameter?: number };
  caster.chunkShadowProxy = true;
  // The source frustums below decide the exact inputs; the union must not veto that decision.
  proxy.frustumCulled = false;
  const geometry = proxy.geometry;
  const complete = ((geometry.getIndex() as BufferAttribute).array as Uint32Array).slice();
  const levels = new Map<Camera, { geometry: BufferGeometry; selected: Uint8Array }>();
  const disposeLevels = (event: { target: unknown }) => {
    const geometries = new Set([geometry]);
    for (const level of levels.values()) geometries.add(level.geometry);
    for (const held of geometries) held.removeEventListener("dispose", disposeLevels);
    for (const held of geometries) if (held !== event.target) held.dispose();
    levels.clear();
  };
  geometry.addEventListener("dispose", disposeLevels);
  const frustum = new Frustum();
  const projection = new Matrix4();
  const sphere = new Sphere();
  proxy.onBeforeRender = function (_renderer, _scene, camera) {
    let level = levels.get(camera);
    if (level === undefined) {
      if (levels.size === 3) {
        // ponytail: three resident camera buffers; extra cameras reuse the oldest slot.
        const oldest = levels.keys().next().value as Camera;
        level = levels.get(oldest) as { geometry: BufferGeometry; selected: Uint8Array };
        levels.delete(oldest);
        level.selected.fill(255);
      } else {
        const perLevel = levels.size === 0 ? geometry : new BufferGeometry();
        if (perLevel !== geometry) {
          perLevel.setAttribute("position", geometry.getAttribute("position"));
          perLevel.setIndex(new BufferAttribute(new Uint32Array(complete.length), 1));
          perLevel.boundingSphere = geometry.boundingSphere;
          perLevel.addEventListener("dispose", disposeLevels);
        }
        level = { geometry: perLevel, selected: new Uint8Array(sources.length).fill(255) };
      }
      levels.set(camera, level);
    }
    // Three fetches the render object after this hook and detects geometry identity changes,
    // even when different cameras share a render object. Exact projection stand-ins use `this`.
    this.geometry = level.geometry;
    const index = level.geometry.getIndex() as BufferAttribute;
    const selected = level.selected;
    frustum.setFromProjectionMatrix(
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    let changed = false;
    let count = 0;
    for (let part = 0; part < sources.length; part += 1) {
      const source = sources[part] as InstancedMesh;
      if (source.boundingSphere === null) source.computeBoundingSphere();
      sphere.copy(source.boundingSphere as Sphere).applyMatrix4(source.matrixWorld);
      let visible = true;
      for (let node: Object3D | null = source; node !== null; node = node.parent)
        if (!node.visible) visible = false;
      const draws =
        visible &&
        sphere.radius * 2 >= (caster.casterMinDiameter ?? 0) &&
        (!source.frustumCulled || frustum.intersectsObject(source));
      const next = draws ? 1 : 0;
      if (selected[part] !== next) changed = true;
      selected[part] = next;
      if (draws) count += geometry.groups[part]?.count ?? 0;
    }
    if (changed) {
      let at = 0;
      for (let part = 0; part < sources.length; part += 1) {
        const range = geometry.groups[part];
        if (selected[part] !== 1 || range === undefined) continue;
        (index.array as Uint32Array).set(
          complete.subarray(range.start, range.start + range.count),
          at,
        );
        at += range.count;
      }
      index.needsUpdate = true;
    }
    level.geometry.setDrawRange(0, count);
  };
}
