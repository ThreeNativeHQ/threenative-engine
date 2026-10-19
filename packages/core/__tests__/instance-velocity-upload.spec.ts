import {
  BoxGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  type InterleavedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  Scene,
} from "three";
import Attributes from "three/src/renderers/common/Attributes.js";
import { AttributeType } from "three/src/renderers/common/Constants.js";
import Renderer from "three/src/renderers/common/Renderer.js";
import { instance } from "three/tsl";
import { type Node, NodeFrame, WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { VelocityTracker } from "../src/render/velocity.js";

/** Three's runtime builder methods are not included in its published declarations. */
interface IInstanceBuilder extends WGSLNodeBuilder {
  setShaderStage(stage: string): void;
  flowStagesNode(node: Node, output: string): void;
  buildUpdateNodes(): void;
  nodes: Node[];
  updateBeforeNodes: Node[];
  updateNodes: Node[];
}

function fixture(dynamic: boolean, temporal = true, scheduled = temporal) {
  const crowd = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 2);
  if (dynamic) crowd.instanceMatrix.setUsage(DynamicDrawUsage);
  crowd.setMatrixAt(0, new Matrix4().makeTranslation(-1, 0, -4));
  crowd.setMatrixAt(1, new Matrix4().makeTranslation(1, 0, -4));
  const scene = new Scene();
  scene.add(crowd);
  const tracker = new VelocityTracker();
  if (scheduled) tracker.update(scene);
  const builder = new WGSLNodeBuilder(crowd, {
    backend: { capabilities: { getUniformBufferLimit: () => 65536 } },
    getMRT: () => (temporal ? new Set(["velocity"]) : null),
  } as never) as IInstanceBuilder;
  builder.setShaderStage("vertex");
  builder.flowStagesNode(Reflect.apply(instance, undefined, [crowd.instanceMatrix]), "void");
  builder.buildUpdateNodes();
  const attributes: InterleavedBufferAttribute[] = [...builder.nodes]
    .map((node) => Reflect.get(node, "attribute"))
    .filter((attribute) => attribute?.isInterleavedBufferAttribute);
  const current = attributes.find(
    (attribute) => attribute.data.array === crowd.instanceMatrix.array,
  );
  const previous = attributes.find(
    (attribute) => attribute.data.array !== crowd.instanceMatrix.array,
  );
  if (!current || (temporal && !previous)) throw new Error("Real instance attributes missing");
  const uploaded = new Map<object, Float32Array>();
  let updates = 0;
  const upload = (attribute: InterleavedBufferAttribute) => {
    uploaded.set(attribute.data, Float32Array.from(attribute.data.array));
    updates += 1;
  };
  const manager = new Attributes(
    { createAttribute: upload, updateAttribute: upload } as never,
    { createAttribute() {} } as never,
  );
  const frame = new NodeFrame();
  frame.object = crowd;
  const renderer = {
    _currentRenderBundle: null,
    _objects: { get: () => ({}) },
    _nodes: {
      needsRefresh: () => true,
      updateBefore: () => {
        for (const node of builder.updateBeforeNodes) frame.updateBeforeNode(node);
      },
      updateForRender: () => {
        for (const node of builder.updateNodes) frame.updateNode(node);
      },
      updateAfter() {},
    },
    _geometries: {
      updateForRender: () => {
        for (const attribute of attributes) manager.update(attribute, AttributeType.VERTEX);
      },
    },
    _bindings: { updateForRender() {} },
    _pipelines: { updateForRender() {}, isReady: () => true },
    backend: { draw() {} },
    info: {},
  };
  return {
    crowd,
    previous,
    tracker,
    scene,
    draw() {
      frame.frameId += 1;
      frame.renderId += 1;
      // Exercise the shipped renderer order, not a test-authored simulation of its phases.
      Reflect.get(Renderer.prototype, "_renderObjectDirect").call(
        renderer,
        crowd,
        crowd.material,
        scene,
        {},
        {},
        null,
        null,
      );
      return {
        current: uploaded.get(current.data),
        previous: previous ? uploaded.get(previous.data) : undefined,
        updates,
      };
    },
  };
}

describe("instance matrix uploads at the actual draw boundary", () => {
  it.each([false, true])(
    "draws current and scheduled previous matrices together (dynamic=%s)",
    (dynamic) => {
      const f = fixture(dynamic);
      const first = f.draw();
      expect(first.previous).toEqual(first.current);
      f.tracker.commit(f.scene);
      for (const x of [2, 4, 3, 3, 1]) {
        const previous = Float32Array.from(f.crowd.instanceMatrix.array);
        f.crowd.setMatrixAt(1, new Matrix4().makeTranslation(x, 0, -4));
        f.crowd.instanceMatrix.needsUpdate = true;
        f.tracker.update(f.scene);
        const drawn = f.draw();
        expect(drawn.current).toEqual(f.crowd.instanceMatrix.array);
        expect(drawn.previous).toEqual(previous);
        expect(drawn.previous?.[12]).toBe(-1);
        f.tracker.commit(f.scene);
      }
      f.tracker.clear();
    },
  );

  it("keeps unscheduled Three history advancing after each upload", () => {
    const f = fixture(false, true, false);
    f.draw();
    for (const x of [2, 4, 3]) {
      const previous = Float32Array.from(f.crowd.instanceMatrix.array);
      f.crowd.setMatrixAt(1, new Matrix4().makeTranslation(x, 0, -4));
      f.crowd.instanceMatrix.needsUpdate = true;
      const drawn = f.draw();
      expect(drawn.current).toEqual(f.crowd.instanceMatrix.array);
      expect(drawn.previous).toEqual(previous);
    }
  });

  it("uses the colour pose written after scheduling without overwriting committed history", () => {
    const f = fixture(false);
    const initial = f.draw();
    f.tracker.commit(f.scene);
    f.tracker.update(f.scene);
    f.crowd.setMatrixAt(1, new Matrix4().makeTranslation(3, 0, -4));
    f.crowd.instanceMatrix.needsUpdate = true;
    const drawn = f.draw();
    expect(drawn.current).toEqual(f.crowd.instanceMatrix.array);
    expect(drawn.previous).toEqual(initial.current);
    f.tracker.clear();
  });

  it("allocates no history and performs no uploads on unchanged temporal-off draws", () => {
    const f = fixture(false, false);
    expect(f.previous).toBeUndefined();
    const initial = f.draw().updates;
    for (let draw = 0; draw < 4; draw += 1) expect(f.draw().updates).toBe(initial);
    f.crowd.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, -4));
    f.crowd.instanceMatrix.needsUpdate = true;
    expect(f.draw().current).toEqual(f.crowd.instanceMatrix.array);
    const changed = f.draw().updates;
    expect(changed).toBeGreaterThan(initial);
    expect(f.draw().updates).toBe(changed);
  });
});
