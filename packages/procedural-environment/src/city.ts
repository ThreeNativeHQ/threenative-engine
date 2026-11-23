import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Canvas, Image, ImageData } from "@napi-rs/canvas";
import type { Box3, Mesh, Object3D } from "three";

/** One Apex City Kit module: its id, name, category name, description and road sockets (N, E, S, W). */
export interface ICityModule {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly edges: string;
}

export interface IBakeCityOptions {
  /** Directory the GLB is written to; created when missing. */
  readonly out: string;
  /** A module id: `environmentElements({ kind: "city" })` lists all 75 (cross, office, sedan, civic-bridge ...). */
  readonly module: string;
  /** An integer 0 to 4294967295. The same options always write the same bytes. Default 31082, the page's. */
  readonly seed?: number;
  /** Geometry detail: 0 low, 1 standard, 2 high. Default 2. */
  readonly detail?: number;
  /** Surface wetness, 0 to 100. Default 30. */
  readonly wet?: number;
  /** Building floors, an integer 2 to 12. Default 4. */
  readonly floors?: number;
  /** Sign text, at most 24 characters; empty uses the generated name. Default "". */
  readonly text?: string;
  /** Include street fixtures. Default true. */
  readonly dressing?: boolean;
  /** Straight and curve carriageway width in metres (6–16). Default 10. */
  readonly roadWidth?: number;
  /** Straight length in metres (8–200). Default 24. */
  readonly roadLength?: number;
  /** Curve sweep in degrees (5–180). Default 90. */
  readonly bendAngle?: number;
  /** Curve centreline radius in metres (12–120). Default 12. */
  readonly bendRadius?: number;
  /** Curve direction from its north inlet. Default "right". */
  readonly bendSide?: "left" | "right";
  /** Roadway material for modules with road sockets. Default "asphalt". */
  readonly roadSurface?: "asphalt" | "concrete" | "paving";
  /** Include pedestrian paving on supported road modules. Default true. */
  readonly sidewalk?: boolean;
  /** Include curbs on supported road modules. Default true. */
  readonly curb?: boolean;
  /** Include lane paint on straight and curve modules. Default true. */
  readonly markings?: boolean;
  /** Light canvas-drawn sign materials (`extras.sign`) with an emissive map for night scenes. Default false. */
  readonly emissiveSigns?: boolean;
  /** Convert transmissive glass (`transmission > 0`) to opaque reflective PBR glass. Default true: the default native engine refuses a transmissive mesh by name (`TN_MATERIAL_UNSUPPORTED transmission`) and three pays a full-scene transmission pass; `false` keeps the kit's transmissive glass. */
  readonly opaqueGlass?: boolean;
}

export const cityRoadDefaults = {
  roadWidth: 10,
  roadLength: 24,
  bendAngle: 90,
  bendRadius: 12,
  bendSide: "right",
  roadSurface: "asphalt",
  sidewalk: true,
  curb: true,
  markings: true,
} satisfies Partial<IBakeCityOptions>;

export const cityBakeDefaults = {
  emissiveSigns: false,
  opaqueGlass: true,
} satisfies Partial<IBakeCityOptions>;

export const cityRoadEdgeModules = [
  "straight",
  "curve",
  "cross",
  "tee",
  "alley",
  "grid",
  "pit",
  "cul-de-sac",
];

type CityRoadSettings = Required<Pick<IBakeCityOptions, keyof typeof cityRoadDefaults>>;
type CityBakeSettings = Required<Pick<IBakeCityOptions, keyof typeof cityBakeDefaults>>;
type CityParameters = Required<
  Omit<IBakeCityOptions, "out" | "module" | keyof CityRoadSettings | keyof CityBakeSettings>
>;

interface IApex {
  build(
    id: string,
    parameters: CityParameters,
    road?: CityRoadSettings,
    profile?: boolean,
  ): Object3D;
  loadMaps(): Promise<void>;
  readonly modules: readonly {
    id: string;
    name: string;
    category: number;
    description: string;
    edges: string;
  }[];
  readonly categories: readonly string[];
  readonly defaults: CityParameters;
  readonly GLTFExporter: new () => {
    parseAsync(input: Object3D, options: Record<string, unknown>): Promise<ArrayBuffer>;
  };
}

const SOURCE = fileURLToPath(new URL("../vendor/apex/apex-city-kit.js", import.meta.url));
let script: vm.Script | undefined;
let catalog: ICityModule[] | undefined;

/** A Blob that resolves in call order, so the exporter lays the GLB out the same on every run. */
class OrderedBlob {
  readonly bytes: Buffer;
  readonly type: string;
  constructor(parts: readonly unknown[], options?: { type?: string }) {
    this.type = options?.type ?? "";
    this.bytes = Buffer.concat(
      parts.map((part) =>
        typeof part === "string"
          ? Buffer.from(part)
          : ArrayBuffer.isView(part)
            ? Buffer.from(part.buffer, part.byteOffset, part.byteLength)
            : Buffer.from(part as ArrayBuffer),
      ),
    );
  }
  get size(): number {
    return this.bytes.byteLength;
  }
}

class OrderedFileReader {
  result: ArrayBuffer | undefined;
  onloadend: (() => void) | undefined;
  readAsArrayBuffer(blob: OrderedBlob): void {
    queueMicrotask(() => {
      this.result = new Uint8Array(blob.bytes).buffer;
      this.onloadend?.();
    });
  }
}

/** A canvas the page would get from `document.createElement("canvas")`. */
function pageCanvas(): Canvas {
  const canvas = Object.assign(new Canvas(300, 150), {
    style: {},
    toBlob(done: (blob: OrderedBlob) => void, type = "image/png"): void {
      // ponytail: PNG and JPEG only, the two types GLTFExporter writes here; the browser's JPEG quality is 0.92.
      const bytes =
        type === "image/jpeg" ? canvas.encodeSync("jpeg", 92) : canvas.encodeSync("png");
      queueMicrotask(() => done(new OrderedBlob([bytes], { type })));
    },
  });
  // A browser canvas has no `data`; napi's raw-pixel method would send GLTFExporter down its
  // DataTexture path and export a blank image.
  Object.defineProperty(canvas, "data", { value: undefined });
  return canvas;
}

function pageImage(): Image {
  const image = new Image();
  return Object.assign(image, {
    addEventListener(type: string, listener: (event: unknown) => void): void {
      if (type === "load") image.onload = () => listener.call(image, { type });
      else if (type === "error") image.onerror = (error) => listener.call(image, error);
    },
    removeEventListener(): void {},
  });
}

/**
 * A fresh run of the page script: its own three, caches and materials, with only what generation
 * and export touch (a canvas, an image, Blob and FileReader). Warnings stay quiet; an error fails.
 */
function apex(errors: string[] = []): IApex {
  script ??= new vm.Script(readFileSync(SOURCE, "utf8"), { filename: SOURCE });
  const quiet = (): void => {};
  const context = vm.createContext({
    console: {
      log: quiet,
      info: quiet,
      warn: quiet,
      debug: quiet,
      error: (...parts: unknown[]) => errors.push(parts.map(String).join(" ")),
    },
    document: {
      createElement: (tag: string) => {
        if (tag === "canvas") return pageCanvas();
        throw new Error(`bakeCity: the page asked for a <${tag}> element`);
      },
      createElementNS: (_namespace: string, tag: string) => {
        if (tag === "img") return pageImage();
        if (tag === "canvas") return pageCanvas();
        throw new Error(`bakeCity: the page asked for a <${tag}> element`);
      },
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    Blob: OrderedBlob,
    FileReader: OrderedFileReader,
    ImageData,
    HTMLCanvasElement: Canvas,
    HTMLImageElement: Image,
  });
  return script.runInContext(context) as IApex;
}

/** The 75 modules of the vendored Apex City Kit, in the page's order. */
export function cityModules(): ICityModule[] {
  if (catalog === undefined) {
    const kit = apex();
    catalog = kit.modules.map(({ id, name, category, description, edges }) => ({
      id,
      name: id === "curve" ? "Two-lane road bend" : name,
      category: kit.categories[category] as string,
      description:
        id === "curve" ? "Two-lane bend with adjustable angle, radius and direction." : description,
      edges,
    }));
  }
  return catalog.map((module) => ({ ...module }));
}

/** The page's own limits (its layout validator): throws naming the option and its range. */
function checkParameters(parameters: CityParameters): void {
  const { seed, detail, wet, floors, text, dressing } = parameters;
  const fail = (rule: string, value: unknown): never => {
    throw new Error(`bakeCity: ${rule}, got ${JSON.stringify(value)}`);
  };
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)
    fail("seed must be an integer 0 to 4294967295", seed);
  if (!Number.isInteger(detail) || detail < 0 || detail > 2)
    fail("detail must be 0 (low), 1 (standard) or 2 (high)", detail);
  if (!Number.isFinite(wet) || wet < 0 || wet > 100) fail("wet must be 0 to 100", wet);
  if (!Number.isInteger(floors) || floors < 2 || floors > 12)
    fail("floors must be an integer 2 to 12", floors);
  if (typeof text !== "string" || text.length > 24)
    fail("text must be a string of at most 24 characters", text);
  if (typeof dressing !== "boolean") fail("dressing must be true or false", dressing);
}

function roadSettings(options: IBakeCityOptions, hasSockets: boolean) {
  const { module } = options;
  const road: CityRoadSettings = { ...cityRoadDefaults };
  const profile = module === "straight" || module === "curve";
  const edges = cityRoadEdgeModules.includes(module);
  const rules = {
    roadWidth: [profile, 6, 16],
    roadLength: [module === "straight", 8, 200],
    bendAngle: [module === "curve", 5, 180],
    bendRadius: [module === "curve", 12, 120],
    bendSide: [module === "curve", "left", "right"],
    roadSurface: [hasSockets, "asphalt", "concrete", "paving"],
    sidewalk: [edges, true, false],
    curb: [edges, true, false],
    markings: [profile, true, false],
  } as const;
  for (const key of Object.keys(road) as (keyof CityRoadSettings)[]) {
    const value = options[key];
    if (value === undefined) continue;
    const [supported, ...values] = rules[key];
    if (!supported) throw new Error(`bakeCity: ${key} is unavailable for "${module}"`);
    const [min, max] = values;
    const valid =
      typeof min === "number" && typeof max === "number"
        ? typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
        : values.some((allowed) => allowed === value);
    if (!valid) throw new Error(`bakeCity: invalid ${key}: ${JSON.stringify(value)}`);
    Object.assign(road, { [key]: value });
  }
  return road;
}

interface IVmTexture {
  name?: string;
  image?: {
    encodeSync?: (format: string) => Uint8Array;
    data?: ArrayBufferView;
    src?: string;
    width?: number;
    height?: number;
  };
  wrapS?: number;
  wrapT?: number;
  magFilter?: number;
  minFilter?: number;
  repeat?: { x: number; y: number };
  offset?: { x: number; y: number };
  center?: { x: number; y: number };
  rotation?: number;
  flipY?: boolean;
  colorSpace?: string;
  generateMipmaps?: boolean;
  anisotropy?: number;
  channel?: number;
  premultiplyAlpha?: boolean;
  unpackAlignment?: number;
  userData?: Record<string, unknown>;
}

interface IVmMaterial {
  type?: string;
  name?: string;
  color?: { r: number; g: number; b: number };
  emissive?: {
    r: number;
    g: number;
    b: number;
    setRGB?: (r: number, g: number, b: number) => void;
  };
  emissiveIntensity?: number;
  emissiveMap?: IVmTexture | null;
  map?: IVmTexture | null;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  transparent?: boolean;
  alphaTest?: number;
  side?: number;
  depthWrite?: boolean;
  depthTest?: boolean;
  vertexColors?: boolean;
  flatShading?: boolean;
  wireframe?: boolean;
  transmission?: number;
  thickness?: number;
  ior?: number;
  attenuationColor?: { r: number; g: number; b: number };
  attenuationDistance?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenRoughness?: number;
  sheenColor?: { r: number; g: number; b: number };
  specularIntensity?: number;
  specularColor?: { r: number; g: number; b: number };
  iridescence?: number;
  iridescenceIOR?: number;
  envMapIntensity?: number;
  normalScale?: { x: number; y: number };
  clearcoatNormalScale?: { x: number; y: number };
  aoMapIntensity?: number;
  bumpScale?: number;
  userData?: Record<string, unknown>;
  [slot: string]: unknown;
}

interface IVmAttribute {
  array: ArrayBufferView &
    ArrayLike<number> & {
      constructor: new (
        length: number,
      ) => ArrayBufferView & {
        set: (array: ArrayBufferView, offset?: number) => void;
      };
    };
  count: number;
  itemSize: number;
  normalized: boolean;
  isInterleavedBufferAttribute?: boolean;
  constructor: new (array: ArrayBufferView, itemSize: number, normalized?: boolean) => IVmAttribute;
}

interface IVmGeometry {
  attributes: Record<string, IVmAttribute>;
  index: IVmAttribute | null;
  groups: unknown[];
  drawRange: { start: number; count: number };
  morphAttributes?: Record<string, unknown>;
  userData?: Record<string, unknown>;
  clone(): IVmGeometry;
  getAttribute(name: string): IVmAttribute | undefined;
  setAttribute(name: string, attribute: IVmAttribute): void;
  setIndex(index: IVmAttribute | number[] | null): void;
  computeBoundingBox(): void;
  computeBoundingSphere(): void;
}

interface IVmMesh extends Object3D {
  isMesh?: boolean;
  geometry: IVmGeometry;
  material: IVmMaterial | IVmMaterial[];
  morphTargetInfluences?: unknown[];
}

const MATERIAL_TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
  "bumpMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "transmissionMap",
  "thicknessMap",
  "specularColorMap",
  "specularIntensityMap",
] as const;

function bakeSettings(options: IBakeCityOptions): {
  readonly settings: CityBakeSettings;
  readonly changes: [string, boolean][];
} {
  const settings: CityBakeSettings = {
    emissiveSigns: options.emissiveSigns ?? cityBakeDefaults.emissiveSigns,
    opaqueGlass: options.opaqueGlass ?? cityBakeDefaults.opaqueGlass,
  };
  if (typeof settings.emissiveSigns !== "boolean")
    throw new Error(
      `bakeCity: emissiveSigns must be true or false, got ${JSON.stringify(settings.emissiveSigns)}`,
    );
  if (typeof settings.opaqueGlass !== "boolean")
    throw new Error(
      `bakeCity: opaqueGlass must be true or false, got ${JSON.stringify(settings.opaqueGlass)}`,
    );
  const changes = Object.entries(settings).filter(
    ([key, value]) => cityBakeDefaults[key as keyof CityBakeSettings] !== value,
  );
  return { changes, settings };
}

function applyMaterialOptions(material: IVmMaterial, bake: CityBakeSettings): void {
  if (bake.emissiveSigns && material.userData?.sign === true && material.map) {
    if (!material.emissiveMap) {
      material.emissiveMap = material.map;
      material.emissive?.setRGB?.(1, 1, 1);
    }
    if (typeof material.emissiveIntensity !== "number" || material.emissiveIntensity <= 0) {
      material.emissiveIntensity = 1;
    }
  }
  if (bake.opaqueGlass && typeof material.transmission === "number" && material.transmission > 0) {
    // three shades glass as mix(diffuse, transmitted, transmission); over a dark interior that is
    // colour × (1 − transmission), so clear glass reads as dark reflective glass, not a white panel.
    const kept = 1 - Math.min(1, material.transmission);
    if (material.color) {
      material.color.r *= kept;
      material.color.g *= kept;
      material.color.b *= kept;
    }
    material.transmission = 0;
    if (typeof material.thickness === "number") material.thickness = 0;
  }
}

function applyCityMaterialOptions(group: Object3D, bake: CityBakeSettings): void {
  if (!bake.emissiveSigns && !bake.opaqueGlass) return;
  const seen = new Set<IVmMaterial>();
  group.traverse((object) => {
    const mesh = object as IVmMesh;
    if (mesh.isMesh !== true) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (material === undefined || material === null || seen.has(material)) continue;
      seen.add(material);
      applyMaterialOptions(material, bake);
    }
  });
}

function imageSignature(
  image: IVmTexture["image"] | undefined,
  cache: Map<object, string>,
  fallbackIds: Map<object, number>,
): string {
  if (image === undefined || image === null || typeof image !== "object") return "none";
  const existing = cache.get(image);
  if (existing !== undefined) return existing;
  let signature: string;
  if (typeof image.encodeSync === "function") {
    signature = `png:${createHash("sha256").update(image.encodeSync("png")).digest("hex")}`;
  } else if (image.data !== undefined && ArrayBuffer.isView(image.data)) {
    const view = image.data;
    const hash = createHash("sha256")
      .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
      .digest("hex");
    signature = `raw:${image.width ?? 0}x${image.height ?? 0}:${hash}`;
  } else if (typeof image.src === "string" && image.src.length > 0) {
    signature = `src:${createHash("sha256").update(image.src).digest("hex")}`;
  } else {
    let id = fallbackIds.get(image);
    if (id === undefined) {
      id = fallbackIds.size;
      fallbackIds.set(image, id);
    }
    signature = `ref:${id}`;
  }
  cache.set(image, signature);
  return signature;
}

function textureSignature(
  texture: IVmTexture,
  imageCache: Map<object, string>,
  fallbackImages: Map<object, number>,
): string {
  return JSON.stringify({
    anisotropy: texture.anisotropy,
    center: texture.center ? [texture.center.x, texture.center.y] : undefined,
    channel: texture.channel,
    colorSpace: texture.colorSpace,
    flipY: texture.flipY,
    generateMipmaps: texture.generateMipmaps,
    image: imageSignature(texture.image, imageCache, fallbackImages),
    magFilter: texture.magFilter,
    minFilter: texture.minFilter,
    name: texture.name,
    offset: texture.offset ? [texture.offset.x, texture.offset.y] : undefined,
    premultiplyAlpha: texture.premultiplyAlpha,
    repeat: texture.repeat ? [texture.repeat.x, texture.repeat.y] : undefined,
    rotation: texture.rotation,
    unpackAlignment: texture.unpackAlignment,
    userData: texture.userData,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
  });
}

function materialSignature(
  material: IVmMaterial,
  canonicalTextureId: (texture: IVmTexture | null | undefined) => number | null,
): string {
  const rgb = (c?: { r: number; g: number; b: number }) =>
    c === undefined ? undefined : [c.r, c.g, c.b];
  const vec2 = (v?: { x: number; y: number }) => (v === undefined ? undefined : [v.x, v.y]);
  const slots: Record<string, number | null> = {};
  for (const slot of MATERIAL_TEXTURE_SLOTS) {
    const tex = material[slot] as IVmTexture | null | undefined;
    if (tex !== undefined && tex !== null) slots[slot] = canonicalTextureId(tex);
  }
  return JSON.stringify({
    alphaTest: material.alphaTest,
    aoMapIntensity: material.aoMapIntensity,
    attenuationColor: rgb(material.attenuationColor),
    attenuationDistance: material.attenuationDistance,
    bumpScale: material.bumpScale,
    clearcoat: material.clearcoat,
    clearcoatNormalScale: vec2(material.clearcoatNormalScale),
    clearcoatRoughness: material.clearcoatRoughness,
    color: rgb(material.color),
    depthTest: material.depthTest,
    depthWrite: material.depthWrite,
    emissive: rgb(material.emissive),
    emissiveIntensity: material.emissiveIntensity,
    envMapIntensity: material.envMapIntensity,
    flatShading: material.flatShading,
    ior: material.ior,
    iridescence: material.iridescence,
    iridescenceIOR: material.iridescenceIOR,
    metalness: material.metalness,
    name: material.name,
    normalScale: vec2(material.normalScale),
    opacity: material.opacity,
    roughness: material.roughness,
    sheen: material.sheen,
    sheenColor: rgb(material.sheenColor),
    sheenRoughness: material.sheenRoughness,
    side: material.side,
    slots,
    specularColor: rgb(material.specularColor),
    specularIntensity: material.specularIntensity,
    thickness: material.thickness,
    transmission: material.transmission,
    transparent: material.transparent,
    type: material.type,
    userData: material.userData,
    vertexColors: material.vertexColors,
    wireframe: material.wireframe,
  });
}

function dedupeCityMaterials(group: Object3D): Map<IVmMaterial, number> {
  const imageCache = new Map<object, string>();
  const fallbackImages = new Map<object, number>();
  const canonicalTextures = new Map<string, { id: number; texture: IVmTexture }>();
  const textureIds = new Map<IVmTexture, number>();
  const canonicalizeTexture = (texture: IVmTexture): IVmTexture => {
    const key = textureSignature(texture, imageCache, fallbackImages);
    let entry = canonicalTextures.get(key);
    if (entry === undefined) {
      entry = { id: canonicalTextures.size, texture };
      canonicalTextures.set(key, entry);
      textureIds.set(entry.texture, entry.id);
    }
    return entry.texture;
  };
  const textureId = (texture: IVmTexture | null | undefined): number | null =>
    texture === undefined || texture === null ? null : (textureIds.get(texture) ?? null);

  const canonicalMaterials = new Map<string, { id: number; material: IVmMaterial }>();
  const materialIds = new Map<IVmMaterial, number>();
  const canonicalizeMaterial = (material: IVmMaterial): IVmMaterial => {
    for (const slot of MATERIAL_TEXTURE_SLOTS) {
      const value = material[slot] as IVmTexture | null | undefined;
      if (value !== undefined && value !== null) {
        material[slot] = canonicalizeTexture(value);
      }
    }
    const key = materialSignature(material, textureId);
    let entry = canonicalMaterials.get(key);
    if (entry === undefined) {
      entry = { id: canonicalMaterials.size, material };
      canonicalMaterials.set(key, entry);
      materialIds.set(entry.material, entry.id);
    }
    return entry.material;
  };

  group.traverse((object) => {
    const mesh = object as IVmMesh;
    if (mesh.isMesh !== true) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) =>
        material ? canonicalizeMaterial(material) : material,
      );
    } else if (mesh.material) {
      mesh.material = canonicalizeMaterial(mesh.material);
    }
  });
  return materialIds;
}

function hasIdentityLocalTransform(object: Object3D): boolean {
  return (
    object.position.x === 0 &&
    object.position.y === 0 &&
    object.position.z === 0 &&
    object.quaternion.x === 0 &&
    object.quaternion.y === 0 &&
    object.quaternion.z === 0 &&
    object.quaternion.w === 1 &&
    object.scale.x === 1 &&
    object.scale.y === 1 &&
    object.scale.z === 1
  );
}

function geometryLayoutSignature(geometry: IVmGeometry): string | undefined {
  if (geometry.groups.length > 0) return undefined;
  if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Number.POSITIVE_INFINITY)
    return undefined;
  if (geometry.morphAttributes !== undefined && Object.keys(geometry.morphAttributes).length > 0)
    return undefined;
  const names = Object.keys(geometry.attributes).sort();
  if (names.length === 0) return undefined;
  const parts: string[] = [geometry.index !== null ? "idx" : "flat"];
  for (const name of names) {
    const attr = geometry.attributes[name];
    if (attr === undefined || attr.isInterleavedBufferAttribute === true) return undefined;
    parts.push(
      `${name}:${attr.itemSize}:${attr.normalized ? 1 : 0}:${attr.array.constructor.name}`,
    );
  }
  return parts.join("|");
}

function mergeSiblingGeometries(geometries: readonly IVmGeometry[]): IVmGeometry {
  const first = geometries[0] as IVmGeometry;
  const merged = first.clone();
  const names = Object.keys(first.attributes);
  const totalVertices = geometries.reduce(
    (sum, geom) => sum + (geom.getAttribute("position")?.count ?? 0),
    0,
  );
  for (const name of names) {
    const sample = first.getAttribute(name) as IVmAttribute;
    const itemSize = sample.itemSize;
    const ArrayCtor = sample.array.constructor;
    const AttrCtor = sample.constructor;
    const buffer = new ArrayCtor(totalVertices * itemSize);
    let offset = 0;
    for (const geom of geometries) {
      const attr = geom.getAttribute(name) as IVmAttribute;
      buffer.set(attr.array, offset * itemSize);
      offset += attr.count;
    }
    merged.setAttribute(name, new AttrCtor(buffer, itemSize, sample.normalized));
  }
  if (first.index !== null) {
    let totalIndices = 0;
    for (const geom of geometries) totalIndices += geom.index?.count ?? 0;
    // A plain array lets Three pick Uint16 or Uint32 from the merged vertex count.
    const indexBuffer = new Array<number>(totalIndices);
    let writeAt = 0;
    let vertexOffset = 0;
    for (const geom of geometries) {
      const idx = geom.index as IVmAttribute;
      const arr = idx.array;
      for (let i = 0; i < idx.count; i += 1) {
        indexBuffer[writeAt + i] = (arr[i] as number) + vertexOffset;
      }
      writeAt += idx.count;
      vertexOffset += geom.getAttribute("position")?.count ?? 0;
    }
    merged.setIndex(indexBuffer);
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** The bucket a direct child mesh merges into, or `undefined` when it must stay as it is. */
function siblingMergeKey(
  mesh: IVmMesh,
  materialIds: ReadonlyMap<IVmMaterial, number>,
): string | undefined {
  if (
    mesh.isMesh !== true ||
    Array.isArray(mesh.material) ||
    mesh.children.length > 0 ||
    !hasIdentityLocalTransform(mesh) ||
    (mesh.morphTargetInfluences !== undefined && mesh.morphTargetInfluences.length > 0)
  ) {
    return undefined;
  }
  const materialId = materialIds.get(mesh.material);
  if (materialId === undefined) return undefined;
  const layout = geometryLayoutSignature(mesh.geometry);
  if (layout === undefined) return undefined;
  return `${materialId}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}|${JSON.stringify(mesh.userData ?? {})}|${layout}`;
}

function mergeDuplicateCityMeshes(
  group: Object3D,
  materialIds: ReadonlyMap<IVmMaterial, number>,
): void {
  const buckets = new Map<string, IVmMesh[]>();
  for (const child of [...group.children]) {
    const mesh = child as IVmMesh;
    const key = siblingMergeKey(mesh, materialIds);
    if (key === undefined) continue;
    let list = buckets.get(key);
    if (list === undefined) {
      list = [];
      buckets.set(key, list);
    }
    list.push(mesh);
  }
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const first = meshes[0] as IVmMesh;
    first.geometry = mergeSiblingGeometries(meshes.map((mesh) => mesh.geometry));
    for (let i = 1; i < meshes.length; i += 1) {
      group.remove(meshes[i] as IVmMesh);
    }
  }
}

interface ICityBake {
  readonly glb: Uint8Array;
  readonly triangles: number;
  readonly bounds: {
    readonly max: readonly [number, number, number];
    readonly min: readonly [number, number, number];
  };
  /** `<module>-<seed>[-f<hash of the other non-default options>].glb` */
  readonly file: string;
}

/**
 * Build one module with the page's generator and export it with the page's GLTFExporter and
 * settings (binary, trs, onlyVisible, textures capped at 1024 px), in a fresh page context.
 */
export async function buildCity(options: IBakeCityOptions): Promise<ICityBake> {
  const errors: string[] = [];
  const kit = apex(errors);
  const { module } = options;
  const entry = kit.modules.find((row) => row.id === module);
  if (entry === undefined) throw new Error(`bakeCity: unknown module "${module}"`);
  const parameters: CityParameters = { ...kit.defaults };
  for (const key of Object.keys(parameters) as (keyof CityParameters)[])
    if (options[key] !== undefined) Object.assign(parameters, { [key]: options[key] });
  checkParameters(parameters);
  const road = roadSettings(options, entry.edges.length > 0);
  const roadChanges = Object.entries(road).filter(
    ([key, value]) => cityRoadDefaults[key as keyof CityRoadSettings] !== value,
  );
  const { settings: bake, changes: bakeChanges } = bakeSettings(options);
  await kit.loadMaps();
  const profile = roadChanges.some(([key]) =>
    ["roadWidth", "roadLength", "bendAngle", "bendRadius", "bendSide"].includes(key),
  );
  const group = kit.build(module, parameters, roadChanges.length > 0 ? road : undefined, profile);
  applyCityMaterialOptions(group, bake);
  const materialIds = dedupeCityMaterials(group);
  mergeDuplicateCityMeshes(group, materialIds);
  const glb = new Uint8Array(
    await new kit.GLTFExporter().parseAsync(group, {
      binary: true,
      trs: true,
      onlyVisible: true,
      maxTextureSize: 1024,
    }),
  );
  if (errors.length > 0) throw new Error(`bakeCity: "${module}" failed: ${errors.join("; ")}`);
  let box: Box3 | undefined;
  let triangles = 0;
  group.updateMatrixWorld(true);
  group.traverse((object) => {
    const { geometry, isMesh } = object as Mesh;
    if (isMesh !== true) return;
    geometry.computeBoundingBox();
    const local = (geometry.boundingBox as Box3).clone().applyMatrix4(object.matrixWorld);
    box = box === undefined ? local : box.union(local);
    triangles += (geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3;
  });
  if (box === undefined || triangles === 0)
    throw new Error(`bakeCity: "${module}" built no triangles`);
  const changed = Object.entries(parameters).filter(
    ([key, value]) => key !== "seed" && kit.defaults[key as keyof CityParameters] !== value,
  );
  changed.push(...roadChanges, ...bakeChanges);
  const tag =
    changed.length === 0
      ? ""
      : `-f${createHash("sha256").update(JSON.stringify(changed)).digest("hex").slice(0, 8)}`;
  return {
    glb,
    triangles,
    bounds: { max: [box.max.x, box.max.y, box.max.z], min: [box.min.x, box.min.y, box.min.z] },
    file: `${module}-${parameters.seed}${tag}.glb`,
  };
}
