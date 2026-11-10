// three's EdgesGeometry over the engine's BufferGeometry, ported from three r187
// src/geometries/EdgesGeometry.js (MIT). The engine binds no Triangle, so the face normal is three's
// Triangle.getNormal written over plain numbers. The source arrays are read once: each engine
// `array` read is one copy, where three's per-vertex getX would be one engine call per component.
// ponytail: positions are read raw, so a normalized (quantized) position attribute is not denormalized.

type Constructor = new (...args: never[]) => object;
type V3 = [number, number, number];

interface IAttribute {
  readonly array: ArrayLike<number>;
  readonly itemSize: number;
  readonly count: number;
}

interface IGeometry {
  getIndex(): IAttribute | null;
  getAttribute(name: string): IAttribute;
  setAttribute(name: string, attribute: object): void;
}

// three's Triangle.getNormal: (c - b) x (a - b), normalized; zero for a degenerate triangle.
function faceNormal([ax, ay, az]: V3, [bx, by, bz]: V3, [cx, cy, cz]: V3): V3 {
  const [ux, uy, uz] = [cx - bx, cy - by, cz - bz];
  const [vx, vy, vz] = [ax - bx, ay - by, az - bz];
  const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const lengthSq = nx * nx + ny * ny + nz * nz;
  const scale = lengthSq > 0 ? 1 / Math.sqrt(lengthSq) : 0;
  return [nx * scale, ny * scale, nz * scale];
}

interface IEdges {
  readonly map: Map<string, { index0: number; index1: number; normal: V3 } | null>;
  readonly vertices: number[];
  readonly point: (vertex: number) => V3;
  readonly thresholdDot: number;
}

const PRECISION = 10 ** 4;
const hash = (p: V3) => p.map((value) => Math.round(value * PRECISION)).join(",");

// One triangle's three edges: a shared edge is kept when its faces meet at the threshold angle or more.
function addFace(edges: IEdges, ids: V3): void {
  const corners = [edges.point(ids[0]), edges.point(ids[1]), edges.point(ids[2])] as const;
  const normal = faceNormal(...corners);
  const hashes = corners.map(hash);
  // Skip degenerate triangles.
  if (hashes[0] === hashes[1] || hashes[1] === hashes[2] || hashes[2] === hashes[0]) return;
  for (let j = 0; j < 3; j++) {
    const next = (j + 1) % 3;
    const key = `${hashes[j]}_${hashes[next]}`;
    const reverse = `${hashes[next]}_${hashes[j]}`;
    const sibling = edges.map.get(reverse);
    if (sibling) {
      const [sx, sy, sz] = sibling.normal;
      if (normal[0] * sx + normal[1] * sy + normal[2] * sz <= edges.thresholdDot)
        edges.vertices.push(...(corners[j] as V3), ...(corners[next] as V3));
      edges.map.set(reverse, null);
    } else if (!edges.map.has(key))
      edges.map.set(key, { index0: ids[j] as number, index1: ids[next] as number, normal });
  }
}

// The edge segments of `geometry`: border edges and edges whose faces meet at `thresholdAngle` or more.
function edgeVertices(geometry: IGeometry, thresholdAngle: number): number[] {
  const index = geometry.getIndex();
  const indices = index?.array;
  const attribute = geometry.getAttribute("position");
  const { array: positions, itemSize: stride } = attribute;
  const edges: IEdges = {
    map: new Map(),
    vertices: [],
    point: (vertex) => {
      const at = vertex * stride;
      return [positions[at] ?? 0, positions[at + 1] ?? 0, positions[at + 2] ?? 0];
    },
    thresholdDot: Math.cos((Math.PI / 180) * thresholdAngle),
  };
  const vertexAt = (i: number) => (indices ? (indices[i] ?? 0) : i);
  const indexCount = index ? index.count : attribute.count;
  for (let i = 0; i < indexCount; i += 3)
    addFace(edges, [vertexAt(i), vertexAt(i + 1), vertexAt(i + 2)]);
  // Every unmatched edge is a border edge.
  for (const edge of edges.map.values())
    if (edge) edges.vertices.push(...edges.point(edge.index0), ...edges.point(edge.index1));
  return edges.vertices;
}

export function defineEdgesGeometry(
  classes: Readonly<Record<"BufferGeometry" | "Float32BufferAttribute", Constructor>>,
) {
  const BufferGeometry = classes.BufferGeometry as new () => IGeometry;
  const Float32BufferAttribute = classes.Float32BufferAttribute as new (
    array: number[],
    itemSize: number,
  ) => object;
  return class EdgesGeometry extends BufferGeometry {
    readonly type = "EdgesGeometry";
    readonly parameters: { geometry: IGeometry | null; thresholdAngle: number };

    constructor(geometry: IGeometry | null = null, thresholdAngle = 1) {
      super();
      this.parameters = { geometry, thresholdAngle };
      if (geometry === null) return;
      this.setAttribute(
        "position",
        new Float32BufferAttribute(edgeVertices(geometry, thresholdAngle), 3),
      );
    }
  };
}
