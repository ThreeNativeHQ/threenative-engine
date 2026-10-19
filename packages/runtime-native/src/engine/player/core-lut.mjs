import { defineLUTCubeLoader } from "../../../../three-native/src/addons/lut-cube-loader.ts";
import { Data3DTexture, logicalPath } from "./core-textures.mjs";

export const LUTCubeLoader = defineLUTCubeLoader({ textureClass: Data3DTexture, vectorClass: globalThis.Vector3 }, async (url) => {
  const bytes = globalThis.tn.loadAsset("buffer", logicalPath(url)).value;
  return decodeURIComponent(Array.from(new Uint8Array(bytes), (byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""));
});
