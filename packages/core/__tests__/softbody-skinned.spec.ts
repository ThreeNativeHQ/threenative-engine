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
import { describe, expect, it } from "vitest";
import type { IRendererLike } from "../src/renderer.js";
import {
  buildClothAdjacency,
  buildTethers,
  frameCarry,
  measureBodyCapsules,
  readClothMask,
  skinnedWorldPosition,
} from "../src/softbody-skinned.js";
import { SoftBody3D } from "../src/softbody.js";

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

  it("shrinks an auto capsule so the cloth's rest pose clears it by the collider thickness", () => {
    const { cape } = character();
    // A rest cloth vertex 0.1 m behind the chest axis, inside the 0.15 m measured skin.
    const capsules = measureBodyCapsules(cape, 16, [0, 1.6, -0.1], 0.01);
    expect(capsules[0]?.radius).toBeCloseTo(0.09, 4);
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
    expect(cloth.warmupNodes).toHaveLength(4);
    const dispatched: unknown[] = [];
    cloth.process(renderer(dispatched));
    expect(dispatched).toHaveLength(1 + 3 * 4);
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
});
