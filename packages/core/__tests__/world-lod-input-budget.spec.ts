import {
  BoxGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Vector3,
} from "three";
import { Fn, attribute, uniform, vec4 } from "three/tsl";
import { type Node, NodeFrame, WGSLNodeBuilder } from "three/webgpu";
import { expect, it } from "vitest";
import { worldLodMaterial } from "../src/render/world-impostor-surface.js";

it.each([
  { pass: "maskNode", dynamic: false },
  { pass: "maskShadowNode", dynamic: false },
  { pass: "maskNode", dynamic: true },
  { pass: "maskShadowNode", dynamic: true },
] as const)(
  "keeps $pass inside the real WGSL input budget (dynamic=$dynamic)",
  ({ pass, dynamic }) => {
    const material = worldLodMaterial(
      new MeshStandardMaterial(),
      new Matrix4(),
      [0, 60],
      0,
      0.2,
      uniform(new Vector3()),
      uniform(1),
      false,
    );
    const mesh = new InstancedMesh(new BoxGeometry(), material, 2);
    if (dynamic) mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < 10; i++)
      mesh.geometry.setAttribute(`extra${i}`, new Float32BufferAttribute(new Float32Array(24), 1));
    let origin: Node | undefined;
    material[pass]?.traverse((node) => {
      if (Reflect.get(node, "isVaryingNode") === true) origin = node;
    });
    if (!origin) throw new Error("LOD origin varying missing");
    const builder = new WGSLNodeBuilder(mesh, {
      backend: { capabilities: { getUniformBufferLimit: () => 65536 } },
      getMRT: () => null,
      hasFeature: () => false,
    } as never) as WGSLNodeBuilder & {
      nodes: Set<Node>;
      updateBeforeNodes: Node[];
      buildUpdateNodes(): void;
      setShaderStage(stage: string): void;
      flowStagesNode(node: Node, output: string): void;
      getAttributes(stage: string): string;
    };
    builder.setShaderStage("vertex");
    builder.flowStagesNode(
      Fn((_inputs: unknown, builder: WGSLNodeBuilder) => {
        Reflect.get(material, "setupPosition").call(material, builder);
        let value: Node<"vec4"> = vec4(origin as Node<"vec3">, 1);
        for (let i = 0; i < 10; i++) value = value.add(attribute(`extra${i}`, "float"));
        return value;
      })(),
      "vec4",
    );
    const declarations = builder.getAttributes("vertex");
    expect(declarations.match(/@location/g)?.length).toBeLessThanOrEqual(16);
    expect(declarations.match(/: vec4<f32>/g)).toHaveLength(4);
    const matrixColumns = [...builder.nodes].filter(
      (node) => Reflect.get(node, "value")?.array === mesh.instanceMatrix.array,
    );
    expect(matrixColumns).toHaveLength(4);
    builder.buildUpdateNodes();
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(23, 4, -7));
    mesh.instanceMatrix.addUpdateRange(16, 16);
    mesh.instanceMatrix.needsUpdate = true;
    const frame = new NodeFrame();
    frame.frameId = 1;
    frame.object = mesh;
    for (const node of builder.updateBeforeNodes) frame.updateBeforeNode(node);
    for (const column of matrixColumns) {
      const buffer = Reflect.get(column, "attribute").data;
      expect(buffer.array).toBe(mesh.instanceMatrix.array);
      expect(buffer.version).toBe(mesh.instanceMatrix.version);
      expect(buffer.updateRanges).toEqual(mesh.instanceMatrix.updateRanges);
    }
    material.dispose();
    mesh.geometry.dispose();
  },
);
