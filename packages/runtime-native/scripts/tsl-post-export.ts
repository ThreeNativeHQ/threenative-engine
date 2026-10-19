import type { ISerializedTslNode } from "./tsl-export.js";

function data(node: Record<string, unknown>, key: string): number[] {
  const value = (node[key] as { value: unknown }).value;
  return typeof value === "number" ? [value] : (value as { toArray(): number[] }).toArray();
}
function image(node: Record<string, unknown>, kind: string, key: string, name: string) {
  const map = (node[key] as { value?: unknown }).value ?? node[key];
  const texture = map as {
    image: { width: number; height: number; data?: ArrayLike<number> };
    minFilter: number;
    wrapS: number;
    flipY: boolean;
  };
  if (!texture.image.data) throw new Error(`TN_TSL_POST_IMAGE_MISSING: ${kind}.${key}`);
  return {
    name,
    width: texture.image.width,
    height: texture.image.height,
    bytes: Array.from(texture.image.data),
    nearest: texture.minFilter === 1003,
    repeat: texture.wrapS === 1000,
    flipY: texture.flipY,
  };
}

/** Capture r185 effect parameters and the actual lookup/noise pixels, never substitute tables.
 * SMAA's PNGs are decoded by the CPU image loader in the template harness; RGBA bytes, flipY=false,
 * linear area / nearest search and clamp wrapping are preserved verbatim in the native package.
 */
export function exportNativePost(
  node: Record<string, unknown>,
  kind: string,
  id: number,
  visit: (node: unknown) => number,
): ISerializedTslNode | undefined {
  if (!["GTAONode", "DenoiseNode", "SMAANode"].includes(kind)) return;
  const parameters: Record<string, number[]> = {};
  const images = [];
  const args: number[] = [];
  const name = `native_post_${id}`;
  const keys: Record<string, string[]> = {
    SMAANode: [],
    GTAONode: [
      "radius",
      "thickness",
      "distanceExponent",
      "distanceFallOff",
      "scale",
      "samples",
      "_cameraProjectionMatrix",
      "_cameraProjectionMatrixInverse",
      "_temporalDirection",
    ],
    DenoiseNode: [
      "lumaPhi",
      "depthPhi",
      "normalPhi",
      "radius",
      "index",
      "_cameraProjectionMatrixInverse",
    ],
  };
  for (const key of keys[kind] ?? []) parameters[key] = data(node, key);
  if (kind === "SMAANode") {
    args.push(visit(node.textureNode));
    images.push(
      image(node, kind, "_areaTexture", `${name}_area`),
      image(node, kind, "_searchTexture", `${name}_search`),
    );
  } else {
    if (kind === "DenoiseNode") args.push(visit(node.textureNode));
    args.push(visit(node.depthNode));
    if (node.normalNode !== null) args.push(visit(node.normalNode));
    images.push(
      image(node, kind, kind === "GTAONode" ? "_noiseNode" : "noiseNode", `${name}_noise`),
    );
  }
  if (kind === "DenoiseNode") {
    parameters.sampleVectors = (
      node._sampleVectors as { array: { toArray(): number[] }[] }
    ).array.flatMap((value) => value.toArray());
  }
  return {
    kind,
    name,
    args,
    dependencies: [],
    post: {
      parameters,
      images,
      normal: kind !== "SMAANode" && node.normalNode !== null,
      resolutionScale: kind === "GTAONode" ? Number(node.resolutionScale) : 1,
      temporal: kind === "GTAONode" && node.useTemporalFiltering === true,
    },
  };
}
