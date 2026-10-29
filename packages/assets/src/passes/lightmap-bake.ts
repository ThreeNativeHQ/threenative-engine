import type { Document, Node, Primitive } from "@gltf-transform/core";
import type { Light } from "@gltf-transform/extensions";
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from "three";

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

interface ITriangle {
  readonly material: string;
  readonly normals: readonly [Vec3, Vec3, Vec3];
  readonly positions: readonly [Vec3, Vec3, Vec3];
  readonly uv: readonly [Vec2, Vec2, Vec2];
}

interface IPunctualLight {
  readonly color: Vec3;
  readonly direction: Vec3;
  readonly innerConeAngle: number;
  readonly intensity: number;
  readonly outerConeAngle: number;
  readonly position: Vec3;
  readonly range: number | null;
  readonly type: "directional" | "point" | "spot";
}

export interface ILightmapBakeResult {
  readonly dilatedTexels: number;
  readonly height: number;
  readonly materialTargets: readonly string[];
  readonly occludedTexels: number;
  readonly pixels: Uint8Array;
  readonly validTexels: number;
  readonly width: number;
}

function add(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(value: Vec3, amount: number): Vec3 {
  return [value[0] * amount, value[1] * amount, value[2] * amount];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function length(value: Vec3): number {
  return Math.sqrt(dot(value, value));
}

function normalize(value: Vec3): Vec3 {
  const magnitude = length(value);
  return magnitude === 0 ? [0, 1, 0] : scale(value, 1 / magnitude);
}

function transformPosition(matrix: readonly number[], value: Vec3): Vec3 {
  return [
    (matrix[0] ?? 1) * value[0] +
      (matrix[4] ?? 0) * value[1] +
      (matrix[8] ?? 0) * value[2] +
      (matrix[12] ?? 0),
    (matrix[1] ?? 0) * value[0] +
      (matrix[5] ?? 1) * value[1] +
      (matrix[9] ?? 0) * value[2] +
      (matrix[13] ?? 0),
    (matrix[2] ?? 0) * value[0] +
      (matrix[6] ?? 0) * value[1] +
      (matrix[10] ?? 1) * value[2] +
      (matrix[14] ?? 0),
  ];
}

function transformDirection(matrix: readonly number[], value: Vec3): Vec3 {
  return normalize([
    (matrix[0] ?? 1) * value[0] + (matrix[4] ?? 0) * value[1] + (matrix[8] ?? 0) * value[2],
    (matrix[1] ?? 0) * value[0] + (matrix[5] ?? 1) * value[1] + (matrix[9] ?? 0) * value[2],
    (matrix[2] ?? 0) * value[0] + (matrix[6] ?? 0) * value[1] + (matrix[10] ?? 1) * value[2],
  ]);
}

function transformNormal(matrix: readonly number[], value: Vec3): Vec3 {
  const column0: Vec3 = [matrix[0] ?? 1, matrix[1] ?? 0, matrix[2] ?? 0];
  const column1: Vec3 = [matrix[4] ?? 0, matrix[5] ?? 1, matrix[6] ?? 0];
  const column2: Vec3 = [matrix[8] ?? 0, matrix[9] ?? 0, matrix[10] ?? 1];
  const determinant = dot(column0, cross(column1, column2));
  const cofactor = add(
    add(scale(cross(column1, column2), value[0]), scale(cross(column2, column0), value[1])),
    scale(cross(column0, column1), value[2]),
  );
  return normalize(scale(cofactor, determinant < 0 ? -1 : 1));
}

function reachableNodes(document: Document): Node[] {
  const nodes: Node[] = [];
  const seen = new Set<Node>();
  const visit = (node: Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    nodes.push(node);
    for (const child of node.listChildren()) visit(child);
  };
  for (const scene of document.getRoot().listScenes()) {
    for (const child of scene.listChildren()) visit(child);
  }
  return nodes;
}

function accessorVec3(primitive: Primitive, semantic: string, index: number): Vec3 | null {
  const accessor = primitive.getAttribute(semantic);
  const array = accessor?.getArray();
  if (array == null) return null;
  const offset = index * 3;
  return [array[offset] ?? 0, array[offset + 1] ?? 0, array[offset + 2] ?? 0];
}

function accessorVec2(primitive: Primitive, semantic: string, index: number): Vec2 | null {
  const accessor = primitive.getAttribute(semantic);
  const array = accessor?.getArray();
  if (array == null) return null;
  const offset = index * 2;
  return [array[offset] ?? 0, array[offset + 1] ?? 0];
}

function triangleFrom(
  primitive: Primitive,
  matrix: readonly number[],
  indices: readonly [number, number, number],
): ITriangle {
  const localPosition0 = accessorVec3(primitive, "POSITION", indices[0]);
  const localPosition1 = accessorVec3(primitive, "POSITION", indices[1]);
  const localPosition2 = accessorVec3(primitive, "POSITION", indices[2]);
  const uv0 = accessorVec2(primitive, "TEXCOORD_1", indices[0]);
  const uv1 = accessorVec2(primitive, "TEXCOORD_1", indices[1]);
  const uv2 = accessorVec2(primitive, "TEXCOORD_1", indices[2]);
  if (
    localPosition0 === null ||
    localPosition1 === null ||
    localPosition2 === null ||
    uv0 === null ||
    uv1 === null ||
    uv2 === null
  ) {
    throw new Error(
      "TN_ASSETS_LIGHTMAP_UV2_MISSING: a baked primitive lacks positions or TEXCOORD_1.",
    );
  }
  const positions: [Vec3, Vec3, Vec3] = [
    transformPosition(matrix, localPosition0),
    transformPosition(matrix, localPosition1),
    transformPosition(matrix, localPosition2),
  ];
  const faceNormal = normalize(
    cross(subtract(positions[1], positions[0]), subtract(positions[2], positions[0])),
  );
  const normals = indices.map((index) => {
    const local = accessorVec3(primitive, "NORMAL", index);
    return local === null ? faceNormal : transformNormal(matrix, local);
  }) as [Vec3, Vec3, Vec3];
  return {
    material: primitive.getMaterial()?.getName() ?? "",
    normals,
    positions,
    uv: [uv0, uv1, uv2],
  };
}

function sceneTriangles(document: Document, nodes: readonly Node[]): ITriangle[] {
  const meshUses = new Map<NonNullable<ReturnType<Node["getMesh"]>>, number>();
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (mesh !== null) meshUses.set(mesh, (meshUses.get(mesh) ?? 0) + 1);
  }
  if ([...meshUses.values()].some((count) => count > 1)) {
    throw new Error(
      "TN_ASSETS_LIGHTMAP_INSTANCING_UNSUPPORTED: one mesh is used by multiple scene nodes.",
    );
  }
  const triangles: ITriangle[] = [];
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (mesh === null) continue;
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices()?.getArray();
      if (indices == null) {
        throw new Error("TN_ASSETS_LIGHTMAP_GEOMETRY_UNSUPPORTED: bake input is not indexed.");
      }
      for (let offset = 0; offset < indices.length; offset += 3) {
        const first = indices[offset];
        const second = indices[offset + 1];
        const third = indices[offset + 2];
        if (first === undefined || second === undefined || third === undefined) continue;
        triangles.push(triangleFrom(primitive, node.getWorldMatrix(), [first, second, third]));
      }
    }
  }
  return triangles;
}

function sceneLights(nodes: readonly Node[]): IPunctualLight[] {
  const lights: IPunctualLight[] = [];
  for (const node of nodes) {
    const light = node.getExtension<Light>("KHR_lights_punctual");
    if (light === null) continue;
    const matrix = node.getWorldMatrix();
    lights.push({
      color: light.getColor() as Vec3,
      direction: transformDirection(matrix, [0, 0, -1]),
      innerConeAngle: light.getInnerConeAngle(),
      intensity: light.getIntensity(),
      outerConeAngle: light.getOuterConeAngle(),
      position: transformPosition(matrix, [0, 0, 0]),
      range: light.getRange(),
      type: light.getType(),
    });
  }
  return lights;
}

interface IOcclusionIndex {
  dispose(): void;
  hits(origin: Vec3, direction: Vec3, maximum: number): boolean;
}

async function buildOcclusionIndex(triangles: readonly ITriangle[]): Promise<IOcclusionIndex> {
  const { MeshBVH } = await import("three-mesh-bvh");
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array(
        triangles.flatMap((triangle) => triangle.positions.flatMap((position) => [...position])),
      ),
      3,
    ),
  );
  const bvh = new MeshBVH(geometry);
  const ray = new Ray();
  return {
    dispose(): void {
      geometry.dispose();
    },
    hits(origin: Vec3, direction: Vec3, maximum: number): boolean {
      ray.origin.copy(new Vector3(...origin));
      ray.direction.copy(new Vector3(...direction));
      return bvh.raycastFirst(ray, DoubleSide, 1e-6, maximum) !== null;
    },
  };
}

interface ILightSample {
  readonly direction: Vec3;
  readonly maximum: number;
  readonly strength: number;
}

function sampleLight(light: IPunctualLight, position: Vec3): ILightSample | null {
  if (light.type === "directional") {
    return {
      direction: scale(light.direction, -1),
      maximum: Number.POSITIVE_INFINITY,
      strength: light.intensity,
    };
  }
  const offset = subtract(light.position, position);
  const distance = length(offset);
  if (distance === 0 || (light.range !== null && distance > light.range)) return null;
  let strength = light.intensity / Math.max(distance * distance, 1e-6);
  if (light.type === "spot") {
    const fromLight = scale(normalize(offset), -1);
    const cosine = dot(light.direction, fromLight);
    const outer = Math.cos(light.outerConeAngle);
    if (cosine <= outer) return null;
    const inner = Math.cos(light.innerConeAngle);
    strength *= inner === outer ? 1 : Math.min(1, (cosine - outer) / (inner - outer));
  }
  return { direction: scale(offset, 1 / distance), maximum: distance - 1e-5, strength };
}

function barycentric(point: Vec2, triangle: readonly [Vec2, Vec2, Vec2]): Vec3 | null {
  const [a, b, c] = triangle;
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denominator) < 1e-12) return null;
  const first =
    ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
  const second =
    ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
  const third = 1 - first - second;
  return first >= -1e-7 && second >= -1e-7 && third >= -1e-7 ? [first, second, third] : null;
}

function interpolate(values: readonly [Vec3, Vec3, Vec3], weights: Vec3): Vec3 {
  return add(
    add(scale(values[0], weights[0]), scale(values[1], weights[1])),
    scale(values[2], weights[2]),
  );
}

function shadeTexel(
  position: Vec3,
  normal: Vec3,
  lights: readonly IPunctualLight[],
  occlusion: IOcclusionIndex,
): { color: Vec3; occluded: boolean } {
  let color: Vec3 = [0, 0, 0];
  let occluded = false;
  const origin = add(position, scale(normal, 1e-5));
  for (const light of lights) {
    const sample = sampleLight(light, position);
    if (sample === null) continue;
    const lambert = Math.max(0, dot(normal, sample.direction));
    if (lambert === 0) continue;
    const blocked = occlusion.hits(origin, sample.direction, sample.maximum);
    if (blocked) {
      occluded = true;
      continue;
    }
    color = add(color, scale(light.color, lambert * sample.strength));
  }
  return { color, occluded };
}

function rasterize(
  triangles: readonly ITriangle[],
  lights: readonly IPunctualLight[],
  occlusion: IOcclusionIndex,
  width: number,
  height: number,
): { occludedTexels: number; pixels: Uint8Array; valid: Uint8Array } {
  const pixels = new Uint8Array(width * height * 4);
  const valid = new Uint8Array(width * height);
  let occludedTexels = 0;
  for (const triangle of triangles) {
    const imageUv = triangle.uv.map(([u, v]) => [u * width, (1 - v) * height] as Vec2) as [
      Vec2,
      Vec2,
      Vec2,
    ];
    const minX = Math.max(0, Math.floor(Math.min(...imageUv.map((value) => value[0]))));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(...imageUv.map((value) => value[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...imageUv.map((value) => value[1]))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...imageUv.map((value) => value[1]))));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const weights = barycentric([x + 0.5, y + 0.5], imageUv);
        if (weights === null) continue;
        const position = interpolate(triangle.positions, weights);
        const normal = normalize(interpolate(triangle.normals, weights));
        const shaded = shadeTexel(position, normal, lights, occlusion);
        const pixel = y * width + x;
        const offset = pixel * 4;
        pixels[offset] = Math.round(Math.min(1, Math.max(0, shaded.color[0])) * 255);
        pixels[offset + 1] = Math.round(Math.min(1, Math.max(0, shaded.color[1])) * 255);
        pixels[offset + 2] = Math.round(Math.min(1, Math.max(0, shaded.color[2])) * 255);
        pixels[offset + 3] = 255;
        valid[pixel] = 1;
        if (shaded.occluded) occludedTexels += 1;
      }
    }
  }
  return { occludedTexels, pixels, valid };
}

function dilate(
  pixels: Uint8Array,
  valid: Uint8Array,
  width: number,
  height: number,
  steps: number,
): number {
  let filled = 0;
  for (let step = 0; step < steps; step += 1) {
    const sourcePixels = pixels.slice();
    const sourceValid = valid.slice();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        if (sourceValid[pixel] === 1) continue;
        let source = -1;
        for (let yOffset = -1; yOffset <= 1 && source < 0; yOffset += 1) {
          for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
            const neighborX = x + xOffset;
            const neighborY = y + yOffset;
            if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height)
              continue;
            const candidate = neighborY * width + neighborX;
            if (sourceValid[candidate] === 1) {
              source = candidate;
              break;
            }
          }
        }
        if (source < 0) continue;
        pixels.set(sourcePixels.subarray(source * 4, source * 4 + 4), pixel * 4);
        valid[pixel] = 1;
        filled += 1;
      }
    }
  }
  return filled;
}

export async function bakeStaticLightmap(
  document: Document,
  width: number,
  height: number,
  padding: number,
): Promise<ILightmapBakeResult> {
  const nodes = reachableNodes(document);
  const triangles = sceneTriangles(document, nodes);
  const lights = sceneLights(nodes);
  if (lights.length === 0) {
    throw new Error(
      "TN_ASSETS_LIGHTMAP_LIGHTS_MISSING: the static scene contains no punctual light.",
    );
  }
  const occlusion = await buildOcclusionIndex(triangles);
  const raster = rasterize(triangles, lights, occlusion, width, height);
  occlusion.dispose();
  const validTexels = raster.valid.reduce((sum, value) => sum + (value === 1 ? 1 : 0), 0);
  const dilatedTexels = dilate(raster.pixels, raster.valid, width, height, padding);
  return {
    dilatedTexels,
    height,
    materialTargets: [...new Set(triangles.map((triangle) => triangle.material))].sort(),
    occludedTexels: raster.occludedTexels,
    pixels: raster.pixels,
    validTexels,
    width,
  };
}
