import { type BufferGeometry, Vector3 } from "three";

/**
 * A far level for a card mesh: keep `keep` of its cards and grow each kept card about its own
 * centre so the mesh holds its total surface area.
 *
 * Needle and leaf cards are disconnected quads, so an edge-collapse simplifier cannot reduce them
 * (the asset cook's chain skips them, and a far tree drew every card of its middle level to the
 * horizon). Dropping cards alone thins the crown, so the kept ones take the lost area, as Unreal's
 * Nanite "Preserve Area" foliage does (UE 5.8.3:
 * Engine/Source/Developer/MeshSimplifier/Private/MeshSimplify.cpp `PreserveSurfaceArea`).
 *
 * A card is one island of triangles joined by shared vertex indices. The choice is deterministic: a
 * fixed-seed shuffle of the islands, taken until the triangle share is met. Positions move; every
 * other attribute is kept, and a uniform scale about the centre leaves normals and UVs valid.
 *
 * Only the drawn range counts: a material section cut from a shared index by `setDrawRange` thins its
 * own triangles, and the result, whose index holds just the kept ones, draws its whole index.
 */
export function thinCards(geometry: BufferGeometry, keep: number): BufferGeometry {
  if (!(keep > 0 && keep <= 1)) throw new Error(`thinCards keep must be in (0, 1], got ${keep}.`);
  const index = geometry.index;
  if (index === null) throw new Error("thinCards needs an indexed geometry.");
  if (geometry.groups.length > 0) throw new Error("thinCards cannot keep material groups.");
  const [first, end] = drawnRange(geometry);
  const triangles = (end - first) / 3;
  const target = Math.max(1, Math.round(triangles * keep));
  if (target >= triangles) return geometry;

  const position = geometry.getAttribute("position");
  const { kept, scale } = pickCards([...cardIslands(geometry, first, end).values()], target);

  const out = geometry.clone();
  const moved = out.getAttribute("position");
  const indices: number[] = [];
  const vertex = new Vector3();
  for (const island of kept) {
    // An island of zero area accumulated nothing in the weighted centre, so it takes the plain mean of
    // its triangle centroids; the origin would scale the card about the world origin instead.
    const centre =
      island.area > 0
        ? island.centre.divideScalar(island.area)
        : island.plain.divideScalar(island.firsts.length);
    const own = new Set<number>();
    for (const t of island.firsts)
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t + k);
        indices.push(v);
        own.add(v);
      }
    for (const v of own) {
      vertex.fromBufferAttribute(position, v).sub(centre).multiplyScalar(scale).add(centre);
      moved.setXYZ(v, vertex.x, vertex.y, vertex.z);
    }
  }
  moved.needsUpdate = true;
  out.setIndex(indices);
  out.setDrawRange(0, Number.POSITIVE_INFINITY);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

interface ICardIsland {
  readonly firsts: number[];
  area: number;
  /** Area-weighted sum of the triangle centroids; the centre once divided by `area`. */
  readonly centre: Vector3;
  /** Unweighted sum of the triangle centroids, the centre of an island whose area is zero. */
  readonly plain: Vector3;
}

/** The index entries the geometry draws, [first, end), whole triangles. */
function drawnRange(geometry: BufferGeometry): [number, number] {
  const count = (geometry.index as NonNullable<BufferGeometry["index"]>).count;
  const first = Math.min(count, Math.max(0, geometry.drawRange.start));
  const end = Math.min(count, first + geometry.drawRange.count);
  return [first - (first % 3), end - ((end - first) % 3)];
}

/** Islands of the drawn triangles joined by shared vertex indices, with their area and centres. */
function cardIslands(
  geometry: BufferGeometry,
  first: number,
  end: number,
): Map<number, ICardIsland> {
  const index = geometry.index as NonNullable<BufferGeometry["index"]>;
  const position = geometry.getAttribute("position");
  const parent = Int32Array.from({ length: position.count }, (_, i) => i);
  const find = (vertex: number): number => {
    let at = vertex;
    while (parent[at] !== at) {
      parent[at] = parent[parent[at] as number] as number;
      at = parent[at] as number;
    }
    return at;
  };
  for (let t = first; t < end; t += 3) {
    const root = find(index.getX(t));
    parent[find(index.getX(t + 1))] = root;
    parent[find(index.getX(t + 2))] = root;
  }

  const islands = new Map<number, ICardIsland>();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let t = first; t < end; t += 3) {
    a.fromBufferAttribute(position, index.getX(t));
    b.fromBufferAttribute(position, index.getX(t + 1));
    c.fromBufferAttribute(position, index.getX(t + 2));
    const centre = a.clone().add(b).add(c).divideScalar(3);
    const area = b.sub(a).cross(c.sub(a)).length() / 2;
    const root = find(index.getX(t));
    const island = islands.get(root) ?? {
      firsts: [],
      area: 0,
      centre: new Vector3(),
      plain: new Vector3(),
    };
    island.firsts.push(t);
    island.area += area;
    island.centre.addScaledVector(centre, area);
    island.plain.add(centre);
    islands.set(root, island);
  }

  return islands;
}

/** A fixed-seed shuffle of the islands, taken until `target` triangles, and the scale that keeps the area. */
function pickCards(order: ICardIsland[], target: number): { kept: ICardIsland[]; scale: number } {
  let seed = 0x9e3779b9;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j] as ICardIsland, order[i] as ICardIsland];
  }
  const total = order.reduce((sum, island) => sum + island.area, 0);
  const kept: ICardIsland[] = [];
  let keptTriangles = 0;
  let keptArea = 0;
  for (const island of order) {
    if (keptTriangles >= target) break;
    kept.push(island);
    keptTriangles += island.firsts.length;
    keptArea += island.area;
  }
  const scale = keptArea > 0 ? Math.sqrt(total / keptArea) : 1;

  return { kept, scale };
}
