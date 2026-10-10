/**
 * three's GLTFLoader under `engine: "native"` on the web (PRD-540): the bytes go to the engine's own
 * glTF loader in Wasm (`tnw_web_load_gltf`), the same C++ the V8 player's loadAsset runs, and the
 * result comes back in GLTFLoader's shape. Upstream GLTFLoader over engine classes never settles,
 * so it is never bundled. The web build cooks models decoder-free for the native engine, so a codec
 * or plugin the engine loader lacks is refused by name instead of being skipped.
 */
// quality-allow: __tnLoadGltf is injected into the virtual three module by the web-engine bundler.
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

type PageImage = { readonly width: number; readonly height: number };
const load = __tnLoadGltf as
  | ((bytes: Uint8Array, images: readonly (PageImage | undefined)[], clips: number) => IEngineModel)
  | undefined;

/** GLTFTextureWebPExtension: a texture draws its WebP source when the browser decodes WebP. */
const WEBP = "EXT_texture_webp";

interface IGltfJson {
  readonly images?: readonly {
    readonly bufferView?: number;
    readonly uri?: string;
    readonly mimeType?: string;
  }[];
  readonly bufferViews?: readonly { readonly byteOffset?: number; readonly byteLength: number }[];
  readonly textures?: readonly {
    readonly source?: number;
    readonly extensions?: Readonly<Record<string, { readonly source?: number } | undefined>>;
  }[];
  readonly animations?: readonly unknown[];
}

/** A GLB's JSON and binary chunks, or a glTF JSON file's text with no binary chunk. */
function chunks(bytes: Uint8Array): { json: IGltfJson; bin?: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    return { json: JSON.parse(new TextDecoder().decode(bytes)) as IGltfJson };
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
  ) as IGltfJson;
  const at = 20 + jsonLength;
  if (at + 8 > bytes.byteLength) return { json };
  return { json, bin: bytes.subarray(at + 8, at + 8 + view.getUint32(at, true)) };
}

/**
 * The images the model's textures draw, decoded by the browser as three's GLTFLoader decodes them
 * (ImageBitmapLoader: no premultiply, no colour conversion): off the main thread and in parallel,
 * where the engine would decode them one by one in Wasm. An image the page cannot read stays
 * undefined, and the engine decodes or refuses it as it would without the page.
 */
async function decodeImages(
  json: IGltfJson,
  bin: Uint8Array | undefined,
): Promise<(PageImage | undefined)[]> {
  const images = json.images ?? [];
  if (typeof createImageBitmap === "undefined") return [];
  const used = new Set<number>();
  for (const texture of json.textures ?? []) {
    const source = texture.extensions?.[WEBP]?.source ?? texture.source;
    if (source !== undefined) used.add(source);
  }
  return Promise.all(
    images.map(async (image, index) => {
      if (!used.has(index)) return undefined;
      let blob: Blob | undefined;
      const view =
        image.bufferView === undefined ? undefined : json.bufferViews?.[image.bufferView];
      if (view !== undefined && bin !== undefined) {
        const offset = view.byteOffset ?? 0;
        blob = new Blob([bin.subarray(offset, offset + view.byteLength)], {
          type: image.mimeType ?? "",
        });
      } else if (image.uri?.startsWith("data:")) {
        blob = await (await fetch(image.uri)).blob();
      }
      if (blob === undefined) return undefined;
      return createImageBitmap(blob, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      }).catch(() => undefined);
    }),
  );
}

function refuse(what: string): never {
  throw new Error(`TN_NATIVE_GLTF_${what}_UNSUPPORTED: the engine glTF loader does not take this`);
}

export class GLTFLoader {
  path = "";

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

  /** `onLoad` or `onError` runs once, after the images decode, as three's parse settles later too. */
  parse(
    data: ArrayBuffer | string,
    path: string,
    onLoad: (gltf: IGltfResult) => void,
    onError?: (error: unknown) => void,
  ): void {
    this.parseAsync(data, path).then(onLoad, (error: unknown) => {
      if (onError === undefined) throw error;
      onError(error);
    });
  }

  async parseAsync(data: ArrayBuffer | string, _path: string): Promise<IGltfResult> {
    if (load === undefined)
      throw new Error("TN_WASM_GLTF_UNAVAILABLE: this web engine has no glTF loader");
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    let json: IGltfJson | undefined;
    let bin: Uint8Array | undefined;
    try {
      ({ json, bin } = chunks(bytes));
    } catch {
      json = undefined; // not a file the page can read: the engine loader refuses it by name
    }
    const images = json === undefined ? [] : await decodeImages(json, bin);
    const model = load(bytes, images, json?.animations?.length ?? 63);
    return {
      scene: model.scene,
      scenes: [model.scene],
      animations: [...model.animations],
      cameras: [],
      asset: { version: "2.0" },
      parser: undefined,
      userData: {},
    };
  }

  async loadAsync(url: string): Promise<IGltfResult> {
    const response = await fetch(this.path + url);
    if (!response.ok) throw new Error(`TN_WASM_GLTF_FETCH: ${response.status} ${url}`);
    return this.parseAsync(await response.arrayBuffer(), url);
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
