import { readFileSync } from "node:fs";
import {
  BoxGeometry,
  Color,
  DoubleSide,
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
import { giCache, installGi, skyRadiance } from "../unreal-look/scaffold/render/giCache.js";

/** The bake's ray query over a group, as the game's `ctx.raycast` answers it. */
const rayContext = (root: Group) => {
  const caster = new Raycaster();
  return {
    raycast: ({ origin, direction, far }: { origin: Vector3; direction: Vector3; far: number }) => {
      caster.set(origin, direction);
      caster.far = far;
      return caster.intersectObject(root, true)[0] as Intersection | undefined;
    },
  };
};

const noSun = { color: new Color(0, 0, 0), intensity: 0, direction: new Vector3(0, 1, 0) };

/** The six faces of every fine texel at a world point: [+x, -x, +y, -y, +z, -z] x RGB, and the six environment shares. */
function texelAt(point: Vector3): { faces: number[][]; share: number[] } {
  const field = giCache.field;
  if (field === undefined) throw new Error("no field baked");
  const { grid } = field;
  const [x, y, z] = [
    Math.floor((point.x - grid.origin.x) / grid.cell),
    Math.floor((point.y - grid.origin.y) / grid.cell),
    Math.floor((point.z - grid.origin.z) / grid.cell),
  ];
  const index = x + grid.nx * (y + grid.ny * z);
  const faces = Array.from({ length: 6 }, (_, f) =>
    [0, 1, 2].map((c) => field.values[(index * 6 + f) * 3 + c] ?? 0),
  );
  return { faces, share: Array.from({ length: 6 }, (_, f) => field.sky[index * 6 + f] ?? 0) };
}

describe("the world-space GI cache against closed forms (PRD-631 L7)", () => {
  it("a closed furnace of albedo rho and emission e reads e (1 - rho^n) / (1 - rho) after n passes", () => {
    // Every point of a closed cavity sees the same radiance, so the gathered light is the geometric series of the
    // wall's bounces: pass 1 sees the emission, each later pass adds rho times the previous.
    const rho = 0.6;
    const emission = 2;
    const material = new MeshStandardMaterial({
      color: new Color(rho, rho, rho),
      emissive: new Color(emission, emission, emission),
      side: DoubleSide,
    });
    // Point reflection of a box turns its outward face normals into inward ones: the room's walls face in.
    const geometry = new BoxGeometry(6, 6, 6).scale(-1, -1, -1);
    const room = new Group().add(new Mesh(geometry, material));
    skyRadiance.current = { data: new Float32Array(6), width: 2, height: 1, scale: [1, 1, 1] };
    const centre = new Vector3(0.3, 0.2, -0.4);
    for (const passes of [1, 2, 3, 5]) {
      installGi(rayContext(room), room, { bounces: passes, sun: noSun });
      const expected = (emission * (1 - rho ** passes)) / (1 - rho);
      for (const face of texelAt(centre).faces)
        for (const channel of face) expect(channel / expected).toBeCloseTo(1, 1);
    }
  });

  it("the share of the environment a face sees is 1 in the open and falls under a roof", () => {
    // A 40 m floor, and a 12 m roof 3 m up. Open: every ray leaves for the sky or lands on open ground.
    const floor = new Mesh(
      new PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ color: new Color(0.2, 0.2, 0.2), side: DoubleSide }),
    );
    const roof = new Mesh(
      new BoxGeometry(12, 0.2, 12).translate(0, 3.1, 0),
      new MeshStandardMaterial({ color: new Color(0.5, 0.5, 0.5), side: DoubleSide }),
    );
    const scene = new Group().add(floor, roof);
    skyRadiance.current = { data: new Float32Array(6), width: 2, height: 1, scale: [1, 1, 1] };
    installGi(rayContext(scene), scene, { bounces: 1, sun: noSun });
    const open = texelAt(new Vector3(15, 1.25, 0));
    const covered = texelAt(new Vector3(0, 1.25, 0));
    // +x is face 0, +y face 2. An open probe's lower rays reach the open ground, its upper rays the sky.
    expect(open.share[2]).toBeGreaterThan(0.95);
    expect(open.share[0]).toBeGreaterThan(0.9);
    // Under the roof the upward face sees the roof but for the rays that slip out under its edge (about 7%), and the
    // ground inside is not open.
    expect(covered.share[2]).toBeLessThan(0.1);
    expect(covered.share[3]).toBeLessThan(0.5);
    expect(covered.share[0]).toBeLessThan(open.share[0] ?? 1);
  });

  it("a small emissive sphere lights a distant probe by L (r / d)^2 cos, not by the few rays that happen to hit it", () => {
    // 8 m away the sphere subtends 0.012 sr and one of a probe's 96 rays stands for 0.13 sr: the rays alone over- or
    // under-read by an order of magnitude, the same way for every neighbour, which lit a wall 4 to 7 times too bright.
    const radiance = 10;
    const radius = 0.5;
    const lamp = new Mesh(
      new SphereGeometry(radius, 32, 16),
      new MeshStandardMaterial({
        color: new Color(0.1, 0.1, 0.1),
        emissive: new Color(1, 1, 1),
        emissiveIntensity: radiance,
      }),
    );
    // A box far away gives the grid something to span and the bake walls to ignore.
    const wall = new Mesh(
      new BoxGeometry(0.2, 4, 4).translate(14, 0, 0),
      new MeshStandardMaterial({ color: new Color(0.5, 0.5, 0.5), side: DoubleSide }),
    );
    const scene = new Group().add(lamp, wall);
    skyRadiance.current = { data: new Float32Array(6), width: 2, height: 1, scale: [1, 1, 1] };
    installGi(rayContext(scene), scene, { bounces: 1, sun: noSun });
    for (const [x, y] of [
      [8.5, 0.5],
      [8.5, 1.5],
      [11.5, -0.5],
    ] as const) {
      const at = new Vector3(x, y, 0.5);
      const toward = new Vector3(0, 0, 0).sub(at);
      const distance = toward.length();
      toward.normalize();
      // The -x face looks at the lamp and reads cos = |toward.x|.
      const face = texelAt(at).faces[1] as number[];
      const expected = radiance * (radius / distance) ** 2 * Math.abs(toward.x);
      expect((face[0] as number) / expected).toBeGreaterThan(0.8);
      expect((face[0] as number) / expected).toBeLessThan(1.25);
    }
  });

  describe("a scene with no sky and no sun, lit by one point light", () => {
    const lamp = {
      position: new Vector3(0, 3, 0),
      color: new Color(1, 1, 1),
      intensity: 100,
      distance: 0,
    };
    const sceneOf = (plate: boolean): Group => {
      const floor = new Mesh(
        new PlaneGeometry(10, 10).rotateX(-Math.PI / 2),
        new MeshStandardMaterial({ color: new Color(0.8, 0.8, 0.8), side: DoubleSide }),
      );
      const scene = new Group().add(floor);
      if (plate)
        scene.add(
          new Mesh(
            new BoxGeometry(3, 0.1, 3).translate(0, 1.5, 0),
            new MeshStandardMaterial({ color: new Color(0.5, 0.5, 0.5), side: DoubleSide }),
          ),
        );
      return scene;
    };
    /** The light that reaches a probe 0.5 m over the floor, under the lamp: the sum of its six faces. */
    const bake = (plate: boolean) => {
      skyRadiance.current = undefined;
      const scene = sceneOf(plate);
      const report = installGi(rayContext(scene), scene, { bounces: 1, lights: [lamp] });
      const total = texelAt(new Vector3(0.5, 0.5, 0.5))
        .faces.flat()
        .reduce((a, b) => a + b, 0);
      return { report, total };
    };

    it("bakes, and the probe under the light receives light", () => {
      const { report, total } = bake(false);
      expect(report).toBeDefined();
      expect(report?.shadowRays).toBeGreaterThan(0);
      expect(total).toBeGreaterThan(0);
    });

    it("an occluder between the light and the floor lowers the light on the floor below it", () => {
      expect(bake(true).total).toBeLessThan(bake(false).total);
    });
  });

  it("a texel just under a 0.2 m roof reads the room, not the sky above the roof (sunlit-room)", () => {
    const data = JSON.parse(
      readFileSync("tools/unreal-reference/gi/sunlit-room/scene.json", "utf8"),
    ) as {
      meshes: {
        size: [number, number, number];
        position: [number, number, number];
        material: { baseColor: [number, number, number] };
      }[];
    };
    const room = new Group();
    for (const m of data.meshes) {
      const mesh = new Mesh(
        new BoxGeometry(...m.size),
        new MeshStandardMaterial({ color: new Color(...m.material.baseColor) }),
      );
      mesh.position.set(...m.position);
      room.add(mesh);
    }
    room.updateMatrixWorld(true);
    skyRadiance.current = {
      data: new Float32Array(6).fill(1),
      width: 2,
      height: 1,
      scale: [1, 1, 1],
    };
    installGi(rayContext(room), room, { bounces: 1, sun: noSun });
    // The roof's underside is at y 3.0. The fine texel centred 0.15 m below it saw the sky through it (-x share 0.46);
    // the texel a row lower sees almost none (0.01).
    const underRoof = texelAt(new Vector3(1.75, 2.85, -3));
    const below = texelAt(new Vector3(1.75, 2.35, -3));
    expect(underRoof.share[1]).toBeLessThan(0.1);
    expect(underRoof.share[1]).toBeLessThan((below.share[1] ?? 0) + 0.05);
  }, 120_000);

  it("returns undefined with no sky, no sun and no lights", () => {
    skyRadiance.current = undefined;
    const scene = new Group().add(new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial()));
    expect(installGi(rayContext(scene), scene, { bounces: 1 })).toBeUndefined();
  });
});
