import type { IAssetLoader } from "@threenative/core";

/** Where `bake.mjs --out assets/terrain/forest` writes the forest inside the game's asset tree. */
export const FOREST_ROOT = "terrain/forest/";

/**
 * The game's asset loader, with every relative path read under {@link FOREST_ROOT}: the forest's
 * art and baked files keep the names the render code asks for, and the game's own assets stay at
 * its asset root. Every other member is the game loader's own.
 */
export function forestAssets(assets: IAssetLoader): IAssetLoader {
  const at = (path: string): string => (/^(?:[a-z]+:|\/)/u.test(path) ? path : FOREST_ROOT + path);
  const scoped: Partial<IAssetLoader> = {
    model: (path, options) => assets.model(at(path), options),
    texture: (path, options) => assets.texture(at(path), options),
    audio: (path) => assets.audio(at(path)),
    release: (kind, path) => assets.release(kind, at(path)),
    resolve: (path) => assets.resolve(at(path)),
  };
  return new Proxy(assets, {
    get(target, key) {
      if (Object.hasOwn(scoped, key)) return scoped[key as keyof IAssetLoader];
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
