// Imported environment imagery: an equirectangular HDR/EXR (or an ordinary image) as sky and/or light.
//
// HDR and EXR files go through three's own loaders and are kept as float data: their radiance is the
// point, so nothing here clamps it, tone-maps it or sends it through the ordinary image decoder that
// treats pixels as 8-bit colour. An ordinary image is colour, loaded through `ctx.assets.texture`
// as sRGB. The file's address comes from `ctx.assets.resolve`, never from a path built here.
import type { IAssetLoader } from "@threenative/core";
import type { IProjectAsset } from "@threenative/terrain/editor";
import { DataUtils, EquirectangularReflectionMapping, LinearFilter, type Texture } from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

export interface IEnvironmentImage {
  readonly id: string;
  readonly sha256: string;
  readonly format: string;
  status: "loading" | "ready" | "failed";
  error?: string;
  texture?: Texture;
  /** The brightest channel value in the file: above 1 means radiance survived the load. */
  peak: number | null;
  load: Promise<void>;
}

function peakOf(texture: Texture): number | null {
  const data = (texture.image as { data?: ArrayLike<number> } | undefined)?.data;
  if (!data || texture.type === undefined) return null;
  const half = data instanceof Uint16Array;
  let peak = 0;
  for (let index = 0; index < data.length; index += 4)
    for (let channel = 0; channel < 3; channel += 1) {
      const raw = data[index + channel] as number;
      peak = Math.max(peak, half ? DataUtils.fromHalfFloat(raw) : raw);
    }
  return peak;
}

export function createEnvironmentImages(
  assets: IAssetLoader,
  urlOf: (asset: IProjectAsset) => string,
  onChange: () => void,
) {
  const images = new Map<string, IEnvironmentImage>();

  async function decode(asset: IProjectAsset, url: string): Promise<Texture> {
    if (asset.format === "hdr") return new HDRLoader().loadAsync(url);
    if (asset.format === "exr") return new EXRLoader().loadAsync(url);
    // An ordinary image is colour: the loader hands it back as sRGB.
    return assets.texture(url, { data: false });
  }

  function drop(id: string): void {
    images.get(id)?.texture?.dispose();
    images.delete(id);
  }

  return {
    /** Start what is not loaded yet; a replaced file loads from its own hash-named URL. */
    request(asset: IProjectAsset): void {
      const known = images.get(asset.id);
      if (known?.sha256 === asset.sha256) return;
      drop(asset.id);
      const entry: IEnvironmentImage = {
        id: asset.id,
        sha256: asset.sha256,
        format: asset.format ?? "",
        status: "loading",
        peak: null,
        load: Promise.resolve(),
      };
      images.set(asset.id, entry);
      entry.load = (async () => {
        try {
          const [url] = await assets.resolve(urlOf(asset));
          if (!url) throw new Error("no address for the file");
          const texture = await decode(asset, url);
          if (images.get(asset.id) !== entry) {
            texture.dispose();
            return;
          }
          texture.mapping = EquirectangularReflectionMapping;
          texture.minFilter = LinearFilter;
          texture.magFilter = LinearFilter;
          texture.generateMipmaps = false;
          entry.peak = peakOf(texture);
          entry.texture = texture;
          entry.status = "ready";
        } catch (error) {
          if (images.get(asset.id) !== entry) return;
          entry.status = "failed";
          entry.error = `${asset.id}: ${error instanceof Error ? error.message : String(error)}`;
        }
        onChange();
      })();
    },
    get: (id: string): IEnvironmentImage | undefined => images.get(id),
    /** Forget what the document no longer lists. */
    retain(list: readonly IProjectAsset[]): void {
      for (const id of [...images.keys()]) if (!list.some((asset) => asset.id === id)) drop(id);
    },
    ready: async (): Promise<void> => {
      await Promise.all([...images.values()].map((entry) => entry.load));
    },
    dispose(): void {
      for (const id of [...images.keys()]) drop(id);
    },
  };
}
