import { BufferGeometry, Group, Mesh, MeshBasicMaterial, type Object3D, Scene } from "three";
import { afterEach, describe, expect, it } from "vitest";
import { MatrixWorldPass } from "../src/matrix-world.js";
import {
  invalidateStatic,
  markStatic,
  refreshStaticTransforms,
  resetStaticTransforms,
} from "../src/static-transform.js";

afterEach(() => {
  resetStaticTransforms();
});

/** A batch the engine placed once: `depth` levels of three children under a root at a fixed place. */
function batch(depth: number): { scene: Scene; root: Group; objects: number } {
  const scene = new Scene();
  const root = new Group();
  root.name = "batch";
  root.position.set(3, 0, -7);
  scene.add(root);
  let objects = 1;
  let frontier: Object3D[] = [root];
  for (let level = 0; level < depth; level += 1) {
    const next: Object3D[] = [];
    for (const parent of frontier) {
      for (let index = 0; index < 3; index += 1) {
        const child = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
        child.position.set(index, level, 0);
        parent.add(child);
        objects += 1;
        next.push(child);
      }
    }
    frontier = next;
  }
  return { objects, root, scene };
}

describe("the world-matrix walk over a frozen batch", () => {
  it("does not visit the batch's subtree again after it is placed", () => {
    const { objects, root, scene } = batch(3);
    const pass = new MatrixWorldPass();
    pass.apply(scene);
    const unvisited = pass.report.visited;

    markStatic(root);
    pass.beginFrame();
    pass.apply(scene);
    const frozen = pass.report.visited;

    // The root still composes, so the frame that places it is the frame that pays for it. What the
    // freeze buys is the frames after it: the scene and the batch root, and nothing below the root.
    expect(unvisited).toBe(objects + 1);
    expect(frozen).toBe(2);
  });

  it("gives a re-placed batch its new world matrix", () => {
    const { root, scene } = batch(2);
    const leaf = root.children[0] as Mesh;
    markStatic(root);
    const pass = new MatrixWorldPass();
    pass.apply(scene);
    const before = leaf.matrixWorld.elements[13] as number;

    root.position.set(0, 5, 0);
    refreshStaticTransforms();
    pass.beginFrame();
    pass.apply(scene);

    expect(leaf.matrixWorld.elements[13]).not.toBe(before);
    expect(leaf.matrixWorld.elements[13]).toBe(5);
  });

  it("gives a batch whose subtree was written to its new world matrix", () => {
    const { root, scene } = batch(2);
    const leaf = root.children[0] as Mesh;
    markStatic(root);
    const pass = new MatrixWorldPass();
    pass.apply(scene);

    // The announced way to move something inside a frozen subtree: the owner re-arms it, which
    // composes the subtree once at its new place.
    leaf.position.set(0, 3, 0);
    invalidateStatic(leaf);
    pass.beginFrame();
    pass.apply(scene);

    expect(leaf.matrixWorld.elements[13]).toBe(3);
  });

  it("keeps pruning when the frame spans patch the scene prototype to time the walk", () => {
    const { objects, root, scene } = batch(3);
    markStatic(root);
    // What `profiling/span-probes.ts` installs on the scene's prototype: an own property that wraps
    // the base walk. It used to read as "a class that overrides the walk", which handed the whole
    // scene to three's own recursion and pruned nothing.
    const prototype = Object.getPrototypeOf(scene) as {
      updateMatrixWorld?: Object3D["updateMatrixWorld"];
    };
    const base = prototype.updateMatrixWorld as Object3D["updateMatrixWorld"];
    let walks = 0;
    prototype.updateMatrixWorld = function timedWalk(this: Object3D, force?: boolean): void {
      walks += 1;
      base.call(this, force);
    };
    try {
      const pass = new MatrixWorldPass();
      pass.apply(scene);

      expect(walks).toBe(0);
      expect(pass.report.visited).toBe(2);
    } finally {
      prototype.updateMatrixWorld = base;
    }
    expect(objects).toBeGreaterThan(2);
  });
});
