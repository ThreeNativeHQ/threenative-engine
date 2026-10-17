import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Skeleton,
  SkinnedMesh,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { MatrixWorldPass } from "../src/matrix-world.js";

/**
 * The engine's visible-only world-matrix walk.
 *
 * These prove the two rules the pass exists for and the two it must never break: a hidden subtree
 * is not walked and is refreshed the frame it shows, visible matrices equal three's own output,
 * and nothing whose world matrix is read while invisible — a skinned rig's bones, a camera's view
 * matrix — is left stale.
 */

function geometry(): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute(
    "position",
    new Float32BufferAttribute([-0.1, 0, 0, 0.1, 0, 0, -0.1, 2, 0, 0.1, 2, 0], 3),
  );
  result.setAttribute(
    "skinIndex",
    new Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  result.setAttribute(
    "skinWeight",
    new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  return result;
}

/** Every node whose whole ancestor chain is visible, which is the set the pass must keep exact. */
function visibleNodes(root: Object3D): Object3D[] {
  const found: Object3D[] = [];
  const stack: Object3D[] = [root];
  while (stack.length > 0) {
    const object = stack.pop() as Object3D;
    if (object.visible === false) continue;
    found.push(object);
    for (const child of object.children) stack.push(child);
  }
  return found;
}

function capture(root: Object3D): Map<Object3D, number[]> {
  const captured = new Map<Object3D, number[]>();
  for (const object of visibleNodes(root)) {
    captured.set(object, object.matrixWorld.elements.slice());
  }
  return captured;
}

/** The scene the profile measured: the visible chain, then a hidden body nothing under can draw. */
function hiddenBody(): { scene: Scene; hidden: Group; mesh: Mesh } {
  const scene = new Scene();
  const hidden = new Group();
  hidden.visible = false;
  const mesh = new Mesh(geometry(), new MeshBasicMaterial());
  const group = new Group();
  group.add(mesh);
  hidden.add(group);
  scene.add(hidden);
  return { scene, hidden, mesh };
}

describe("MatrixWorldPass", () => {
  it("does not walk a hidden subtree", () => {
    const { scene } = hiddenBody();
    const pass = new MatrixWorldPass();
    // The scene and the hidden root are visited; nothing below the hidden root is visited.
    expect(pass.apply(scene)).toBe(2);
    pass.dispose();
  });

  it("leaves a hidden root's local and world matrices untouched until it shows", () => {
    const { scene, hidden } = hiddenBody();
    hidden.position.set(1, 2, 3);
    scene.updateMatrixWorld(true);
    const local = hidden.matrix.elements.slice();
    const world = hidden.matrixWorld.elements.slice();
    const compose = vi.spyOn(hidden, "updateMatrix");
    const pass = new MatrixWorldPass();
    hidden.position.set(7, 8, 9);
    pass.apply(scene);
    pass.apply(scene);
    expect(compose).not.toHaveBeenCalled();
    expect(hidden.matrix.elements).toEqual(local);
    expect(hidden.matrixWorld.elements).toEqual(world);
    hidden.visible = true;
    pass.apply(scene);
    expect(compose).toHaveBeenCalledOnce();
    expect(hidden.matrixWorld.elements.slice(12, 15)).toEqual([7, 8, 9]);
    compose.mockRestore();
    pass.dispose();
  });

  it.each([true, false])(
    "refreshes a reparented hidden root and descendants with matrixAutoUpdate=%s",
    (matrixAutoUpdate) => {
      const { scene, hidden, mesh } = hiddenBody();
      const first = new Group();
      const next = new Group();
      first.position.set(2, 3, 4);
      next.position.set(-5, 6, 7);
      scene.add(first, next);
      first.add(hidden);
      scene.updateMatrixWorld(true);
      hidden.matrixAutoUpdate = matrixAutoUpdate;
      const pass = new MatrixWorldPass();
      pass.apply(scene);
      hidden.position.set(8, 9, 10);
      if (!matrixAutoUpdate) hidden.updateMatrix();
      mesh.position.set(0, 2, 0);
      first.position.x += 3;
      next.add(hidden);
      pass.apply(scene);
      next.position.z += 4;
      hidden.visible = true;
      pass.apply(scene);
      const actual = capture(scene);
      scene.updateMatrixWorld(true);
      expect(actual).toEqual(capture(scene));
      expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([3, 17, 21]);
      pass.dispose();
    },
  );

  it("preserves an authored world matrix when a hidden root is revealed", () => {
    const { scene, hidden, mesh } = hiddenBody();
    scene.updateMatrixWorld(true);
    hidden.matrixAutoUpdate = false;
    hidden.matrixWorldAutoUpdate = false;
    const pass = new MatrixWorldPass();
    pass.apply(scene);
    hidden.matrixWorld.makeTranslation(4, 5, 6);
    scene.position.x = 20;
    pass.apply(scene);
    hidden.visible = true;
    pass.apply(scene);
    const actual = capture(scene);
    scene.updateMatrixWorld(true);
    expect(actual).toEqual(capture(scene));
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([4, 5, 6]);
    pass.dispose();
  });

  it('walks every node in "all" mode, as three\'s own pass does', () => {
    const { scene, hidden } = hiddenBody();
    const pass = new MatrixWorldPass({ mode: "all" });
    hidden.position.set(2, 3, 4);
    expect(pass.apply(scene)).toBe(4);
    expect(hidden.matrixWorld.elements.slice(12, 15)).toEqual([2, 3, 4]);
    pass.dispose();
  });

  it("refreshes a hidden subtree the first frame it shows, after an ancestor moved", () => {
    const { scene, hidden, mesh } = hiddenBody();
    const pass = new MatrixWorldPass();
    pass.apply(scene);
    hidden.position.set(5, 2, 0);
    hidden.visible = true;
    pass.apply(scene);

    const actual = capture(scene);
    scene.updateMatrixWorld(true);
    const expected = capture(scene);
    expect(actual).toEqual(expected);
    expect(mesh.matrixWorld.elements[12]).toBeCloseTo(5);
    pass.dispose();
  });

  it("keeps visible matrices equal to three's own walk", () => {
    const scene = new Scene();
    const root = new Group();
    root.position.set(1, 2, 3);
    const outer = new Group();
    outer.position.set(-4, 0, 1);
    const inner = new Group();
    inner.position.set(0, 9, -2);
    inner.rotation.z = 0.5;
    inner.add(new Mesh(geometry(), new MeshBasicMaterial()));
    outer.add(inner);
    root.add(outer);
    scene.add(root);
    // A second hidden branch, so the walk that is compared exercises the pruning too.
    const hidden = new Group();
    hidden.visible = false;
    const parked = new Group();
    parked.add(new Mesh(geometry(), new MeshBasicMaterial()));
    hidden.add(parked);
    scene.add(hidden);

    const pass = new MatrixWorldPass();
    pass.apply(scene);
    const actual = capture(scene);
    scene.updateMatrixWorld(true);
    const expected = capture(scene);
    expect(actual).toEqual(expected);
    pass.dispose();
  });

  it("keeps a hidden skeleton's bones fresh for a visible SkinnedMesh", () => {
    const scene = new Scene();
    const armature = new Group();
    armature.visible = false;
    const hip = new Bone();
    const crown = new Bone();
    crown.position.set(0, 1, 0);
    hip.add(crown);
    armature.add(hip);
    scene.add(armature);
    const mesh = new SkinnedMesh(geometry(), new MeshBasicMaterial());
    mesh.bind(new Skeleton([hip, crown]));
    scene.add(mesh);

    const pass = new MatrixWorldPass();
    pass.apply(scene);
    hip.position.set(3, 0, 0);
    pass.apply(scene);

    expect(hip.matrixWorld.elements[12]).toBeCloseTo(3);
    // The SkinnedMesh's own override ran, so its bind inverse tracks its world matrix.
    const expectedInverse = mesh.matrixWorld.clone().invert().elements.slice();
    expect(mesh.bindMatrixInverse.elements).toEqual(expectedInverse);
    const actual = capture(scene);
    scene.updateMatrixWorld(true);
    expect(actual).toEqual(capture(scene));
    pass.dispose();
  });

  it("gives a camera in the scene a fresh matrixWorldInverse", () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.visible = false;
    scene.add(camera);
    const pass = new MatrixWorldPass();
    pass.apply(scene);
    scene.position.set(0, 4, 0);
    pass.apply(scene);

    const expected = camera.matrixWorld.clone().invert();
    expect(camera.matrixWorldInverse.elements).toEqual(expected.elements);
    pass.dispose();
  });

  it("runs the updateMatrixWorld a class overrides", () => {
    let calls = 0;
    class Custom extends Mesh {
      override updateMatrixWorld(force = false): void {
        calls += 1;
        super.updateMatrixWorld(force);
      }
    }
    const scene = new Scene();
    const object = new Custom(geometry(), new MeshBasicMaterial());
    object.visible = false;
    scene.add(object);
    const pass = new MatrixWorldPass();
    pass.apply(scene);
    expect(calls).toBe(1);
    pass.dispose();
  });

  it("reports the visited count for the frame, both ways", () => {
    const { scene } = hiddenBody();
    const visible = new MatrixWorldPass();
    visible.beginFrame();
    visible.apply(scene);
    expect(visible.report).toEqual({ schemaVersion: 1, mode: "visible", visited: 2 });

    const all = new MatrixWorldPass({ mode: "all" });
    all.beginFrame();
    all.apply(scene);
    expect(all.report).toEqual({ schemaVersion: 1, mode: "all", visited: 4 });
    visible.dispose();
    all.dispose();
  });
});
