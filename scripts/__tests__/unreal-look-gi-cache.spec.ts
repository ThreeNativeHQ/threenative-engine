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

/** The sunlit-room calibration scene (tools/unreal-reference/gi/sunlit-room): boxes with their base colours. */
function sunlitRoom(): Group {
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
  return room;
}

/** E / pi at a point (luminance) by path tracing: the sun, a uniform sky of radiance `sky`, Lambert bounces up to `depth`. */
function pathTrace(
  room: Group,
  sun: Vector3,
  sky: number,
  point: Vector3,
  normal: Vector3,
  depth: number,
  paths: number,
): number {
  const caster = new Raycaster();
  const hit = (o: Vector3, d: Vector3) => {
    caster.set(o, d);
    return caster.intersectObject(room, true)[0];
  };
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const gather = (p: Vector3, n: Vector3, level: number): number => {
    const o = p.clone().addScaledVector(n, 1e-3);
    const cos = n.dot(sun);
    const direct = cos > 0 && hit(o, sun) === undefined ? cos : 0;
    if (level > depth) return direct;
    // A cosine-weighted direction about n.
    const [r1, r2] = [random(), random()];
    const tangent = new Vector3(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0)
      .cross(n)
      .normalize();
    const bitangent = n.clone().cross(tangent);
    const d = tangent
      .multiplyScalar(Math.cos(2 * Math.PI * r1) * Math.sqrt(r2))
      .addScaledVector(bitangent, Math.sin(2 * Math.PI * r1) * Math.sqrt(r2))
      .addScaledVector(n, Math.sqrt(1 - r2));
    const h = hit(o, d);
    if (h === undefined) return direct + sky;
    const hn = (h.face?.normal ?? new Vector3()).clone().transformDirection(h.object.matrixWorld);
    if (hn.dot(d) > 0) hn.negate();
    const c = ((h.object as Mesh).material as MeshStandardMaterial).color;
    return direct + (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * gather(h.point, hn, level + 1);
  };
  let sum = 0;
  for (let i = 0; i < paths; i += 1) sum += gather(point, normal, 1);
  return sum / paths;
}

/** The cache's luminance E / pi at a surface point, read as the material does: half a texel off, trilinear. */
function cacheAt(point: Vector3, normal: Vector3): number {
  const field = giCache.field;
  if (field === undefined) throw new Error("no field baked");
  const { grid, values } = field;
  const at = point
    .clone()
    .addScaledVector(normal, grid.cell * 0.5)
    .sub(grid.origin)
    .divideScalar(grid.cell)
    .subScalar(0.5);
  const lower = [Math.floor(at.x), Math.floor(at.y), Math.floor(at.z)];
  const fraction = [at.x - (lower[0] ?? 0), at.y - (lower[1] ?? 0), at.z - (lower[2] ?? 0)];
  const faces = [normal.x < 0 ? 1 : 0, normal.y < 0 ? 3 : 2, normal.z < 0 ? 5 : 4];
  const squares = [normal.x ** 2, normal.y ** 2, normal.z ** 2];
  let sum = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    let weight = 1;
    const t = [0, 1, 2].map((a) => {
      const bit = (corner >> a) & 1;
      weight *= bit ? (fraction[a] ?? 0) : 1 - (fraction[a] ?? 0);
      return (lower[a] ?? 0) + bit;
    });
    const texel = (t[0] ?? 0) + grid.nx * ((t[1] ?? 0) + grid.ny * (t[2] ?? 0));
    for (let a = 0; a < 3; a += 1) {
      const o = (texel * 6 + (faces[a] ?? 0)) * 3;
      sum +=
        weight *
        (squares[a] ?? 0) *
        (0.2126 * (values[o] ?? 0) + 0.7152 * (values[o + 1] ?? 0) + 0.0722 * (values[o + 2] ?? 0));
    }
  }
  return sum;
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
    const room = sunlitRoom();
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

  it("the sunlit room's walls and ceiling read the path-traced light, not 1.5 times it, and smooth (sunlit-room)", () => {
    // A 40 m ground stretched the probe grid to 1 m, 0.9 m under the ceiling, and every bounce over-read: the walls
    // came out 1.46 to 1.78 times the path trace. Five bounces against a path of six surfaces, both with the same sun.
    const room = sunlitRoom();
    const [el, az] = [(60 * Math.PI) / 180, (25 * Math.PI) / 180];
    const sun = new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    // About the atmosphere's share: its sky lights the interior a quarter as much as the sun's bounce does.
    const sky = 0.1;
    skyRadiance.current = {
      data: new Float32Array(6).fill(sky),
      width: 2,
      height: 1,
      scale: [1, 1, 1],
    };
    installGi(rayContext(room), room, {
      bounces: 5,
      sun: { color: new Color(1, 1, 1), intensity: Math.PI, direction: sun },
    });
    const surfaces: [(u: number, v: number) => Vector3, Vector3][] = [
      [(u, v) => new Vector3(-3, 0.4 + 2.2 * v, -5.6 + 5.2 * u), new Vector3(1, 0, 0)],
      [(u, v) => new Vector3(-0.9 + 3.6 * u, 0.4 + 2.2 * v, -6), new Vector3(0, 0, 1)],
      [(u, v) => new Vector3(-2.6 + 5.2 * u, 3, -5.6 + 5.2 * v), new Vector3(0, -1, 0)],
    ];
    for (const [at, normal] of surfaces) {
      let [traced, cached] = [0, 0];
      for (let a = 0; a < 4; a += 1)
        for (let b = 0; b < 3; b += 1) {
          const point = at((a + 0.5) / 4, (b + 0.5) / 3);
          traced += pathTrace(room, sun, sky, point, normal, 6, 300);
          cached += cacheAt(point, normal);
        }
      expect(cached / traced).toBeGreaterThan(0.7);
      expect(cached / traced).toBeLessThan(1.2);
    }
    // And a flat wall reads smooth: at 0.5 m probes the rays' noise showed as half-metre blotches (judge round 10).
    // Roughness is the mean |read - its 1 m box mean| / mean over the left wall: 0.060 unfiltered, 0.011 at 1 m probes.
    const [w, h] = [48, 20];
    const reads: number[] = [];
    for (let b = 0; b < h; b += 1)
      for (let a = 0; a < w; a += 1)
        reads.push(
          cacheAt(
            new Vector3(-3, 0.4 + (2.2 * (b + 0.5)) / h, -5.6 + (5.2 * (a + 0.5)) / w),
            new Vector3(1, 0, 0),
          ),
        );
    let [deviation, level] = [0, 0];
    for (let b = 2; b < h - 2; b += 1)
      for (let a = 4; a < w - 4; a += 1) {
        let box = 0;
        for (let db = -2; db <= 2; db += 1)
          for (let da = -4; da <= 4; da += 1) box += reads[(b + db) * w + a + da] ?? 0;
        deviation += Math.abs((reads[b * w + a] ?? 0) - box / 45);
        level += reads[b * w + a] ?? 0;
      }
    expect(deviation / level).toBeLessThan(0.015);
  }, 120_000);

  it("the probe filter keeps the window's light off the sill below it (sunlit-room, sun 15)", () => {
    // The probes in the window opening see the low sun's patch deep in the room; a plain filter averaged them into the
    // sill's probes and lit a halo round the window (judge round 10b): sill 2.9 times the path trace, 1.5 unfiltered.
    const room = sunlitRoom();
    const [el, az] = [(15 * Math.PI) / 180, (25 * Math.PI) / 180];
    const sun = new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    const sky = 0.1;
    skyRadiance.current = {
      data: new Float32Array(6).fill(sky),
      width: 2,
      height: 1,
      scale: [1, 1, 1],
    };
    installGi(rayContext(room), room, {
      bounces: 5,
      sun: { color: new Color(1, 1, 1), intensity: Math.PI, direction: sun },
    });
    const normal = new Vector3(0, 0, -1);
    let [traced, cached] = [0, 0];
    for (let a = 0; a < 4; a += 1)
      for (let b = 0; b < 3; b += 1) {
        const point = new Vector3(-0.95 + (1.9 * (a + 0.5)) / 4, 0.1 + (0.65 * (b + 0.5)) / 3, 0);
        traced += pathTrace(room, sun, sky, point, normal, 6, 300);
        cached += cacheAt(point, normal);
      }
    expect(cached / traced).toBeLessThan(2.2);
  }, 120_000);

  it("returns undefined with no sky, no sun and no lights", () => {
    skyRadiance.current = undefined;
    const scene = new Group().add(new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial()));
    expect(installGi(rayContext(scene), scene, { bounces: 1 })).toBeUndefined();
  });
});
