import {
  Box3,
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from "three";
import { pass } from "three/tsl";
import {
  ConditionalNode,
  type Node,
  type NodeBuilder,
  OperatorNode,
  WGSLNodeBuilder,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  GLTF_IOR,
  refractBehind,
  refractionGain,
} from "../unreal-look/scaffold/render/refraction.js";

/** The WGSL one fragment node builds to, on the fake WebGPU renderer the starter's fog tests use. */
function fragmentCode(camera: PerspectiveCamera, node: Node): string {
  const renderer = {
    backend: {
      isWebGPUBackend: true,
      capabilities: { getUniformBufferLimit: () => 65_536 },
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
    },
    coordinateSystem: 2001,
    hasCompatibility: () => true,
    hasFeature: () => false,
    getRenderTarget: () => null,
    getOutputBufferType: () => 1016,
    samples: 0,
    getMRT: () => null,
    library: { fromMaterial: () => null },
    shadowMap: { enabled: true, type: 1 },
  };
  const builder = new WGSLNodeBuilder(
    new Mesh(new BoxGeometry(), new MeshBasicMaterial()),
    renderer as never,
  ) as unknown as {
    camera: PerspectiveCamera;
    setShaderStage(stage: string): void;
    flowStagesNode(node: Node, output: string): { code: string };
  };
  builder.camera = camera;
  builder.setShaderStage("fragment");
  return builder.flowStagesNode(node, "vec4").code;
}

describe("a translucent surface bends the scene behind it as Unreal's distortion pass does (PRD-643)", () => {
  it("scales the offset by (IOR - 1), the view width and 1 / tan(half the field of view)", () => {
    const projectionXx = 1 / Math.tan((60 * Math.PI) / 180 / 2);
    // The glass-edge pose: a 60 degree view, 1280 px wide, the pane normal at -0.252 along the view's x axis.
    const gain = refractionGain(GLTF_IOR, 1280, projectionXx);
    expect(gain).toBeCloseTo(0.255, 3);
    expect(Math.abs(-0.252 * gain) * 1280).toBeCloseTo(82.2, 0);
    // IOR 1 is no refraction, and a view twice as wide moves twice as many screen units.
    expect(refractionGain(1, 1280, projectionXx)).toBe(0);
    expect(refractionGain(GLTF_IOR, 2560, projectionXx)).toBeCloseTo(2 * gain, 6);
  });

  it("builds for the owned engine: comparisons of one type and selects on a bool scalar", () => {
    const comparison = new Set(["==", "!=", "<", ">", "<=", ">="]);
    const wrong: string[] = [];
    const seen = { comparisons: 0, selects: 0 };
    const generateOperator = OperatorNode.prototype.generate;
    const generateConditional = ConditionalNode.prototype.generate;
    OperatorNode.prototype.generate = function (
      this: OperatorNode,
      builder: NodeBuilder,
      output?: string | null,
    ) {
      if (comparison.has(this.op)) {
        seen.comparisons += 1;
        const a = this.aNode.getNodeType(builder);
        const b = this.bNode.getNodeType(builder);
        if (a !== b) wrong.push(`${a} ${this.op} ${b}`);
      }
      return generateOperator.call(this, builder, output);
    };
    ConditionalNode.prototype.generate = function (
      this: ConditionalNode<string>,
      builder: NodeBuilder,
      output?: string | null,
    ) {
      seen.selects += 1;
      const type = this.condNode.getNodeType(builder);
      if (type !== "bool") wrong.push(`select on ${type}`);
      return generateConditional.call(this, builder, output);
    };
    try {
      const camera = new PerspectiveCamera(60, 16 / 9);
      const scenePass = pass(new Scene(), camera);
      const box = new Box3(new Vector3(-1.2, 0.2, -0.82), new Vector3(1.2, 2.2, -0.78));
      const refracted = refractBehind(scenePass, camera, [box], {
        ior: GLTF_IOR,
        widthPixels: () => 1280,
      });
      // A TSL function body runs when the shader builds.
      const code = fragmentCode(camera, refracted);
      // The scene colour is read twice: at the pixel and at its shifted place.
      expect(code.match(/textureSample|textureLoad/gu)?.length).toBeGreaterThanOrEqual(3);
      scenePass.dispose();
    } finally {
      OperatorNode.prototype.generate = generateOperator;
      ConditionalNode.prototype.generate = generateConditional;
    }
    expect(wrong).toEqual([]);
    // Fail closed: a three upgrade that renames either method would leave this check empty.
    expect(seen.comparisons).toBeGreaterThan(0);
    expect(seen.selects).toBeGreaterThan(0);
  });
});
