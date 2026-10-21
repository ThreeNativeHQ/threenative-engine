/**
 * `three/addons/utils/BufferGeometryUtils.js` as the engine back ends provide it: three's
 * mergeGeometries, mergeAttributes and mergeVertices (merge-geometries.ts) over whichever engine `three` names in
 * this build, the V8 facade or the Wasm entry. The module's other utilities are not provided, so an
 * import of one fails the build.
 */
import { BufferAttribute, BufferGeometry } from "three";

import { defineBufferGeometryUtils } from "./merge-geometries.js";

export const { mergeGeometries, mergeAttributes, mergeVertices } = defineBufferGeometryUtils({
  BufferAttribute,
  BufferGeometry,
} as never);
