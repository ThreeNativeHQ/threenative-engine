import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";

// Counts the calls into each flat query and passes them through: `cast` answers from plain numbers, `raycast` from vector objects.
const calls = { cast: 0, raycast: 0 };
vi.mock("../unreal-look/scaffold/render/bakeRays.js", async (importActual) => {
  const actual = await importActual<typeof import("../unreal-look/scaffold/render/bakeRays.js")>();
  return {
    ...actual,
    bakeRays: (root: Parameters<typeof actual.bakeRays>[0]) => {
      const rays = actual.bakeRays(root);
      if (rays === undefined) return rays;
      const cast = rays.cast;
      const raycast = rays.raycast;
      rays.cast = (...args) => {
        calls.cast += 1;
        return cast(...args);
      };
      rays.raycast = (...args) => {
        calls.raycast += 1;
        return raycast.call(rays, ...args);
      };
      return rays;
    },
  };
});
import { giCache, installGi } from "../unreal-look/scaffold/render/giCache.js";

const SUN = {
  color: new Color(1, 1, 1),
  intensity: 3,
  direction: new Vector3(0.3, 0.9, 0.3).normalize(),
};

/** A closed room of five thin boxes, lit by the sun through nothing: every probe ray lands on a wall. */
function room(): Group {
  const group = new Group();
  const wall = (size: [number, number, number], at: [number, number, number]) => {
    const mesh = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({ color: 0x886644 }));
    mesh.position.set(...at);
    group.add(mesh);
  };
  wall([4, 0.2, 4], [0, -0.1, 0]);
  wall([4, 0.2, 4], [0, 2.1, 0]);
  wall([0.2, 2, 4], [-2.1, 1, 0]);
  wall([0.2, 2, 4], [2.1, 1, 0]);
  wall([4, 2, 0.2], [0, 1, -2.1]);
  group.updateMatrixWorld(true);
  return group;
}

describe("GI bake trace", () => {
  it("casts the probe rays from plain numbers, not through vector objects", () => {
    // On the owned engine each field of a vector is a call into the engine, and the bake casts a million rays: the
    // trace must not hand them vectors. The rays that are not probe rays (shadow, links, solid tests) may: in this small
    // room they are a third of the casts.
    const scene = room();
    const gameCtx = {
      raycast: () => {
        throw new Error("the game's raycast was used");
      },
    };
    const report = installGi(gameCtx as never, scene, { bounces: 1, sun: SUN });
    expect(report?.pass).toBe("final");
    expect(giCache.field).toBeDefined();
    expect(calls.cast).toBeGreaterThan(10_000);
    expect(calls.cast).toBeGreaterThan(calls.raycast * 2);
  });
});
