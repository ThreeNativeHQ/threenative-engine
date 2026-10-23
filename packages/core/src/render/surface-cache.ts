/**
 * The Surface Cache: what a traced global-illumination ray reads at the surface it hits (PRD-639).
 *
 * Unreal keeps a lit proxy of every mesh, the Surface Cache, and its rays read that, never the material
 * (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenSoftwareRayTracing.ush`, `SurfaceCache/LumenSurfaceCache.usf`).
 * This is the same job in texture space: the meshes already carry UVs, so a material's base colour and
 * emissive maps are reduced to one small tile each and packed into an atlas, and a hit reads the tile at its
 * UV. A material without a map keeps its flat colour. `SurfaceLights` adds the local lights at the hit.
 *
 * Mechanism only. Every colour, texture and light comes from the game's materials and lights; the cache owns none.
 */

/** A colour channel triple in linear light, as three's `Color` holds it. */
interface IRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Pixels a map can be read from: `ImageData` or a typed array with a size. */
interface IPixels {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/** The part of a three `Texture` the cache reads. `image` is an `ImageData`, an `ImageBitmap` or a canvas. */
export interface ISurfaceCacheTexture {
  readonly image?: unknown;
  /** "srgb" (three's `SRGBColorSpace`) is decoded to linear; anything else is taken as linear. */
  readonly colorSpace?: string;
  /** three's default is true; glTF textures load with false (v = 0 is the top row). */
  readonly flipY?: boolean;
  /** Wrap mode as three's constants: 1000 repeat, 1001 clamp, 1002 mirrored repeat. Default repeat. */
  readonly wrapS?: number;
  readonly wrapT?: number;
  /** three's UV transform; `updateMatrix` is called when present. */
  readonly matrix?: { readonly elements: ArrayLike<number> };
  updateMatrix?(): void;
}

/** The part of a three `MeshStandardMaterial` the cache reads. */
export interface ISurfaceCacheMaterial {
  readonly name?: string;
  readonly color?: IRgb;
  readonly map?: ISurfaceCacheTexture | null;
  readonly metalness?: number;
  readonly emissive?: IRgb;
  readonly emissiveIntensity?: number;
  readonly emissiveMap?: ISurfaceCacheTexture | null;
}

export interface ISurfaceCacheOptions {
  /** Atlas edge in texels, a power of two. Default 2048 (Unreal: 2048 at Medium, 4096 at Epic). */
  readonly atlasSize?: number;
  /** Scales the 64-texel tile a material starts from. Default 1. The atlas budget still shrinks it. */
  readonly cardTexelDensityScale?: number;
  /**
   * The pixels of a map whose own `image` carries none. The owned engine decodes a glTF's maps itself, so JS sees
   * their size and nothing else: the game hands over the image it read from the same file. Returning `undefined`
   * keeps the texture's own `image`.
   */
  readonly images?: (material: ISurfaceCacheMaterial, slot: "map" | "emissiveMap") => unknown;
}

export interface ISurfaceCacheReport {
  readonly atlasSize: number;
  /** Bytes of the albedo and emissive atlases as 8-bit RGBA, the form a GPU upload takes. */
  readonly atlasBytes: number;
  readonly tileEdge: number;
  readonly tilesInUse: number;
  readonly mappedMaterials: number;
  readonly flatMaterials: number;
  /** Materials that have a map the cache could not use, so their hits return the flat colour. */
  readonly fallbacks: readonly {
    readonly material: string;
    readonly reason: "unreadable-image";
    /** What the image was and why it could not be read. */
    readonly detail: string;
  }[];
}

const START_TILE = 64;
const MIN_TILE = 2;
const MAX_TILE = 512;
const REPEAT = 1000;
const MIRRORED = 1002;
/** Largest edge read from a source image. Past it the browser downsamples the draw. */
const MAX_READ = 1024;

const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** The pixels of a map, or a sentence saying what the image was and why it cannot be read. */
function pixelsOf(image: unknown): IPixels | string {
  const candidate = image as
    | { data?: unknown; width?: number; height?: number; constructor?: { name?: string } }
    | null
    | undefined;
  const what = `${candidate?.constructor?.name ?? typeof image} ${candidate?.width ?? "?"}x${candidate?.height ?? "?"}`;
  if (typeof candidate?.width !== "number" || typeof candidate.height !== "number")
    return `${what}, no size`;
  const data =
    candidate.data instanceof ArrayBuffer ? new Uint8Array(candidate.data) : candidate.data;
  if (
    ArrayBuffer.isView(data) &&
    !(data instanceof DataView) &&
    candidate.width > 0 &&
    candidate.height > 0
  )
    return {
      data: data as ArrayBufferView & ArrayLike<number>,
      width: candidate.width,
      height: candidate.height,
    };
  if (typeof OffscreenCanvas === "undefined") return `${what}, no OffscreenCanvas`;
  if (!candidate.width || !candidate.height) return `${what}, empty (a closed bitmap?)`;
  const scale = Math.min(1, MAX_READ / Math.max(candidate.width, candidate.height));
  const [w, h] = [
    Math.max(1, Math.round(candidate.width * scale)),
    Math.max(1, Math.round(candidate.height * scale)),
  ];
  try {
    const context = new OffscreenCanvas(w, h).getContext("2d");
    context?.drawImage(image as CanvasImageSource, 0, 0, w, h);
    return context?.getImageData(0, 0, w, h) ?? `${what}, no 2d context`;
  } catch (error) {
    return `${what}, ${String(error).slice(0, 120)}`;
  }
}

/**
 * One map as a `tile` x `tile` block of linear RGB, row 0 at the top of the image. Reducing averages every source
 * texel a tile texel covers (a bounce carries the mean albedo); enlarging repeats texels, so a tiny map reads exact.
 */
function reduce(pixels: IPixels, tile: number, srgb: boolean, out: Float32Array): void {
  const { data, width, height } = pixels;
  const unit = data instanceof Float32Array || data instanceof Float64Array ? 1 : 255;
  const decode = srgb && unit === 255;
  const channels = Math.max(3, Math.round(data.length / (width * height)));
  for (let ty = 0; ty < tile; ty += 1) {
    const [y0, y1] = [
      Math.floor((ty * height) / tile),
      Math.max(Math.floor((ty * height) / tile) + 1, Math.ceil(((ty + 1) * height) / tile)),
    ];
    for (let tx = 0; tx < tile; tx += 1) {
      const [x0, x1] = [
        Math.floor((tx * width) / tile),
        Math.max(Math.floor((tx * width) / tile) + 1, Math.ceil(((tx + 1) * width) / tile)),
      ];
      const sum = [0, 0, 0];
      for (let y = y0; y < y1; y += 1)
        for (let x = x0; x < x1; x += 1)
          for (let c = 0; c < 3; c += 1) {
            const v = (data[(y * width + x) * channels + c] ?? 0) / unit;
            sum[c] = (sum[c] ?? 0) + (decode ? srgbToLinear(v) : v);
          }
      const n = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 3; c += 1) out[(ty * tile + tx) * 3 + c] = (sum[c] ?? 0) / n;
    }
  }
}

function wrap(v: number, mode: number | undefined): number {
  if (mode === REPEAT || mode === undefined) return v - Math.floor(v);
  if (mode === MIRRORED) {
    const m = v - 2 * Math.floor(v / 2);
    return m > 1 ? 2 - m : m;
  }
  return Math.min(1, Math.max(0, v));
}

interface ITile {
  /** Linear RGB, `tile * tile * 3`. */
  readonly texels: Float32Array;
  readonly texture: ISurfaceCacheTexture;
}

interface ISlot {
  readonly albedo: IRgb;
  readonly albedoTile: ITile | undefined;
  readonly emissive: IRgb;
  readonly emissiveTile: ITile | undefined;
}

/**
 * A material atlas over a fixed list of materials. A hit names the material by its index in that list (the
 * trace's material table) and the UV from the triangle's barycentrics. Static, like the scene's BVH: build
 * a new one when the materials change.
 */
export class SurfaceCache {
  readonly report: ISurfaceCacheReport;
  readonly #slots: readonly ISlot[];
  readonly #tile: number;

  private constructor(slots: readonly ISlot[], tile: number, report: ISurfaceCacheReport) {
    this.#slots = slots;
    this.#tile = tile;
    this.report = report;
  }

  static from(
    materials: readonly ISurfaceCacheMaterial[],
    options: ISurfaceCacheOptions = {},
  ): SurfaceCache {
    const atlasSize = options.atlasSize ?? 2048;
    const scale = options.cardTexelDensityScale ?? 1;
    if (materials.length === 0) throw new RangeError("SurfaceCache needs at least one material");
    if (!isPowerOfTwo(atlasSize))
      throw new RangeError(`atlasSize ${atlasSize} must be a power of two`);
    if (!(scale > 0) || !Number.isFinite(scale))
      throw new RangeError(`cardTexelDensityScale ${scale} must be positive`);
    // One albedo tile and one emissive tile per material; the atlas holds `(atlasSize / tile)^2` of each.
    let tile = Math.min(
      MAX_TILE,
      Math.max(MIN_TILE, 2 ** Math.round(Math.log2(START_TILE * scale))),
    );
    while (tile > MIN_TILE && Math.floor(atlasSize / tile) ** 2 < materials.length) tile /= 2;
    if (Math.floor(atlasSize / tile) ** 2 < materials.length)
      throw new RangeError(`atlasSize ${atlasSize} holds fewer than ${materials.length} materials`);

    const fallbacks: { material: string; reason: "unreadable-image"; detail: string }[] = [];
    let mapped = 0;
    const tileOf = (
      material: ISurfaceCacheMaterial,
      index: number,
      slot: "map" | "emissiveMap",
    ): ITile | undefined => {
      const texture = material[slot];
      if (texture === null || texture === undefined) return undefined;
      const pixels = pixelsOf(options.images?.(material, slot) ?? texture.image);
      if (typeof pixels === "string") {
        fallbacks.push({
          material: material.name || `material ${index}`,
          reason: "unreadable-image",
          detail: pixels,
        });
        return undefined;
      }
      const texels = new Float32Array(tile * tile * 3);
      reduce(pixels, tile, texture.colorSpace === "srgb", texels);
      texture.updateMatrix?.();
      return { texels, texture };
    };
    const slots = materials.map((material, index): ISlot => {
      const k = 1 - (material.metalness ?? 0);
      const color = material.color ?? { r: 1, g: 1, b: 1 };
      const e = material.emissive ?? { r: 0, g: 0, b: 0 };
      const intensity = material.emissiveIntensity ?? 1;
      const albedoTile = tileOf(material, index, "map");
      const emissiveTile = tileOf(material, index, "emissiveMap");
      if (albedoTile !== undefined || emissiveTile !== undefined) mapped += 1;
      return {
        albedo: { r: color.r * k, g: color.g * k, b: color.b * k },
        albedoTile,
        emissive: { r: e.r * intensity, g: e.g * intensity, b: e.b * intensity },
        emissiveTile,
      };
    });
    return new SurfaceCache(slots, tile, {
      atlasSize,
      atlasBytes: atlasSize * atlasSize * 4 * 2,
      tileEdge: tile,
      tilesInUse: materials.length,
      mappedMaterials: mapped,
      flatMaterials: materials.length - mapped,
      fallbacks,
    });
  }

  /** Writes the diffuse albedo (linear RGB) at `u`, `v` of material `slot`: the map times the colour factor. */
  albedo(slot: number, u: number, v: number, out: number[]): number[] {
    const s = this.#slot(slot);
    return this.#read(s.albedoTile, s.albedo, u, v, out);
  }

  /** Writes the emitted radiance at `u`, `v`: the emissive map times the colour times the intensity. */
  emissive(slot: number, u: number, v: number, out: number[]): number[] {
    const s = this.#slot(slot);
    return this.#read(s.emissiveTile, s.emissive, u, v, out);
  }

  #slot(slot: number): ISlot {
    const s = this.#slots[slot];
    if (s === undefined) throw new RangeError(`SurfaceCache has no material ${slot}`);
    return s;
  }

  #read(tile: ITile | undefined, factor: IRgb, u: number, v: number, out: number[]): number[] {
    if (tile === undefined) {
      out[0] = factor.r;
      out[1] = factor.g;
      out[2] = factor.b;
      return out;
    }
    const m = tile.texture.matrix?.elements;
    // three's UV transform, column-major 3x3 acting on (u, v, 1).
    const [tu, tv] =
      m === undefined || m.length < 9
        ? [u, v]
        : [
            (m[0] ?? 1) * u + (m[3] ?? 0) * v + (m[6] ?? 0),
            (m[1] ?? 0) * u + (m[4] ?? 1) * v + (m[7] ?? 0),
          ];
    const x = wrap(tu, tile.texture.wrapS);
    // flipY (three's default) puts v = 0 at the bottom row; glTF textures load with it false.
    const y = wrap(tile.texture.flipY === false ? tv : 1 - tv, tile.texture.wrapT);
    const n = this.#tile;
    const [px, py] = [Math.min(n - 1, Math.floor(x * n)), Math.min(n - 1, Math.floor(y * n))];
    const at = (py * n + px) * 3;
    out[0] = (tile.texels[at] ?? 0) * factor.r;
    out[1] = (tile.texels[at + 1] ?? 0) * factor.g;
    out[2] = (tile.texels[at + 2] ?? 0) * factor.b;
    return out;
  }
}

/** A local light, in three's units: `intensity` is candela and `distance` the cutoff (0 = none). */
export interface ISurfaceLight {
  readonly kind: "point" | "spot";
  readonly position: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly distance: number;
  /** Spot only: unit direction the cone points along, half angle in radians, penumbra 0..1. */
  readonly direction?: readonly [number, number, number];
  readonly angle?: number;
  readonly penumbra?: number;
}

export interface ISurfaceLightsOptions {
  /** The most lights evaluated at one hit, the brightest first. Default 8. */
  readonly maxLights?: number;
}

/**
 * The local lights at a hit: culled to the ones whose range reaches the point, the brightest first, capped, with
 * one shadow ray each, supplied by the caller (the bake's BVH ray, or the kernel's). Lights skipped by the cap are
 * counted in `skipped`.
 */
export class SurfaceLights {
  /** Lights left out by the cap, summed over every `shade` call. */
  skipped = 0;
  readonly #lights: readonly ISurfaceLight[];
  readonly #max: number;
  readonly #scores: number[];
  readonly #order: number[] = [];

  constructor(lights: readonly ISurfaceLight[], options: ISurfaceLightsOptions = {}) {
    const max = options.maxLights ?? 8;
    if (!Number.isInteger(max) || max < 1)
      throw new RangeError(`maxLights ${max} must be an integer of 1 or more`);
    this.#lights = lights;
    this.#max = max;
    this.#scores = new Array<number>(lights.length).fill(0);
  }

  /**
   * Adds the light the hit receives to `out` (RGB, linear): albedo x colour x (intensity / pi) / d^2 x window x cos
   * (x cone for a spot). `visible(i)` answers the shadow ray to light `i`; it is not asked for a light behind the
   * surface, out of range or outside its cone.
   */
  shade(
    point: readonly [number, number, number],
    normal: readonly [number, number, number],
    albedo: readonly [number, number, number],
    out: number[],
    visible: (light: number) => boolean,
  ): number[] {
    const order = this.#order;
    order.length = 0;
    for (let i = 0; i < this.#lights.length; i += 1) {
      const score = this.#score(this.#lights[i] as ISurfaceLight, point, normal);
      this.#scores[i] = score;
      if (score > 0) order.push(i);
    }
    order.sort((a, b) => (this.#scores[b] ?? 0) - (this.#scores[a] ?? 0));
    this.skipped += Math.max(0, order.length - this.#max);
    for (let k = 0; k < Math.min(order.length, this.#max); k += 1) {
      const i = order[k] as number;
      if (!visible(i)) continue;
      const light = this.#lights[i] as ISurfaceLight;
      for (let c = 0; c < 3; c += 1)
        out[c] = (out[c] ?? 0) + (albedo[c] ?? 0) * (light.color[c] ?? 0) * (this.#scores[i] ?? 0);
    }
    return out;
  }

  /** The light's contribution per unit albedo and colour at `point`, 0 when it cannot reach it. */
  #score(
    light: ISurfaceLight,
    [px, py, pz]: readonly [number, number, number],
    [nx, ny, nz]: readonly [number, number, number],
  ): number {
    const [dx, dy, dz] = [light.position[0] - px, light.position[1] - py, light.position[2] - pz];
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.02 || (light.distance > 0 && d >= light.distance)) return 0;
    const cos = (nx * dx + ny * dy + nz * dz) / d;
    if (cos <= 0) return 0;
    // three's getDistanceAttenuation: inverse square times a window that closes at the cutoff distance.
    const window =
      light.distance > 0 ? Math.min(1, Math.max(0, 1 - (d / light.distance) ** 4)) ** 2 : 1;
    let cone = 1;
    if (light.kind === "spot") {
      const dir = light.direction ?? [0, -1, 0];
      const toHit = (-dx * dir[0] - dy * dir[1] - dz * dir[2]) / d;
      const outer = Math.cos(light.angle ?? Math.PI / 3);
      const inner = Math.cos((light.angle ?? Math.PI / 3) * (1 - (light.penumbra ?? 0)));
      // three's getSpotAttenuation: smoothstep between the outer and the inner cone.
      const t = Math.min(1, Math.max(0, (toHit - outer) / Math.max(inner - outer, 1e-6)));
      cone = t * t * (3 - 2 * t);
    }
    return (light.intensity / Math.PI / (d * d)) * window * cos * cone;
  }
}
