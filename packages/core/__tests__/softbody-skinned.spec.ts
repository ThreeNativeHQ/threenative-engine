import {
  Bone,
  BufferAttribute,
  type BufferGeometry,
  CylinderGeometry,
  Group,
  PlaneGeometry,
  Quaternion,
  Scene,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import type { IRendererLike } from "../src/renderer.js";
import {
  MAX_BODY_CAPSULES,
  buildClothAdjacency,
  buildTethers,
  createSkinnedCloth,
  fitCapsule,
  frameCarry,
  measureBodyCapsules,
  readClothMask,
  skinnedWorldPosition,
} from "../src/softbody-skinned.js";
import { SoftBody3D, buildClothTopology } from "../src/softbody.js";
import { WindField3D } from "../src/wind-field.js";
import { mannequinBindPose } from "./mannequin-bind-pose.js";

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

/** A renderer whose first readback lands `sample`, then never lands another copy. */
function samplingRenderer(sample: () => ArrayBuffer): IRendererLike {
  let calls = 0;
  return {
    ...(renderer([]) as unknown as Record<string, unknown>),
    readback: () => {
      const bytes = calls++ === 0 ? sample() : undefined;
      return bytes === undefined ? new Promise<ArrayBuffer>(() => {}) : Promise.resolve(bytes);
    },
  } as unknown as IRendererLike;
}

/** The cloth's rest sample in unique-vertex order, with vertex 0 pushed up by `stretch` metres. */
function stretchedCape(cape: SkinnedMesh, stretch: number): Float32Array<ArrayBuffer> {
  const sample = new Float32Array(buildClothTopology(cape.geometry, { pinned: [0] }).positions);
  sample[1] = (sample[1] as number) + stretch;
  return sample;
}

function skin(geometry: BufferGeometry, boneIndex: number): BufferGeometry {
  const count = geometry.getAttribute("position").count;
  const index = new Uint16Array(count * 4);
  const weight = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    index[v * 4] = boneIndex;
    weight[v * 4] = 1;
  }
  geometry.setAttribute("skinIndex", new BufferAttribute(index, 4));
  geometry.setAttribute("skinWeight", new BufferAttribute(weight, 4));
  return geometry;
}

/** A 1.8 m character: hips -> chest -> head, a cylinder body on the chest bone, and a cape. */
function character() {
  const hips = new Bone();
  hips.position.set(0, 1, 0);
  const chest = new Bone();
  chest.position.set(0, 0.4, 0);
  const head = new Bone();
  head.position.set(0, 0.4, 0);
  hips.add(chest);
  chest.add(head);
  const root = new Group();
  root.add(hips);
  const scene = new Scene();
  scene.add(root);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton([hips, chest, head]);
  const bodyGeometry = skin(new CylinderGeometry(0.15, 0.15, 0.4, 24, 6).translate(0, 1.6, 0), 1);
  const body = new SkinnedMesh(bodyGeometry, new MeshStandardNodeMaterial());
  root.add(body);
  body.bind(skeleton);
  const capeGeometry = skin(new PlaneGeometry(0.5, 0.8, 4, 6).translate(0, 1.4, -0.25), 1);
  const colour = new Float32Array(capeGeometry.getAttribute("position").count * 3);
  const position = capeGeometry.getAttribute("position");
  for (let v = 0; v < position.count; v++) colour[v * 3] = position.getY(v) > 1.79 ? 1 : 0;
  capeGeometry.setAttribute("color", new BufferAttribute(colour, 3));
  const cape = new SkinnedMesh(capeGeometry, new MeshStandardNodeMaterial());
  root.add(cape);
  cape.bind(skeleton);
  root.updateMatrixWorld(true);
  return { scene, root, hips, chest, cape };
}

describe("skinned SoftBody3D helpers", () => {
  it("builds stretch edges and one bend pair across a shared edge", () => {
    // Quad 0-1-2-3 split along 0-2: triangles (0,1,2) and (0,2,3); bend pair 1-3.
    const unique = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const { neighbors, counts, maxNeighbors } = buildClothAdjacency(
      unique,
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    );
    const rest = (v: number) =>
      Array.from(
        { length: counts[v] as number },
        (_, s) => neighbors[(v * maxNeighbors + s) * 2 + 1] as number,
      );
    expect([...counts]).toEqual([3, 3, 3, 3]);
    expect(rest(1).filter((r) => r < 0)).toHaveLength(1);
    expect(rest(1).find((r) => r < 0)).toBeCloseTo(-Math.SQRT2, 6);
    expect(rest(0).every((r) => r > 0)).toBe(true);
  });

  it("tethers each vertex to its nearest pin by geodesic distance", () => {
    const unique = new Float32Array([0, 0, 0, 0, -1, 0, 0, -3, 0]);
    const edges = new Map([
      [0, [1]],
      [1, [0, 2]],
      [2, [1]],
    ]);
    const { anchor, distance } = buildTethers(unique, edges, (v) => v === 0);
    expect([...anchor]).toEqual([0, 0, 0]);
    expect([...distance]).toEqual([0, 1, 3]);
  });

  it("reads the mask from a colour channel or an array and fails closed on a missing channel", () => {
    const plane = new PlaneGeometry(1, 1, 1, 1);
    expect(readClothMask(plane, [1, 1, 0, 0], () => false).mask).toEqual(
      new Float32Array([1, 1, 0, 0]),
    );
    expect(() => readClothMask(plane, "color.g", () => false)).toThrow(/no color attribute/);
    expect(readClothMask(plane, undefined, (v) => v > 1)).toMatchObject({ chosen: "leaf-bones" });
    plane.setAttribute(
      "color",
      new BufferAttribute(new Float32Array([1, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0]), 3),
    );
    expect(readClothMask(plane, undefined, () => false).mask).toEqual(
      new Float32Array([1, 0.5, 0, 0]),
    );
  });

  it("carries a quarter of the reference motion with Unreal's 0.75 scales, all of it on a teleport", () => {
    const out = { rotation: new Quaternion(), translation: new Vector3() };
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1);
    frameCarry(new Vector3(), new Quaternion(), new Vector3(4, 0, 0), turn, 0.75, 0.75, out);
    expect(out.translation.x).toBeCloseTo(1);
    expect(out.rotation.angleTo(new Quaternion())).toBeCloseTo(0.25);
    frameCarry(new Vector3(), new Quaternion(), new Vector3(4, 0, 0), turn, 0, 0, out);
    expect(out.translation.x).toBeCloseTo(4);
    expect(out.rotation.angleTo(turn)).toBeCloseTo(0);
  });

  it("measures a body capsule from the skin: a 0.15 m cylinder gives a 0.15 m capsule", () => {
    const { cape, chest } = character();
    const capsules = measureBodyCapsules(cape);
    expect(capsules).toHaveLength(1);
    expect(capsules[0]?.bone).toBe(chest);
    expect(capsules[0]?.radius).toBeCloseTo(0.15, 2);
  });

  it("merges a bone smaller than Unreal's 20 cm MinBoneSize into its parent, as fingers into a hand", () => {
    const { root, chest, cape } = character();
    const hand = new Bone();
    hand.position.set(0.4, 0, 0);
    chest.add(hand);
    const finger = new Bone();
    finger.position.set(0.15, 0, 0);
    hand.add(finger);
    root.updateMatrixWorld(true);
    const skeleton = new Skeleton([...cape.skeleton.bones, hand, finger]);
    const parts = [
      skin(new CylinderGeometry(0.15, 0.15, 0.4, 24, 6).translate(0, 1.6, 0), 1),
      skin(
        new CylinderGeometry(0.05, 0.05, 0.3, 12, 4).rotateZ(Math.PI / 2).translate(0.55, 1.4, 0),
        3,
      ),
      skin(
        new CylinderGeometry(0.01, 0.01, 0.06, 8, 2).rotateZ(Math.PI / 2).translate(0.75, 1.4, 0),
        4,
      ),
    ];
    for (const geometry of parts) {
      const mesh = new SkinnedMesh(geometry, new MeshStandardNodeMaterial());
      root.add(mesh);
      mesh.bind(skeleton);
    }
    cape.bind(skeleton);
    root.updateMatrixWorld(true);
    const bones = measureBodyCapsules(cape).map((capsule) => capsule.bone);
    expect(bones).toContain(hand);
    expect(bones).not.toContain(finger);
  });

  it("fits Unreal's auto capsule: along the skin's long axis, enclosing it, past the child joint", () => {
    // A 0.6 m arm of radius 0.05 skinned to one bone whose child joint sits 0.1 m out: the capsule
    // follows the skin, not the bone-to-child segment (PhysicsAssetUtils.cpp:944-965).
    const points: Vector3[] = [];
    for (let i = 0; i <= 12; i++)
      for (let k = 0; k < 8; k++) {
        const angle = (k / 8) * Math.PI * 2;
        points.push(new Vector3(i * 0.05, 1.4 + Math.cos(angle) * 0.05, Math.sin(angle) * 0.05));
      }
    const fit = fitCapsule(points);
    expect(fit.radius).toBeCloseTo(0.0505, 3);
    expect(Math.abs(fit.end.x - fit.start.x)).toBeCloseTo(0.303, 3);
    expect((fit.end.x + fit.start.x) / 2).toBeCloseTo(0.3, 3);
    expect(fit.start.y).toBeCloseTo(1.4, 3);
  });

  it("shrinks an auto capsule so the cloth's rest pose clears it by the collider thickness", () => {
    const { cape } = character();
    // A rest cloth vertex 0.1 m behind the chest axis, inside the 0.15 m measured skin.
    const capsules = measureBodyCapsules(cape, 16, [0, 1.6, -0.1], 0.01);
    expect(capsules[0]?.radius).toBeCloseTo(0.09, 4);
  });
});

describe("body capsules on the real mannequin", () => {
  it("measures the bind pose's capsules from the skin: torso, pelvis, thighs and upperarms, no fingers or toes", async () => {
    const { cape } = await mannequinBindPose();
    const capsules = measureBodyCapsules(cape());
    const measured = capsules.map((capsule) => `${capsule.bone.name}:${capsule.radius.toFixed(3)}`);
    console.info(`TN_SOFTBODY_AUTO_CAPSULES:${JSON.stringify(measured)}`);
    const bones = capsules.map((capsule) => capsule.bone.name);
    expect(bones).toContain("pelvis");
    expect(bones.some((name) => name === "spine_03" || name === "spine_02")).toBe(true);
    expect(bones).toEqual(
      expect.arrayContaining(["thigh_l", "thigh_r", "upperarm_l", "upperarm_r"]),
    );
    expect(bones.filter((name) => /(index|middle|pinky|ring|thumb|ball)/.test(name))).toEqual([]);
    for (const capsule of capsules) {
      expect(Number.isFinite(capsule.radius)).toBe(true);
      expect(capsule.radius).toBeGreaterThan(0.02);
      expect(capsule.radius).toBeLessThan(0.3);
    }
    expect(capsules.length).toBeGreaterThan(0);
    expect(capsules.length).toBeLessThanOrEqual(MAX_BODY_CAPSULES);
  });

  it("replaces the measured capsules with an explicit bodyColliders array, and turns them off with false", async () => {
    const { cape, spine } = await mannequinBindPose();
    const source = cape();
    const measured = measureBodyCapsules(source);
    expect(measured.length).toBeGreaterThan(1);
    const explicit = { bone: spine, end: new Vector3(0, 0.2, 0), radius: 0.42 };
    const override = createSkinnedCloth(source, { bodyColliders: [explicit] });
    expect(override.capsules).toHaveLength(1);
    expect(override.capsules[0]).toBe(explicit);
    const replaced = new SoftBody3D(source, { bodyColliders: [explicit] });
    expect(replaced.debug().bodyCapsules).toBe(1);
    const auto = new SoftBody3D(source, {});
    expect(auto.debug().bodyCapsules).toBe(measured.length);
    const off = new SoftBody3D(source, { bodyColliders: false });
    expect(off.debug().bodyCapsules).toBe(0);
  });
});

describe("skinnedWorldPosition", () => {
  it("matches three's applyBoneTransform on a posed skeleton", () => {
    const { cape, chest, root } = character();
    chest.rotation.set(0.4, 0.3, -0.2);
    root.position.set(1, 0, 2);
    root.updateMatrixWorld(true);
    cape.skeleton.update();
    for (const v of [0, 7, 20]) {
      // SkinnedMesh.getVertexPosition already skins; applyBoneTransform takes the raw position.
      const raw = new Vector3().fromBufferAttribute(cape.geometry.getAttribute("position"), v);
      const expected = cape.applyBoneTransform(v, raw).applyMatrix4(cape.matrixWorld);
      expect(skinnedWorldPosition(cape, v, new Vector3()).distanceTo(expected)).toBeLessThan(1e-6);
    }
  });
});

describe("SoftBody3D on a SkinnedMesh", () => {
  it("simulates in world space with auto capsules, hides the source and dispatches carry plus three passes per substep", () => {
    const { scene, cape } = character();
    const cloth = new SoftBody3D(cape, { substeps: 4 });
    scene.add(cloth);
    expect(cape.visible).toBe(false);
    expect(cloth.debug()).toMatchObject({
      skinned: true,
      maskSource: "color.r",
      bodyCapsules: 1,
      substeps: 4,
    });
    expect(cloth.warmupNodes).toHaveLength(5);
    const dispatched: unknown[] = [];
    cloth.process(renderer(dispatched));
    // One compute call per substep, so the renderer uploads uniforms 4 times, not 13.
    expect(dispatched).toHaveLength(4);
    expect(dispatched.flat()).toHaveLength(1 + 3 * 4);
  });

  it("adds two ping-pong passes per substep for each extra pair of iterations, and rejects an odd count", () => {
    const { scene, cape } = character();
    const cloth = new SoftBody3D(cape, { substeps: 4, iterations: 4 });
    scene.add(cloth);
    const dispatched: unknown[] = [];
    cloth.process(renderer(dispatched));
    expect(dispatched).toHaveLength(4);
    expect(dispatched.flat()).toHaveLength(1 + 5 * 4);
    expect(() => new SoftBody3D(character().cape, { iterations: 3 })).toThrow(/even/);
  });

  it("reports a teleport when the reference bone jumps past the auto distance, and a manual reset", () => {
    const { scene, root, cape } = character();
    const cloth = new SoftBody3D(cape, { bodyColliders: false });
    scene.add(cloth);
    const r = renderer([]);
    cloth.process(r);
    root.position.x += 8;
    root.updateMatrixWorld(true);
    cloth.process(r);
    expect(cloth.lastReset).toBe("teleport");
    cloth.reset();
    cloth.process(r);
    expect(cloth.lastReset).toBe("manual");
  });

  it("reads the scene's WindField3D every step, and an explicit wind option overrides it", () => {
    const { scene, cape } = character();
    const field = new WindField3D([4, 0, 1]);
    scene.add(field);
    const cloth = new SoftBody3D(cape, { bodyColliders: false });
    scene.add(cloth);
    cloth.process(renderer([]));
    expect(cloth.wind.toArray()).toEqual([4, 0, 1]);
    field.velocity.set(-2, 0, 0);
    cloth.process(renderer([]));
    expect(cloth.wind.toArray()).toEqual([-2, 0, 0]);
    const fixed = new SoftBody3D(character().cape, { bodyColliders: false, wind: [1, 0, 0] });
    scene.add(fixed);
    fixed.process(renderer([]));
    expect(fixed.wind.toArray()).toEqual([1, 0, 0]);
  });

  it("brings the pin bones to this step's pose before skinning the pins", () => {
    const { scene, root, chest, cape } = character();
    const cloth = new SoftBody3D(cape, { bodyColliders: false });
    scene.add(cloth);
    cloth.process(renderer([]));
    root.position.x += 0.5; // moved by the game, not yet drawn: chest.matrixWorld is stale
    cloth.process(renderer([]));
    expect(chest.matrixWorld.elements[12]).toBeCloseTo(0.5);
  });

  it("fails closed when nothing pins the cloth or when it is not at the scene root", () => {
    const { scene, root, cape } = character();
    expect(() => new SoftBody3D(cape, { cloth: new Array(35).fill(0) })).toThrow(
      /no vertex with mask 1/,
    );
    const cloth = new SoftBody3D(cape, {});
    root.add(cloth);
    expect(() => cloth.process(renderer([]))).toThrow(/scene root/);
    void scene;
  });

  it("ignores a stretched readback sample when extremeDeformationEdgeRatio is off", async () => {
    const { scene, cape } = character();
    const cloth = new SoftBody3D(cape, { bodyColliders: false, readbackEveryFrames: 1 });
    scene.add(cloth);
    const r = samplingRenderer(() => stretchedCape(cape, 100).buffer);
    cloth.process(r);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cloth.process(r);
    expect(cloth.lastReset).toBeUndefined();
    expect(cloth.debug().resets).toBe(0);
  });

  it("resets to the rest pose when an edge stretches past the ratio, once per landed sample", async () => {
    const { scene, cape } = character();
    const cloth = new SoftBody3D(cape, {
      bodyColliders: false,
      extremeDeformationEdgeRatio: 2,
      readbackEveryFrames: 1,
    });
    scene.add(cloth);
    const r = samplingRenderer(() => stretchedCape(cape, 100).buffer);
    const logs: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      cloth.process(r);
      await new Promise((resolve) => setTimeout(resolve, 0));
      cloth.process(r);
    } finally {
      info.mockRestore();
    }
    expect(cloth.lastReset).toBe("extremeDeformation");
    expect(cloth.debug().resets).toBe(1);
    expect(
      logs.some((line) =>
        /^TN_SOFTBODY_RESET cause=extremeDeformation ratio=\d+\.\d{3} threshold=2$/.test(line),
      ),
    ).toBe(true);
    cloth.process(r);
    expect(cloth.debug().resets).toBe(1);
  });

  it("keeps a rest-pose sample: every edge reads its rest length in the readback's vertex order", async () => {
    const { scene, cape } = character();
    const cloth = new SoftBody3D(cape, {
      bodyColliders: false,
      extremeDeformationEdgeRatio: 1.01,
      readbackEveryFrames: 1,
    });
    scene.add(cloth);
    const r = samplingRenderer(() => stretchedCape(cape, 0).buffer);
    cloth.process(r);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cloth.process(r);
    expect(cloth.lastReset).toBeUndefined();
    expect(cloth.debug().resets).toBe(0);
  });

  it("fails closed on a ratio at or below 1, a non-finite ratio, or no readback", () => {
    expect(
      () =>
        new SoftBody3D(character().cape, {
          extremeDeformationEdgeRatio: 1,
          readbackEveryFrames: 1,
        }),
    ).toThrow(/greater than 1/);
    expect(
      () =>
        new SoftBody3D(character().cape, {
          extremeDeformationEdgeRatio: Number.NaN,
          readbackEveryFrames: 1,
        }),
    ).toThrow(/finite number/);
    expect(() => new SoftBody3D(character().cape, { extremeDeformationEdgeRatio: 2 })).toThrow(
      /readbackEveryFrames/,
    );
  });
});
