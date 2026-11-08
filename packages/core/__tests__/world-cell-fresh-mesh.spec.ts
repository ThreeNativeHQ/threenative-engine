import { BoxGeometry, Group, InstancedMesh, MeshBasicMaterial, Scene } from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  markStatic,
  refreshStaticTransforms,
  resetStaticTransforms,
} from "../src/static-transform.js";
import { freshMeshFor } from "../src/world-cell-render-util.js";

afterEach(() => {
  resetStaticTransforms();
});

describe("freshMeshFor", () => {
  it("gives a frozen draw's replacement the authored flags, so it follows a moved world root", () => {
    // A seated world (`world.position.y = -ground`) drew every GPU-dressed tree at the package's
    // absolute height: the replacement inherited the freeze's `matrixWorldAutoUpdate = false`, and
    // the new freeze took that for a game-owned world matrix and never composed it again.
    const scene = new Scene();
    const world = new Group();
    world.position.set(0, -11.4, 0);
    scene.add(world);
    scene.updateMatrixWorld(true);
    const geometry = new BoxGeometry();
    const old = new InstancedMesh(geometry, new MeshBasicMaterial(), 4);
    markStatic(old);

    const next = freshMeshFor(old, geometry, 8);
    world.add(next);
    refreshStaticTransforms();
    scene.updateMatrixWorld(false);

    expect(next.matrixWorld.elements[13]).toBeCloseTo(-11.4, 6);
  });
});
