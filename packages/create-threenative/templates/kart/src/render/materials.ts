// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The course and the karts are built from primitives painted with vertex colours and merged, so a
// kart is a handful of draw calls instead of forty. `paint` colours one primitive, `merge` joins a
// list into one geometry, and `lit` is the one cached physically based material per look: rough
// and non-metal like the stock Unreal default material, so the meter sees albedos, not glints.
import {
  BufferAttribute,
  type BufferGeometry,
  Color,
  type ColorRepresentation,
  Euler,
  type Material,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { C } from "./palette.js";

const cache = new Map<string, Material>();

/** One shared material per option set; `vertexColors` is the default for merged parts. */
export function lit(
  options: {
    color?: ColorRepresentation;
    roughness?: number;
    metalness?: number;
    emissive?: ColorRepresentation;
    emissiveIntensity?: number;
    vertexColors?: boolean;
    transparent?: boolean;
    opacity?: number;
    flatShading?: boolean;
  } = {},
): MeshStandardMaterial {
  const key = JSON.stringify(options);
  const hit = cache.get(key);
  if (hit !== undefined) return hit as MeshStandardMaterial;
  const material = new MeshStandardMaterial({
    color: options.color ?? C.white,
    depthWrite: options.transparent !== true,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0,
    flatShading: options.flatShading ?? false,
    metalness: options.metalness ?? 0,
    opacity: options.opacity ?? 1,
    roughness: options.roughness ?? 0.75,
    transparent: options.transparent ?? false,
    vertexColors: options.vertexColors ?? true,
  });
  cache.set(key, material);
  return material;
}

const scratch = new Color();

/**
 * Colours every vertex of `geometry` and bakes `transform` (position, rotation, scale) into it.
 * `shade` varies the colour by height in the part, 0 for none: a gentle top-light that keeps a
 * merged lump from reading as one flat colour.
 */
export function paint(
  geometry: BufferGeometry,
  color: ColorRepresentation,
  transform?: Matrix4,
  shade = 0,
): BufferGeometry {
  const part = geometry.index === null ? geometry : geometry.toNonIndexed();
  if (transform !== undefined) part.applyMatrix4(transform);
  const position = part.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  scratch.set(color);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < position.count; i += 1) {
    low = Math.min(low, position.getY(i));
    high = Math.max(high, position.getY(i));
  }
  for (let i = 0; i < position.count; i += 1) {
    const t = high > low ? (position.getY(i) - low) / (high - low) : 1;
    const k = 1 - shade * (1 - t);
    colors.set([scratch.r * k, scratch.g * k, scratch.b * k], i * 3);
  }
  part.setAttribute("color", new BufferAttribute(colors, 3));
  if (part.getAttribute("uv") === undefined)
    part.setAttribute("uv", new BufferAttribute(new Float32Array(position.count * 2), 2));
  return part;
}

/** Joins painted parts into one geometry; throws rather than drawing nothing. */
export function merge(parts: readonly BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries([...parts], false);
  if (merged === null) throw new Error("merge: parts do not share the same attributes.");
  for (const part of parts) part.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/** A transform from position, Euler angles (radians, XYZ) and scale. */
export function at(
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): Matrix4 {
  return new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromEuler(new Euler(rx, ry, rz)),
    new Vector3(sx, sy, sz),
  );
}
