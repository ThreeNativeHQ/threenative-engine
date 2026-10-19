import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, type Vector2 } from "three";
import { expect, test } from "vitest";

import { ThreePlaytestEntityRegistry } from "../src/three/entities.js";
import { sampleThreeObservations } from "../src/three/observations.js";

/**
 * Round 9 reported that a registered entity whose object is a `Group` of body parts fails
 * `TN_PLAYTEST_VISIBILITY_FAILED` — "however many visible children it has, it reports zero
 * projected pixels" — and worked around it by registering an invisible proxy `Mesh` at the
 * capsule centre instead. See docs/verification/sweep-platformer-2026-08-16.md.
 *
 * That diagnosis does not hold at this layer: bounds come from `Box3.setFromObject`, which
 * expands over descendants, so a `Group` of parts reports the union of its children. These
 * tests pin that, so a future change that does break Group observation fails here rather
 * than in a game's screenshot — and so the round 9 row stays open against a real
 * reproduction instead of a cause that is already ruled out.
 */
function observe(object: { id: string; object: Group | Mesh }) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 2, 6);
  camera.lookAt(0, 1, 0);
  camera.updateProjectionMatrix();
  scene.add(object.object, camera);
  const registry = new ThreePlaytestEntityRegistry();
  registry.register(object);
  const snapshot = sampleThreeObservations(
    {
      camera,
      clockMode: "fixed-step",
      registry,
      renderer: { getDrawingBufferSize: (target: Vector2) => target.set(1600, 900) },
      scene,
      tick: 1,
    },
    { entities: [object.id] },
  );
  const entity = snapshot.entities?.find(({ id }) => id === object.id);
  if (entity === undefined) throw new Error("The registered entity was not observed.");
  return entity;
}

function part(x: number, y: number): Mesh {
  const mesh = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshBasicMaterial());
  mesh.position.set(x, y, 0);
  return mesh;
}

test("a Group of body parts reports the projected bounds of its children", () => {
  const rig = new Group();
  rig.add(part(0, 1), part(0.4, 1.4), part(-0.4, 1.4));

  const observed = observe({ id: "player", object: rig });

  expect(observed.visible).toBe(true);
  expect(observed.bounds?.width ?? 0).toBeGreaterThan(20);
  expect(observed.bounds?.height ?? 0).toBeGreaterThan(20);
});

test("a Group's bounds cover more than any single part", () => {
  const rig = new Group();
  rig.add(part(0, 1), part(0.9, 1), part(-0.9, 1));
  const solo = part(0, 1);

  const group = observe({ id: "rig", object: rig });
  const single = observe({ id: "solo", object: solo });

  expect(group.bounds?.width ?? 0).toBeGreaterThan(single.bounds?.width ?? 0);
});

test("an empty Group reports no bounds and is not visible", () => {
  const observed = observe({ id: "empty", object: new Group() });

  expect(observed.bounds).toBeUndefined();
  expect(observed.visible).toBe(false);
});

test("an observation snapshot retains optional diagnostics and partial render performance", () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  const registry = new ThreePlaytestEntityRegistry();
  const snapshot = sampleThreeObservations(
    {
      camera,
      clockMode: "fixed-step",
      diagnostics: () => [{ code: "sample" }],
      registry,
      renderChain: () => ({ tier: "high" }) as never,
      renderer: {
        getDrawingBufferSize: (target: Vector2) => target.set(1600, 900),
        info: { render: { drawCalls: 3 } },
      },
      scene,
      tick: 1,
    },
    { entities: [] },
  );

  expect(snapshot.diagnostics).toEqual([{ code: "sample" }]);
  expect(snapshot.performance).toEqual({ drawCalls: 3 });
  expect(snapshot.renderChain).toEqual({ tier: "high" });
});

test("a box that crosses the near plane is bounded by its visible part, not by corners behind the eye", () => {
  // The box spans x 0.5 to 1.5, y -1 to 1, and z -2 to 0.5. The near plane is at z -1.
  // The visible part is z -2 to -1. Corners at z 0.5 sit behind the eye and must not flip the result.
  const scene = new Scene();
  const camera = new PerspectiveCamera(90, 1, 1, 100);
  const slab = new Mesh(new BoxGeometry(1, 2, 2.5), new MeshBasicMaterial());
  slab.position.set(1, 0, -0.75);
  scene.add(slab, camera);
  const registry = new ThreePlaytestEntityRegistry();
  registry.register({ id: "slab", object: slab });
  const snapshot = sampleThreeObservations(
    {
      camera,
      clockMode: "fixed-step",
      registry,
      renderer: { getDrawingBufferSize: (target: Vector2) => target.set(100, 100) },
      scene,
      tick: 1,
    },
    { entities: ["slab"] },
  );
  const bounds = snapshot.entities?.find(({ id }) => id === "slab")?.bounds;
  // The visible NDC span is x 0.25 to 1.5 and y -1 to 1, on a 100 px viewport.
  expect(bounds?.x).toBeCloseTo(62.5);
  expect(bounds?.width).toBeCloseTo(62.5);
  expect(bounds?.y).toBeCloseTo(0);
  expect(bounds?.height).toBeCloseTo(100);
});
