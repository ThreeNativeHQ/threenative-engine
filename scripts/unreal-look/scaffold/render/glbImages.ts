// Generated for you: ordinary Three.js; ThreeNative does not read this file. Delete or rewrite
// it freely.
//
// The images a .glb names for its materials, by material name: embedded in the file or beside it
// (the asset pipeline moves them out). The owned engine decodes a glTF's maps itself and shows
// JavaScript their size and nothing else, so a game that needs their pixels (the Surface Cache of
// PRD-639) reads them again here.
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface IGltfJson {
  readonly materials?: readonly {
    readonly name?: string;
    readonly pbrMetallicRoughness?: { readonly baseColorTexture?: { readonly index: number } };
    readonly emissiveTexture?: { readonly index: number };
  }[];
  readonly textures?: readonly { readonly source?: number }[];
  readonly images?: readonly {
    readonly bufferView?: number;
    readonly mimeType?: string;
    readonly uri?: string;
  }[];
  readonly bufferViews?: readonly { readonly byteOffset?: number; readonly byteLength: number }[];
}

export interface IGlbMaterialImages {
  readonly map?: ImageBitmap;
  readonly emissiveMap?: ImageBitmap;
}

/**
 * The decoded base colour and emissive image of every material that has one, keyed by material name.
 * `base` is the absolute URL of the file, which an image `uri` is relative to.
 */
export async function glbMaterialImages(
  file: ArrayBuffer,
  base: string,
): Promise<Map<string, IGlbMaterialImages>> {
  const view = new DataView(file);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("TN_GLB_IMAGES: not a binary glTF");
  let json: IGltfJson | undefined;
  let binary = 0;
  for (let at = 12; at + 8 <= file.byteLength; ) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    if (type === CHUNK_JSON)
      json = JSON.parse(
        new TextDecoder().decode(new Uint8Array(file, at + 8, length)),
      ) as IGltfJson;
    if (type === CHUNK_BIN) binary = at + 8;
    at += 8 + length;
  }
  if (json === undefined) throw new Error("TN_GLB_IMAGES: no JSON chunk");
  const gltf = json;
  const decode = async (texture: number | undefined): Promise<ImageBitmap | undefined> => {
    const image = gltf.images?.[gltf.textures?.[texture ?? -1]?.source ?? -1];
    if (image === undefined) return undefined;
    const part = gltf.bufferViews?.[image.bufferView ?? -1];
    let blob: Blob | undefined;
    if (part !== undefined)
      blob = new Blob([new Uint8Array(file, binary + (part.byteOffset ?? 0), part.byteLength)], {
        type: image.mimeType ?? "image/png",
      });
    else if (image.uri !== undefined) {
      const url = new URL(image.uri, base);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`TN_GLB_IMAGES: ${url.href} returned ${response.status}`);
      blob = await response.blob();
    }
    return blob === undefined
      ? undefined
      : createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  };
  const byName = new Map<string, IGlbMaterialImages>();
  for (const material of gltf.materials ?? []) {
    const map = await decode(material.pbrMetallicRoughness?.baseColorTexture?.index);
    const emissiveMap = await decode(material.emissiveTexture?.index);
    if (material.name !== undefined && (map !== undefined || emissiveMap !== undefined))
      byName.set(material.name, {
        ...(map === undefined ? {} : { map }),
        ...(emissiveMap === undefined ? {} : { emissiveMap }),
      });
  }
  return byName;
}

/**
 * `glbMaterialImages` of the first of `urls` (the places the asset store resolves a file to) that answers, and what each
 * URL gave, for the capture log. No answer leaves the map empty: the Surface Cache then returns each colour factor.
 */
export async function fetchGlbMaterialImages(
  urls: readonly string[],
): Promise<{ images: Map<string, IGlbMaterialImages>; tried: string[] }> {
  const tried: string[] = [];
  for (const url of urls) {
    const response = await fetch(url);
    tried.push(`${response.status} ${url}`);
    if (!response.ok) continue;
    try {
      return {
        images: await glbMaterialImages(
          await response.arrayBuffer(),
          new URL(url, location.href).href,
        ),
        tried,
      };
    } catch (error) {
      tried.push(String(error));
    }
  }
  return { images: new Map(), tried };
}
