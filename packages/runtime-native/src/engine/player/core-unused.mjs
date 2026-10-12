import { unsupportedExport } from "../../../../three-native/src/refused.ts";

// Unused imports must never pull upstream rendering/loader code into this artifact.
export const MeshBVH = unsupportedExport("MeshBVH");
export const GLTFLoader = unsupportedExport("GLTFLoader");
export const DRACOLoader = unsupportedExport("DRACOLoader");
export const MeshoptDecoder = { ready: Promise.resolve(), decodeGltfBuffer: unsupportedExport("MeshoptDecoder.decodeGltfBuffer") };
export const mergeGeometries = unsupportedExport("mergeGeometries");
export const mergeAttributes = unsupportedExport("mergeAttributes");
export const clone = unsupportedExport("clone");
export class KTX2Loader {
  setTranscoderPath() {}
  setWorkerLimit() {}
  detectSupport = unsupportedExport("KTX2Loader.detectSupport");
  load = unsupportedExport("KTX2Loader.load");
}
export const {
  Fn, attribute, instanceIndex, normalGeometry, normalLocal, positionGeometry,
  positionPrevious, storage, tangentGeometry, tangentLocal, uint, vec4,
  context, mrt, output, velocity,
} = globalThis;
