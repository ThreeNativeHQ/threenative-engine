/**
 * three's GLTFLoader under `engine: "threenative"` on the web (PRD-540): the bytes go to the engine's own
 * glTF loader in Wasm (`tnw_web_load_gltf`), the same C++ the V8 player's loadAsset runs, and the
 * result comes back in GLTFLoader's shape. Upstream GLTFLoader over engine classes never settles,
 * so it is never bundled. The web build cooks models decoder-free for the native engine, so a codec
 * or plugin the engine loader lacks is refused by name instead of being skipped.
 *
 * One plugin path is hosted: `TN_discrete_lod`, the LOD chain the asset pipeline bakes (PRD-617).
 * `register` takes core's DiscreteLodPlugin and runs its `afterRoot` over a small parser: the file's
 * JSON, its index accessors, and the engine's meshes keyed to the glTF mesh and primitive they came from.
 */
// quality-allow: the symbol exists only in the web engine module the bundler resolves "three" to, so no declaration can type it.
// @ts-expect-error -- `__tnLoadGltf` exists only in the web engine module "three" resolves to.
import { __tnLoadGltf } from "three";

interface IEngineModel {
  readonly scene: object;
  readonly animations: readonly object[];
}

/** GLTFLoader's result: one default scene, its clips, and the members three's callers read. */
export interface IGltfResult {
  readonly scene: object;
  readonly scenes: readonly object[];
  readonly animations: readonly object[];
  readonly cameras: readonly object[];
  readonly asset: { readonly version: string };
  readonly parser: undefined;
  readonly userData: Record<string, unknown>;
}

const load = __tnLoadGltf as
  | ((bytes: Uint8Array, files: ReadonlyMap<string, Uint8Array>) => IEngineModel)
  | undefined;

interface IGltfJson {
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    count?: number;
    sparse?: unknown;
    type?: string;
  }[];
  bufferViews?: { byteLength?: number; byteOffset?: number; byteStride?: number }[];
  images?: { uri?: unknown }[];
  meshes?: { primitives?: unknown[] }[];
  nodes?: { children?: number[]; mesh?: number }[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
}

/** The JSON and, for a GLB, the binary chunk. Throws on a file that is neither. */
function readGltf(data: ArrayBuffer | string): { json: IGltfJson; bin: Uint8Array | undefined } {
  if (typeof data === "string") return { bin: undefined, json: JSON.parse(data) as IGltfJson };
  const bytes = new Uint8Array(data);
  if (bytes.byteLength < 20 || bytes[0] !== 0x67 || bytes[1] !== 0x6c)
    return { bin: undefined, json: JSON.parse(new TextDecoder().decode(bytes)) as IGltfJson };
  const view = new DataView(data);
  const jsonEnd = 20 + view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, jsonEnd))) as IGltfJson;
  const hasBin =
    jsonEnd + 8 <= bytes.byteLength && view.getUint32(jsonEnd + 4, true) === 0x004e4942;
  return {
    bin: hasBin
      ? bytes.subarray(jsonEnd + 8, jsonEnd + 8 + view.getUint32(jsonEnd, true))
      : undefined,
    json,
  };
}

/**
 * The files a glTF names by relative uri for its images (the asset cook writes shared images beside
 * the model), which the engine loader cannot fetch itself. Data URIs and GLB-embedded images are not.
 */
export function externalImageUris(data: ArrayBuffer | string): string[] {
  let json: IGltfJson;
  try {
    json = readGltf(data).json;
  } catch {
    return []; // a malformed file is refused by name when the engine loader parses it
  }
  const uris = (json.images ?? []).flatMap(({ uri }) =>
    typeof uri === "string" && !uri.startsWith("data:") ? [uri] : [],
  );
  return [...new Set(uris)];
}

function refuse(what: string): never {
  throw new Error(`TN_NATIVE_GLTF_${what}_UNSUPPORTED: the engine glTF loader does not take this`);
}

const HOSTED_PLUGIN = "TN_discrete_lod";

/** The part of three's GLTFParser that DiscreteLodPlugin reads. */
interface IEngineParser {
  readonly associations: Map<object, { meshes: number; nodes: number; primitives: number }>;
  readonly json: IGltfJson;
  getDependency(type: string, index: number): Promise<unknown>;
}

interface IHostedPlugin {
  readonly name: string;
  afterRoot?(result: IGltfResult): Promise<void> | void;
}

type PluginFactory = (parser: IEngineParser) => IHostedPlugin;

const ELEMENTS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array } as const;

/** An index accessor's values, copied out of the GLB's binary chunk. */
function readIndices(
  json: IGltfJson,
  bin: Uint8Array | undefined,
  index: number,
): { array: ArrayLike<number> } {
  const accessor = json.accessors?.[index];
  const view = json.bufferViews?.[accessor?.bufferView ?? -1];
  const Element = ELEMENTS[accessor?.componentType as keyof typeof ELEMENTS];
  if (
    accessor === undefined ||
    view === undefined ||
    Element === undefined ||
    accessor.type !== "SCALAR" ||
    accessor.sparse !== undefined ||
    typeof accessor.count !== "number" ||
    (view.byteStride ?? 0) !== 0
  )
    throw new Error(
      `TN_WASM_GLTF_LOD_ACCESSOR: accessor ${String(index)} is not a plain index accessor`,
    );
  if (bin === undefined)
    throw new Error("TN_WASM_GLTF_LOD_ACCESSOR: only a GLB's binary chunk is read for a LOD chain");
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const end = start + accessor.count * Element.BYTES_PER_ELEMENT;
  if (!Number.isInteger(start) || end > bin.byteLength)
    throw new Error(
      `TN_WASM_GLTF_LOD_ACCESSOR: accessor ${String(index)} reads past the binary chunk`,
    );
  return { array: new Element(bin.slice(start, end).buffer) };
}

/**
 * Keys each engine mesh to the glTF mesh and primitive it came from. The engine loader builds
 * GLTFLoader's hierarchy, so meshes come in one order on both sides: node by node, depth first, a
 * node's own primitives before its children. A count that differs is a scene this walk does not
 * describe, and refuses the load rather than chain the wrong geometry.
 */
function associate(json: IGltfJson, scene: object, into: IEngineParser["associations"]): void {
  const expected: { meshes: number; nodes: number; primitives: number }[] = [];
  const visit = (node: number): void => {
    const def = json.nodes?.[node];
    if (def === undefined)
      throw new Error(`TN_WASM_GLTF_LOD_MISMATCH: node ${String(node)} is missing`);
    if (def.mesh !== undefined)
      for (
        let primitives = 0;
        primitives < (json.meshes?.[def.mesh]?.primitives?.length ?? 0);
        primitives += 1
      )
        expected.push({ meshes: def.mesh, nodes: node, primitives });
    for (const child of def.children ?? []) visit(child);
  };
  for (const node of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(node);
  const meshes: object[] = [];
  const walk = (object: { isMesh?: boolean; children: object[] }): void => {
    if (object.isMesh === true) meshes.push(object);
    for (const child of object.children) walk(child as never);
  };
  walk(scene as never);
  if (meshes.length !== expected.length)
    throw new Error(
      `TN_WASM_GLTF_LOD_MISMATCH: the file has ${String(expected.length)} primitive(s) and the engine scene ${String(meshes.length)} mesh(es)`,
    );
  for (const [i, mesh] of meshes.entries()) into.set(mesh, expected[i] as never);
}

/** Builds the registered plugins over the file's parser; any plugin but the one hosted is refused by name. */
function hostPlugins(
  factories: readonly PluginFactory[],
  data: ArrayBuffer | string,
): { parser: IEngineParser; plugins: IHostedPlugin[] } | undefined {
  if (factories.length === 0) return undefined;
  const { bin, json } = readGltf(data);
  const parser: IEngineParser = {
    associations: new Map(),
    getDependency: async (type, index) => {
      if (type === "accessor") return readIndices(json, bin, index);
      throw new Error(
        `TN_WASM_GLTF_DEPENDENCY_UNSUPPORTED: the engine glTF loader returns no '${type}'`,
      );
    },
    json,
  };
  const plugins = factories.map((factory) => factory(parser));
  for (const plugin of plugins) if (plugin.name !== HOSTED_PLUGIN) refuse("PLUGIN");
  return { parser, plugins };
}

export class GLTFLoader {
  path = "";
  /** A plugin defect (a chain the file declares and cannot deliver) rejects the load; core's plugin logs it on stock three. */
  readonly failClosed = true;
  readonly #factories: PluginFactory[] = [];

  setPath(path: string): this {
    this.path = path;
    return this;
  }

  setResourcePath(): this {
    return this;
  }

  setCrossOrigin(): this {
    return this;
  }

  setRequestHeader(): this {
    return this;
  }

  setKTX2Loader(): never {
    return refuse("KTX2");
  }

  setMeshoptDecoder(): never {
    return refuse("MESHOPT");
  }

  setDRACOLoader(): never {
    return refuse("DRACO");
  }

  /** Takes a plugin factory; only `TN_discrete_lod` is hosted, any other is refused by name when parsing. */
  register(factory: PluginFactory): this {
    this.#factories.push(factory);
    return this;
  }

  /** `onLoad` or `onError` runs once, as three's does; images named by uri are fetched first. */
  parse(
    data: ArrayBuffer | string,
    path: string,
    onLoad: (gltf: IGltfResult) => void,
    onError?: (error: unknown) => void,
  ): void {
    const settle = async (files: ReadonlyMap<string, Uint8Array>): Promise<void> => {
      let result: IGltfResult;
      try {
        if (load === undefined)
          throw new Error("TN_WASM_GLTF_UNAVAILABLE: this web engine has no glTF loader");
        const bytes =
          typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
        const hosted = hostPlugins(this.#factories, data);
        const model = load(bytes, files);
        result = {
          scene: model.scene,
          scenes: [model.scene],
          animations: [...model.animations],
          cameras: [],
          asset: { version: "2.0" },
          parser: undefined,
          userData: {},
        };
        if (hosted !== undefined) {
          associate(hosted.parser.json, model.scene, hosted.parser.associations);
          for (const plugin of hosted.plugins) await plugin.afterRoot?.(result);
        }
      } catch (error) {
        if (onError === undefined) throw error;
        onError(error);
        return;
      }
      onLoad(result);
    };
    const uris = externalImageUris(data);
    if (uris.length === 0) {
      void settle(new Map());
      return;
    }
    Promise.all(
      uris.map(async (uri) => {
        const response = await fetch(path + uri);
        if (!response.ok) throw new Error(`TN_WASM_GLTF_FETCH: ${response.status} ${path + uri}`);
        // A dev server answers a missing file with its page and a 200 (Vite's SPA fallback); the
        // engine would refuse those bytes only as "undecoded images", without the file's name.
        if (response.headers.get("content-type")?.startsWith("text/html"))
          throw new Error(`TN_WASM_GLTF_FETCH: text/html ${path + uri}`);
        // The engine loader asks for the uri with its percent escapes decoded.
        return [decodeURIComponent(uri), new Uint8Array(await response.arrayBuffer())] as const;
      }),
    ).then(
      (files) => settle(new Map(files)),
      (error: unknown) => {
        if (onError === undefined) throw error;
        onError(error);
      },
    );
  }

  parseAsync(data: ArrayBuffer | string, path: string): Promise<IGltfResult> {
    return new Promise((resolve, reject) => this.parse(data, path, resolve, reject));
  }

  async loadAsync(url: string): Promise<IGltfResult> {
    const response = await fetch(this.path + url);
    if (!response.ok) throw new Error(`TN_WASM_GLTF_FETCH: ${response.status} ${url}`);
    const resolved = this.path + url;
    return this.parseAsync(
      await response.arrayBuffer(),
      resolved.slice(0, resolved.lastIndexOf("/") + 1),
    );
  }

  load(
    url: string,
    onLoad: (gltf: IGltfResult) => void,
    _onProgress?: unknown,
    onError?: (error: unknown) => void,
  ): void {
    this.loadAsync(url).then(onLoad, (error: unknown) => {
      if (onError === undefined) throw error;
      onError(error);
    });
  }
}
