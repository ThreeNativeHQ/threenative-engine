import type { IComputeDriven, SoftBody3D } from "@threenative/core";
import {
  MeshBasicNodeMaterial,
  ReadbackBuffer,
  StorageArrayElementNode,
  StorageBufferAttribute,
  StorageBufferNode,
  StorageInstancedBufferAttribute,
} from "three/webgpu";

/** Observe the public TSL position storage after primary timing has stopped; no hidden SoftBody fields. */
export async function observeCloth(
  cloth: SoftBody3D,
  renderer: Parameters<IComputeDriven["process"]>[0],
  vertices: number,
): Promise<{
  readonly fixedStep: number;
  readonly staleTicks: number;
  readonly bytes: number;
  readonly positions: Float32Array;
}> {
  if (cloth.released)
    throw new Error("TN_RIGGING_OBSERVATION_STALE: cloth generation has retired.");
  if (!Number.isSafeInteger(vertices) || vertices < 1 || vertices > 2048)
    throw new Error("TN_RIGGING_OBSERVATION_INVALID: bounded authored vertex count is required.");
  const material = cloth.material;
  if (
    !(material instanceof MeshBasicNodeMaterial) ||
    !(material.positionNode instanceof StorageArrayElementNode)
  )
    throw new Error("TN_RIGGING_OBSERVATION_UNSUPPORTED: public cloth position storage is absent.");
  const node = material.positionNode.node;
  if (!(node instanceof StorageBufferNode) || node.bufferType !== "vec3")
    throw new Error("TN_RIGGING_OBSERVATION_UNSUPPORTED: position node is not public storage.");
  const attribute = node.value;
  if (
    !(
      attribute instanceof StorageBufferAttribute ||
      attribute instanceof StorageInstancedBufferAttribute
    ) ||
    (attribute.itemSize !== 3 && attribute.itemSize !== 4) ||
    attribute.count !== vertices
  )
    throw new Error("TN_RIGGING_OBSERVATION_INVALID: authored cloth storage count/layout changed.");
  const fixedStep = cloth.steps;
  const target = new ReadbackBuffer(vertices * 16);
  let bytes: ArrayBuffer | undefined;
  let failure: { cause: unknown } | undefined;
  try {
    bytes = await renderer.readback(attribute, target);
  } catch (cause) {
    failure = { cause };
  } finally {
    try {
      target.dispose();
    } catch (cause) {
      failure = {
        cause: new Error("TN_RIGGING_READBACK_RELEASE: final staging cleanup failed.", { cause }),
      };
    }
  }
  if (failure !== undefined) throw failure.cause;
  if (bytes === undefined)
    throw new Error("TN_RIGGING_OBSERVATION_INVALID: final readback returned no bytes.");
  if (cloth.released)
    throw new Error("TN_RIGGING_OBSERVATION_STALE: cloth exited during final readback.");
  if (bytes.byteLength !== vertices * 12 && bytes.byteLength !== vertices * 16)
    throw new Error("TN_RIGGING_OBSERVATION_INVALID: packed/padded vec3 byte count differs.");
  const data = new Float32Array(bytes);
  const stride = data.length / vertices;
  const positions = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++)
    for (let axis = 0; axis < 3; axis++) {
      const value = data[i * stride + axis];
      if (value === undefined || !Number.isFinite(value))
        throw new Error("TN_RIGGING_OBSERVATION_INVALID: missing/nonfinite physical position.");
      positions[i * 3 + axis] = value;
    }
  return Object.freeze({
    fixedStep,
    staleTicks: cloth.steps - fixedStep,
    bytes: bytes.byteLength,
    positions,
  });
}
