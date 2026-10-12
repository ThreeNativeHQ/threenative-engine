import type { Layer } from "@threenative/terrain";
import { Quaternion, Vector3 } from "three";

/** Recipe footprints are heights over X/Z, never independently transformed solids. */
export function landformPose(layer: Layer, worldSize: number) {
  if (layer.type !== "stamp" && layer.type !== "paste" && layer.type !== "heightmap")
    return undefined;
  const p = layer.params;
  const size = p.size ?? (layer.type === "heightmap" ? worldSize : 120);
  const radius =
    "radius" in p && p.radius !== undefined
      ? p.radius
      : typeof size === "number"
        ? size / 2
        : [size[0] / 2, size[1] / 2];
  const extents = typeof radius === "number" ? [radius, radius] : radius;
  return {
    position: [p.at?.[0] ?? 0, p.offset ?? 0, p.at?.[1] ?? 0] as [number, number, number],
    // The recovered operation rotates +X towards +Z; Three.js Y rotation has the opposite sign.
    quaternion: new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      (-(p.rotation ?? 0) * Math.PI) / 180,
    ),
    scale: [extents[0], p.scale ?? 1, extents[1]] as [number, number, number],
    rectangular: layer.type !== "stamp" || p.data !== undefined,
  };
}

export function transformedLandform(
  layer: Layer,
  position: Vector3,
  quaternion: Quaternion,
  scale: Vector3,
  anchor: number,
): Layer {
  if (layer.type !== "stamp" && layer.type !== "paste" && layer.type !== "heightmap")
    throw new Error("This layer has no landform footprint");
  if (
    ![...position.toArray(), ...quaternion.toArray(), ...scale.toArray(), anchor].every(
      Number.isFinite,
    ) ||
    Math.min(scale.x, scale.y, scale.z) <= 0
  )
    throw new Error("Landform coordinates must be finite and scales positive");
  if (Math.abs(quaternion.x) > 1e-6 || Math.abs(quaternion.z) > 1e-6)
    throw new Error("Heightfields cannot represent overhanging X/Z rotations");
  const footprint =
    layer.type === "heightmap" ||
    (layer.params.radius === undefined && layer.params.size !== undefined)
      ? { size: [scale.x * 2, scale.z * 2] as [number, number] }
      : { radius: [scale.x, scale.z] as [number, number] };
  return {
    ...layer,
    params: {
      ...layer.params,
      ...footprint,
      at: [position.x, position.z],
      offset: position.y - anchor,
      scale: scale.y,
      rotation: (-2 * Math.atan2(quaternion.y, quaternion.w) * 180) / Math.PI,
    },
  } as Layer;
}
