/**
 * three's GLTFLoader under `engine: "native"` on the web (PRD-540): the bytes go to the engine's own
 * glTF loader in Wasm (`tnw_web_load_gltf`), the same C++ the V8 player's loadAsset runs, and the
 * result comes back in GLTFLoader's shape. Upstream GLTFLoader over engine classes never settles,
 * so it is never bundled. The web build cooks models decoder-free for the native engine, so a codec
 * or plugin the engine loader lacks is refused by name instead of being skipped.
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

/**
 * The files a glTF names by relative uri for its images (the asset cook writes shared images beside
 * the model), which the engine loader cannot fetch itself. Data URIs and GLB-embedded images are not.
 */
export function externalImageUris(data: ArrayBuffer | string): string[] {
  let json: { images?: { uri?: unknown }[] };
  try {
    const bytes = typeof data === "string" ? undefined : new Uint8Array(data);
    const glb =
      bytes !== undefined && bytes.byteLength >= 20 && bytes[0] === 0x67 && bytes[1] === 0x6c;
    json = JSON.parse(
      typeof data === "string"
        ? data
        : new TextDecoder().decode(
            glb ? bytes.subarray(20, 20 + new DataView(data).getUint32(12, true)) : bytes,
          ),
    );
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

export class GLTFLoader {
  path = "";
  /** The engine loader reads no extension plugin, so a caller registers none (core's asset loader checks). */
  readonly hostsPlugins = false;

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

  register(): never {
    return refuse("PLUGIN");
  }

  /** `onLoad` or `onError` runs once, as three's does; images named by uri are fetched first. */
  parse(
    data: ArrayBuffer | string,
    path: string,
    onLoad: (gltf: IGltfResult) => void,
    onError?: (error: unknown) => void,
  ): void {
    const settle = (files: ReadonlyMap<string, Uint8Array>): void => {
      let result: IGltfResult;
      try {
        if (load === undefined)
          throw new Error("TN_WASM_GLTF_UNAVAILABLE: this web engine has no glTF loader");
        const bytes =
          typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
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
      } catch (error) {
        if (onError === undefined) throw error;
        onError(error);
        return;
      }
      onLoad(result);
    };
    const uris = externalImageUris(data);
    if (uris.length === 0) {
      settle(new Map());
      return;
    }
    Promise.all(
      uris.map(async (uri) => {
        const response = await fetch(path + uri);
        if (!response.ok) throw new Error(`TN_WASM_GLTF_FETCH: ${response.status} ${path + uri}`);
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
