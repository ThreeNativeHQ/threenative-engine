// three's HDRLoader over the cooked package: the .hdr's bytes from a Buffer entry, decoded by the
// shared RGBE parser into a native DataTexture with the settings three's DataTextureLoader applies.
import { parseHDR } from "../../../../three-native/src/addons/hdr.ts";
import { logicalPath } from "./core-textures.mjs";

const NativeDataTexture = globalThis.DataTexture;

export class HDRLoader {
  constructor() {
    this.type = 1016; // HalfFloatType, three's default
    this.path = "";
  }
  setDataType(type) { this.type = type; return this; }
  setPath(path) { this.path = path; return this; }
  load(url, onLoad, onProgress, onError) {
    const result = this.loadAsync(url);
    result.then(onLoad, (error) => { if (onError) onError(error); else throw error; });
  }
  async loadAsync(url) {
    const image = parseHDR(globalThis.tn.loadAsset("buffer", logicalPath(this.path + url)).value, this.type);
    // The native constructor, not the facade's: nothing here edits the texels after the upload,
    // so there is no JS-side source to re-send (8M values for a 2K sky).
    const texture = new NativeDataTexture(image.data, image.width, image.height, globalThis.RGBAFormat, image.type);
    Object.assign(texture, { colorSpace: globalThis.LinearSRGBColorSpace, minFilter: globalThis.LinearFilter,
      magFilter: globalThis.LinearFilter, flipY: true });
    texture.needsUpdate = true;
    return texture;
  }
}
