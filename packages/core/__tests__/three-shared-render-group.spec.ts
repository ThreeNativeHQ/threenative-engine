import { BoxGeometry, DepthTexture, DirectionalLight, Mesh, MeshBasicMaterial } from "three";
// @ts-expect-error Three's private chain map has no public declarations.
import ChainMap from "three/src/renderers/common/ChainMap.js";
// @ts-expect-error Three's node manager has no public declarations.
import NodeManager from "three/src/renderers/common/nodes/NodeManager.js";
import { PCFShadowFilter, PCFSoftShadowFilter, renderGroup, vec3, vec4 } from "three/tsl";
import { type Node, WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it } from "vitest";

/** A uniform group binding as three keeps it: the CPU copy of the buffer the shader reads. */
interface IUniformsGroup {
  readonly isNodeUniformsGroup?: boolean;
  readonly buffer: Float32Array;
  update(): boolean;
}

interface IBindGroup {
  readonly name: string;
  readonly bindings: IUniformsGroup[];
}

interface IRecordBuilder {
  flowStagesNode(node: Node, output: "vec4"): { code: string };
  setShaderStage(shaderStage: "fragment"): void;
  getBindings(): IBindGroup[];
  buildUpdateNodes(): void;
  readonly updateNodes: Array<
    Node & { updateReference(state: object): void; update(frame: object): void }
  >;
}

/** One renderer for every material of the test, as one render context holds them all. */
const renderer = {
  backend: {
    isWebGPUBackend: true,
    utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
  },
  hasCompatibility: () => true,
  hasFeature: () => false,
  library: { fromMaterial: () => null },
  reversedDepthBuffer: false,
  shadowMap: { enabled: true, type: 1 },
};

/** A material that samples `shadow` through `filter`, built by its own node builder as three does. */
function record(shadow: DirectionalLight["shadow"], filter = PCFShadowFilter): IRecordBuilder {
  const builder = new WGSLNodeBuilder(
    new Mesh(new BoxGeometry(), new MeshBasicMaterial()),
    renderer as never,
  ) as unknown as IRecordBuilder;
  builder.setShaderStage("fragment");
  // The typings declare the filter's three-argument TSL form; three calls it with one inputs object.
  const sampled = (filter as unknown as (inputs: object) => Node)({
    depthTexture: new DepthTexture(1024, 1024),
    shadow,
    shadowCoord: vec3(0.5, 0.5, 0.5),
  });
  builder.flowStagesNode(vec4(sampled as never) as unknown as Node, "vec4");
  builder.buildUpdateNodes();
  return builder;
}

function renderBindGroup(builder: IRecordBuilder): IBindGroup {
  const group = builder.getBindings().find((bindGroup) => bindGroup.name === "render");
  if (group === undefined) throw new Error("the shadow filter declared no render-group uniforms");
  return group;
}

function uniformsOf(group: IBindGroup): IUniformsGroup {
  const uniforms = group.bindings.find((binding) => binding.isNodeUniformsGroup === true);
  if (uniforms === undefined) throw new Error("the render group holds no uniform buffer");
  return uniforms;
}

/** The node manager's group gate, which is what decides whether a record walks a group. */
function groupGate(): { updateGroup(binding: IUniformsGroup): boolean } {
  const nodes = Object.create(NodeManager.prototype);
  nodes.groupsData = new ChainMap();
  return nodes;
}

/**
 * One render call over `records`: the render group's version moves once, as NodeFrame moves it, the
 * records that are not settled run their per-object node updates, and every record then walks its
 * render group through the real gate. Returns the number of walks that wrote the buffer.
 */
function renderCall(
  gate: ReturnType<typeof groupGate>,
  records: Array<{ builder: IRecordBuilder; settled: boolean }>,
): number {
  renderGroup.needsUpdate = true;
  let walks = 0;
  for (const { builder, settled } of records) {
    if (!settled)
      for (const node of builder.updateNodes)
        if (node.getUpdateType() === "object") {
          node.updateReference({});
          node.update({});
        }
    const uniforms = uniformsOf(renderBindGroup(builder));
    if (gate.updateGroup(uniforms)) {
      walks += 1;
      uniforms.update();
    }
  }
  return walks;
}

describe("a shadow filter's render-group uniforms are shared by every material", () => {
  it.each([
    ["PCF", PCFShadowFilter],
    ["PCF soft", PCFSoftShadowFilter],
  ])("two materials sampling one %s shadow bind one render group", (_name, filter) => {
    // A filter body runs once per node builder. Before, it made new mapSize/radius reference nodes
    // in every build, and three keys a shared bind group on its uniforms' node ids - so every
    // material got a private render-group buffer. On the Machinefall walk that was 338 render
    // groups in two seconds, each compared and written per render call.
    const shadow = new DirectionalLight().shadow;
    const first = renderBindGroup(record(shadow, filter));
    const second = renderBindGroup(record(shadow, filter));
    expect(second, "one render bind group for both materials").toBe(first);
  });

  it("keeps two shadows' uniforms apart", () => {
    const a = new DirectionalLight().shadow;
    const b = new DirectionalLight().shadow;
    expect(renderBindGroup(record(a))).not.toBe(renderBindGroup(record(b)));
  });

  it("writes the shared render group once per render call, not once per record", () => {
    const shadow = new DirectionalLight().shadow;
    const gate = groupGate();
    const records = [record(shadow), record(shadow), record(shadow)].map((builder) => ({
      builder,
      settled: false,
    }));
    expect(renderCall(gate, records), "first render call").toBe(1);
    shadow.radius = 2;
    expect(renderCall(gate, records), "next render call").toBe(1);
  });

  it("shows a changed render-group value to every record on the next render call", () => {
    // The regression the settled-bundle attempt shipped: a record whose own copy of the render
    // group was not refreshed kept stale shadow values. A settled record skips its per-object node
    // updates, so its private reference node never read the new radius; a shared node is read by
    // any record that is not settled, and the one buffer it fills is the one every record binds.
    const shadow = new DirectionalLight().shadow;
    shadow.radius = 1;
    const gate = groupGate();
    const live = record(shadow);
    const settled = record(shadow);
    const records = [
      { builder: live, settled: false },
      { builder: settled, settled: true },
    ];
    renderCall(gate, records);
    shadow.radius = 3;
    renderCall(gate, records);
    for (const builder of [live, settled]) {
      const buffer = uniformsOf(renderBindGroup(builder)).buffer;
      expect(Array.from(buffer), "the buffer this record binds").toContain(3);
      expect(Array.from(buffer)).not.toContain(1);
    }
  });
});
