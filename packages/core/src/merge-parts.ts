import {
  BufferAttribute,
  BufferGeometry,
  Color,
  type ColorRepresentation,
  type InstancedMesh,
  type InterleavedBufferAttribute,
  type Material,
  Matrix3,
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
 * Three's `denormalize` divisor for an array's type, or `-1` for a type it does not know.
 *
 * `denormalize` divides by it and clamps at `-1`; `normalize` multiplies by the same number and
 * rounds. A float channel's divisor is `0`, because both are the identity there and the copy skips
 * them. One number covers both directions because three switches on the same array constructor for
 * each.
 */
function divisorOf(array: IRawNumbers): number {
  if (array instanceof Float32Array) return 0;
  if (array instanceof Int8Array) return 127;
  if (array instanceof Uint8Array) return 255;
  if (array instanceof Int16Array) return 32767;
  if (array instanceof Uint16Array) return 65535;
  if (array instanceof Int32Array) return 2147483647;
  if (array instanceof Uint32Array) return 4294967295;
  return -1;
}

/**
 * Where one channel's raw components live, addressed for a copy loop.
 *
 * A cooked model's channels are quantized and interleaved (`KHR_mesh_quantization`: normalized Int8
 * normals inside a shared stride), so three reaches them through `getX`/`setXYZ`, which denormalizes,
 * multiplies and renormalizes one component at a time through a `Vector3`, and a `clone()` of such a
 * channel de-interleaves it first through a boxed `Array`. Read straight out of the array the same
 * arithmetic is three additions and a divide, and nothing is copied five times to get there.
 */
interface IChannel {
  /** Components one vertex holds. */
  readonly itemSize: number;
  /** Vertices the part contributes: its own, or its index count where the group de-indexes. */
  readonly count: number;
  /** Components between two vertices: the interleaved stride, or `itemSize` for a plain attribute. */
  readonly stride: number;
  /** Where this channel sits inside a vertex. */
  readonly offset: number;
  /** The raw numbers: an interleaved buffer's array, or a plain attribute's. */
  readonly array: IRawNumbers;
  /** {@link divisorOf} for this channel's array, or `-1` when this path cannot read it. */
  readonly scale: number;
}

/** Raw components, addressed by index: any typed array three reads a channel out of. */
interface IRawNumbers {
  readonly [component: number]: number;
}

/** The channel a kept attribute reads as, or `undefined` for a type this path cannot read. */
function channelOf(attribute: BufferAttribute, count: number): IChannel | undefined {
  if (Reflect.get(attribute, "isFloat16BufferAttribute") === true) return undefined;
  // quality-allow: three types a geometry attribute as BufferAttribute; the flag below tells them apart.
  const interleaved = attribute as unknown as InterleavedBufferAttribute | undefined;
  const data = interleaved?.isInterleavedBufferAttribute === true ? interleaved.data : undefined;
  const array = (data?.array ?? attribute.array) as IRawNumbers;
  const scale = divisorOf(array);
  if (scale < 0) return undefined;
  return {
    array,
    count,
    itemSize: attribute.itemSize,
    offset: data === undefined ? 0 : (interleaved?.offset ?? 0),
    scale,
    stride: data?.stride ?? attribute.itemSize,
  };
}

/** The index a de-indexing part reads its vertices through, or `null` when it reads them in order. */
function indexOf(part: IMergePart, deindex: boolean): Uint16Array | Uint32Array | null {
  if (!deindex) return null;
  const index = part.geometry.getIndex();
  if (index === null) return null;
  const array = index.array;
  if (array instanceof Uint16Array) return array;
  if (array instanceof Uint32Array) return array;
  return null;
}

/** The 16 elements of a placement, read once so the loop below reads locals. */
type PlacementElements = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** The 9 elements of an inverse transpose, read once so the loop below reads locals. */
type NormalElements = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Positions of one part, placed, written into `values` at `at`.
 *
 * The expression is three's `Vector3.applyMatrix4` term for term over the same elements in the same
 * order, including its homogeneous divide, so a merged buffer holds the values it held before. The
 * second half of it is what `setXYZ` wrote back into the part's own typed array before the
 * de-quantizing copy read it again: `normalize` rounds into the channel's own range — the scratch
 * store keeps a value outside that range wrapping exactly as three's store did — and `denormalize`
 * reads it back as a float.
 */
function writePosition(
  channel: IChannel,
  indices: Uint16Array | Uint32Array | null,
  elements: PlacementElements | null,
  scratch: IScratch | null,
  values: Float32Array,
  at: number,
): void {
  const { array, count, offset, scale, stride } = channel;
  for (let vertex = 0; vertex < count; vertex += 1) {
    const base = (indices === null ? vertex : (indices[vertex] as number)) * stride + offset;
    const raw = array as { [component: number]: number | undefined };
    const x = scale === 0 ? (raw[base] as number) : Math.max((raw[base] as number) / scale, -1);
    const y =
      scale === 0 ? (raw[base + 1] as number) : Math.max((raw[base + 1] as number) / scale, -1);
    const z =
      scale === 0 ? (raw[base + 2] as number) : Math.max((raw[base + 2] as number) / scale, -1);
    let px: number;
    let py: number;
    let pz: number;
    if (elements === null) {
      px = x;
      py = y;
      pz = z;
    } else {
      const e = elements;
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
      px = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
      py = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
      pz = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    }
    const out = at + vertex * 3;
    if (scratch !== null) {
      scratch[0] = Math.round(px * scale);
      scratch[1] = Math.round(py * scale);
      scratch[2] = Math.round(pz * scale);
      px = Math.max((scratch[0] as number) / scale, -1);
      py = Math.max((scratch[1] as number) / scale, -1);
      pz = Math.max((scratch[2] as number) / scale, -1);
    }
    values[out] = px;
    values[out + 1] = py;
    values[out + 2] = pz;
  }
}

/**
 * Normals of one part, placed by the inverse transpose, written into `values` at `at`. Three's
 * `applyNormalMatrix`, term for term, quantized back to the channel's own range exactly as
 * {@link writePosition} does.
 */
function writeNormal(
  channel: IChannel,
  indices: Uint16Array | Uint32Array | null,
  elements: NormalElements | null,
  scratch: IScratch | null,
  values: Float32Array,
  at: number,
): void {
  const { array, count, offset, scale, stride } = channel;
  const e = elements;
  for (let vertex = 0; vertex < count; vertex += 1) {
    const base = (indices === null ? vertex : (indices[vertex] as number)) * stride + offset;
    const raw = array as { [component: number]: number | undefined };
    const x = scale === 0 ? (raw[base] as number) : Math.max((raw[base] as number) / scale, -1);
    const y =
      scale === 0 ? (raw[base + 1] as number) : Math.max((raw[base + 1] as number) / scale, -1);
    const z =
      scale === 0 ? (raw[base + 2] as number) : Math.max((raw[base + 2] as number) / scale, -1);
    let px: number;
    let py: number;
    let pz: number;
    if (e === null) {
      px = x;
      py = y;
      pz = z;
    } else {
      px = e[0] * x + e[3] * y + e[6] * z;
      py = e[1] * x + e[4] * y + e[7] * z;
      pz = e[2] * x + e[5] * y + e[8] * z;
      // `Vector3.applyNormalMatrix` ends in `normalize()`, so a placed normal is a unit normal and
      // not the scaled vector the matrix produced — the same three terms, then its `length()` and
      // its `multiplyScalar(1 / length)`.
      const by = 1 / (Math.sqrt(px * px + py * py + pz * pz) || 1);
      px *= by;
      py *= by;
      pz *= by;
    }
    const out = at + vertex * 3;
    if (scratch !== null) {
      scratch[0] = Math.round(px * scale);
      scratch[1] = Math.round(py * scale);
      scratch[2] = Math.round(pz * scale);
      px = Math.max((scratch[0] as number) / scale, -1);
      py = Math.max((scratch[1] as number) / scale, -1);
      pz = Math.max((scratch[2] as number) / scale, -1);
    }
    values[out] = px;
    values[out + 1] = py;
    values[out + 2] = pz;
  }
}

/**
 * Every other kept channel of one part, copied through as three's de-quantizing copy read it, and one
 * part's flat colour written over `count` vertices.
 */
function writeThrough(
  channel: IChannel,
  indices: Uint16Array | Uint32Array | null,
  values: Float32Array,
  at: number,
): void {
  const { array, count, itemSize, offset, scale, stride } = channel;
  if (scale === 0) {
    for (let vertex = 0; vertex < count; vertex += 1) {
      const from = (indices === null ? vertex : (indices[vertex] as number)) * stride + offset;
      const out = at + vertex * itemSize;
      for (let component = 0; component < itemSize; component += 1)
        values[out + component] = array[from + component] as number;
    }
    return;
  }
  for (let vertex = 0; vertex < count; vertex += 1) {
    const from = (indices === null ? vertex : (indices[vertex] as number)) * stride + offset;
    const out = at + vertex * itemSize;
    for (let component = 0; component < itemSize; component += 1)
      values[out + component] = Math.max((array[from + component] as number) / scale, -1);
  }
}

/** One part's flat colour, written across every vertex it contributes. */
function writeColour(values: Float32Array, at: number, count: number, tone: Color): void {
  for (let vertex = 0; vertex < count; vertex += 1) {
    const out = at + vertex * 3;
    values[out] = tone.r;
    values[out + 1] = tone.g;
    values[out + 2] = tone.b;
  }
}

/**
 * A three-component scratch array of one channel's own type, standing in for the in-place
 * quantization `setXYZ` did on the part three had cloned.
 */
interface IScratch {
  [component: number]: number;
}

/** A scratch array of one channel's own type, where `setXYZ` would have quantized in place. */
function scratchOf(array: IRawNumbers): IScratch | null {
  if (array instanceof Int8Array) return new Int8Array(3);
  if (array instanceof Int16Array) return new Int16Array(3);
  if (array instanceof Int32Array) return new Int32Array(3);
  if (array instanceof Uint8Array) return new Uint8Array(3);
  if (array instanceof Uint16Array) return new Uint16Array(3);
  if (array instanceof Uint32Array) return new Uint32Array(3);
  return null;
}

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
      attribute.array instanceof Float32Array &&
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
  // One indexed part among non-indexed ones is what `mergeGeometries` refuses, so a mixed group
  // de-indexes and an all-indexed group keeps its index and a third of its vertices.
  const deindex = !list.every((part) => part.geometry.index !== null);
  const merged = fusable(list, preserve, deindex)
    ? concatenate(list, coloured !== 0, preserve, deindex, label)
    : mergeThroughThree(list, coloured !== 0, preserve, deindex, label);
  if (!preserve.includes("normal")) merged.computeVertexNormals();
  return merged;
}

/** The channels a group keeps, in the order the first part carries them — a merged buffer's own order. */
function keptChannels(first: IMergePart, preserve: readonly ("uv" | "normal")[]): string[] {
  const keep = new Set<string>(["position", ...preserve]);
  return Object.keys(first.geometry.attributes).filter((name) => keep.has(name));
}

/** Vertices one part contributes: its index count where the group de-indexes, else its own. */
function contributes(part: IMergePart, deindex: boolean): number {
  const index = part.geometry.getIndex();
  if (!deindex || index === null) return part.geometry.getAttribute("position")?.count ?? 0;
  return index.count;
}

/**
 * Whether {@link concatenate} can read every channel this group keeps. It cannot for a type three's
 * `normalize`/`denormalize` do not describe (half floats) or for a position that is not three
 * components, and those groups take the path that was always here.
 */
function fusable(
  list: readonly IMergePart[],
  preserve: readonly ("uv" | "normal")[],
  deindex: boolean,
): boolean {
  if (!preserve.every((channel) => channel === "uv" || channel === "normal")) return false;
  const names = keptChannels(list[0] as IMergePart, preserve);
  return list.every((part) => fusablePart(part, names, deindex));
}

/** One part's answer to {@link fusable}, per kept channel. */
function fusablePart(part: IMergePart, names: readonly string[], deindex: boolean): boolean {
  const index = part.geometry.getIndex();
  if (deindex && index !== null && indexOf(part, deindex) === null) return false;
  const count = contributes(part, deindex);
  return names.every((name) => {
    const attribute = part.geometry.getAttribute(name);
    if (attribute === undefined) return false;
    // A channel whose vertex count is not the part's own would merge at a length of its own, which
    // is a buffer three had already stopped being able to draw; that part takes the three path.
    if (attribute.count !== count) return false;
    if (attribute.itemSize !== 3 && (name === "position" || name === "normal")) return false;
    return channelOf(attribute as BufferAttribute, count) !== undefined;
  });
}

/**
 * Every part's channels, placed and de-quantized, written straight into one buffer.
 *
 * This is what `flatten` and `mergeGeometries` did between them, without the intermediates: no
 * `clone()` (which de-interleaves a quantized channel through a boxed `Array`), no `toNonIndexed()`,
 * no per-channel re-quantizing copy, no second copy into the merged attributes, and no index built
 * one `Array.push` at a time. Each byte of a part is read once and lands once, which is the whole of
 * a 5.5 ms/MB merge becoming a fraction of that.
 */
function concatenate(
  list: readonly IMergePart[],
  paint: boolean,
  preserve: readonly ("uv" | "normal")[],
  deindex: boolean,
  label: string,
): BufferGeometry {
  const names = keptChannels(list[0] as IMergePart, preserve);
  if (paint) names.push("color");
  const counts = list.map((part) => contributes(part, deindex));
  const vertices = counts.reduce((total, count) => total + count, 0);
  const geometry = new BufferGeometry();
  for (const name of names) {
    const itemSize =
      name === "color" ? 3 : ((list[0] as IMergePart).geometry.getAttribute(name)?.itemSize ?? 3);
    const values = new Float32Array(vertices * itemSize);
    let at = 0;
    for (let part = 0; part < list.length; part += 1) {
      const count = counts[part] as number;
      if (name === "color") writeColour(values, at, count, new Color(list[part]?.color));
      else writeChannel(name, list[part] as IMergePart, count, deindex, label, values, at);
      at += count * itemSize;
    }
    geometry.setAttribute(name, new BufferAttribute(values, itemSize));
  }
  geometry.setIndex(deindex ? null : new BufferAttribute(mergeIndex(list, vertices), 1));
  return geometry;
}

/** One part's one kept channel, placed and de-quantized into `values` at `at`. */
function writeChannel(
  name: string,
  part: IMergePart,
  count: number,
  deindex: boolean,
  label: string,
  values: Float32Array,
  at: number,
): void {
  const channel = channelOf(part.geometry.getAttribute(name) as BufferAttribute, count);
  if (channel === undefined)
    throw new Error(`mergeParts(${label}): a part has no ${name} this path can read.`);
  const indices = indexOf(part, deindex);
  const matrix = placementMatrix(part);
  if (name === "position") {
    writePosition(
      channel,
      indices,
      // quality-allow: Matrix4.elements is number[] in three's types and always 16 long.
      matrix === undefined ? null : (matrix.elements as unknown as PlacementElements),
      scratchOf(channel.array),
      values,
      at,
    );
    return;
  }
  if (name === "normal") {
    writeNormal(
      channel,
      indices,
      matrix === undefined
        ? null
        : // quality-allow: Matrix3.elements is number[] in three's types and always 9 long.
          (new Matrix3().getNormalMatrix(matrix).elements as unknown as NormalElements),
      scratchOf(channel.array),
      values,
      at,
    );
    return;
  }
  writeThrough(channel, indices, values, at);
}

/**
 * One index for the whole group, each part's offset by the vertices before it — a 32-bit one past
 * 65,535 vertices, because a 16-bit one cannot name the vertex, which is the same rule `widenIndex`
 * applied to a merged index three had already built.
 */
function mergeIndex(list: readonly IMergePart[], vertices: number): Uint16Array | Uint32Array {
  let total = 0;
  for (const part of list) total += part.geometry.getIndex()?.count ?? 0;
  const merged = vertices > 65_535 ? new Uint32Array(total) : new Uint16Array(total);
  let at = 0;
  let offset = 0;
  for (const part of list) {
    const source = part.geometry.getIndex();
    if (source === null) continue;
    const values = source.array as Uint16Array | Uint32Array;
    for (let entry = 0; entry < source.count; entry += 1)
      merged[at + entry] = (values[entry] as number) + offset;
    at += source.count;
    offset += part.geometry.getAttribute("position")?.count ?? 0;
  }
  return merged;
}

/**
 * The path that was always here: `flatten` each part and hand the lot to `mergeGeometries`. It is
 * what a group whose channels this file cannot read directly — a half-float channel, a position that
 * is not three components — takes, and the refusals it raises are the ones a caller already handles.
 */
function mergeThroughThree(
  list: readonly IMergePart[],
  paint: boolean,
  preserve: readonly ("uv" | "normal")[],
  deindex: boolean,
  label: string,
): BufferGeometry {
  const flattened: BufferGeometry[] = [];
  let merged: BufferGeometry | null;
  try {
    for (const part of list) flattened.push(flatten(part, paint, preserve, deindex));
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
