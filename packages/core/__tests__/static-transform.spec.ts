import { Group, Mesh, type Object3D, Scene } from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  RenderListValidator,
  validateWorldMatrices,
} from "../src/profiling/render-list-validate.js";
import {
  invalidateStatic,
  isStatic,
  markStatic,
  refreshStaticTransforms,
  resetStaticTransforms,
  staticTransformCensus,
  unmarkStatic,
} from "../src/static-transform.js";

afterEach(() => {
  resetStaticTransforms();
});

/**
 * A scene shaped like the thing this is for: a moving root, and an island of scenery under it that
 * never moves. `depth` levels of `breadth` children each, so the composes deleted are countable.
 */
function scenery(depth: number, breadth: number): { scene: Scene; island: Group; objects: number } {
  const scene = new Scene();
  const island = new Group();
  island.name = "island";
  island.position.set(3, 0, -7);
  scene.add(island);
  let objects = 1;
  const grow = (parent: Object3D, level: number): void => {
    if (level === 0) return;
    for (let index = 0; index < breadth; index += 1) {
      const child = new Mesh();
      child.position.set(index, level, index * 0.5);
      child.scale.setScalar(1 + index * 0.1);
      parent.add(child);
      objects += 1;
      grow(child, level - 1);
    }
  };
  grow(island, depth);
  return { island, objects, scene };
}

/** Counts `updateMatrix` calls under a root, which is the arithmetic the freeze deletes. */
function countComposes(root: Object3D): { walk: () => void; composes: () => number } {
  let composes = 0;
  root.traverse((object) => {
    const original = object.updateMatrix.bind(object);
    object.updateMatrix = () => {
      composes += 1;
      original();
    };
  });
  return { composes: () => composes, walk: () => root.parent?.updateMatrixWorld(false) };
}

describe("markStatic", () => {
  it("deletes the local matrix composes of the subtree, counted rather than timed", () => {
    const { scene, island, objects } = scenery(3, 4);
    scene.updateMatrixWorld(true);
    const counter = countComposes(island);

    // A live subtree composes every object's local matrix on every walk.
    scene.updateMatrixWorld(false);
    const live = counter.composes();
    expect(live).toBe(objects);

    markStatic(island);
    scene.updateMatrixWorld(false);
    scene.updateMatrixWorld(false);
    // Frozen: three more walks, and not one more compose than the single forced one `markStatic`
    // does itself.
    expect(counter.composes()).toBe(live + objects);
  });

  it("leaves every world matrix exactly where the full recompute puts it", () => {
    const { scene, island } = scenery(3, 3);
    scene.updateMatrixWorld(true);
    markStatic(island);
    scene.updateMatrixWorld(false);
    expect(() => validateWorldMatrices(scene)).not.toThrow();
  });

  it("still updates an object marked static whose transform is written — the version is the contract", () => {
    const { scene, island } = scenery(2, 2);
    scene.updateMatrixWorld(true);
    const version = markStatic(island);
    expect(isStatic(island)).toBe(true);

    island.position.set(50, 0, 0);
    // The author did not announce it; the engine's own per-frame check is what catches a moved root.
    refreshStaticTransforms();
    scene.updateMatrixWorld(false);

    expect(island.matrixWorld.elements[12]).toBeCloseTo(50, 6);
    expect(() => validateWorldMatrices(scene)).not.toThrow();
    expect(staticTransformCensus().rearmed).toBe(1);
    expect(markStatic(island)).toBeGreaterThan(version);
  });

  it("re-arms the owning root when something deeper inside the subtree is announced", () => {
    const { scene, island } = scenery(2, 2);
    scene.updateMatrixWorld(true);
    markStatic(island);
    const deep = island.children[0]?.children[0];
    expect(deep).toBeDefined();

    (deep as Object3D).position.set(0, 99, 0);
    invalidateStatic(deep as Object3D);
    scene.updateMatrixWorld(false);

    expect(() => validateWorldMatrices(scene)).not.toThrow();
    // island.y 0 + its child's authored y 2 + the 99 just written.
    expect((deep as Object3D).matrixWorld.elements[13]).toBeCloseTo(101, 6);
  });

  it("re-arms a root frozen before it joined a moved parent, so a streamed world follows its root", () => {
    // WorldCells freezes each draw mesh, then attaches it under the world root; a game that seats
    // the world (`world.position.y = -ground`) drew every tree at the package's absolute height.
    const scene = new Scene();
    const world = new Group();
    world.position.set(0, -11.4, 0);
    scene.add(world);
    scene.updateMatrixWorld(true);
    const mesh = new Mesh();
    markStatic(mesh);
    world.add(mesh);

    refreshStaticTransforms();
    scene.updateMatrixWorld(false);

    expect(mesh.matrixWorld.elements[13]).toBeCloseTo(-11.4, 6);
    expect(() => validateWorldMatrices(scene)).not.toThrow();
  });

  it("composes again when a frozen root is marked a second time under a moved parent", () => {
    // WorldCells marks a draw mesh at every dress: the first freeze turned the root's world compose
    // off, so the second one snapshotted the moved parent and kept the identity world matrix.
    const scene = new Scene();
    const world = new Group();
    world.position.set(0, -11.4, 0);
    scene.add(world);
    scene.updateMatrixWorld(true);
    const mesh = new Mesh();
    markStatic(mesh);
    world.add(mesh);
    markStatic(mesh);

    refreshStaticTransforms();
    scene.updateMatrixWorld(false);

    expect(mesh.matrixWorld.elements[13]).toBeCloseTo(-11.4, 6);
    expect(() => validateWorldMatrices(scene)).not.toThrow();
  });

  it("re-arms a frozen root whose parent moved", () => {
    const { scene, island } = scenery(2, 2);
    const world = new Group();
    scene.add(world);
    world.add(island);
    scene.updateMatrixWorld(true);
    markStatic(island);

    world.position.y = 5;
    scene.updateMatrixWorld(false);
    refreshStaticTransforms();
    scene.updateMatrixWorld(false);

    expect(island.matrixWorld.elements[13]).toBeCloseTo(5, 6);
    expect(() => validateWorldMatrices(scene)).not.toThrow();
  });

  it("does not re-arm a subtree that did not move, so a still scene pays a comparison and nothing else", () => {
    const { scene, island } = scenery(2, 3);
    scene.updateMatrixWorld(true);
    markStatic(island);
    for (let frame = 0; frame < 10; frame += 1) refreshStaticTransforms();
    expect(staticTransformCensus().rearmed).toBe(0);
  });

  it("thaws on unmark, so a subtree that becomes dynamic composes again", () => {
    const { scene, island } = scenery(2, 2);
    scene.updateMatrixWorld(true);
    markStatic(island);
    unmarkStatic(island);
    expect(isStatic(island)).toBe(false);

    island.position.set(0, 0, 12);
    scene.updateMatrixWorld(false);
    expect(island.matrixWorld.elements[14]).toBeCloseTo(12, 6);
  });

  it("reports what is frozen, so a census can be read instead of guessed", () => {
    const { scene, island, objects } = scenery(2, 3);
    scene.updateMatrixWorld(true);
    markStatic(island);
    const census = staticTransformCensus();
    expect(census.roots).toBe(1);
    expect(census.objects).toBe(objects);
  });
});

describe("the per-frame cost of the convention nobody opted into", () => {
  it("is a single guarded return when no subtree is frozen", () => {
    // `refreshStaticTransforms` runs every frame in every game, whether or not anything is
    // static, so "authored staticness costs nothing until you author some" has to be true rather
    // than asserted. A registry lookup per frame is the whole price; a walk would not fit here.
    expect(staticTransformCensus().roots).toBe(0);
    const started = Date.now();
    for (let index = 0; index < 1_000_000; index += 1) refreshStaticTransforms();
    const elapsed = Date.now() - started;
    // Loose on purpose: this checks the guard exists, it is not a benchmark. A per-call walk or
    // allocation would be orders of magnitude over this.
    expect(elapsed).toBeLessThan(500);
  });

  it("reads the frozen root and never walks the subtree it froze", () => {
    const { scene, island } = scenery(4, 4);
    scene.updateMatrixWorld(true);
    markStatic(island);
    const census = staticTransformCensus();
    expect(census.roots).toBe(1);
    expect(census.objects).toBeGreaterThan(300);

    // Counted, not timed. A per-frame walk of 340 objects is only a few hundred microseconds, so
    // a wall-clock bound loose enough to be stable is also loose enough to pass with the walk in
    // place — measured: an O(objects) version of this check passed a 500 ms bound over 100,000
    // calls. Counting the walks is the instrument that can tell the two apart.
    let walks = 0;
    const original = island.traverse.bind(island);
    island.traverse = (callback) => {
      walks += 1;
      original(callback);
    };
    try {
      for (let index = 0; index < 1_000; index += 1) refreshStaticTransforms();
      expect(walks).toBe(0);
      expect(staticTransformCensus().rearmed).toBe(0);
    } finally {
      island.traverse = original;
    }
  });
});

describe("validateWorldMatrices", () => {
  it("throws on a stale world matrix, naming the object and the element", () => {
    const { scene, island } = scenery(1, 2);
    scene.updateMatrixWorld(true);
    markStatic(island);
    // Exactly the bug the freeze could ship: the authored transform moved and nothing re-armed.
    island.position.set(0, 0, 40);

    expect(() => validateWorldMatrices(scene)).toThrow(/island .* has a stale world matrix/u);
  });

  it("checks every object under the root", () => {
    const { scene, objects } = scenery(2, 3);
    scene.updateMatrixWorld(true);
    // The scene itself plus the island subtree.
    expect(validateWorldMatrices(scene).checked).toBe(objects + 1);
  });

  it("skips an object that owns its world matrix instead of calling it stale", () => {
    // `matrixWorldAutoUpdate = false` is three's "I maintain this myself", and the engine's own
    // render projection sets it across its mirror. Recomputing those from the parent chain
    // reported every one of them stale on a real game: `Mesh (id 19) ... drawing 1 where a full
    // recompute gives 0.5695`. A validator that cries wolf on the default configuration is worse
    // than none, because the first thing anybody does with it is turn it off.
    const { scene, island } = scenery(2, 2);
    scene.updateMatrixWorld(true);
    island.matrixWorldAutoUpdate = false;
    island.matrixWorld.makeScale(0.5, 0.5, 0.5);
    // A game that owns a world matrix writes it before the frame's walk, and three then
    // propagates it to the children from the matrix the game wrote.
    scene.updateMatrixWorld(true);

    expect(() => validateWorldMatrices(scene)).not.toThrow();
    const report = validateWorldMatrices(scene);
    expect(report.gameOwned).toBe(1);
    expect(report.checked).toBeGreaterThan(0);
  });

  it("still checks a subtree the freeze silenced, which is the whole point of it", () => {
    const { scene, island } = scenery(2, 2);
    scene.updateMatrixWorld(true);
    markStatic(island);
    // The freeze also sets `matrixWorldAutoUpdate = false`; that must not buy an exemption.
    expect(island.matrixWorldAutoUpdate).toBe(false);
    expect(validateWorldMatrices(scene).gameOwned).toBe(0);
    island.position.set(0, 0, 40);
    expect(() => validateWorldMatrices(scene)).toThrow(/stale world matrix/u);
  });
});

describe("the oracle checks what was frozen, not only what is drawn", () => {
  it("catches a stale frozen subtree that is not inside the drawn root", () => {
    // The engine's projection draws a collapsed mirror, so the root handed to the validator is
    // not the authored scene. Measured on the native host before this was fixed: 200 frozen
    // meshes with one genuinely stale reported `checked: 3, divergences: 0` — the oracle
    // reassured without looking at the thing the freeze was applied to.
    const drawn = new Scene();
    drawn.add(new Mesh());
    drawn.updateMatrixWorld(true);

    const authored = new Scene();
    const island = new Group();
    const victim = new Mesh();
    island.add(victim);
    authored.add(island);
    authored.updateMatrixWorld(true);
    markStatic(island);

    const validator = new RenderListValidator();
    expect(() => validator.frame(drawn, island)).not.toThrow();

    // A write inside a frozen subtree without `invalidateStatic` — exactly what the freeze makes
    // possible and what this oracle exists to catch.
    victim.position.x += 5;
    expect(() => validator.frame(drawn, island)).toThrow(/stale world matrix/u);

    // Validating only the drawn root is the old behaviour, and it still sees nothing: that is
    // why the frozen roots have to be passed in rather than discovered from the draw root.
    expect(() => validator.frame(drawn)).not.toThrow();
  });

  it("counts every root it was handed and never double-counts one", () => {
    const scene = new Scene();
    scene.add(new Mesh());
    scene.updateMatrixWorld(true);
    const validator = new RenderListValidator();
    validator.frame(scene, scene);
    const once = validator.report().checked;
    expect(once).toBe(2);
  });
});
