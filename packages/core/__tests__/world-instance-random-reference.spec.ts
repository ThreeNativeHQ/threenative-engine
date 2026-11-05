import { BoxGeometry, InstancedBufferAttribute, InstancedMesh } from "three";
import { Fn, vec4 } from "three/tsl";
import { MeshStandardNodeMaterial, type Node, WGSLNodeBuilder } from "three/webgpu";
import { expect, it } from "vitest";
import { instanceRandom } from "../src/render/world-impostor-surface.js";

// BUG-strata-tree-shake: on the real renderer, r187 binds `instanceMatrix` per object
// (`ReferenceBufferAttributeNode`). `instanceMatrixNode` did not recognise those columns and built
// its own over the build-time array, so a batch whose buffer `#resize` replaced drew from the old
// 64-record buffer: "Instance range ... requires a larger buffer", the bundle and the frame dropped.
it("instanceRandom reads the instance matrix the drawn object holds now, not the one it was built with", () => {
  const material = new MeshStandardNodeMaterial();
  const mesh = new InstancedMesh(new BoxGeometry(), material, 64);
  const builder = new WGSLNodeBuilder(mesh, {
    // The real renderer: three binds instance data per object only for one.
    isRenderer: true,
    backend: { capabilities: { getUniformBufferLimit: () => 65536 } },
    debug: { diagnostics: { keywords: false } },
    getMRT: () => null,
    hasFeature: () => false,
  } as never) as WGSLNodeBuilder & {
    setShaderStage(stage: string): void;
    flowStagesNode(node: Node, output: string): void;
    getAttributes(stage: string): string;
    getAttributesArray(): {
      node?: { attribute?: unknown; getObjectAttribute(o: object): never };
    }[];
  };
  builder.setShaderStage("vertex");
  builder.flowStagesNode(
    Fn((_inputs: unknown, b: WGSLNodeBuilder) => {
      Reflect.get(material, "setupPosition").call(material, b);
      return vec4(instanceRandom());
    })(),
    "vec4",
  );
  // One set of matrix columns: three's own.
  expect(builder.getAttributes("vertex").match(/: vec4<f32>/g)).toHaveLength(4);
  // What `RenderObject.getAttributes` binds after `SharedBatch#resize` swaps the buffer.
  mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(1024 * 16), 16);
  const instanced = builder
    .getAttributesArray()
    .flatMap(({ node }) =>
      node?.attribute
        ? [node.getObjectAttribute(mesh) as { data?: object; isInstancedBufferAttribute?: boolean }]
        : [],
    )
    .map((attribute) => attribute.data ?? attribute)
    .filter(
      (buffer) =>
        Reflect.get(buffer, "isInstancedBufferAttribute") === true ||
        Reflect.get(buffer, "isInstancedInterleavedBuffer") === true,
    );
  expect(instanced.length).toBeGreaterThan(0);
  for (const buffer of instanced) expect(buffer).toBe(mesh.instanceMatrix);
  material.dispose();
  mesh.geometry.dispose();
});
