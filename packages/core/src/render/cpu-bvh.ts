/**
 * A CPU bounding-volume hierarchy for the probe trace, in the node layout the trace threads
 * (`threadBvh`): 8 words a node, bounds as 6 floats, then a leaf offset and `0xffff0000 | count`, or the
 * right child's distance in nodes and an axis. The left child of node `i` is node `i + 1`.
 *
 * It exists because the owned engine's `MeshBVH` builds no tree (`TN_NATIVE_MESH_BVH_OPTIONS_UNSUPPORTED`),
 * so `GPUSceneBVH` cannot take its nodes there. A median split along the longest centroid axis is
 * slower to trace than a surface-area split. It builds in O(n log^2 n) and is correct on any engine.
 */
const LEAF_FLAG = 0xffff0000;
export const CPU_BVH_LEAF_SIZE = 8;

export interface ICpuBvh {
  /** 8 words a node, depth-first, left child first. */
  readonly nodes: Uint32Array;
  /** `order[slot]` is the source triangle held at leaf slot `slot`. */
  readonly order: Uint32Array;
}

/** `positions` are tight xyz triples and `indices` three vertex indices a triangle. */
export function buildCpuBvh(positions: Float32Array, indices: Uint32Array): ICpuBvh {
  const count = Math.floor(indices.length / 3);
  const order = Uint32Array.from({ length: count }, (_, i) => i);
  if (count === 0) return { nodes: new Uint32Array(8), order };
  const low = new Float32Array(count * 3);
  const high = new Float32Array(count * 3);
  const centre = new Float32Array(count * 3);
  for (let t = 0; t < count; t += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let corner = 0; corner < 3; corner += 1) {
        const value = positions[(indices[t * 3 + corner] as number) * 3 + axis] as number;
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
      low[t * 3 + axis] = lo;
      high[t * 3 + axis] = hi;
      centre[t * 3 + axis] = (lo + hi) / 2;
    }
  }
  const words: number[] = [];
  const floats = new Float32Array(1);
  const bits = new Uint32Array(floats.buffer);
  const bitsOf = (value: number): number => {
    floats[0] = value;
    return bits[0] as number;
  };
  const build = (start: number, end: number): number => {
    const node = words.length / 8;
    words.push(0, 0, 0, 0, 0, 0, 0, 0);
    const box = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    const middle = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (let slot = start; slot < end; slot += 1) {
      const t = order[slot] as number;
      for (let axis = 0; axis < 3; axis += 1) {
        box[axis] = Math.min(box[axis] as number, low[t * 3 + axis] as number);
        box[axis + 3] = Math.max(box[axis + 3] as number, high[t * 3 + axis] as number);
        middle[axis] = Math.min(middle[axis] as number, centre[t * 3 + axis] as number);
        middle[axis + 3] = Math.max(middle[axis + 3] as number, centre[t * 3 + axis] as number);
      }
    }
    for (let i = 0; i < 6; i += 1) words[node * 8 + i] = bitsOf(box[i] as number);
    const spread = (a: number) => (middle[a + 3] as number) - (middle[a] as number);
    let axis = 0;
    if (spread(1) > spread(axis)) axis = 1;
    if (spread(2) > spread(axis)) axis = 2;
    if (end - start <= CPU_BVH_LEAF_SIZE || spread(axis) <= 0) {
      words[node * 8 + 6] = start;
      words[node * 8 + 7] = (LEAF_FLAG | (end - start)) >>> 0;
      return node;
    }
    const slice = Array.from(order.subarray(start, end)).sort(
      (a, b) => (centre[a * 3 + axis] as number) - (centre[b * 3 + axis] as number),
    );
    order.set(slice, start);
    const half = start + ((end - start) >> 1);
    build(start, half);
    const right = build(half, end);
    words[node * 8 + 6] = right - node;
    words[node * 8 + 7] = axis;
    return node;
  };
  build(0, count);
  return { nodes: Uint32Array.from(words), order };
}
