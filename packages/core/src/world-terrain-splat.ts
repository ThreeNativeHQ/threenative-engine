import {
  CompressedArrayTexture,
  type CompressedTexture,
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  Mesh,
  NoColorSpace,
  type Object3D,
  RGBAFormat,
  RepeatWrapping,
  type Texture,
  UnsignedByteType,
  Vector3,
} from "three";
import {
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dot,
  float,
  int,
  mix,
  mx_noise_float,
  normalWorld,
  positionWorld,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { IAssetLoader } from "./assets.js";
import type { IRendererLike } from "./renderer.js";
import type { IWorldExtent } from "./world-package.js";

type Channel = "r" | "g" | "b" | "a";

/** What a layer that states no surface response at all answers with: the matte dielectric surface
 *  this material carried before the table carried roughness and metalness. */
const DEFAULT_ROUGHNESS = 0.92;

/** One texture set: albedo (and optionally a normal and ORM map) tiled in metres, tinted in linear. */
export interface ITerrainSplatLayer {
  readonly id: string;
  readonly tile: number;
  readonly tint: readonly [number, number, number];
  /** Package-relative image paths; omitted entries retain `<textures>/<id>_<kind>.jpg`.
   * Normal, ORM and height maps are still loaded only when their flags request them. */
  readonly maps?: {
    readonly diffuse?: string;
    readonly normal?: string;
    readonly orm?: string;
    readonly height?: string;
  };
  readonly normal?: boolean;
  /** `<id>_orm.jpg`: occlusion in r, roughness in g, metalness in b, read as linear data. */
  readonly orm?: boolean;
  /** Without an ORM map, how this layer answers light. Defaults to `DEFAULT_ROUGHNESS` and 0. */
  readonly metalness?: number;
  readonly roughness?: number;
  readonly saturation?: number;
  /** Box-projected, for cliffs a top-down projection smears. */
  readonly triplanar?: boolean;
  /**
   * `<id>_h.jpg`: the layer's own height in r, read as linear data and handed to `layerWeight`.
   * Read only on a masked layer; the base has no weight to bend.
   */
  readonly height?: boolean;
  /**
   * The same map again at a larger `tile`, mixed in by up to `amount` as camera distance goes from
   * `from` to `to` metres, so a repeated pattern stops reading as a grid at grazing angles.
   * Top-down layers only; every value is the game's.
   */
  readonly far?: {
    readonly tile: number;
    readonly from: number;
    readonly to: number;
    readonly amount: number;
  };
}

/** A layer blended over what is below it by one mask channel, remapped from `lo..hi`. */
export interface ITerrainSplatMaskedLayer extends ITerrainSplatLayer {
  readonly mask: string;
  /** The component of a `rgb` mask; ignored by a single-component mask. */
  readonly channel: "r" | "g" | "b";
  readonly lo: number;
  readonly hi: number;
}

/**
 * The package's terrain table (`terrain.layers.table`). Written by the export recipe
 * `export_terrain_layers.py` from the game's own table; every value is the game's.
 */
export interface ITerrainSplatTable {
  readonly base: ITerrainSplatLayer;
  /** Noise (0..1 at `scale` per metre) that pushes every mask edge by +-`push`. */
  readonly breakup: { readonly scale: number; readonly push: number };
  /** Large-scale brightness variation against visible tiling, mapped to `min..max`. */
  readonly macro: { readonly scale: number; readonly min: number; readonly max: number };
  readonly layers: readonly ITerrainSplatMaskedLayer[];
  /**
   * `terrain.layers.splat`: `planes` RGBA8 planes of `size`², rows bottom-up, covering the
   * package extent. `masks` names each mask's plane and component (`rgb` = pick by the layer's
   * `channel`).
   */
  readonly splat: {
    readonly size: number;
    readonly planes: number;
    readonly masks: Readonly<Record<string, readonly [number, Channel | "rgb"]>>;
  };
  /** Package-relative folder of `<id>_diff.jpg`, `<id>_nrm.jpg`, `<id>_orm.jpg` and `<id>_h.jpg`. */
  readonly textures: string;
}

/** What `ILoadTerrainSplatOptions.layerWeight` is told about the layer whose weight it returns. */
export interface ITerrainSplatWeightContext {
  readonly layer: ITerrainSplatMaskedLayer;
  /** The layer's height sample, projected as its albedo is; `undefined` when it ships no `height`. */
  readonly height: Node<"float"> | undefined;
  /** The layer's index in `table.layers`. */
  readonly index: number;
}

/** Loaded images for one game-authored sample; index 0 is the base, then table.layers in order.
 * The loader owns these images until the returned material is disposed; do not dispose them. */
export interface ITerrainSplatSampleContext {
  readonly layer: ITerrainSplatLayer;
  readonly index: number;
  readonly diffuse: Texture;
  readonly normal: Texture | undefined;
  readonly orm: Texture | undefined;
  readonly height: Texture | undefined;
}

/** A game's projected layer. An absent normal leaves the accumulated normal unchanged.
 * Normals are encoded OpenGL for the default factory; a custom factory owns their encoding.
 * An absent ORM uses the layer's existing map or scalar response. */
export interface ITerrainSplatSample {
  readonly color: Node<"vec3">;
  readonly normal?: Node<"vec3">;
  readonly orm?: Node<"vec3">;
}

/** Engine-blended channels; color includes the table's macro variation. */
export interface ITerrainSplatMaterialContext {
  readonly color: Node<"vec3">;
  readonly normal: Node<"vec3">;
  readonly orm: Node<"vec3">;
}

export interface ILoadTerrainSplatOptions {
  readonly assets: IAssetLoader;
  /** Game-authored appearance. The baked splat mask descriptor and texture folder remain in the package. */
  readonly table?: Pick<ITerrainSplatTable, "base" | "breakup" | "macro" | "layers">;
  /**
   * The live renderer. Uncompressed layers stack into one array texture per set through GPU copies,
   * which need one; without it every layer keeps its own sampler and the marker says so.
   */
  readonly renderer?: IRendererLike;
  /** Precomputed for every layer before layerWeight runs; replaces the package's projection.
   * Custom sampling retains the loaded images and skips texture-array stacking. */
  readonly layerSample?: (context: ITerrainSplatSampleContext) => ITerrainSplatSample;
  /** Replaces final material assembly, retaining the engine's ordered channel blend.
   * Loader-owned textures are released with the returned material, including composition errors. */
  readonly materialFactory?: (context: ITerrainSplatMaterialContext) => Material;
  /**
   * Replaces each layer's blend weight, given the mask's own (remapped, 0..1) and the layer's
   * height sample. The game owns the curve, for example a height blend; the package mixes colour,
   * normal and ORM by whatever this returns. Absent, the mask weight is used unchanged.
   */
  readonly layerWeight?: (
    weight: Node<"float">,
    context: ITerrainSplatWeightContext,
  ) => Node<"float">;
  /** The world package's `world.json`, as `WorldCells.load` takes it. */
  readonly url: string;
}

/**
 * The two things this surface needs from world.json: its extent and its terrain layer paths.
 * `WorldCells.load` validates the whole package; this only refuses a shape it cannot read.
 */
function worldLayers(raw: unknown): {
  extent: IWorldExtent;
  layers: Readonly<Record<string, string>>;
} {
  const record = raw as { extent?: Partial<IWorldExtent>; terrain?: { layers?: unknown } };
  const extent = record.extent;
  const numbers = [extent?.minX, extent?.minZ, extent?.sizeX, extent?.sizeZ];
  if (
    extent === undefined ||
    !numbers.every((value) => typeof value === "number" && Number.isFinite(value))
  )
    throw new Error("loadTerrainSplat: world.json has no numeric extent.");
  const layers = record.terrain?.layers;
  const paths: Record<string, string> = {};
  if (typeof layers === "object" && layers !== null)
    for (const [name, value] of Object.entries(layers))
      if (typeof value === "string") paths[name] = value;
  return { extent: extent as IWorldExtent, layers: paths };
}

function packageDir(url: string): string {
  const slash = url.lastIndexOf("/");
  return slash === -1 ? "" : url.slice(0, slash + 1);
}

async function fetchResolved(assets: IAssetLoader, path: string): Promise<Response> {
  for (const candidate of await assets.resolve(path)) {
    const response = await fetch(candidate);
    if (response.ok) return response;
  }
  throw new Error(`loadTerrainSplat: '${path}' is not served.`);
}

/** Every splat plane in one array texture: one sampler, whatever the plane count. */
function splatArray(bytes: Uint8Array, size: number, planes: number): Texture {
  if (bytes.byteLength < planes * size * size * 4)
    throw new Error(`loadTerrainSplat: splat data is shorter than plane ${String(planes - 1)}.`);
  const map = new DataArrayTexture(bytes.subarray(0, planes * size * size * 4), size, size, planes);
  map.format = RGBAFormat;
  map.type = UnsignedByteType;
  map.colorSpace = NoColorSpace;
  map.magFilter = LinearFilter;
  map.minFilter = LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
}

/** The two texture-copy calls `stackUncompressed` needs, as the live renderer exposes them. */
interface IRawTextureCopier {
  readonly copyTextureToTexture?: (
    source: Texture,
    destination: Texture,
    sourceRegion?: unknown,
    destinationPosition?: unknown,
  ) => void;
  readonly initTexture?: (texture: Texture) => void;
}

/** A loaded layer's texel size on the GPU, whatever its pixels are held in. */
function gpuSize(map: Texture): { readonly width: number; readonly height: number } | undefined {
  const image = map.image as { width?: number; height?: number } | undefined;
  const { width, height } = image ?? {};
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

/**
 * Same-size uncompressed layers as one `DataArrayTexture`: one sampler, whatever the layer count.
 * Every layer arrives as a GPU copy out of its own texture, so the pixels never come back to the
 * CPU — and the array itself is created with no CPU data to upload, its layers written instead.
 *
 * `undefined` when they cannot stack (a size the others do not share) or when the host has no
 * initialised renderer to copy with.
 */
function stackUncompressed(
  maps: readonly Texture[],
  renderer: IRendererLike | undefined,
): Texture | undefined {
  const raw = renderer?.raw as IRawTextureCopier | undefined;
  if (raw === undefined || raw.initTexture === undefined || raw.copyTextureToTexture === undefined)
    return undefined;
  const size = gpuSize(maps[0] as Texture);
  if (size === undefined) return undefined;
  const sameSize = maps.every((map) => {
    const other = gpuSize(map);
    return other !== undefined && other.width === size.width && other.height === size.height;
  });
  if (!sameSize) return undefined;

  const first = maps[0] as Texture;
  const array = new DataArrayTexture(
    new Uint8Array(size.width * size.height * 4 * maps.length),
    size.width,
    size.height,
    maps.length,
  );
  array.format = first.format;
  array.type = first.type;
  array.colorSpace = first.colorSpace;
  array.minFilter = first.minFilter;
  array.magFilter = first.magFilter;
  array.wrapS = RepeatWrapping;
  array.wrapT = RepeatWrapping;
  array.anisotropy = 8;
  array.flipY = false;
  try {
    // One creation of the GPU texture, with every mip level it will ever have, and nothing to
    // upload: `dataReady` false is how three is told a texture's texels are already on the GPU.
    array.needsUpdate = true;
    array.source.dataReady = false;
    raw.initTexture(array);
    maps.forEach((map, layer) => {
      raw.initTexture?.(map);
      raw.copyTextureToTexture?.(map, array, null, new Vector3(0, 0, layer));
    });
  } catch (error) {
    // An array nothing finished writing would draw whatever the copy left behind: fall back.
    array.dispose();
    console.warn(
      `TN_TERRAIN_SPLAT: GPU stacking failed (${String(error)}); these layers bind their own samplers.`,
    );
    return undefined;
  }
  array.image.data = new Uint8Array(0);
  for (const map of maps) map.dispose();
  return array;
}

/**
 * Same-format, same-size compressed layers as one `CompressedArrayTexture`, and same-size
 * uncompressed ones as one `DataArrayTexture`, or `undefined` when they cannot stack (a mixed
 * codec, a size the cap did not equalise, no renderer to copy uncompressed layers with).
 *
 * WebGPU guarantees 16 samplers a stage and three binds one per texture; a splat terrain's albedos
 * and normals as separate textures plus an open-world shadow's maps passes 16 and the pipeline is
 * invalid. Stacked, a surface costs one sampler per array however many layers it blends.
 */
export function stackLayers(
  maps: readonly Texture[],
  renderer?: IRendererLike,
): Texture | undefined {
  const first = maps[0] as CompressedTexture | undefined;
  if (first === undefined) return undefined;
  if (first.isCompressedTexture !== true) return stackUncompressed(maps, renderer);
  const width = (first.image as { width: number }).width;
  const height = (first.image as { height: number }).height;
  const stackable = maps.every((map) => {
    const layer = map as CompressedTexture;
    const image = layer.image as { width: number; height: number };
    return (
      layer.isCompressedTexture === true &&
      layer.format === first.format &&
      image.width === width &&
      image.height === height &&
      layer.mipmaps.length === first.mipmaps.length
    );
  });
  if (!stackable) return undefined;
  const mipmaps = first.mipmaps.map((mip, level) => {
    const parts = maps.map((map) => {
      const data = (map as CompressedTexture).mipmaps[level]?.data as ArrayBufferView;
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    });
    const data = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.byteLength;
    }
    return { data, height: mip.height, width: mip.width };
  });
  const array = new CompressedArrayTexture(
    mipmaps as never,
    width,
    height,
    maps.length,
    first.format,
    first.type,
  );
  array.colorSpace = first.colorSpace;
  array.minFilter = first.minFilter;
  array.magFilter = first.magFilter;
  array.wrapS = RepeatWrapping;
  array.wrapT = RepeatWrapping;
  array.anisotropy = 8;
  array.needsUpdate = true;
  for (const map of maps) map.dispose();
  return array;
}

/**
 * The splat terrain surface a world package describes, for `WorldCells.load({ surface })`.
 *
 * Layers blend over a base by mask channels read as linear data (the masks ship raw, beside the
 * heightmap, so no cook moves a blend threshold), with noise-broken edges and macro brightness
 * variation. Texture sets tile in world metres on the package's ground plane (x, -z: a Z-up
 * authoring tool's x and y), cliffs can be triplanar, and the base plus any layer that asks carries
 * a normal map. Each layer answers light from its own ORM map where the table ships one and from
 * the table's own roughness and metalness where it does not; a layer that states neither is matte
 * and dielectric, and named in a warning. Nothing here is a look choice:
 * textures, tiles, tints, thresholds, surface response and noise scales all come from the package's
 * table, which the game authors once and its DCC shares.
 *
 * @situation terrain textured by splat masks exported from Blender with the world package
 * @situation the game's terrain should match the DCC's terrain material without a second copy
 * @constraint the package's world.json must carry `terrain.layers.table` and `terrain.layers.splat`, written by `export_terrain_layers` in the `export_world.py` recipe
 * @constraint WebGPU allows 16 sampled textures per stage: same-size layers stack into one array texture per set, and `TN_TERRAIN_SPLAT samplers=<n>` reports what is left
 * @override `table` may replace `base`, `breakup`, `macro` and `layers` from game source; baked `splat` and `textures` stay package-owned
 * @example
 * const surface = await loadTerrainSplat({ assets: ctx.assets, renderer: ctx.renderer, url: "world/world.json" });
 * const world = await WorldCells.load({ assets: ctx.assets, url: "world/world.json", surface, follow, ring: 2 });
 */
export async function loadTerrainSplat(options: ILoadTerrainSplatOptions): Promise<Material> {
  const { assets, url } = options;
  const world = worldLayers(await (await fetchResolved(assets, url)).json());
  const layerPaths = world.layers;
  if (layerPaths.table === undefined || layerPaths.splat === undefined)
    throw new Error(
      "loadTerrainSplat: world.json has no terrain.layers.table/splat; export them with the export_world.py recipe.",
    );
  const dir = packageDir(url);
  const bakedTable = (await (
    await fetchResolved(assets, dir + layerPaths.table)
  ).json()) as ITerrainSplatTable;
  const table: ITerrainSplatTable =
    options.table === undefined
      ? bakedTable
      : { ...options.table, splat: bakedTable.splat, textures: bakedTable.textures };
  const bytes = new Uint8Array(
    await (await fetchResolved(assets, dir + layerPaths.splat)).arrayBuffer(),
  );

  const { minX, minZ, sizeX, sizeZ } = world.extent;
  // Rows are bottom-up in the authoring tool's ground plane, whose +y is three's -z.
  const maskUv = vec2(
    positionWorld.x.sub(minX).div(sizeX),
    float(minZ + sizeZ)
      .sub(positionWorld.z)
      .div(sizeZ),
  );
  const splat = splatArray(bytes, table.splat.size, table.splat.planes);
  const planes: Node<"vec4">[] = [];
  for (let plane = 0; plane < table.splat.planes; plane += 1)
    planes.push(texture(splat, maskUv).depth(int(plane)));

  const all: ITerrainSplatLayer[] = [table.base, ...table.layers];
  // A table exported before the orm column states no surface response at all, which is a package
  // the recipe wrote, not a malformed one: it loads, matte and dielectric, with the gap named. A
  // throw here fails the world's `load()` instead, and the game waits on its loading gate forever.
  const unstated = all
    .filter(
      (layer) =>
        layer.orm !== true &&
        typeof layer.roughness !== "number" &&
        typeof layer.metalness !== "number",
    )
    .map((layer) => layer.id);
  if (unstated.length > 0)
    console.warn(
      `TN_TERRAIN_SPLAT: ${unstated.join(", ")} states no orm map and no roughness/metalness, so they answer light as roughness ${String(DEFAULT_ROUGHNESS)} and metalness 0; re-export the package to author them.`,
    );

  const owned =
    options.layerSample !== undefined || options.materialFactory !== undefined
      ? new Set<Texture>([splat])
      : undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const map of owned ?? []) map.dispose();
  };

  const load = async (
    layer: ITerrainSplatLayer,
    kind: "diff" | "nrm" | "orm" | "h",
  ): Promise<Texture> => {
    if (
      layer.maps !== undefined &&
      (layer.maps === null || typeof layer.maps !== "object" || Array.isArray(layer.maps))
    )
      throw new Error(`loadTerrainSplat: layer '${layer.id}' maps needs a path object.`);
    const paths = {
      diff: layer.maps?.diffuse,
      nrm: layer.maps?.normal,
      orm: layer.maps?.orm,
      h: layer.maps?.height,
    };
    const explicitPath = paths[kind];
    if (
      explicitPath !== undefined &&
      (typeof explicitPath !== "string" ||
        explicitPath.trim() === "" ||
        /^(?:[/\\]|[a-z][a-z0-9+.-]*:)/iu.test(explicitPath))
    )
      throw new Error(
        `loadTerrainSplat: layer '${layer.id}' ${kind} map needs a package-relative path.`,
      );
    const path =
      explicitPath === undefined ? `${table.textures}/${layer.id}_${kind}.jpg` : explicitPath;
    const map = await assets.texture(`${dir}${path}`, { data: kind !== "diff" });
    map.wrapS = RepeatWrapping;
    map.wrapT = RepeatWrapping;
    map.anisotropy = 8;
    map.needsUpdate = true;
    if (released && owned?.has(map) === false) map.dispose();
    owned?.add(map);
    return map;
  };
  try {
    const withNormals = all.filter((layer) => layer.normal === true);
    const withOrm = all.filter((layer) => layer.orm === true);
    const diffuseMaps = await Promise.all(all.map((layer) => load(layer, "diff")));
    const normalMaps = await Promise.all(withNormals.map((layer) => load(layer, "nrm")));
    const ormMaps = await Promise.all(withOrm.map((layer) => load(layer, "orm")));
    const withHeight = table.layers.filter((layer) => layer.height === true);
    const heightMaps = await Promise.all(withHeight.map((layer) => load(layer, "h")));

    // One sampler per set when the layers stack; separate textures (and a warning) when they do not.
    let samplers = 1;
    let stackedSets = 0;
    const sampler = (
      maps: readonly Texture[],
      what: string,
    ): ((layer: number, uv: Node<"vec2">) => Node<"vec3">) => {
      if (options.layerSample !== undefined) {
        samplers += maps.length;
        return (layer, uv) => texture(maps[layer] as Texture, uv).rgb;
      }
      const stacked = stackLayers(maps, options.renderer);
      if (stacked !== undefined) {
        samplers += 1;
        stackedSets += 1;
        for (const map of maps) owned?.delete(map);
        owned?.add(stacked);
        return (layer, uv) => texture(stacked, uv).depth(int(layer)).rgb;
      }
      samplers += maps.length;
      if (maps.length > 1)
        console.warn(
          `TN_TERRAIN_SPLAT: ${what} layers could not stack into one array (mixed format or size, or no renderer to copy them with); they bind ${String(maps.length)} samplers, and WebGPU guarantees 16 a stage.`,
        );
      return (layer, uv) => texture(maps[layer] as Texture, uv).rgb;
    };
    const diffuseAt = sampler(diffuseMaps, "albedo");
    const normalAt = withNormals.length === 0 ? undefined : sampler(normalMaps, "normal");
    const ormAt = withOrm.length === 0 ? undefined : sampler(ormMaps, "ORM");
    const heightAt = withHeight.length === 0 ? undefined : sampler(heightMaps, "height");

    const ground = vec2(positionWorld.x, positionWorld.z.negate());
    const maskOf = (layer: ITerrainSplatMaskedLayer): Node<"float"> => {
      const where = table.splat.masks[layer.mask];
      if (where === undefined)
        throw new Error(
          `loadTerrainSplat: layer '${layer.id}' names missing mask '${layer.mask}'.`,
        );
      const source = planes[where[0]];
      if (source === undefined)
        throw new Error(`loadTerrainSplat: mask '${layer.mask}' names a missing plane.`);
      return source[where[1] === "rgb" ? layer.channel : where[1]];
    };
    const breakup = mx_noise_float(vec3(ground.mul(table.breakup.scale), 0))
      .mul(0.5)
      .add(0.5);
    const push = breakup.mul(2 * table.breakup.push).sub(table.breakup.push);

    // Box projection for cliffs: three axis-aligned samples blended by the surface normal.
    const triplanar = (at: (uv: Node<"vec2">) => Node<"vec3">, tile: number): Node<"vec3"> => {
      const weights = normalWorld.abs();
      const w = weights.div(weights.x.add(weights.y).add(weights.z));
      const p = positionWorld.div(tile);
      return at(p.zy).mul(w.x).add(at(p.xz).mul(w.y)).add(at(p.xy).mul(w.z));
    };

    const albedo = (layer: ITerrainSplatLayer, index: number): Node<"vec3"> => {
      let sample: Node<"vec3"> =
        layer.triplanar === true
          ? triplanar((uv) => diffuseAt(index, uv), layer.tile)
          : diffuseAt(index, ground.div(layer.tile));
      const far = layer.far;
      if (far !== undefined && layer.triplanar !== true) {
        if (!(far.tile > 0 && far.from < far.to && far.amount >= 0 && far.amount <= 1))
          throw new Error(
            `loadTerrainSplat: layer '${layer.id}' far needs tile > 0, from < to and amount in 0..1.`,
          );
        const reach = smoothstep(far.from, far.to, positionWorld.distance(cameraPosition));
        sample = mix(sample, diffuseAt(index, ground.div(far.tile)), reach.mul(far.amount));
      }
      if (layer.saturation !== undefined) {
        const luma = dot(sample, vec3(0.2126, 0.7152, 0.0722));
        sample = mix(vec3(luma), sample, layer.saturation);
      }
      return sample.mul(vec3(...layer.tint));
    };
    const normalOf = (layer: ITerrainSplatLayer): Node<"vec3"> | undefined => {
      const slot = withNormals.indexOf(layer);
      return slot === -1 || normalAt === undefined
        ? undefined
        : normalAt(slot, ground.div(layer.tile));
    };
    /**
     * A layer's answer to light, as occlusion in r, roughness in g and metalness in b: its ORM map
     * where it ships one, else the two numbers the table states (and no occlusion to apply).
     */
    const ormOf = (layer: ITerrainSplatLayer): Node<"vec3"> => {
      const slot = withOrm.indexOf(layer);
      if (slot !== -1 && ormAt !== undefined) return ormAt(slot, ground.div(layer.tile));
      return vec3(1, layer.roughness ?? DEFAULT_ROUGHNESS, layer.metalness ?? 0);
    };

    /** A height-carrying layer's own height, on the projection its albedo uses. */
    const heightOf = (layer: ITerrainSplatMaskedLayer): Node<"float"> | undefined => {
      const slot = withHeight.indexOf(layer);
      if (slot === -1 || heightAt === undefined) return undefined;
      const at = (uv: Node<"vec2">): Node<"vec3"> => heightAt(slot, uv);
      return (layer.triplanar === true ? triplanar(at, layer.tile) : at(ground.div(layer.tile))).r;
    };

    const samples = all.map(
      (layer, index): ITerrainSplatSample =>
        options.layerSample === undefined
          ? { color: albedo(layer, index), normal: normalOf(layer), orm: ormOf(layer) }
          : options.layerSample({
              layer,
              index,
              diffuse: diffuseMaps[index] as Texture,
              normal: normalMaps[withNormals.indexOf(layer)],
              orm: ormMaps[withOrm.indexOf(layer)],
              height: heightMaps[withHeight.indexOf(layer as ITerrainSplatMaskedLayer)],
            }),
    );
    let color = (samples[0] as ITerrainSplatSample).color;
    let normalSample: Node<"vec3"> = samples[0]?.normal ?? vec3(0.5, 0.5, 1);
    let ormSample: Node<"vec3"> = samples[0]?.orm ?? ormOf(table.base);
    table.layers.forEach((layer, offset) => {
      const masked = clamp(
        maskOf(layer)
          .add(push)
          .sub(layer.lo)
          .div(layer.hi - layer.lo),
        0,
        1,
      );
      const weight =
        options.layerWeight === undefined
          ? masked
          : options.layerWeight(masked, { height: heightOf(layer), index: offset, layer });
      const sample = samples[offset + 1] as ITerrainSplatSample;
      color = mix(color, sample.color, weight);
      const nrm = sample.normal;
      if (nrm !== undefined) normalSample = mix(normalSample, nrm, weight);
      ormSample = mix(ormSample, sample.orm ?? ormOf(layer), weight);
    });
    const macro = mx_noise_float(vec3(ground.mul(table.macro.scale), 0))
      .mul(0.5)
      .add(0.5)
      .mul(table.macro.max - table.macro.min)
      .add(table.macro.min);

    // Every layer's own light response, blended by the same weights as its colour: the material
    // holds no scalar of its own, and `DEFAULT_ROUGHNESS` only answers for a layer that states
    // nothing at all.
    let material: Material;
    if (options.materialFactory === undefined) {
      const standard = new MeshStandardNodeMaterial();
      standard.name = "terrain-splat";
      standard.colorNode = color.mul(macro);
      // A top-down projection's tangent frame: +x along u, ground +y (three -z) along v, OpenGL green
      // up v, re-orthogonalised against the tile's own normal.
      const n = normalWorld;
      const tangent = vec3(1, 0, 0).sub(n.mul(n.x)).normalize();
      const bitangent = n.cross(tangent).normalize();
      const t = normalSample.mul(2).sub(1);
      const perturbed = tangent.mul(t.x).add(bitangent.mul(t.y)).add(n.mul(t.z)).normalize();
      standard.normalNode = cameraViewMatrix.mul(vec4(perturbed, 0)).xyz.normalize();
      standard.aoNode = ormSample.r;
      standard.roughnessNode = ormSample.g;
      standard.metalnessNode = ormSample.b;
      material = standard;
    } else {
      material = options.materialFactory({
        color: color.mul(macro),
        normal: normalSample,
        orm: ormSample,
      });
    }
    if (owned !== undefined) material.addEventListener("dispose", release);
    // One line, printed and kept on the material: what this surface costs, readable by a game that
    // wants to assert it rather than scrape a console.
    material.userData.TN_TERRAIN_SPLAT =
      options.layerSample === undefined
        ? `layers=${String(all.length)} samplers=${String(samplers)} stacked=${String(stackedSets)}`
        : `layers=${String(all.length)} loadedSamplerUpperBound=${String(samplers)} stacked=0 sampling=custom`;
    console.info(`TN_TERRAIN_SPLAT ${material.userData.TN_TERRAIN_SPLAT as string}`);
    return material;
  } catch (error) {
    if (owned !== undefined) release();
    throw error;
  }
}

/**
 * Apply a cooked GLB's package-authored layered surface to its marked terrain meshes.
 * `url` is the loaded GLB URL; extras pointers are relative to it. Uses the same asset/fetch
 * path as loadTerrainSplat on web and native. The caller owns the assigned materials' lifetime.
 * @situation apply the authored layered terrain surface after loading a cooked world GLB
 * @constraint url names the loaded GLB; tnTerrainSurface extras name a relative world package JSON
 * @override `table` may replace `base`, `breakup`, `macro` and `layers`; baked `splat` and `textures` stay package-owned
 * @example
 * await applyTerrainSurface(world.scene, { assets: ctx.assets, renderer: ctx.renderer, url: "world/world.glb" });
 */
export async function applyTerrainSurface(
  root: Object3D,
  options: ILoadTerrainSplatOptions,
): Promise<void> {
  const targets = new Map<Mesh, string>();
  const retained = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    let owner: Object3D | null = object;
    while (owner !== null && owner.userData.tnTerrainSurface === undefined && owner !== root)
      owner = owner.parent;
    const pointer: unknown = owner?.userData.tnTerrainSurface;
    if (pointer === undefined) {
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        retained.add(material);
      return;
    }
    if (
      typeof pointer !== "string" ||
      !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.json$/u.test(pointer)
    )
      throw new Error(`applyTerrainSurface: invalid terrain surface pointer '${String(pointer)}'.`);
    targets.set(object, packageDir(options.url) + pointer);
  });
  const surfaces = new Map<string, Material>();
  try {
    for (const url of new Set(targets.values()))
      surfaces.set(url, await loadTerrainSplat({ ...options, url }));
  } catch (error) {
    for (const surface of surfaces.values()) surface.dispose();
    throw error;
  }
  const replaced = new Set<Material>();
  for (const [mesh, url] of targets) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
      replaced.add(material);
    mesh.material = surfaces.get(url) as Material;
  }
  for (const material of replaced) if (!retained.has(material)) material.dispose();
}
