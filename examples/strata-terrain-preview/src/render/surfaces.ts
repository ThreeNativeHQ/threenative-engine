// Imported surface images: which of this game's live texture inputs an imported PNG, JPEG or WebP replaces.
//
// The input names are this game's own (`bark.albedo`, `stone.normal`, ...); the addon only checks that
// a name is `<surface>.<channel>` and that the file is a registered image. What an input draws, and
// how its pixels are read, is decided here: albedo is colour, so it is sampled as sRGB, and every
// other channel is a number, so it is sampled as data and never colour-converted.
//
// A replacement swaps the *image* a texture already holds. The texture object, its sampler slot and
// every material node that reads it stay exactly as they were, so a mapping adds no sampler (the
// ground shader already binds 15 of the 16 WebGPU allows) and no material rebuild. Restoring the
// starter art is putting its original image back, which needs no request.
import type { IAssetLoader } from "@threenative/core";
import {
  type IProjectAsset,
  type ISurfaceMappings,
  surfaceSpace,
} from "@threenative/terrain/editor";
import { NoColorSpace, RepeatWrapping, SRGBColorSpace, type Texture } from "three";

export interface ISurfaceReading {
  readonly input: string;
  /** What the channel's name says the pixels are. */
  readonly expectedSpace: "srgb" | "linear";
  /** What the bound texture is actually configured to be sampled as. */
  readonly actualSpace: "srgb" | "linear";
  /** `starter` or the registered image id now bound. */
  readonly source: string;
  readonly sha256: string | null;
  readonly width: number;
  readonly height: number;
  /** The centre pixel of the image the texture holds, as bytes. */
  readonly pixel: number[];
  /** Identity of the bound image, so a swap and a stale copy can be told apart. */
  readonly imageId: string;
  readonly textureId: string;
  /** The GPU texture's own format once drawn: `-srgb` means the hardware decodes colour on sampling. */
  readonly gpuFormat: string | null;
}

interface IBinding {
  readonly texture: Texture;
  readonly original: Texture["source"];
  assetId: string | null;
  sha256: string | null;
  url: string | null;
}

export function createSurfaceBindings(
  assets: IAssetLoader,
  inputs: Record<string, Texture | undefined>,
  urlOf: (asset: IProjectAsset) => string,
  gpuFormat: (texture: Texture) => string | undefined = () => undefined,
) {
  const bindings = new Map<string, IBinding>();
  for (const [input, texture] of Object.entries(inputs))
    if (texture)
      bindings.set(input, {
        texture,
        original: texture.source,
        assetId: null,
        sha256: null,
        url: null,
      });
  let diagnostics: string[] = [];
  let pending: Promise<void> = Promise.resolve();

  const space = (texture: Texture): "srgb" | "linear" =>
    texture.colorSpace === SRGBColorSpace ? "srgb" : "linear";

  function restore(binding: IBinding): void {
    if (binding.url) assets.release("texture", binding.url);
    binding.texture.source = binding.original;
    binding.texture.dispose();
    binding.texture.needsUpdate = true;
    binding.assetId = null;
    binding.sha256 = null;
    binding.url = null;
  }

  async function bind(
    input: string,
    binding: IBinding,
    asset: IProjectAsset,
    problems: string[],
  ): Promise<void> {
    const url = urlOf(asset);
    try {
      const wanted = surfaceSpace(input);
      const loaded = await assets.texture(url, {
        anisotropy: 8,
        data: wanted === "linear",
        wrap: RepeatWrapping,
      });
      const previous = binding.url;
      binding.texture.source = loaded.source;
      // The channel decides the colour space, never the file: an albedo is colour, the rest is data.
      binding.texture.colorSpace = wanted === "srgb" ? SRGBColorSpace : NoColorSpace;
      binding.texture.dispose();
      binding.texture.needsUpdate = true;
      if (previous && previous !== url) assets.release("texture", previous);
      binding.assetId = asset.id;
      binding.sha256 = asset.sha256;
      binding.url = url;
    } catch (error) {
      problems.push(
        `${input}: ${asset.id} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function run(mappings: ISurfaceMappings, list: readonly IProjectAsset[]): Promise<void> {
    const problems: string[] = [];
    for (const input of Object.keys(mappings))
      if (!bindings.has(input))
        problems.push(`No surface input '${input}' in this project's render source`);
    for (const [input, binding] of bindings) {
      const wanted = mappings[input];
      const asset = wanted ? list.find((entry) => entry.id === wanted.asset) : undefined;
      if (!asset) {
        if (binding.assetId) restore(binding);
        continue;
      }
      if (binding.assetId === asset.id && binding.sha256 === asset.sha256) continue;
      await bind(input, binding, asset, problems);
    }
    diagnostics = problems;
  }

  return {
    /** Make the live inputs match the saved mappings; queued, so overlapping edits apply in order. */
    sync(mappings: ISurfaceMappings, list: readonly IProjectAsset[]): void {
      pending = pending.then(() => run(mappings, list)).catch(() => undefined);
    },
    ready: (): Promise<void> => pending,
    /** The address of the imported image each mapped input draws, so an export can carry the same one. */
    urls: (): Record<string, string> =>
      Object.fromEntries(
        [...bindings.entries()].flatMap(([input, binding]) =>
          binding.url ? [[input, binding.url]] : [],
        ),
      ),
    diagnostics: (): string[] => [...diagnostics],
    inputs: (): { input: string; channel: string }[] =>
      [...bindings.keys()].map((input) => ({ input, channel: input.split(".")[1] ?? "" })),
    /** What each input holds right now, read off the bound texture and the image inside it. */
    read(): ISurfaceReading[] {
      return [...bindings.entries()].map(([input, binding]) => {
        const image = binding.texture.source.data as { width: number; height: number } | undefined;
        let pixel: number[] = [];
        if (image?.width && typeof OffscreenCanvas !== "undefined") {
          const canvas = new OffscreenCanvas(1, 1);
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context?.drawImage(
            image as unknown as CanvasImageSource,
            Math.floor(image.width / 2),
            Math.floor(image.height / 2),
            1,
            1,
            0,
            0,
            1,
            1,
          );
          pixel = [...(context?.getImageData(0, 0, 1, 1).data ?? [])];
        }
        return {
          input,
          expectedSpace: surfaceSpace(input),
          actualSpace: space(binding.texture),
          source: binding.assetId ?? "starter",
          sha256: binding.sha256,
          width: image?.width ?? 0,
          height: image?.height ?? 0,
          pixel,
          imageId: binding.texture.source.uuid,
          textureId: binding.texture.uuid,
          gpuFormat: gpuFormat(binding.texture) ?? null,
        };
      });
    },
    dispose(): void {
      for (const binding of bindings.values()) if (binding.assetId) restore(binding);
    },
  };
}
