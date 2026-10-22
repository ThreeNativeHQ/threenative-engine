import {
  BackSide,
  BoxGeometry,
  DoubleSide,
  FrontSide,
  Group,
  type Intersection,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Raycaster,
  SphereGeometry,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { bakeRays } from "../unreal-look/scaffold/render/bakeRays.js";

/** What the game's `ctx.raycast` answers: three's raycaster over the group (the reference the bake used before). */
const stock = (root: Group) => {
  const caster = new Raycaster();
  return {
    raycast: ({ origin, direction, far }: { origin: Vector3; direction: Vector3; far: number }) => {
      caster.set(origin, direction);
      caster.far = far;
      return caster.intersectObject(root, true)[0] as Intersection | undefined;
    },
  };
};

/** A small deterministic generator (the spec must not depend on Math.random). */
const lcg = (start: number) => {
  let seed = start;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
};

function scene(): Group {
  const root = new Group();
  const sides = [FrontSide, BackSide, DoubleSide];
  const next = lcg(7);
  const geometries = [
    new BoxGeometry(1, 1, 1),
    new SphereGeometry(0.7, 12, 8),
    new PlaneGeometry(2, 2),
  ];
  for (let i = 0; i < 24; i += 1) {
    const mesh = new Mesh(
      geometries[i % 3],
      new MeshStandardMaterial({ side: sides[i % 3] as typeof FrontSide }),
    );
    mesh.position.set(next() * 8 - 4, next() * 4, next() * 8 - 4);
    mesh.rotation.set(next() * 6, next() * 6, next() * 6);
    // A mirrored and a non-uniform scale: the winding and the normal transform must follow the stock query.
    mesh.scale.set(next() + 0.5, i % 5 === 0 ? -(next() + 0.5) : next() + 0.5, next() + 0.5);
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  return root;
}

describe("bakeRays", () => {
  it("answers every ray as three's raycaster does: the nearest hit, the object, the face normal", () => {
    const root = scene();
    const reference = stock(root);
    const rays = bakeRays(root, reference);
    expect(rays).not.toBe(reference);
    const next = lcg(11);
    const origin = new Vector3();
    const direction = new Vector3();
    let hits = 0;
    for (let i = 0; i < 6000; i += 1) {
      origin.set(next() * 10 - 5, next() * 5, next() * 10 - 5);
      // The first 300 rays run along an axis, as the bake's link rays do.
      if (i < 300) direction.set(0, 0, 0).setComponent(i % 3, i % 2 === 0 ? 1 : -1);
      else direction.set(next() - 0.5, next() - 0.5, next() - 0.5).normalize();
      const far = i % 4 === 0 ? 1.5 : 1000;
      const want = reference.raycast({ origin, direction, far });
      const [wd, wn, wo] = [want?.distance, want?.face?.normal.clone(), want?.object];
      const got = rays.raycast({ origin, direction, far });
      if (want === undefined) {
        expect(got, `ray ${i} should miss`).toBeUndefined();
        continue;
      }
      hits += 1;
      expect(
        got,
        `ray ${i} should hit ${JSON.stringify({ o: origin.toArray(), d: direction.toArray(), far, wd, side: ((wo as Mesh).material as MeshStandardMaterial).side, scale: (wo as Mesh).scale.toArray() })}`,
      ).toBeDefined();
      expect(got?.distance).toBeCloseTo(wd as number, 4);
      expect(got?.object).toBe(wo);
      expect(got?.face?.normal.distanceTo(wn as Vector3)).toBeLessThan(1e-4);
    }
    expect(hits).toBeGreaterThan(1000);
  });

  it("answers the hit's UV as three's raycaster does, so a texture is read where the ray lands (PRD-639)", () => {
    const root = scene();
    const reference = stock(root);
    const rays = bakeRays(root, reference);
    const next = lcg(23);
    const origin = new Vector3();
    const direction = new Vector3();
    let compared = 0;
    for (let i = 0; i < 4000; i += 1) {
      origin.set(next() * 10 - 5, next() * 5, next() * 10 - 5);
      direction.set(next() - 0.5, next() - 0.5, next() - 0.5).normalize();
      const want = reference.raycast({ origin, direction, far: 1000 });
      const wantUv = want?.uv?.clone();
      const got = rays.raycast({ origin, direction, far: 1000 });
      if (wantUv === undefined) continue;
      compared += 1;
      expect(got?.uv, `ray ${i} should carry a uv`).toBeDefined();
      expect(got?.uv?.distanceTo(wantUv), `ray ${i} uv`).toBeLessThan(1e-4);
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("answers the material slot of the hit triangle", () => {
    const root = new Group();
    const geometry = new BoxGeometry(1, 1, 1);
    const first = new MeshStandardMaterial();
    const second = new MeshStandardMaterial();
    const mesh = new Mesh(geometry, [first, second, first, first, first, first]);
    root.add(mesh);
    root.updateMatrixWorld(true);
    const rays = bakeRays(root, stock(root));
    // BoxGeometry groups: +x, -x, +y, -y, +z, -z. A ray from +x along -x lands on group 0, one from -x on group 1.
    const fromPlusX = rays.raycast({
      origin: new Vector3(5, 0, 0),
      direction: new Vector3(-1, 0, 0),
      far: 20,
    });
    expect(fromPlusX?.face?.materialIndex).toBe(0);
    const fromMinusX = rays.raycast({
      origin: new Vector3(-5, 0, 0),
      direction: new Vector3(1, 0, 0),
      far: 20,
    });
    expect(fromMinusX?.face?.materialIndex).toBe(1);
  });

  it("reads the material side per ray, so a bake that switches it to double-sided sees the back faces", () => {
    const root = new Group();
    const material = new MeshStandardMaterial({ side: FrontSide });
    root.add(new Mesh(new PlaneGeometry(2, 2), material));
    root.updateMatrixWorld(true);
    const rays = bakeRays(root, stock(root));
    const ray = { origin: new Vector3(0, 0, -1), direction: new Vector3(0, 0, 1), far: 10 };
    expect(rays.raycast(ray)).toBeUndefined();
    material.side = DoubleSide;
    expect(rays.raycast(ray)?.distance).toBeCloseTo(1, 6);
  });

  it("keeps the stock query for a scene it cannot flatten", () => {
    const root = new Group();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    (mesh as unknown as { isInstancedMesh: boolean }).isInstancedMesh = true;
    root.add(mesh);
    const reference = stock(root);
    expect(bakeRays(root, reference)).toBe(reference);
  });
});
