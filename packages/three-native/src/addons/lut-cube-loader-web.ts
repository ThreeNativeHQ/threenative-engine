import { Data3DTexture, Vector3 } from "three";
import { defineLUTCubeLoader } from "./lut-cube-loader.js";

export const LUTCubeLoader = defineLUTCubeLoader(
  {
    // quality-allow: generated engine declarations omit the Data3DTexture source constructor and image record.
    textureClass: Data3DTexture as unknown as Parameters<
      typeof defineLUTCubeLoader
    >[0]["textureClass"],
    vectorClass: Vector3,
  },
  async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`TN_LUT_FETCH: ${response.status} ${url}`);
    return response.text();
  },
);
