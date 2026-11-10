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
  /** Every scene in file order: a model can keep each LOD level as a named scene (`fir_lod1`). */
  readonly scenes: readonly object[];
  readonly animations: readonly object[];
}

/** GLTFLoader's result: the default scene, every scene, its clips, and the members three's callers read. */
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
  | ((bytes: Uint8Array, files: ReadonlyMap<string, Uint8Array>) => Promise<IEngineModel>)
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
  bufferViews?: {
    byteLength?: number;
    byteOffset?: number;
    byteStride?: number;
    extensions?: Record<string, IMeshoptView | undefined>;
  }[];
  images?: { uri?: unknown }[];
  meshes?: { primitives?: unknown[] }[];
  nodes?: { children?: number[]; mesh?: number }[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
}

/** An EXT/KHR_meshopt_compression buffer view: the compressed stream and how it decodes. */
interface IMeshoptView {
  buffer?: number;
  byteLength?: number;
  byteOffset?: number;
  byteStride?: number;
  count?: number;
  filter?: string;
  mode?: string;
}

/** three's MeshoptDecoder, as core hands it to `setMeshoptDecoder`. */
interface IMeshoptDecoder {
  readonly ready: Promise<void>;
  decodeGltfBuffer(
    target: Uint8Array,
    count: number,
    size: number,
    source: Uint8Array,
    mode: string,
    filter?: string,
  ): void;
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

/**
 * A buffer view's bytes from the GLB's binary chunk: as stored, or decoded when the cook
 * meshopt-compressed it (the engine's own loader decodes the mesh; this reads only the LOD chain).
 */
async function viewBytes(
  view: NonNullable<IGltfJson["bufferViews"]>[number],
  bin: Uint8Array,
  decoder: IMeshoptDecoder | undefined,
  index: number,
): Promise<Uint8Array> {
  const meshopt =
    view.extensions?.EXT_meshopt_compression ?? view.extensions?.KHR_meshopt_compression;
  if (meshopt === undefined) return bin.subarray(view.byteOffset ?? 0);
  const { byteLength = 0, byteOffset = 0, byteStride = 0, count = 0, mode = "" } = meshopt;
  if (
    decoder === undefined ||
    (meshopt.buffer ?? 0) !== 0 ||
    byteOffset + byteLength > bin.byteLength
  )
    throw new Error(
      `TN_WASM_GLTF_LOD_ACCESSOR: accessor ${String(index)} is meshopt-compressed ${decoder === undefined ? "and no meshopt decoder was set" : "outside the binary chunk"}`,
    );
  await decoder.ready;
  const decoded = new Uint8Array(count * byteStride);
  decoder.decodeGltfBuffer(
    decoded,
    count,
    byteStride,
    bin.subarray(byteOffset, byteOffset + byteLength),
    mode,
    meshopt.filter,
  );
  return decoded;
}

/** An index accessor's values, copied out of the GLB's binary chunk. */
async function readIndices(
  json: IGltfJson,
  bin: Uint8Array | undefined,
  index: number,
  decoder: IMeshoptDecoder | undefined,
): Promise<{ array: ArrayLike<number> }> {
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
  const bytes = await viewBytes(view, bin, decoder, index);
  const start = accessor.byteOffset ?? 0;
  const end = start + accessor.count * Element.BYTES_PER_ELEMENT;
  if (!Number.isInteger(start) || end > bytes.byteLength)
    throw new Error(
      `TN_WASM_GLTF_LOD_ACCESSOR: accessor ${String(index)} reads past the binary chunk`,
    );
  return { array: new Element(bytes.slice(start, end).buffer) };
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
  decoder: IMeshoptDecoder | undefined,
): { parser: IEngineParser; plugins: IHostedPlugin[] } | undefined {
  if (factories.length === 0) return undefined;
  const { bin, json } = readGltf(data);
  const parser: IEngineParser = {
    associations: new Map(),
    getDependency: async (type, index) => {
      if (type === "accessor") return readIndices(json, bin, index, decoder);
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

/**
 * One fetch per image file while it is in flight: models loaded together that share an image (ten
 * spruce models and their 12 MB atlas in the Strata forest) wait on the same bytes instead of each
 * downloading them. The engine copies the bytes, so sharing them is safe. Nothing is kept once the
 * fetch lands. ponytail: a model loaded later fetches again; keep the bytes if that shows in a load.
 */
const inFlight = new Map<string, Promise<Uint8Array>>();
function imageBytes(url: string): Promise<Uint8Array> {
  const key = new URL(url, globalThis.location?.href ?? "http://localhost/").href;
  let pending = inFlight.get(key);
  if (pending === undefined) {
    pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`TN_WASM_GLTF_FETCH: ${response.status} ${url}`);
      // A dev server answers a missing file with its page and a 200 (Vite's SPA fallback); the
      // engine would refuse those bytes only as "undecoded images", without the file's name.
      if (response.headers.get("content-type")?.startsWith("text/html"))
        throw new Error(`TN_WASM_GLTF_FETCH: text/html ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    })();
    inFlight.set(key, pending);
    const settled = () => inFlight.delete(key);
    pending.then(settled, settled);
  }
  return pending;
}

export class GLTFLoader {
  path = "";
  /**
   * Serves one image file's bytes in place of a plain fetch: core hands the resident levels of a
   * KTX2 here (PRD-860). `undefined` from it means "fetch it as usual".
   */
  imageSource: ((url: string) => Promise<Uint8Array | undefined>) | undefined = undefined;
  /** A plugin defect (a chain the file declares and cannot deliver) rejects the load; core's plugin logs it on stock three. */
  readonly failClosed = true;
  readonly #factories: PluginFactory[] = [];
  #meshopt: IMeshoptDecoder | undefined;

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

  /** The engine's loader transcodes KHR_texture_basisu itself (PRD-861), so the JS loader goes unused. */
  setKTX2Loader(_loader?: unknown): this {
    return this;
  }

  /**
   * The engine's loader decodes EXT/KHR_meshopt_compression itself (PRD-861); the JS decoder reads
   * only a hosted LOD chain's compressed index views.
   */
  setMeshoptDecoder(decoder?: IMeshoptDecoder): this {
    this.#meshopt = decoder;
    return this;
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
        const hosted = hostPlugins(this.#factories, data, this.#meshopt);
        const model = await load(bytes, files);
        result = {
          scene: model.scene,
          scenes: [...model.scenes],
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
      // The engine loader asks for the uri with its percent escapes decoded.
      uris.map(
        async (uri) =>
          [
            decodeURIComponent(uri),
            (await this.imageSource?.(path + uri)) ?? (await imageBytes(path + uri)),
          ] as const,
      ),
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
