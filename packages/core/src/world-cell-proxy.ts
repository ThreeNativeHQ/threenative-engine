import {
  Box3,
  BufferGeometry,
  Material,
  type Matrix4,
  Mesh,
  type Object3D,
  Sphere,
  Texture,
  TextureUtils,
  Vector3,
} from "three";
import { isEngineRenderHook } from "./engine-render-hook.js";
import { INSTANCED_LOD_MAX_PIXEL_ERROR } from "./instanced-batch-lod.js";
import { baseGeometryOf } from "./model-lod.js";
import { DISCRETE_LOD_DEFAULT_HYSTERESIS, type ILodView, selectLodLevel } from "./model-lod.js";
import { displacesVertices } from "./projection-plan.js";
import type { IWorldCellProxy } from "./world-package.js";

export interface ICellProxySelectionInput {
  /** Existing admission owner sets this after compilation and a main-context backend submission observation. */
  readonly proxyReady: boolean;
  readonly sourceReady: boolean;
  /** False for runtime materials/deformation or per-placement culls the cook cannot reproduce. */
  readonly sourceCompatible: boolean;
  /** Cost of the selected source LODs at this view even while hidden, including distant impostors. Never the cook's LOD0 census. */
  readonly sourceTriangles: number;
  /** Draws actually retired by this swap. A shared batch with other cells still live contributes 0. */
  readonly replaceableSourceDraws: number;
  /** Existing conservativeViewDepth/lod views, with finest set throughout the protected near field. */
  readonly views: readonly ILodView[];
  /** Error scales with the WorldCells transform, just like its conservative bounds. */
  readonly errorScale?: number;
  readonly maxPixelError?: number;
  readonly hysteresis?: number;
}

function count(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Cell proxy ${name} must be a non-negative safe integer.`);
}

/**
 * Internal selection only. WorldCells owns models, admission, cache paths, generation cancellation,
 * collision and shadow/bundle attachment. The owner commits this result and source visibility in
 * one admission unit, and resets the selector on eviction. No material, loader or scheduler lives here.
 */
export class CellProxySelection {
  readonly #proxy: IWorldCellProxy;
  #level = 0;

  constructor(proxy: IWorldCellProxy) {
    if (!Number.isFinite(proxy.error) || proxy.error < 0)
      throw new Error("Cell proxy error must be finite and non-negative.");
    count(proxy.triangles, "triangles");
    count(proxy.materialGroups, "materialGroups");
    if (proxy.triangles === 0 || proxy.materialGroups === 0)
      throw new Error("Cell proxy must contain drawn geometry.");
    this.#proxy = proxy;
  }

  select(input: ICellProxySelectionInput): "detail" | "proxy" | "pending" {
    count(input.sourceTriangles, "sourceTriangles");
    count(input.replaceableSourceDraws, "replaceableSourceDraws");
    const scale = input.errorScale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0)
      throw new Error("Cell proxy error scale must be finite and positive.");
    const budget = input.maxPixelError ?? INSTANCED_LOD_MAX_PIXEL_ERROR;
    const hysteresis = input.hysteresis ?? DISCRETE_LOD_DEFAULT_HYSTERESIS;
    if (
      !Number.isFinite(budget) ||
      budget <= 0 ||
      !Number.isFinite(hysteresis) ||
      hysteresis < 0 ||
      hysteresis >= 1
    )
      throw new Error("Cell proxy needs a positive pixel budget and hysteresis in [0, 1).");
    if (!input.proxyReady || !input.sourceCompatible) {
      this.#level = 0;
      return input.sourceReady ? "detail" : "pending";
    }
    // Returning detail remains in the existing load queue; a ready proxy stays drawn meanwhile.
    if (!input.sourceReady && this.#level === 1) return "proxy";
    if (
      this.#proxy.triangles >= input.sourceTriangles ||
      this.#proxy.materialGroups > input.replaceableSourceDraws
    ) {
      this.#level = 0;
      return input.sourceReady ? "detail" : "pending";
    }
    this.#level = selectLodLevel(
      [0, this.#proxy.error * scale],
      this.#level,
      budget,
      hysteresis,
      input.views,
    );
    return this.#level === 1 ? "proxy" : input.sourceReady ? "detail" : "pending";
  }

  reset(): void {
    this.#level = 0;
  }
}

/** Fixed static representation only; a managed AutoLOD chain must never replace parked geometry. */
export function cellProxyMaterialSafe(material: Material): boolean {
  return (
    (Reflect.get(material, "isMeshBasicMaterial") === true ||
      (Reflect.get(material, "isMeshStandardMaterial") === true &&
        Reflect.get(material, "isMeshPhysicalMaterial") !== true)) &&
    Reflect.get(material, "isNodeMaterial") !== true &&
    !material.transparent &&
    !displacesVertices(material) &&
    Reflect.get(material, "vertexNode") == null &&
    Reflect.get(material, "positionNode") == null &&
    material.onBeforeCompile === Material.prototype.onBeforeCompile &&
    material.clippingPlanes == null &&
    Object.entries(Reflect.get(material, "defines") ?? {}).every(
      ([name, value]) => name === "STANDARD" && value === "",
    )
  );
}
export function cellProxyGeometrySafe(geometry: BufferGeometry): boolean {
  return (
    geometry.drawRange.start === 0 &&
    geometry.drawRange.count === Number.POSITIVE_INFINITY &&
    Object.keys(geometry.morphAttributes).length === 0 &&
    geometry.getAttribute("position") != null &&
    Object.keys(geometry.attributes).every((name) =>
      ["position", "normal", "uv", "color"].includes(name),
    ) &&
    (geometry.getAttribute("color") == null ||
      ([3, 4].includes(geometry.getAttribute("color").itemSize) &&
        geometry.getAttribute("color").count === geometry.getAttribute("position").count))
  );
}
export function cellProxySourceSafe(root: Object3D, staticInstances?: ReadonlySet<Mesh>): boolean {
  let safe = (Reflect.get(root, "animations")?.length ?? 0) === 0;
  root.traverse((node) => {
    if (
      Reflect.get(node, "isLight") ||
      Reflect.get(node, "isPoints") ||
      Reflect.get(node, "isLine")
    )
      safe = false;
    if (!(node instanceof Mesh)) return;
    if (
      Reflect.get(node, "isSkinnedMesh") ||
      (Reflect.get(node, "isInstancedMesh") &&
        (staticInstances?.has(node) !== true ||
          Reflect.get(node, "morphTexture") != null ||
          Reflect.get(node, "instanceColor") != null)) ||
      Array.isArray(node.material) ||
      !cellProxyGeometrySafe(node.geometry) ||
      !cellProxyMaterialSafe(node.material as Material) ||
      (node.onBeforeRender !== Mesh.prototype.onBeforeRender &&
        !isEngineRenderHook(node.onBeforeRender)) ||
      (node.onAfterRender !== Mesh.prototype.onAfterRender &&
        !isEngineRenderHook(node.onAfterRender))
    )
      safe = false;
  });
  return safe;
}
export interface IPreparedCellProxy {
  readonly root: Object3D;
  readonly meshes: readonly Mesh[];
  readonly ranges: readonly { readonly start: number; readonly count: number }[];
  readonly bounds: Sphere;
  /** Decoded source buffers/textures plus owned fixed copies, not physical driver allocation. */
  readonly bytes: number;
}

/** Conservative decoded texture cost. An unreadable image cannot be admitted under a byte cap. */
function textureBytes(texture: Texture): number {
  const images = Array.isArray(texture.image) ? texture.image : [texture.image];
  const buffers = new Set<ArrayBufferLike>();
  let storage = 0;
  let bytes = 0;
  for (const image of images) {
    const width = image?.width;
    const height = image?.height;
    const depth = image?.depth ?? 1;
    if (![width, height, depth].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new Error("Cell proxy texture has no measurable decoded extent.");
    const mips = image?.mipmaps ?? texture.mipmaps;
    // Three uses the supplied chain, or generates one only when explicitly requested without mips.
    const levels =
      mips.length > 0
        ? mips.length
        : texture.generateMipmaps && Reflect.get(texture, "isCompressedTexture") !== true
          ? Math.floor(Math.log2(Math.max(width, height))) + 1
          : 1;
    for (let level = 0; level < levels; level++) {
      const mip = mips[level] ?? (level === 0 ? image : undefined);
      const w = Math.max(1, Math.floor(width / 2 ** level));
      const h = Math.max(1, Math.floor(height / 2 ** level));
      try {
        bytes += TextureUtils.getByteLength(w, h, texture.format, texture.type) * depth;
      } catch {
        // An unknown format keeps the float32 RGBA upper bound; never guess a compression ratio.
        bytes += w * h * depth * 16;
      }
      const data = mip?.data;
      if (ArrayBuffer.isView(data) && !buffers.has(data.buffer)) {
        buffers.add(data.buffer);
        storage += data.buffer.byteLength;
      }
    }
  }
  bytes = Math.max(bytes, storage);
  if (!Number.isSafeInteger(bytes)) throw new Error("Cell proxy texture bytes overflow.");
  return bytes;
}

/** Reject oversize decoded resources when IO settles, before an admission queue can retain them. */
export function measureCellProxy(
  model: Object3D,
  proxy: IWorldCellProxy,
  includeCopies = false,
): number {
  if (!cellProxySourceSafe(model))
    throw new Error("Cell proxy has unsupported static geometry or material.");
  const buffers = new Set<ArrayBufferLike>();
  const textures = new Set<Texture>();
  let bytes = 0;
  let copies = 0;
  let triangles = 0;
  let draws = 0;
  let nodes = 0;
  model.traverse((node) => {
    if (++nodes > 4096) throw new Error("Cell proxy exceeds the bounded node count.");
    if (!(node instanceof Mesh)) return;
    const geometry = baseGeometryOf(node);
    for (const attribute of [geometry.index, ...Object.values(geometry.attributes)]) {
      if (attribute == null) continue;
      const array = Reflect.get(attribute, "array") ?? Reflect.get(attribute, "data")?.array;
      if (array == null) throw new Error("Cell proxy has an unreadable buffer.");
      // Plain clones copy the view; interleaved clones may share a copied store. Charging each
      // attribute view is conservative for that sharing and bounds every private allocation.
      copies += array.byteLength;
      if (!buffers.has(array.buffer)) {
        buffers.add(array.buffer);
        bytes += array.buffer.byteLength;
      }
    }
    triangles += (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
    draws++;
    for (const value of Object.values(node.material))
      if (value instanceof Texture) textures.add(value);
  });
  if (triangles !== proxy.triangles || draws !== proxy.materialGroups)
    throw new Error("Cell proxy draw census does not match its manifest.");
  for (const texture of textures) bytes += textureBytes(texture);
  if (!Number.isSafeInteger(bytes) || bytes > 4 * 1024 * 1024)
    throw new Error("Cell proxy exceeds the decoded admission unit.");
  return bytes + (includeCopies ? copies : 0);
}
export function prepareCellProxy(
  model: Object3D,
  proxy: IWorldCellProxy,
  maxBytes = Number.POSITIVE_INFINITY,
): IPreparedCellProxy {
  if (!cellProxySourceSafe(model))
    throw new Error("Cell proxy has unsupported static geometry or material.");
  const bytes = measureCellProxy(model, proxy, true);
  if (bytes > maxBytes) throw new Error("Cell proxy exceeds its reserved decoded budget.");
  const root = model.clone(true);
  const meshes: Mesh[] = [];
  const ranges: { start: number; count: number }[] = [];
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root, false);
  if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite))
    throw new Error("Cell proxy has no finite bounds.");
  if (proxy.bounds !== undefined) {
    const declared = new Box3(new Vector3(...proxy.bounds.min), new Vector3(...proxy.bounds.max));
    const margin = 1e-4;
    declared.expandByScalar(margin);
    // The cook declares the exact vertex extent. `box` above is the cheaper geometry-box hull, which
    // a rotated mesh inflates past that exact extent, so test the vertices themselves.
    const exact = new Box3().setFromObject(root, true);
    if (!declared.containsBox(exact))
      throw new Error("Cell proxy lies outside its declared bounds.");
  }
  // copy() does not invoke the installed clone hook that registers another managed LOD chain.
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const fixed = new BufferGeometry().copy(baseGeometryOf(node));
    node.geometry = fixed;
    meshes.push(node);
    ranges.push({ ...fixed.drawRange });
    fixed.setDrawRange(0, 0);
    node.castShadow = false;
    node.frustumCulled = false;
  });
  return { root, meshes, ranges, bounds: box.getBoundingSphere(new Sphere()), bytes };
}

/** Cook-compatible fixed materials. No image serialization or quantized/HDR-clamped colors. */
export function cellProxyMaterialMatches(a: Material, b: Material): boolean {
  if (a.type !== b.type) return false;
  const descriptor = (material: Material): string => {
    const fields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(material)) {
      if (
        ["id", "uuid", "name", "version", "userData"].includes(name) ||
        value instanceof Texture ||
        typeof value === "function"
      )
        continue;
      if (value == null || ["string", "number", "boolean"].includes(typeof value))
        fields[name] = value;
      else if (Reflect.get(value, "isColor") === true)
        fields[name] = [Reflect.get(value, "r"), Reflect.get(value, "g"), Reflect.get(value, "b")];
      else if (Reflect.get(value, "isEuler") === true)
        fields[name] = [
          Reflect.get(value, "x"),
          Reflect.get(value, "y"),
          Reflect.get(value, "z"),
          Reflect.get(value, "order"),
        ];
      else if (Reflect.get(value, "isVector2") === true)
        fields[name] = [Reflect.get(value, "x"), Reflect.get(value, "y")];
      else if (name === "defines") fields[name] = value;
    }
    return JSON.stringify(fields);
  };
  if (descriptor(a) !== descriptor(b)) return false;
  const textureFields = new Set(
    [...Object.entries(a), ...Object.entries(b)]
      .filter(([, value]) => value instanceof Texture)
      .map(([name]) => name),
  );
  for (const name of textureFields) {
    const value = Reflect.get(a, name);
    const other = Reflect.get(b, name);
    if (!(value instanceof Texture) || !(other instanceof Texture)) return false;
    if (
      value.source !== other.source &&
      value.image !== other.image &&
      !(
        typeof value.image?.src === "string" &&
        value.image.src.length > 0 &&
        value.image.src === other.image?.src
      )
    )
      return false;
    if (value.mipmaps !== other.mipmaps && value.mipmaps.length + other.mipmaps.length > 0)
      return false;
    const parameters = (texture: Texture): string =>
      JSON.stringify([
        texture.mapping,
        texture.channel,
        texture.wrapS,
        texture.wrapT,
        texture.magFilter,
        texture.minFilter,
        texture.anisotropy,
        texture.flipY,
        texture.colorSpace,
        texture.format,
        texture.type,
        texture.internalFormat,
        texture.matrix.toArray(),
        texture.offset.toArray(),
        texture.repeat.toArray(),
        texture.center.toArray(),
        texture.rotation,
        texture.matrixAutoUpdate,
        texture.generateMipmaps,
        texture.premultiplyAlpha,
        texture.unpackAlignment,
      ]);
    if (parameters(value) !== parameters(other)) return false;
  }
  return true;
}

/** Gershgorin bound of M-transpose-M, also conservative for composed TRS that contains shear. */
export function cellProxyWorldScale(matrix: Matrix4): number {
  const e = matrix.elements;
  const a = new Vector3(e[0], e[1], e[2]);
  const b = new Vector3(e[4], e[5], e[6]);
  const c = new Vector3(e[8], e[9], e[10]);
  const ab = Math.abs(a.dot(b));
  const ac = Math.abs(a.dot(c));
  const bc = Math.abs(b.dot(c));
  return Math.sqrt(
    Math.max(a.lengthSq() + ab + ac, b.lengthSq() + ab + bc, c.lengthSq() + ac + bc),
  );
}
