// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// Rounded, cached primitives — the single highest-leverage thing in this
// folder. A sharp BoxGeometry reads as Minecraft; the same box with a 0.14
// corner radius reads as a toy, and that soft corner-wrap is most of what
// separates a stack of boxes from something that looks designed.
//
// Nothing here is textured, on purpose. Surface variety comes from alternating
// palette entries across a run of meshes, never from a bitmap: `CanvasTexture`
// samples BLACK under `WebGPURenderer`, which is a trap worth knowing about
// before you spend an afternoon painting one.
import {
  BoxGeometry,
  type BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  type Material,
  MathUtils,
  Mesh,
  PlaneGeometry,
  SphereGeometry,
  TorusKnotGeometry,
  Vector3,
} from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

const roundedCache = new Map<string, BufferGeometry>();

// Canonical primitives: ONE geometry object per shape, sized per mesh through
// `mesh.scale`. A plain `new BoxGeometry(w, h, d)` per mesh is pixel-identical
// to a shared unit box scaled by (w, h, d) — positions are linear in the
// dimensions and the axis-aligned normals survive a diagonal scale — but the
// per-mesh version gives every mesh its own geometry identity, and identity is
// what instancing keys on. A town that builds 200 solids this way draws 200
// times where it could draw once; these exist so that never happens again.
let unitBoxGeometry: BufferGeometry | undefined;
export function unitBox(): BufferGeometry {
  unitBoxGeometry ??= new BoxGeometry(1, 1, 1);
  return unitBoxGeometry;
}

let unitPlaneGeometry: BufferGeometry | undefined;
export function unitPlane(): BufferGeometry {
  unitPlaneGeometry ??= new PlaneGeometry(1, 1);
  return unitPlaneGeometry;
}

const unitCylinderCache = new Map<number, BufferGeometry>();
/** A radius-1, height-1 cylinder scaled by (r, h, r); segments are part of the shape. */
export function unitCylinder(segments: number): BufferGeometry {
  let geometry = unitCylinderCache.get(segments);
  if (geometry === undefined) {
    geometry = new CylinderGeometry(1, 1, 1, segments);
    unitCylinderCache.set(segments, geometry);
  }
  return geometry;
}

/**
 * A box with rounded edges: every vertex of a segmented box pushed outward
 * from the clamped "inner" box by `radius`, then welded so normals interpolate
 * smoothly across the seams instead of faceting at them.
 */
export function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius = 0.14,
  segments = 3,
): BufferGeometry {
  const key = `${width},${height},${depth},${radius},${segments}`;
  const cached = roundedCache.get(key);
  if (cached !== undefined) return cached;

  const limit = Math.min(radius, width / 2 - 1e-3, height / 2 - 1e-3, depth / 2 - 1e-3);
  const geometry = new BoxGeometry(width, height, depth, segments, segments, segments);
  // No UVs and no normals: both are rebuilt after welding, and a geometry with
  // stale UVs is a geometry someone will eventually try to texture.
  geometry.deleteAttribute("uv");
  geometry.deleteAttribute("normal");

  const position = geometry.attributes.position;
  if (position === undefined) throw new Error("Rounded box lost its position attribute.");
  const inner = new Vector3(width / 2 - limit, height / 2 - limit, depth / 2 - limit);
  const vertex = new Vector3();
  const clamped = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index);
    clamped.set(
      MathUtils.clamp(vertex.x, -inner.x, inner.x),
      MathUtils.clamp(vertex.y, -inner.y, inner.y),
      MathUtils.clamp(vertex.z, -inner.z, inner.z),
    );
    vertex.sub(clamped);
    const length = vertex.length();
    if (length > 1e-6) vertex.multiplyScalar(limit / length);
    position.setXYZ(index, vertex.x + clamped.x, vertex.y + clamped.y, vertex.z + clamped.z);
  }

  const welded = mergeVertices(geometry, 1e-4);
  welded.computeVertexNormals();
  roundedCache.set(key, welded);
  return welded;
}

export interface IShapeOptions {
  readonly castShadow?: boolean;
  readonly radius?: number;
  readonly receiveShadow?: boolean;
  readonly segments?: number;
}

function shadowed(mesh: Mesh, options: IShapeOptions): Mesh {
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  return mesh;
}

/** The workhorse: a rounded box that casts and receives shadows. */
export function block(
  width: number,
  height: number,
  depth: number,
  material: Material,
  options: IShapeOptions = {},
): Mesh {
  const geometry = roundedBox(width, height, depth, options.radius ?? 0.14, options.segments ?? 3);
  return shadowed(new Mesh(geometry, material), options);
}

export function ball(radius: number, material: Material, options: IShapeOptions = {}): Mesh {
  const segments = options.segments ?? 16;
  const geometry = new SphereGeometry(radius, segments, Math.max(6, Math.round(segments / 2)));
  return shadowed(new Mesh(geometry, material), options);
}

export function tube(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  material: Material,
  options: IShapeOptions = {},
): Mesh {
  const geometry = new CylinderGeometry(radiusTop, radiusBottom, height, options.segments ?? 16);
  return shadowed(new Mesh(geometry, material), options);
}

export function spike(
  radius: number,
  height: number,
  material: Material,
  options: IShapeOptions = {},
): Mesh {
  const geometry = new ConeGeometry(radius, height, options.segments ?? 14);
  return shadowed(new Mesh(geometry, material), options);
}

/** A smooth prop for the starter scene. */
export function sculpture(material: Material): Mesh {
  // 128 × 24 is 6,144 triangles. The old 500 × 100 mesh pushed 100k triangles
  // through the colour, shadow and bloom passes for no visible gain.
  const geometry = new TorusKnotGeometry(1.35, 0.38, 128, 24);
  return shadowed(new Mesh(geometry, material), {});
}

/**
 * Deterministic PRNG. Never Math.random: the world has to be byte-identical on
 * every reload or a screenshot diff means nothing and you cannot tell a bug
 * from a reroll.
 */
export function makeRandom(seed = 1337): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
