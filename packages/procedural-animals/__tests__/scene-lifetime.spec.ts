import {
  type BufferAttribute,
  DataTexture,
  Group,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  Scene as ThreeScene,
  Vector3,
} from "three";
import { AttributeType } from "three/src/renderers/common/Constants.js";
import Info from "three/src/renderers/common/Info.js";
import { ComputeNode, WGSLNodeBuilder, WebGPURenderer } from "three/webgpu";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Production Three managers omit public declarations. Keep these test-only shapes explicit.
const privateThree = "three/src/renderers/common/";
const { default: Attributes } = (await import(`${privateThree}Attributes.js`)) as {
  default: new (
    backend: object,
    info: Info,
  ) => { update(attribute: BufferAttribute, type: number): void };
};
const { default: Geometries } = (await import(`${privateThree}Geometries.js`)) as {
  default: new (attributes: object, info: Info) => { initGeometry(renderObject: object): void };
};
const { default: RenderObject } = (await import(`${privateThree}RenderObject.js`)) as {
  default: { prototype: { getAttributes(this: object): BufferAttribute[] } };
};

import { parseAnimalBake } from "../src/format.js";
import { encodeFixture } from "./fixture.js";

const owned = vi.hoisted(() => ({
  bodies: [] as ReturnType<typeof vi.fn>[],
  animals: [] as ReturnType<typeof vi.fn>[],
  failActor: -1,
  throwDispose: -1,
  course: vi.fn(),
  unregister: vi.fn(),
  callbacks: [] as ((dt: number) => void)[],
  drift: 0,
  readbackDispose: vi.fn(),
}));
vi.mock(
  "../../../examples/procedural-animals/node_modules/@threenative/core/dist/index.js",
  async () => ({
    Scene: (await import("../../core/src/scene.js")).Scene,
    afterPhysics: (_ctx: unknown, callback: (dt: number) => void) => {
      owned.callbacks.push(callback);
      return owned.unregister;
    },
    GPUReadback: class {
      dispose() {
        owned.readbackDispose();
      }
    },
  }),
);
vi.mock("@threenative/physics", () => ({
  CollisionShape3D: { sphere: () => ({}) },
  CharacterBody3D: class {
    velocity = new Vector3();
    dispose = vi.fn();
    constructor() {
      owned.bodies.push(this.dispose);
    }
  },
}));
vi.mock("@threenative/procedural-animals", () => ({
  loadAnimalBake: async () => parseAnimalBake(encodeFixture()),
  createAnimalActor: () => {
    const index = owned.animals.length;
    if (index === owned.failActor) throw new Error("acquire animal");
    const dispose = vi.fn(() => {
      if (index === owned.throwDispose) throw new Error("dispose animal");
    });
    owned.animals.push(dispose);
    const object = new Group();
    return {
      object,
      mesh: new Mesh(),
      follow: (state: { position: Vector3 }) => {
        object.position.copy(state.position);
        object.position.x += owned.drift;
      },
      dispose: () => {
        try {
          dispose();
        } finally {
          object.removeFromParent();
        }
      },
    };
  },
}));
vi.mock("../../../examples/procedural-animals/src/render/course.js", () => ({
  course: () => owned.course,
}));
import { Animals } from "../../../examples/procedural-animals/src/Animals.js";
import { AnimalGPUProbe } from "../../../examples/procedural-animals/src/render/gpu-probe.js";

beforeEach(() => {
  owned.bodies.length = owned.animals.length = owned.callbacks.length = 0;
  owned.drift = 0;
  owned.failActor = owned.throwDispose = -1;
  owned.course.mockReset();
  owned.unregister.mockReset();
  owned.readbackDispose.mockReset();
});
const ctx = () => {
  const scene = new ThreeScene();
  return {
    scene,
    camera: new OrthographicCamera(-64 / 3, 64 / 3, 12, -12, 0.1, 100),
    assets: {},
    physics: { directSpaceState: { intersectRay: () => ({ position: { y: 0 } }) } },
    startup: { phase: "ready" },
    state: { set: vi.fn(), getState: () => ({ visibleCaptured: false }) },
    add: (...objects: Group[]) => scene.add(...objects),
    entities: { add: vi.fn(), remove: vi.fn() },
    afterPhysics: () => owned.unregister,
  } as unknown as Parameters<Animals["enter"]>[0];
};

describe("animal qualification scene acquisition and cleanup", () => {
  it("retains a transient root error after a later completed step returns to agreement", async () => {
    const scene = new Animals("crowd");
    const context = ctx();
    await scene.load(context);
    scene.enter(context);
    try {
      const callback = owned.callbacks[0];
      if (!callback) throw new Error("missing actual scene afterPhysics callback");
      owned.drift = 0.002;
      callback(1 / 60);
      owned.drift = 0;
      callback(1 / 60);
      const patch = vi.mocked(context.state.set).mock.calls.at(-1)?.[0];
      if (typeof patch === "function") throw new Error("unexpected functional fixture patch");
      expect(patch?.rootError).toBeCloseTo(0.002, 9);
    } finally {
      scene.exit();
    }
  });
  it("releases every body and course after an actor disposer throws", async () => {
    const scene = new Animals("crowd");
    const context = ctx();
    await scene.load(context);
    scene.enter(context);
    owned.throwDispose = 31;
    expect(() => scene.exit()).toThrow();
    expect(owned.animals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(owned.bodies.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(owned.course).toHaveBeenCalledOnce();
    expect(owned.unregister).toHaveBeenCalledOnce();
    expect(context.scene.children).toHaveLength(0);
    scene.exit();
    expect(owned.bodies.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
  it("unwinds prior acquisitions and the current body when actor creation fails", async () => {
    const scene = new Animals("crowd");
    const context = ctx();
    await scene.load(context);
    owned.failActor = 2;
    expect(() => scene.enter(context)).toThrow("acquire animal");
    expect(owned.animals).toHaveLength(2);
    expect(owned.bodies).toHaveLength(3);
    expect(owned.animals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(owned.bodies.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(owned.course).toHaveBeenCalledOnce();
    expect(context.scene.children).toHaveLength(0);
  });
  it("releases later probe resources when asynchronous readback cleanup throws", () => {
    const probe = new AnimalGPUProbe(parseAnimalBake(encodeFixture()));
    const parent = new Group();
    parent.add(probe);
    const textures = vi.spyOn(DataTexture.prototype, "dispose");
    const disposeKernel = vi.spyOn(ComputeNode.prototype, "dispose");
    owned.readbackDispose.mockImplementation(() => {
      throw new Error("dispose readback");
    });
    expect(() => probe.detach()).toThrow();
    expect(disposeKernel).toHaveBeenCalledOnce();
    expect(textures).toHaveBeenCalledOnce();
    textures.mockRestore();
    expect(parent.children).toHaveLength(0);
    expect(probe.released).toBe(true);
    probe.detach();
    expect(owned.readbackDispose).toHaveBeenCalledOnce();
  });
  it("owns all five storage attributes through Three's real material and geometry lifecycle", () => {
    const probe = new AnimalGPUProbe(parseAnimalBake(encodeFixture()));
    const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    const capabilities = Reflect.get(renderer.backend, "capabilities");
    vi.spyOn(capabilities, "getUniformBufferLimit").mockReturnValue(65_536);
    // Three omits this production NodeManager accessor from its declarations.
    const builder = new WGSLNodeBuilder(probe, renderer) as unknown as {
      build(): void;
      camera: PerspectiveCamera;
      scene: ThreeScene;
      getAttributesArray(): { name: string; node?: { attribute?: BufferAttribute } }[];
    };
    builder.camera = new PerspectiveCamera();
    builder.scene = new ThreeScene();
    builder.build();
    const renderObject = {
      geometry: probe.geometry,
      attributes: null,
      getNodeBuilderState: () => ({ nodeAttributes: builder.getAttributesArray() }),
    };
    const attributes = RenderObject.prototype.getAttributes.call(renderObject as never);
    expect(
      attributes.filter((item) => Reflect.get(item, "isStorageInstancedBufferAttribute") === true),
    ).toHaveLength(5);
    const live = new Set<object>();
    const backend = {
      createStorageAttribute: (item: object) => live.add(item),
      destroyAttribute: (item: object) => live.delete(item),
    };
    const info = new Info();
    const destroyed = vi.spyOn(info, "destroyAttribute");
    const manager = new Attributes(backend as never, info as never);
    for (const item of attributes.filter(
      (item) => Reflect.get(item, "isStorageInstancedBufferAttribute") === true,
    ))
      manager.update(item, AttributeType.STORAGE);
    const geometries = new Geometries(manager, info as never);
    geometries.initGeometry({ geometry: probe.geometry, getAttributes: () => attributes } as never);
    expect(live.size).toBe(5);
    expect(info.memory.geometries).toBe(1);
    probe.detach();
    expect(live.size).toBe(0);
    expect(info.memory.geometries).toBe(0);
    expect(destroyed).toHaveBeenCalledTimes(5);
    probe.detach();
    expect(destroyed).toHaveBeenCalledTimes(5);
  });
});
