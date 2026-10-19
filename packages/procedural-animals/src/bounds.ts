import { Box3, BufferAttribute, type BufferGeometry, Sphere, Vector3 } from "three";
import { animalError, requireValidatedBake } from "./format.js";
import type { IAnimalBake } from "./format.js";

// Float32 squares and their sum cannot overflow or underflow a JavaScript double.
// The envelope's existing float32 rounding margin also covers norm rounding.
function float32Norm(x: number, y: number, z: number, w = 0): number {
  return Math.sqrt(x * x + y * y + z * z + w * w);
}

/** Bone-packet envelope, without per-frame vertex deformation or GPU readback. */
export function createAnimalBounds(bake: IAnimalBake, geometry?: BufferGeometry) {
  requireValidatedBake(bake);
  let radius = 0;
  let minimumFirstWeight = 1;
  let maximumWeightSum = 0;
  let previousPosition: BufferAttribute | undefined;
  let previousWeights: BufferAttribute | undefined;
  let previousIndices: BufferAttribute | undefined;
  let positionVersion = -1;
  let weightVersion = -1;
  let indexVersion = -1;
  const measure = () => {
    const attribute = (name: string, size: number) => {
      if (!geometry) return undefined;
      const value = geometry.getAttribute(name);
      if (!(value instanceof BufferAttribute) || value.itemSize !== size || value.count !== bake.nV)
        throw animalError(
          "BOUNDS",
          "edited geometry must retain ordinary position/skin attributes and vertex count",
        );
      return value;
    };
    const position = attribute("position", 3);
    const weights = attribute("skinWeight", 4);
    const indices = attribute("skinIndex", 4);
    if (weights?.normalized || indices?.normalized)
      throw animalError("BOUNDS", "normalized edited skin attributes are unsupported");
    if (
      position === previousPosition &&
      weights === previousWeights &&
      indices === previousIndices &&
      position?.version === positionVersion &&
      weights?.version === weightVersion &&
      indices?.version === indexVersion
    )
      return;
    radius = 0;
    minimumFirstWeight = 1;
    maximumWeightSum = 0;
    for (let v = 0; v < bake.nV; v++) {
      const x = position?.getX(v) ?? bake.pos[v * 3] ?? 0;
      const y = position?.getY(v) ?? bake.pos[v * 3 + 1] ?? 0;
      const z = position?.getZ(v) ?? bake.pos[v * 3 + 2] ?? 0;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
        throw animalError("BOUNDS", "edited bind positions must be finite");
      radius = Math.max(radius, Math.hypot(x, y, z));
      let sum = 0;
      for (let influence = 0; influence < 4; influence++) {
        const weight = weights
          ? weights.array[v * 4 + influence]
          : bake.skinWeight[v * 4 + influence];
        const index = indices
          ? indices.array[v * 4 + influence]
          : bake.skinIndex[v * 4 + influence];
        if (
          weight === undefined ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 1 ||
          index === undefined ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= bake.bones.length
        )
          throw animalError("BOUNDS", "edited skin weights/indices must remain valid");
        if (influence === 0) minimumFirstWeight = Math.min(minimumFirstWeight, weight);
        sum += weight;
      }
      if (Math.abs(sum - 1) > 1e-4)
        throw animalError("BOUNDS", "edited skin weights must remain normalized");
      maximumWeightSum = Math.max(maximumWeightSum, sum);
    }
    previousPosition = position;
    previousWeights = weights;
    previousIndices = indices;
    positionVersion = previousPosition?.version ?? -1;
    weightVersion = previousWeights?.version ?? -1;
    indexVersion = previousIndices?.version ?? -1;
  };
  measure();
  const sphere = new Sphere(new Vector3(), 0);
  const box = new Box3();
  return {
    sphere,
    box,
    update(data: Float32Array) {
      if (geometry) measure();
      sphere.center.set(0, 0, 0);
      if (data.length !== bake.bones.length * 20)
        throw animalError("BOUNDS", "missing or non-finite pose packet");
      for (let p = 0; p < data.length; p++)
        if (!Number.isFinite(data[p]))
          throw animalError("BOUNDS", "missing or non-finite pose packet");
      let scaledRadius = 0;
      let dualRadius = 0;
      let minimumQuaternionLength = Number.POSITIVE_INFINITY;
      const norm = data instanceof Float32Array ? float32Norm : Math.hypot;
      for (let o = 0; o < data.length; o += 20) {
        minimumQuaternionLength = Math.min(
          minimumQuaternionLength,
          norm(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, data[o + 3] ?? 0),
        );
        dualRadius = Math.max(
          dualRadius,
          norm(data[o + 4] ?? 0, data[o + 5] ?? 0, data[o + 6] ?? 0, data[o + 7] ?? 0),
        );
        let normSquared = 0;
        for (let row = 8; row <= 16; row += 4)
          for (let column = 0; column < 3; column++)
            normSquared += (data[o + row + column] ?? 0) ** 2;
        const offset = norm(data[o + 11] ?? 0, data[o + 15] ?? 0, data[o + 19] ?? 0);
        scaledRadius = Math.max(scaledRadius, Math.sqrt(normSquared) * radius + offset);
      }
      // Every influence is hemisphere-aligned against the first quaternion: projection of the
      // real blend onto it is >= its first weight * length. Zero first weight uses GLSL's clamp.
      // Affine blending is convex after weight normalization; quaternion rotation preserves length.
      const denominator = Math.max(minimumFirstWeight * minimumQuaternionLength, 1e-6);
      const bound = scaledRadius + (2 * dualRadius * maximumWeightSum) / denominator;
      if (!Number.isFinite(bound)) throw animalError("BOUNDS", "unbounded pose envelope");
      // Cover float32 arithmetic in the actual TSL packet/skin path; this is relative, not metres.
      sphere.radius = bound * (1 + 64 * 2 ** -23) + 64 * 2 ** -23;
      sphere.getBoundingBox(box);
    },
  };
}
