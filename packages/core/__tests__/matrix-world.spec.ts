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
import { describe, expect, it } from "vitest";
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
    // The scene and the hidden node itself — its own matrix is composed — and nothing below it.
    expect(pass.apply(scene)).toBe(2);
    pass.dispose();
  });

  it('walks every node in "all" mode, as three\'s own pass does', () => {
    const { scene } = hiddenBody();
    const pass = new MatrixWorldPass({ mode: "all" });
    expect(pass.apply(scene)).toBe(4);
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

/**
 * A scene of `count` groups whose `children` reads are counted: each read stands for the bridge crossing it costs
 * on the native engine, where the pass would otherwise make a handful per node.
 */
function countedScene(count: number): { reads: () => number; scene: Scene } {
  let reads = 0;
  const scene = new Scene();
  const nodes: Object3D[] = [scene];
  for (let index = 0; index < count; index += 1) {
    const group = new Group();
    scene.add(group);
    nodes.push(group);
  }
  for (const node of nodes) {
    const children = node.children;
    Object.defineProperty(node, "children", {
      configurable: true,
      get() {
        reads += 1;
        return children;
      },
    });
  }
  return { reads: () => reads, scene };
}

describe("MatrixWorldPass on a native-engine root", () => {
  it("walks the scene itself without a native walk, so reads grow with the node count", () => {
    const small = countedScene(100);
    const large = countedScene(1000);
    new MatrixWorldPass().apply(small.scene);
    new MatrixWorldPass().apply(large.scene);
    expect(small.reads()).toBeGreaterThanOrEqual(100);
    expect(large.reads()).toBeGreaterThanOrEqual(1000);
  });

  it("calls the root's native walk once and reads nothing, whatever the node count", () => {
    for (const count of [100, 1000]) {
      const { reads, scene } = countedScene(count);
      const calls: [boolean, boolean][] = [];
      (
        scene as Scene & { __tnUpdateMatrixWorld: (force: boolean, prune: boolean) => number }
      ).__tnUpdateMatrixWorld = (force, prune) => {
        calls.push([force, prune]);
        return count + 1;
      };
      const pass = new MatrixWorldPass();
      pass.beginFrame();
      expect(pass.apply(scene)).toBe(count + 1);
      expect(pass.apply(scene, true)).toBe(count + 1);
      expect(calls).toEqual([
        [false, true],
        [true, true],
      ]);
      expect(reads()).toBe(0);
      expect(pass.report.visited).toBe(2 * (count + 1));
      pass.dispose();
    }
  });

  it('uses the native walk in "all" mode too, asking it not to prune', () => {
    const { reads, scene } = countedScene(10);
    const prunes: boolean[] = [];
    (
      scene as Scene & { __tnUpdateMatrixWorld: (force: boolean, prune: boolean) => number }
    ).__tnUpdateMatrixWorld = (_force, prune) => {
      prunes.push(prune);
      return 11;
    };
    const pass = new MatrixWorldPass({ mode: "all" });
    expect(pass.apply(scene)).toBe(11);
    expect(prunes).toEqual([false]);
    expect(reads()).toBe(0);
    pass.dispose();
  });
});
