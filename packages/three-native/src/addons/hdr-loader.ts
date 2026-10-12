/**
 * three's `HDRLoader` (three/addons/loaders/HDRLoader.js) for the browser back end: fetch the file,
 * decode it with the shared `parseHDR`, and build the engine `DataTexture` with the settings three's
 * `DataTextureLoader` applies. `three` here is the engine binding the web build aliases it to.
 * The V8 player's equivalent reads the cooked package instead (runtime-native core-hdr.mjs).
 */
import { DataTexture, LinearFilter, LinearSRGBColorSpace, RGBAFormat } from "three";

import { HALF_FLOAT_TYPE, parseHDR } from "./hdr.js";

type EngineDataTexture = {
  colorSpace: string;
  flipY: boolean;
  magFilter: number;
  minFilter: number;
  needsUpdate: boolean;
};
const EngineDataTexture = DataTexture as unknown as new (
  data: ArrayLike<number>,
  width: number,
  height: number,
  format: number,
  type: number,
) => EngineDataTexture;

export class HDRLoader {
  type: number = HALF_FLOAT_TYPE;
  path = "";

  setDataType(type: number): this {
    this.type = type;
    return this;
  }

  setPath(path: string): this {
    this.path = path;
    return this;
  }

  load(
    url: string,
    onLoad?: (texture: EngineDataTexture) => void,
    _onProgress?: unknown,
    onError?: (error: unknown) => void,
  ): void {
    this.loadAsync(url).then(onLoad, (error) => {
      if (onError === undefined) throw error;
      onError(error);
    });
  }

  async loadAsync(url: string): Promise<EngineDataTexture> {
    const response = await fetch(this.path + url);
    if (!response.ok)
      throw new Error(`TN_HDR_FETCH: ${this.path + url} answered ${String(response.status)}`);
    const image = parseHDR(await response.arrayBuffer(), this.type);
    const texture = new EngineDataTexture(
      image.data,
      image.width,
      image.height,
      RGBAFormat,
      image.type,
    );
    texture.colorSpace = LinearSRGBColorSpace;
    texture.minFilter = texture.magFilter = LinearFilter;
    texture.flipY = true;
    texture.needsUpdate = true;
    return texture;
  }
}
