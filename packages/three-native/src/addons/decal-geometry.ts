/**
 * `three/addons/geometries/DecalGeometry.js` as the engine back ends provide it: three's clipping
 * (decal.ts) over whichever engine `three` names in this build, the V8 facade or the Wasm entry.
 */
import {
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  Mesh,
  Vector3,
} from "three";

import { defineDecalGeometry } from "./decal.js";

export const { DecalGeometry, DecalVertex } = defineDecalGeometry({
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  Mesh,
  Vector3,
} as never);
