import { Matrix4, PerspectiveCamera } from "three";
import { describe, expect, it, vi } from "vitest";
import {
  PLACEMENT_ROWS,
  SOURCE_FLOOR,
  STORAGE_WORDS,
  WorldGpuScene,
} from "../src/world-gpu-scene.js";

/**
 * The source buffer as the cull kernels bind it.
 *
 * One placement is 24 words whatever shape the kernel reads them in, but the owned engine refuses a
 * struct-typed storage element: the native facade refuses `storage(attr, <struct>, n)` outright and
 * the engine's IR has no struct element type to lower. So the kernels read the same words as
 * `PLACEMENT_ROWS` consecutive `vec4` rows, and the two facts that must hold are the ones this file
 * holds them to: no binding names a struct, and every binding's element count is exactly what was
 * allocated — a binding over its buffer is a refused pipeline, not a wrong picture.
 */

interface IBinding {
  readonly attribute: { readonly array: { length: number }; readonly count: number };
  readonly type: unknown;
  readonly count: number;
}

const recorded = vi.hoisted(() => ({ bindings: [] as IBinding[] }));

// Every `storage(...)` a kernel binds is recorded, then delegated unchanged: what is asserted is the
// pair both back ends see, not a reimplementation of it.
vi.mock("three/tsl", async (importOriginal) => {
  const tsl = await importOriginal<typeof import("three/tsl")>();
  return {
    ...tsl,
    storage: (attribute: unknown, type: unknown, count: number, ...rest: unknown[]) => {
      recorded.bindings.push({ attribute: attribute as IBinding["attribute"], count, type });
      return (tsl.storage as (...args: unknown[]) => unknown)(attribute, type, count, ...rest);
    },
  };
});

const LOCAL = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A scene with its gate table registered, and a camera and renderer that record their dispatches. */
function harness(): {
  camera: PerspectiveCamera;
  compute: () => { count: number }[];
  renderer: unknown;
  scene: WorldGpuScene;
} {
  const scene = new WorldGpuScene();
  // `slot` is what allocates the buffers: a placement needs one before it has anywhere to land.
  scene.slot("pine", { cull: 100, distances: [0, 10], levels: [{ firstKey: 0, parts: 1 }] });
  const camera = new PerspectiveCamera(60, 1, 0.1, 10_000);
  camera.lookAt(0, 0, 1);
  camera.updateMatrixWorld(true);
  const submitted: { count: number }[] = [];
  const renderer = {
    compute: (node: unknown): void => {
      submitted.push(...((Array.isArray(node) ? node : [node]) as { count: number }[]));
    },
    kind: "webgpu",
    log: (): void => {},
    raw: { backend: { hasFeature: (): boolean => true } },
  };
  expect(scene.enable(renderer as never, true)).toBe(true);
  return { camera, compute: () => submitted, renderer, scene };
}

/** The bindings of the one buffer the scene allocated at `bytes`: the source, at these sizes. */
function bindingsOf(bytes: number): IBinding[] {
  return recorded.bindings.filter((one) => one.attribute.array.length * 4 === bytes);
}

describe("the cull kernels bind the source buffer as vec4 rows", () => {
  it("declares no struct element, and one element per allocated row", () => {
    recorded.bindings.length = 0;
    const { camera, renderer, scene } = harness();
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);
    scene.place(0, new Matrix4().makeTranslation(1, 0, 8), 1, 0, 8, 0.5);
    scene.dispatch(renderer as never, camera);

    // Nothing a kernel binds is a struct: every element type is a name the engine can lower. The
    // element size times the bound count is the allocation, exactly — a count past it is a binding
    // larger than its buffer, which the device refuses with the dispatch left unrun.
    expect(recorded.bindings.length).toBeGreaterThan(0);
    for (const binding of recorded.bindings) {
      expect(typeof binding.type, `element type ${String(binding.type)}`).toBe("string");
      expect(
        STORAGE_WORDS[binding.type as keyof typeof STORAGE_WORDS] * binding.count,
        `${String(binding.type)} binding over its buffer`,
      ).toBe(binding.attribute.array.length);
    }

    const source = scene.footprint().source as { bytes: number; count: number; type: string };
    expect(source.type).toBe("vec4");
    // Six rows per placement: the floor of sixteen placements is 96 rows and 1536 bytes, the same
    // 24 words per record the CPU `Float32Array` is written in.
    expect(source.count).toBe(SOURCE_FLOOR * PLACEMENT_ROWS);
    expect(source.bytes).toBe(SOURCE_FLOOR * PLACEMENT_ROWS * 16);

    const bound = bindingsOf(source.bytes);
    expect(bound).toHaveLength(1);
    expect(bound[0]?.type).toBe("vec4");
    expect(bound[0]?.count).toBe(source.count);
    expect(bound[0]?.count).toBe(bound[0]?.attribute.count);
    scene.dispose();
  });

  it("keeps the bound count on the allocation when the source grows past the floor", () => {
    recorded.bindings.length = 0;
    const { camera, renderer, scene } = harness();
    // One placement past the floor of sixteen doubles the buffer: 32 slots, 192 rows.
    for (let index = 0; index < SOURCE_FLOOR + 1; index += 1)
      scene.place(0, new Matrix4().makeTranslation(0, 0, index + 1), 0, 0, index + 1, 0.5);
    const source = scene.footprint().source as { bytes: number; count: number };
    expect(source.count).toBe(2 * SOURCE_FLOOR * PLACEMENT_ROWS);
    expect(source.count % PLACEMENT_ROWS).toBe(0);
    scene.dispatch(renderer as never, camera);

    const bound = bindingsOf(source.bytes);
    expect(bound).toHaveLength(1);
    expect(bound[0]?.count).toBe(source.count);
    scene.dispose();
  });

  it("dispatches one thread per placement record, not per row", () => {
    recorded.bindings.length = 0;
    const { camera, compute, renderer, scene } = harness();
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);
    scene.dispatch(renderer as never, camera);
    const source = scene.footprint().source as { count: number };
    const [clear, cull] = compute();
    // `[clear, cull]`: the clear is one thread per key, the cull one per placement record. A count
    // of the row count would have the cull read the buffer six rows at a time from nowhere.
    expect(clear?.count).toBe(1);
    expect(cull?.count).toBe(source.count / PLACEMENT_ROWS);
    scene.dispose();
  });
});
