/**
 * Project assets the editor can place or map: a custom GLB model, a PBR surface image, an
 * environment image. This file validates and measures files; it never loads or draws one — the
 * project's render source does that through `ctx.assets`.
 */
import { Matrix4, Quaternion, Vector3 } from "three";
import { SURFACE_CHANNELS } from "./images.js";

export type IAssetKind = "model" | "image" | "environment";

export interface IAssetBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Source-unit scale and pivot applied when a model is placed; the file itself is never edited. */
export interface IAssetAdjust {
  /** Multiplies the model's own units to metres. 1 means the file is already in metres. */
  readonly scale: number;
  /** Which point of the bounds sits on the placement: the base centre, the centre or the origin. */
  readonly pivot: "base" | "centre" | "origin";
}

/** One registered file, as saved in the authoring document. */
export interface IProjectAsset {
  readonly id: string;
  readonly kind: IAssetKind;
  readonly name: string;
  /** Relative to the project's assets directory; the file's name carries its content hash. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly status: "ready";
  readonly license?: string;
  readonly source?: string;
  readonly bounds?: IAssetBounds;
  readonly triangles?: number;
  readonly adjust?: IAssetAdjust;
  /** Authoring diagnostics, e.g. an imported light that stays inactive. */
  readonly diagnostics?: readonly string[];
  readonly width?: number;
  readonly height?: number;
  /** An image's declared format: `png`, `jpeg`, `webp`, `hdr` or `exr`. */
  readonly format?: string;
}

export interface IAssetLimits {
  /** File size cap in bytes. */
  readonly maxBytes: number;
  /** Decoded image width/height cap in pixels. */
  readonly maxDimension: number;
  /** Triangle cap for one model. */
  readonly maxTriangles: number;
}

export const DEFAULT_ASSET_LIMITS: IAssetLimits = {
  maxBytes: 128 * 1024 * 1024,
  maxDimension: 16384,
  maxTriangles: 5_000_000,
};
export const MAX_ASSETS = 64;
export const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/u;
export const PATH =
  /^(models|images|environments)\/[a-f0-9]{12}-[a-z0-9_-]+\.(glb|png|jpg|webp|hdr|exr)$/u;
export const FOLDER: Record<IAssetKind, string> = {
  model: "models",
  image: "images",
  environment: "environments",
};
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_COUNT: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

interface IGltf {
  asset?: { version?: string };
  buffers?: { uri?: string; byteLength: number }[];
  images?: { uri?: string; bufferView?: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    sparse?: unknown;
  }[];
  meshes?: {
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      mode?: number;
    }[];
  }[];
  nodes?: {
    children?: number[];
    mesh?: number;
    camera?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    extensions?: Record<string, { light?: number }>;
  }[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  extensionsRequired?: string[];
}

export interface IGlbReport {
  readonly bounds: IAssetBounds;
  readonly triangles: number;
  readonly diagnostics: string[];
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Inspect a GLB's real bytes: container, embedded geometry, bounds in model units and imported
 * lights/cameras (reported, never activated). Throws by name for anything it cannot honour.
 */
export function inspectGlb(bytes: Uint8Array, limits: IAssetLimits): IGlbReport {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC)
    fail("Not a GLB file: missing the glTF binary header");
  if (view.getUint32(4, true) !== 2) fail("Unsupported GLB version; expected glTF 2");
  if (view.getUint32(8, true) !== bytes.byteLength)
    fail("GLB length header disagrees with the file size");
  let json: IGltf | undefined;
  let bin: Uint8Array | undefined;
  for (let offset = 12; offset < bytes.byteLength; ) {
    if (offset + 8 > bytes.byteLength) fail("GLB chunk header is truncated");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.byteLength) fail("GLB chunk runs past the end of the file");
    if (type === JSON_CHUNK)
      try {
        json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length)));
      } catch {
        fail("GLB JSON chunk is not valid JSON");
      }
    else if (type === BIN_CHUNK && bin === undefined) bin = bytes.subarray(start, start + length);
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json || json.asset?.version?.startsWith("2") !== true) fail("GLB has no glTF 2 JSON chunk");
  const gltf = json;
  const diagnostics: string[] = [];
  for (const [index, buffer] of (gltf.buffers ?? []).entries())
    if (buffer.uri !== undefined && !buffer.uri.startsWith("data:"))
      fail(
        `GLB references external buffer '${buffer.uri}'; supply a self-contained .glb, dependencies are never fetched (buffer ${index})`,
      );
  for (const image of gltf.images ?? [])
    if (image.uri !== undefined && !image.uri.startsWith("data:"))
      fail(`GLB references external image '${image.uri}'; embed it or supply it as a project file`);
  if (gltf.extensionsRequired?.length)
    fail(
      `GLB requires extensions this editor does not guarantee: ${gltf.extensionsRequired.join(", ")}`,
    );

  const accessorData = (
    index: number,
  ): { read(i: number, c: number): number; count: number; components: number } => {
    const accessor = gltf.accessors?.[index] ?? fail(`GLB accessor ${index} is missing`);
    if (accessor.sparse) fail(`GLB accessor ${index} is sparse, which is not supported`);
    const width =
      COMPONENT_BYTES[accessor.componentType] ??
      fail(`GLB accessor ${index} has an unknown component type`);
    const components =
      TYPE_COUNT[accessor.type] ?? fail(`GLB accessor ${index} has an unknown type`);
    const viewIndex = accessor.bufferView ?? fail(`GLB accessor ${index} has no buffer view`);
    const bufferView =
      gltf.bufferViews?.[viewIndex] ?? fail(`GLB buffer view ${viewIndex} is missing`);
    const source = bufferView.buffer === 0 && bin ? bin : fail("GLB buffer data is not embedded");
    const stride = bufferView.byteStride ?? width * components;
    const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    if (base + stride * Math.max(accessor.count - 1, 0) + width * components > source.byteLength)
      fail(`GLB accessor ${index} reads past its buffer`);
    const data = new DataView(source.buffer, source.byteOffset, source.byteLength);
    return {
      count: accessor.count,
      components,
      read: (i, c) => {
        const at = base + stride * i + width * c;
        switch (accessor.componentType) {
          case 5126:
            return data.getFloat32(at, true);
          case 5125:
            return data.getUint32(at, true);
          case 5123:
            return data.getUint16(at, true);
          case 5122:
            return data.getInt16(at, true);
          case 5121:
            return data.getUint8(at);
          default:
            return data.getInt8(at);
        }
      },
    };
  };

  const world = (node: NonNullable<IGltf["nodes"]>[number]): Matrix4 => {
    if (node.matrix?.length === 16) return new Matrix4().fromArray(node.matrix);
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];
    return new Matrix4().compose(
      new Vector3(t[0], t[1], t[2]),
      new Quaternion(r[0], r[1], r[2], r[3]),
      new Vector3(s[0], s[1], s[2]),
    );
  };
  const low = new Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const high = new Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  let triangles = 0;
  let lights = 0;
  let cameras = 0;
  const visit = (nodeIndex: number, parent: Matrix4, depth: number): void => {
    if (depth > 64) fail("GLB node hierarchy is too deep");
    const node = gltf.nodes?.[nodeIndex] ?? fail(`GLB node ${nodeIndex} is missing`);
    const matrix = parent.clone().multiply(world(node));
    if (node.camera !== undefined) cameras += 1;
    if (node.extensions?.KHR_lights_punctual) lights += 1;
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes?.[node.mesh] ?? fail(`GLB mesh ${node.mesh} is missing`);
      for (const primitive of mesh.primitives) {
        if ((primitive.mode ?? 4) !== 4)
          fail("GLB has a non-triangle primitive, which is not supported");
        const position = accessorData(
          primitive.attributes.POSITION ?? fail("GLB primitive has no POSITION"),
        );
        if (position.components !== 3) fail("GLB POSITION must be VEC3");
        const point = new Vector3();
        for (let i = 0; i < position.count; i += 1) {
          point.set(position.read(i, 0), position.read(i, 1), position.read(i, 2));
          if (!Number.isFinite(point.x + point.y + point.z))
            fail(`GLB geometry has a non-finite vertex (vertex ${i})`);
          point.applyMatrix4(matrix);
          low.min(point);
          high.max(point);
        }
        triangles +=
          primitive.indices === undefined
            ? Math.floor(position.count / 3)
            : Math.floor(accessorData(primitive.indices).count / 3);
      }
    }
    for (const child of node.children ?? []) visit(child, matrix, depth + 1);
  };
  const roots =
    gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? fail("GLB has no default scene with nodes");
  for (const root of roots) visit(root, new Matrix4(), 0);
  if (!Number.isFinite(low.x + high.x) || triangles === 0)
    fail("GLB contains no triangle geometry");
  if (triangles > limits.maxTriangles)
    fail(`GLB has ${triangles} triangles; this project's limit is ${limits.maxTriangles}`);
  if (lights)
    diagnostics.push(
      `${lights} imported light(s) stay inactive: lights come from the world's environment`,
    );
  if (cameras)
    diagnostics.push(`${cameras} imported camera(s) stay inactive: the editor owns its cameras`);
  return {
    bounds: {
      min: low.toArray() as [number, number, number],
      max: high.toArray() as [number, number, number],
    },
    triangles,
    diagnostics,
  };
}

function text(value: unknown, name: string, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new Error(`${name} must be a short non-empty string`);
  return value;
}

/**
 * Validate one saved asset registration exactly as a document commit stores it.
 * @summary Validate a registered terrain-editor asset entry
 * @requires npm i -D @threenative/terrain
 * @situation check a model, image or environment asset entry before saving it in the authoring document
 * @constraint authoring metadata only; ids, content-hashed paths, bounds and unit adjustments are checked, files are not read
 * @example const asset = validateAsset({ id: "oak", kind: "model", name: "oak.glb", path: "models/0123456789ab-oak.glb", sha256: "0123456789ab".padEnd(64, "0"), bytes: 2180, status: "ready" });
 * @override the project owns its asset directory and which entries it keeps
 */
export function validateAsset(input: unknown): IProjectAsset {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("An asset must be an object");
  const value = input as Record<string, unknown>;
  const known = [
    "id",
    "kind",
    "name",
    "path",
    "sha256",
    "bytes",
    "status",
    "license",
    "source",
    "bounds",
    "triangles",
    "adjust",
    "diagnostics",
    "width",
    "height",
    "format",
  ];
  const extra = Object.keys(value).filter((key) => !known.includes(key));
  if (extra.length) throw new Error(`Asset has unknown fields: ${extra.join(", ")}`);
  const id = text(value.id, "Asset.id", 48);
  if (!ID.test(id)) throw new Error(`Asset id '${id}' must be lowercase letters, digits, - or _`);
  if (value.kind !== "model" && value.kind !== "image" && value.kind !== "environment")
    throw new Error("Asset.kind must be model, image or environment");
  const path = text(value.path, "Asset.path", 96);
  if (!PATH.test(path) || !path.startsWith(`${FOLDER[value.kind]}/`))
    throw new Error(
      `Asset.path '${path}' must be a content-addressed file under ${FOLDER[value.kind]}/`,
    );
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256))
    throw new Error("Asset.sha256 must be a 64-digit hex digest");
  if (!path.includes(`/${value.sha256.slice(0, 12)}-`))
    throw new Error("Asset.path must carry the first 12 digits of its sha256");
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0)
    throw new Error("Asset.bytes must be a positive integer");
  if (value.status !== "ready") throw new Error("Asset.status must be ready");
  const out: Record<string, unknown> = {
    id,
    kind: value.kind,
    name: text(value.name, "Asset.name", 128),
    path,
    sha256: value.sha256,
    bytes: value.bytes,
    status: "ready",
  };
  for (const key of ["license", "source"] as const)
    if (value[key] !== undefined) out[key] = text(value[key], `Asset.${key}`, 512);
  if (value.bounds !== undefined) {
    const bounds = value.bounds as { min?: unknown; max?: unknown };
    const ok = (v: unknown): v is [number, number, number] =>
      Array.isArray(v) &&
      v.length === 3 &&
      v.every((n) => typeof n === "number" && Number.isFinite(n));
    const { min, max } = bounds ?? {};
    if (!ok(min) || !ok(max) || min.some((n, i) => n > (max[i] as number)))
      throw new Error("Asset.bounds must be finite ordered min/max vectors");
    out.bounds = { min, max };
  }
  for (const key of ["triangles", "width", "height"] as const)
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
        throw new Error(`Asset.${key} must be a non-negative integer`);
      out[key] = value[key];
    }
  if (value.format !== undefined) out.format = text(value.format, "Asset.format", 16);
  if (value.adjust !== undefined) {
    const adjust = value.adjust as { scale?: unknown; pivot?: unknown };
    if (
      typeof adjust?.scale !== "number" ||
      !Number.isFinite(adjust.scale) ||
      adjust.scale <= 0 ||
      adjust.scale > 1e4
    )
      throw new Error("Asset.adjust.scale must be a positive finite number");
    if (!["base", "centre", "origin"].includes(adjust.pivot as string))
      throw new Error("Asset.adjust.pivot must be base, centre or origin");
    out.adjust = { scale: adjust.scale, pivot: adjust.pivot };
  }
  if (value.diagnostics !== undefined) {
    if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 16)
      throw new Error("Asset.diagnostics must list at most 16 messages");
    out.diagnostics = value.diagnostics.map((entry) => text(entry, "Asset.diagnostics", 256));
  }
  // quality-allow: required fields are validated before this key-indexed record is returned
  return out as unknown as IProjectAsset;
}

/**
 * Validate the whole asset list of an authoring document.
 * @summary Validate the registered terrain-editor assets
 * @requires npm i -D @threenative/terrain
 * @situation check every registered model, image and environment entry together, with unique ids
 * @constraint at most 64 entries; unique ids; each entry as validateAsset
 * @example const assets = validateAssets(document.assets ?? []);
 * @override the project owns its asset directory and which entries it keeps
 */
export function validateAssets(input: unknown): IProjectAsset[] {
  if (!Array.isArray(input) || input.length > MAX_ASSETS)
    throw new Error(`A document holds at most ${MAX_ASSETS} assets`);
  const assets = input.map((entry) => validateAsset(entry));
  if (new Set(assets.map((entry) => entry.id)).size !== assets.length)
    throw new Error("Asset ids must be unique");
  return assets;
}

export type IAssetOperation =
  | { readonly op: "list" }
  /** The agent path: a local file, as an asset-MCP download result returns it. */
  | {
      readonly op: "register";
      readonly id: string;
      readonly kind?: IAssetKind;
      readonly path: string;
      readonly license?: string;
      readonly source?: string;
      readonly replace?: boolean;
    }
  /** The GUI path: bytes the browser read from a picked or dropped file. */
  | {
      readonly op: "upload";
      readonly id: string;
      readonly kind?: IAssetKind;
      readonly name: string;
      readonly data: string;
      readonly license?: string;
      readonly source?: string;
      readonly replace?: boolean;
    }
  | { readonly op: "adjust"; readonly id: string; readonly adjust: unknown }
  /** Bind an image asset to one named surface input of the project's render source. */
  | { readonly op: "map"; readonly input: string; readonly asset: string }
  /** Return one surface input to the project's own art. */
  | { readonly op: "unmap"; readonly input: string }
  /** Removes the palette entry only; the stored file is never erased. */
  | { readonly op: "remove"; readonly id: string };

/** One surface input and the registered image that replaces its starter art. */
export interface ISurfaceMapping {
  readonly asset: string;
}
export type ISurfaceMappings = Record<string, ISurfaceMapping>;

export interface IAssetResult {
  readonly op: string;
  readonly assets: readonly IProjectAsset[];
  readonly surfaces: ISurfaceMappings;
  readonly asset: IProjectAsset | null;
}

/**
 * The kind and format a file's own bytes declare, whatever its name says.
 * @summary Identify a GLB, PNG, JPEG, WebP, HDR or EXR file by its header
 * @requires npm i -D @threenative/terrain
 * @situation decide whether a dropped or downloaded file is a model, surface image or environment image
 * @constraint reads only the first bytes; a file it cannot name returns undefined and must be refused
 * @example const kind = sniff(new Uint8Array(await file.arrayBuffer()))?.kind;
 * @override the caller decides what to do with an unknown file
 */
export function sniff(
  bytes: Uint8Array,
): { kind: IAssetKind; ext: string; format: string } | undefined {
  const head = (...codes: number[]) => codes.every((code, i) => bytes[i] === code);
  if (head(0x67, 0x6c, 0x54, 0x46)) return { kind: "model", ext: "glb", format: "glb" };
  if (head(0x89, 0x50, 0x4e, 0x47)) return { kind: "image", ext: "png", format: "png" };
  if (head(0xff, 0xd8, 0xff)) return { kind: "image", ext: "jpg", format: "jpeg" };
  if (head(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45)
    return { kind: "image", ext: "webp", format: "webp" };
  const ascii = new TextDecoder().decode(bytes.subarray(0, 11));
  if (ascii.startsWith("#?RADIANCE") || ascii.startsWith("#?RGBE"))
    return { kind: "environment", ext: "hdr", format: "hdr" };
  if (head(0x76, 0x2f, 0x31, 0x01)) return { kind: "environment", ext: "exr", format: "exr" };
  return undefined;
}

const SURFACE_INPUT = /^[a-z0-9][a-z0-9_-]{0,31}\.([a-z]+)$/u;

/**
 * The colour space an input's pixels are read in, from the channel its name ends with.
 * @summary Resolve a surface input name to sRGB or linear
 * @requires npm i -D @threenative/terrain
 * @situation decide how an imported image bound to a named surface input must be sampled
 * @constraint throws by name for an input that is not <surface>.<channel> with a known channel
 * @example const space = surfaceSpace("bark.normal");
 * @override the project owns which surface inputs exist
 */
export function surfaceSpace(input: string): "srgb" | "linear" {
  const channel = SURFACE_INPUT.exec(input)?.[1];
  const space = channel
    ? (SURFACE_CHANNELS as Record<string, "srgb" | "linear">)[channel]
    : undefined;
  if (!space)
    throw new Error(
      `Surface input '${input}' must be <surface>.<channel>, channel one of ${Object.keys(SURFACE_CHANNELS).join(", ")}`,
    );
  return space;
}

/**
 * Validate surface mappings against the registered images they name.
 * @summary Validate terrain-editor surface image mappings
 * @requires npm i -D @threenative/terrain
 * @situation save which imported PBR image replaces which named surface input of the project's render source
 * @constraint authoring metadata only; each input is <surface>.<channel>; every asset must be a registered image
 * @example const surfaces = validateSurfaces({ "bark.normal": { asset: "my-normal" } }, document.assets ?? []);
 * @override the project's render source defines which surface inputs exist and what they draw
 */
export function validateSurfaces(
  input: unknown,
  assets: readonly IProjectAsset[],
): ISurfaceMappings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("surfaces must be an object");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 64) throw new Error("A document holds at most 64 surface mappings");
  const out: ISurfaceMappings = {};
  for (const [key, value] of entries) {
    surfaceSpace(key);
    const mapping = value as { asset?: unknown } | null;
    if (!mapping || typeof mapping !== "object" || Object.keys(mapping).some((k) => k !== "asset"))
      throw new Error(`surfaces.${key} must be { asset }`);
    const asset = assets.find((entry) => entry.id === mapping.asset);
    if (!asset || asset.kind !== "image")
      throw new Error(
        `surfaces.${key} names '${String(mapping.asset)}', which is not a registered image`,
      );
    out[key] = { asset: asset.id };
  }
  return out;
}
