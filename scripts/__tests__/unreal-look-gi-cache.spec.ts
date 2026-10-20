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
import {
  giCache,
  installGi,
  skyRadiance,
  sphereShare,
} from "../unreal-look/scaffold/render/giCache.js";

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

  it("a small emissive sphere's direct light leaves the cache, which keeps only what it bounces", () => {
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
      // The -x face looks at the lamp: its direct light, L (r / d)^2 cos, is read per pixel by `emitterLight` and
      // must not also sit in the 0.5 m field (it would count twice, and a cell cannot hold a glow within 0.3 m).
      const face = texelAt(at).faces[1] as number[];
      const direct = radiance * (radius / distance) ** 2 * Math.abs(toward.x);
      expect(Math.abs(face[0] as number)).toBeLessThan(direct * 0.05);
    }
  });

  it("a sphere above the horizon lights a surface by (r / d)^2 cos; one cut by the horizon fades to zero smoothly", () => {
    const sin2 = 0.25;
    // Wholly above the horizon: the closed form.
    expect(sphereShare(sin2, 1)).toBeCloseTo(0.25, 6);
    expect(sphereShare(sin2, 0.9)).toBeCloseTo(0.225, 6);
    // Wholly below: nothing.
    expect(sphereShare(sin2, -0.6)).toBe(0);
    // Continuous where the horizon starts to cut it (cos = sin of the angular radius).
    const edge = Math.sqrt(sin2);
    expect(sphereShare(sin2, edge - 1e-4)).toBeCloseTo(sphereShare(sin2, edge + 1e-4), 3);
    expect(sphereShare(sin2, -edge + 1e-4)).toBeCloseTo(0, 3);
    // Monotonic as the sphere sinks, and above zero while any of it shows.
    let last = Number.POSITIVE_INFINITY;
    for (let cos = 0.99; cos > -edge + 0.02; cos -= 0.01) {
      const share = sphereShare(sin2, cos);
      expect(share).toBeLessThanOrEqual(last + 1e-9);
      expect(share).toBeGreaterThan(0);
      last = share;
    }
    // A sphere resting on a floor touches every floor point's horizon (cos = r / d = sin), so the floor reads
    // (r / d)^3: half a radius from the contact point, d^2 = 1.25 r^2.
    const d = Math.sqrt(1.25);
    expect(sphereShare(1 / 1.25, 1 / d)).toBeCloseTo((1 / d) ** 3, 4);
    // Partly cut by the horizon, the part still above it gives more than (r / d)^2 cos (which reaches zero while
    // half the sphere still shows) and less than the whole sphere overhead.
    expect(sphereShare(0.8, 0.447)).toBeGreaterThan(0.8 * 0.447);
    expect(sphereShare(0.8, 0.447)).toBeLessThan(0.8);
    expect(sphereShare(0.25, 0)).toBeGreaterThan(0);
  });
});
