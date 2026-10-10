import {
  BufferAttribute,
  type BufferGeometry,
  Color,
  type ColorRepresentation,
  Float32BufferAttribute,
  type InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  Object3D,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * One piece on its way into a merged buffer.
 *
 * A `Mesh` is already one of these — pass the meshes straight in and their own transforms are
 * used. Every value here is the game's: the shape, where it sits, and what colour it is.
 */
export interface IMergePart {
  /** The piece's own colour, written flat across its vertices. Omit it on every part for none. */
  readonly color?: ColorRepresentation;
  /** The shape. It is cloned before anything is done to it, so the game's copy is untouched. */
  readonly geometry: BufferGeometry;
  /** Where the piece sits. A `Mesh` brings its own; identity when there is none. */
  readonly matrix?: Matrix4;
}

export interface IMergePartsOptions {
  /** Named in the error when the merge is refused. Say what was being built. */
  readonly label: string;
  /**
   * Channels to keep from each part besides `position`. Absent or empty keeps today's
   * position-only merge, whose normals are recomputed from the merged result.
   *
   * `"normal"` keeps each part's authored normals, transformed by the part's placement matrix
   * (the inverse-transpose normal matrix) and **never** recomputed. `"uv"` keeps each part's
   * texture coordinates verbatim — the placement matrix moves position and normal, so UV values
   * are retained unchanged. A part that does not carry a listed channel refuses the merge.
   */
  readonly preserve?: readonly ("uv" | "normal")[];
}

export interface IMergeByMaterialOptions {
  /** Named in the error when a group's merge is refused. Say what was being built. */
  readonly label: string;
  /**
   * Leaves one mesh out of its material's group and out of the result — a piece that moves at run
   * time, or one a capture script addresses by name.
   */
  readonly skip?: (mesh: Mesh) => boolean;
  /**
   * An `InstancedMesh` is baked into its material's group as one part per instance matrix while that
   * group stays at or below this many triangles. Above it — or absent, which is the old behaviour —
   * it comes back in the result untouched, because one instanced draw is already cheaper than the
   * triangles it expands into.
   */
  readonly expandInstancedUnderTriangles?: number;
  /**
   * Vertices one merged group may hold before the rest of its material's parts start a second mesh.
   *
   * One merged group is one upload on the frame that first draws it, and that upload is the frame's
   * whole cost: measured in a browser, a streamed world created 826 GPU buffers totalling 228.8 MB
   * out of `createAttribute`, 33 of them over 1 MB, and the first draw of the largest chunk meshes
   * took up to 230 ms. Splitting a material group in traversal order — which keeps the pieces
   * adjacent to the pieces they were placed beside — bounds each of those uploads instead of
   * trading one draw for a single enormous buffer. See `CHUNK_MERGE_MAX_VERTICES`.
   */
  readonly maxGroupVertices?: number;
}

/** The channels `mergeByMaterial` keeps, in the order it asks `mergeParts` for them. */
const MERGEABLE_CHANNELS = ["normal", "uv"] as const;

/** One material's parts that will become one mesh, and what that costs. */
interface IMergeGroup {
  readonly parts: IMergePart[];
  triangles: number;
  vertices: number;
}

/**
 * Triangles an `InstancedMesh`'s own shape may hold before the repeats are baked into the merge.
 *
 * Expanding trades one instanced draw for `count` copies of the shape, so the shape has to be worth
 * repeating: a box, a fence post, a kerb. A detailed prop is already one cheap draw whatever the
 * count, and baking it produces a merged buffer of the same detail per instance — the 228.8 MB of
 * triangle soup this whole path used to produce. 2,048 triangles is about where a repeated shape
 * stops being cheaper instanced than it is merged.
 */
const INSTANCED_REPEAT_MAX_TRIANGLES = 2048;

/**
 * Triangles one geometry submits: its index, or its vertex count where it carries none.
 */
function trianglesOf(geometry: BufferGeometry): number {
  const drawn = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
  return Math.floor(drawn / 3);
}

/** Vertices one part contributes to a merged group: its own, de-indexed or not. */
function verticesOf(geometry: BufferGeometry): number {
  return geometry.getAttribute("position")?.count ?? 0;
}

function placementMatrix(part: IMergePart): Matrix4 | undefined {
  if (!(part instanceof Object3D)) return part.matrix;
  if (!part.matrixAutoUpdate) return part.matrix;
  return new Matrix4().compose(part.position, part.quaternion, part.scale);
}

/**
 * Flatten one piece: place it, strip it to position plus the requested channels, and paint its colour.
 *
 * `mergeGeometries` needs every input to agree on indexing and on the exact set of attribute names. A
 * `BoxGeometry` is indexed and an `ExtrudeGeometry` is not, so a building made of both fails at the
 * first piece; the attribute sets diverge the same way. When the group is mixed, de-indexing
 * everything and keeping one known set of channels is what makes the two agree — the fallback, and
 * the only path that does.
 *
 * When **every** part is indexed there is nothing to reconcile, so the index is kept: the matrix is
 * baked into the cloned vertices and `mergeGeometries` offsets each part's indices into one index.
 * That is a third of the vertices a de-indexed merge uploads, and the saving is the whole point —
 * 228.8 MB of triangle soup over 826 buffers, on the first draw of every new chunk mesh.
 *
 * Position alone is the default and the normals are recomputed after the merge, because the merged
 * seam's normal is not either input's; a caller that asks for `normal` keeps the authored ones
 * instead, and `uv` is copied through.
 */
function flatten(
  part: IMergePart,
  paint: boolean,
  preserve: readonly ("uv" | "normal")[],
  deindex: boolean,
): BufferGeometry {
  const placed = part.geometry.clone();
  const matrix = placementMatrix(part);
  if (matrix !== undefined) placed.applyMatrix4(matrix);
  const flat = deindex && placed.index !== null ? placed.toNonIndexed() : placed;
  if (flat !== placed) placed.dispose();
  const keep = new Set<string>(["position", ...preserve]);
  for (const name of Object.keys(flat.attributes)) {
    if (!keep.has(name)) flat.deleteAttribute(name);
  }
  flat.morphAttributes = {};
  flat.morphTargetsRelative = false;
  // A cooked model's attributes are quantized (`KHR_mesh_quantization`: normalized Int16 uv,
  // Int8 normals, interleaved buffers), and `mergeGeometries` refuses parts whose arrays differ in
  // type. Every kept channel is merged as plain float, read through the attribute's own accessors
  // so normalization and interleaving resolve to the values three would have drawn.
  for (const name of Object.keys(flat.attributes)) {
    const attribute = flat.getAttribute(name);
    if (
      (attribute instanceof Float32BufferAttribute || attribute.array instanceof Float32Array) &&
      !attribute.normalized &&
      !("isInterleavedBufferAttribute" in attribute)
    )
      continue;
    const values = new Float32Array(attribute.count * attribute.itemSize);
    for (let index = 0; index < attribute.count; index += 1)
      for (let component = 0; component < attribute.itemSize; component += 1)
        values[index * attribute.itemSize + component] = attribute.getComponent(index, component);
    flat.setAttribute(name, new BufferAttribute(values, attribute.itemSize));
  }
  const position = flat.getAttribute("position");
  if (!paint || position === undefined) return flat;
  const tone = new Color(part.color);
  const painted = new Float32Array(position.count * 3);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    painted[vertex * 3] = tone.r;
    painted[vertex * 3 + 1] = tone.g;
    painted[vertex * 3 + 2] = tone.b;
  }
  flat.setAttribute("color", new BufferAttribute(painted, 3));
  return flat;
}

/**
 * Merge game-authored pieces into one buffer, keeping each piece's own colour and, when asked,
 * its uv and authored normals.
 *
 * Two things go wrong every time an agent bakes a building, a ship or a character out of
 * primitives, and neither is about how any of it looks. `mergeGeometries` returns `null` on
 * mismatched inputs instead of throwing, and the usual mismatch — one non-indexed extrusion among
 * a hundred indexed primitives — is invisible until the whole scene is missing; and a merged
 * buffer draws with one surface, so per-piece colour is gone unless every piece carries a flat
 * `color` attribute written before the merge. Writing that attribute is mechanical. The colours
 * are entirely the game's, one per part, and changing them changes nothing here. By default the
 * merged normals are recomputed from the merged buffer; `preserve` keeps the authored normals and
 * texture coordinates instead so an imported model's shading survives the bake.
 *
 * A group whose parts are all indexed merges indexed — the sum of their vertex counts, not three
 * times their triangles — and only a mixed group falls back to the de-indexed soup. One crossing
 * 65,535 vertices gets a 32-bit index, because a 16-bit one cannot name the vertex.
 */
export function mergeParts(
  parts: Iterable<IMergePart>,
  options: IMergePartsOptions,
): BufferGeometry {
  const list = [...parts];
  const { label } = options;
  const preserve = options.preserve ?? [];
  if (list.length === 0) throw new Error(`mergeParts(${label}): the part list is empty.`);
  const coloured = list.filter((part) => part.color !== undefined).length;
  if (coloured !== 0 && coloured !== list.length) {
    const reason = "A merged buffer needs the attribute on every part or on none of them.";
    throw new Error(
      `mergeParts(${label}): ${coloured} of ${list.length} parts name a colour. ${reason}`,
    );
  }
  list.forEach((part, index) => {
    for (const channel of preserve) {
      if (part.geometry.getAttribute(channel) === undefined) {
        throw new Error(
          `mergeParts(${label}): part ${index} has no ${channel} to preserve. Prepare the missing channel in the part's own data first.`,
        );
      }
    }
  });
  const flattened: BufferGeometry[] = [];
  // One indexed part among non-indexed ones is what `mergeGeometries` refuses, so a mixed group
  // de-indexes and an all-indexed group keeps its index and a third of its vertices.
  const deindex = !list.every((part) => part.geometry.index !== null);
  let merged: BufferGeometry | null;
  try {
    for (const part of list) flattened.push(flatten(part, coloured !== 0, preserve, deindex));
    merged = mergeGeometries(flattened, false);
  } finally {
    for (const geometry of flattened) geometry.dispose();
  }
  if (merged === null) {
    const reason = "three.js refused the merge and reported why on the console.";
    const requirement =
      "Every part needs a position attribute, and morph targets do not survive a merge.";
    throw new Error(`mergeParts(${label}): ${reason} Tried ${list.length} parts. ${requirement}`);
  }
  if (!deindex) widenIndex(merged);
  if (!preserve.includes("normal")) merged.computeVertexNormals();
  return merged;
}

/**
 * A 16-bit index cannot name a vertex past 65,535, so a merge that crosses that is unreadable.
 * Three picks the type from the inputs, so one widened here is the only place it can be wrong.
 */
function widenIndex(geometry: BufferGeometry): void {
  const index = geometry.getIndex();
  const vertices = geometry.getAttribute("position")?.count ?? 0;
  if (index === null || index.array instanceof Uint32Array || vertices <= 65_535) return;
  const widened = new Uint32Array(index.count);
  for (let at = 0; at < index.count; at += 1) widened[at] = index.getX(at);
  geometry.setIndex(new BufferAttribute(widened, 1));
}

/**
 * Bake a hierarchy's static meshes into one mesh per material, transforms and all.
 *
 * A building or a ship is dozens of boxes and cylinders that never move relative to each other, and
 * every one of them is a draw call. Grouping by material and merging each group is the ordinary
 * fix, and the ordinary fix is thirty lines an agent rewrites in every game, each time slightly
 * differently: walk the tree, group by material, bake `matrixWorld` into the vertices, hand the
 * group to `mergeParts`, build a mesh on the game's own material. The parts here are the same
 * `IMergePart` list, so a game that already merges by hand gets the same refusals — a group that
 * cannot merge throws naming `label:material`, not silently vanishing.
 *
 * Nothing here decides how anything looks: the material is the game's own instance, the geometry is
 * exactly what was authored, and the group split follows the materials the game already made.
 *
 * `normal` survives when every mesh in a group carries it and is recomputed otherwise. `uv` survives
 * when any mesh carries it, so a group where only some do is the refusal `mergeParts` raises, never
 * a texture silently left unmapped. Skinned meshes are left alone — their vertices are posed per
 * frame — and an instanced one is left alone unless `expandInstancedUnderTriangles` names a cap its
 * group fits under and its own shape is small enough to be worth repeating, which bakes every
 * instance matrix into the merge.
 *
 * `maxGroupVertices` bounds a single group, and a material whose parts cross it is merged into
 * several meshes in traversal order — more draws, none of them carrying a buffer big enough to stall
 * the frame that first submits it.
 */
export function mergeByMaterial(root: Object3D, options: IMergeByMaterialOptions): Mesh[] {
  root.updateMatrixWorld(true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert();
  const byMaterial = new Map<Material, IMergeGroup[]>();
  const kept: Mesh[] = [];
  /** The group a part joins: the last one, or a new one once that one has taken its vertex budget. */
  const groupFor = (material: Material, part: IMergePart): IMergeGroup => {
    let groups = byMaterial.get(material);
    if (groups === undefined) {
      groups = [];
      byMaterial.set(material, groups);
    }
    const open = groups[groups.length - 1];
    const vertices = verticesOf(part.geometry);
    if (
      open === undefined ||
      open.vertices + vertices > (options.maxGroupVertices ?? Number.POSITIVE_INFINITY)
    ) {
      const started: IMergeGroup = { parts: [], triangles: 0, vertices: 0 };
      groups.push(started);
      return started;
    }
    return open;
  };
  const add = (material: Material, part: IMergePart, triangles: number): IMergeGroup => {
    const group = groupFor(material, part);
    group.parts.push(part);
    group.triangles += triangles;
    group.vertices += verticesOf(part.geometry);
    return group;
  };
  root.traverse((object) => {
    // three's own discriminators, read structurally the way `assets.ts` reads `isTexture`.
    const renderable = object as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
    if (!renderable.isMesh || renderable.isSkinnedMesh) return;
    if (Array.isArray(renderable.material) || options.skip?.(renderable) === true) return;
    const place = toRoot.clone().multiply(renderable.matrixWorld);
    if (renderable.isInstancedMesh !== true) {
      add(
        renderable.material,
        { geometry: renderable.geometry, matrix: place },
        trianglesOf(renderable.geometry),
      );
      return;
    }
    const instanced = renderable as InstancedMesh;
    const shape = trianglesOf(instanced.geometry);
    const cost = instanced.count * shape;
    const cap = options.expandInstancedUnderTriangles;
    // The group the repeats would join, which a shape too big to repeat never gets to: expanding a
    // detailed prop repeats its detail per instance, and one instanced draw of it beats a merged
    // buffer of the expanded soup by everything the expansion costs.
    const target = groupFor(renderable.material, {
      geometry: instanced.geometry,
      matrix: place,
    });
    if (
      cap === undefined ||
      shape > INSTANCED_REPEAT_MAX_TRIANGLES ||
      target.triangles + cost > cap
    ) {
      kept.push(instanced);
      return;
    }
    const instance = new Matrix4();
    for (let index = 0; index < instanced.count; index += 1) {
      instanced.getMatrixAt(index, instance);
      add(
        renderable.material,
        { geometry: instanced.geometry, matrix: place.clone().multiply(instance) },
        shape,
      );
    }
  });
  const merged: Mesh[] = [];
  [...byMaterial].forEach(([material, groups], index) => {
    groups.forEach((group, part) => {
      // A group of nothing is an instanced mesh of zero instances: nothing to draw, nothing to refuse.
      if (group.parts.length === 0) return;
      // A normal missing from one piece is recomputed; a uv missing from one piece is a refusal, since
      // dropping it would leave the group's texture unmapped without a word.
      const has = (piece: IMergePart, channel: "normal" | "uv") =>
        piece.geometry.getAttribute(channel) !== undefined;
      const preserve = MERGEABLE_CHANNELS.filter((channel) =>
        channel === "uv"
          ? group.parts.some((piece) => has(piece, channel))
          : group.parts.every((piece) => has(piece, channel)),
      );
      merged.push(
        new Mesh(
          mergeParts(group.parts, {
            label: `${options.label}:${material.name || index}${part === 0 ? "" : `#${part}`}`,
            preserve,
          }),
          material,
        ),
      );
    });
  });
  return [...merged, ...kept];
}
