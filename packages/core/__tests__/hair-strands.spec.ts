import { Bone, Group, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { HairStrands3D } from "../src/hair-strands.js";
import type { IRendererLike } from "../src/renderer.js";
import { WindField3D } from "../src/wind-field.js";

function renderer(dispatched: unknown[]): IRendererLike {
  return {
    compileAsync: async () => undefined,
    compute: (node: unknown) => dispatched.push(node),
    dispose: () => undefined,
    domElement: new EventTarget() as HTMLCanvasElement,
    gpuFrameMs: () => undefined,
    info: {},
    kind: "webgpu",
  } as unknown as IRendererLike;
}

/** A head bone at 1.7 m and two 8-point guides hanging 0.28 m behind it. */
function head() {
  const scene = new Scene();
  const root = new Group();
  const bone = new Bone();
  bone.position.set(0, 1.7, 0);
  root.add(bone);
  scene.add(root);
  root.updateMatrixWorld(true);
  const guides = new Float32Array(2 * 8 * 3);
  for (let s = 0; s < 2; s++)
    for (let p = 0; p < 8; p++) guides.set([s * 0.05, 1.8 - p * 0.04, -0.1], (s * 8 + p) * 3);
  return { scene, root, bone, guides };
}

describe("HairStrands3D", () => {
  it("measures rest lengths from the guides and resets, then dispatches one step per substep", () => {
    const { scene, bone, guides } = head();
    const hair = new HairStrands3D(guides, { pointsPerStrand: 8, bone });
    scene.add(hair);
    expect(hair.strandCount).toBe(2);
    expect(hair.restLengths[0]).toBeCloseTo(0.04);
    expect(hair.restLengths[7]).toBe(0);
    expect(hair.debug()).toMatchObject({ substeps: 5, iterations: 5, windFromScene: true });
    const dispatched: unknown[] = [];
    hair.process(renderer(dispatched));
    expect(dispatched).toEqual([hair.warmupNodes[1], ...Array(5).fill(hair.warmupNodes[0])]);
    dispatched.length = 0;
    hair.process(renderer(dispatched));
    expect(dispatched).toHaveLength(5);
    expect(hair.debug().resets).toBe(1);
  });

  it("restarts from the rest shape when the head jumps past Unreal's 50 cm teleport distance", () => {
    const { scene, root, bone, guides } = head();
    const hair = new HairStrands3D(guides, { pointsPerStrand: 8, bone, substeps: 1 });
    scene.add(hair);
    const dispatched: unknown[] = [];
    hair.process(renderer(dispatched));
    root.position.x = 0.3;
    hair.process(renderer(dispatched));
    expect(hair.debug().resets).toBe(1);
    root.position.x = 1.2;
    hair.process(renderer(dispatched));
    expect(hair.debug().resets).toBe(2);
  });

  it("reads the scene's WindField3D every step, and an explicit wind overrides it", () => {
    const { scene, bone, guides } = head();
    scene.add(new WindField3D([4, 0, 0]));
    const hair = new HairStrands3D(guides, { pointsPerStrand: 8, bone });
    scene.add(hair);
    hair.process(renderer([]));
    expect(hair.wind.toArray()).toEqual([4, 0, 0]);
    const fixed = new HairStrands3D(guides, {
      pointsPerStrand: 8,
      bone,
      wind: new Vector3(0, 0, 1),
    });
    scene.add(fixed);
    fixed.process(renderer([]));
    expect(fixed.wind.toArray()).toEqual([0, 0, 1]);
  });

  it("builds a multi-copy readback for a probe and takes nothing before a sample lands", () => {
    const { bone, guides } = head();
    const hair = new HairStrands3D(guides, {
      pointsPerStrand: 8,
      bone,
      readbackEveryFrames: 1,
      readbackInFlight: 3,
    });
    expect(hair.takeSamples()).toStrictEqual([]);
  });

  it("fails closed on a ragged guide array, a zero-length segment, too many colliders or a nested parent", () => {
    const { scene, root, bone, guides } = head();
    expect(() => new HairStrands3D(guides.subarray(3), { pointsPerStrand: 8, bone })).toThrow(
      /multiple of 24/,
    );
    const flat = guides.slice();
    flat.set(flat.subarray(0, 3), 3);
    expect(() => new HairStrands3D(flat, { pointsPerStrand: 8, bone })).toThrow(/zero length/);
    const colliders = Array.from({ length: 9 }, () => ({
      bone,
      end: new Vector3(0, 0.1, 0),
      radius: 0.1,
    }));
    expect(() => new HairStrands3D(guides, { pointsPerStrand: 8, bone, colliders })).toThrow(
      /at most 8/,
    );
    const hair = new HairStrands3D(guides, { pointsPerStrand: 8, bone });
    root.add(hair);
    expect(() => hair.process(renderer([]))).toThrow(/scene root/);
    void scene;
  });
});
