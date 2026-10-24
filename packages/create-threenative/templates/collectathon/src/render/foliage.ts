// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The island's planting and its shore: round fruit trees, shore palms, bushes, hedge rows,
// flower clusters, mushrooms, tall grass that sways, a dirt path, contact shade under everything
// that stands on the lawn, and a sand-and-foam beach round each island. Every kind is one
// `InstancedMesh`, so about 2,500 plants cost two dozen draws. Nothing here is solid: the hero walks
// through a bush as it walks through a tree trunk, and the course's metres stay the course's.
// Placement is seeded and asks the course where planting may go (`clear`).
import {
  type BufferGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  type Material,
  Mesh,
  Object3D,
  OctahedronGeometry,
  RingGeometry,
  SphereGeometry,
} from "three";
import { hash, instanceIndex, positionLocal, sin, time, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { flat, lit, mottle } from "./materials.js";
import { C } from "./palette.js";

/** x, y, z, scale x, y, z, rotation x, y, z. */
type Placement = readonly [number, number, number, number, number, number, number, number, number];

export interface IPlantingSite {
  readonly rng: () => number;
  /** The island's centre and lawn radius; planting stays on its flat top at y = 0. */
  readonly radius: number;
  /** Whether a plant this wide may stand at (x, z): off the landmarks and the routes. */
  clear(x: number, z: number, width: number): boolean;
  /** Contact shade already owed by the course's own rocks and pines: x, z, radius. */
  readonly shade: [number, number, number][];
  /** The dirt path's corner points, x and z, on the lawn. */
  readonly path: readonly (readonly [number, number])[];
  /** Islands that get a beach: x, z, cliff radius at the waterline, and the sea's height. */
  readonly shores: readonly (readonly [number, number, number])[];
  readonly seaLevel: number;
}

const dummy = new Object3D();
// Yaw last: a placement leans or droops about X, then turns to face its way round Y.
dummy.rotation.order = "YXZ";

function instanced(
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
  castShadow: boolean,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, Math.max(1, placements.length));
  mesh.count = placements.length;
  placements.forEach(([x, y, z, sx, sy, sz, rx, ry, rz], i) => {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(rx, ry, rz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

/** A lit leaf material whose vertices above y = 0 sway with the wind, each instance on its own phase. */
function swaying(color: number, amount: number): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ color, roughness: 0.85 });
  const phase = hash(instanceIndex).mul(6.28);
  const height = positionLocal.y.max(0);
  const bend = height.mul(height).mul(amount);
  material.positionNode = positionLocal.add(
    vec3(
      sin(time.mul(1.9).add(phase)).mul(bend),
      0,
      sin(time.mul(1.3).add(phase.mul(1.7)))
        .mul(bend)
        .mul(0.6),
    ),
  );
  return material;
}

export function plantIsland(site: IPlantingSite): Group {
  const { rng, radius, clear, shade } = site;
  const group = new Group();
  group.name = "planting";
  const spin = () => rng() * Math.PI * 2;
  /** A random clear spot on the lawn between `inner` and `outer` from the centre, or undefined. */
  const spot = (inner: number, outer: number, width: number): [number, number] | undefined => {
    for (let tries = 0; tries < 12; tries += 1) {
      const angle = spin();
      const r = Math.sqrt(inner ** 2 + rng() * (outer ** 2 - inner ** 2));
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      if (clear(x, z, width)) return [x, z];
    }
    return undefined;
  };

  // Round fruit trees: a trunk, a two-blob crown, and red fruit on some.
  const trunks: Placement[] = [];
  const crowns: Placement[] = [];
  const fruit: Placement[] = [];
  for (let i = 0; i < 14; i += 1) {
    const at = spot(8, radius - 5, 3);
    if (at === undefined) continue;
    const [x, z] = at;
    const size = 0.75 + rng() * 0.6;
    const height = 2.4 * size;
    trunks.push([x, 0, z, size, height, size, 0, spin(), 0]);
    crowns.push([x, height + 1.1 * size, z, size, size * 0.9, size, 0, spin(), 0]);
    crowns.push([
      x + 0.6 * size,
      height + 0.6 * size,
      z + 0.3,
      size * 0.7,
      size * 0.6,
      size * 0.7,
      0,
      0,
      0,
    ]);
    if (i % 2 === 0) {
      for (let f = 0; f < 5; f += 1) {
        const a = spin();
        const r = 1.45 * size;
        const y = height + (0.6 + rng() * 0.9) * size;
        fruit.push([x + Math.cos(a) * r, y, z + Math.sin(a) * r, 1, 1, 1, 0, 0, 0]);
      }
    }
    shade.push([x, z, 1.6 * size]);
  }
  const trunk = new CylinderGeometry(0.16, 0.26, 1, 7).translate(0, 0.5, 0);
  group.add(instanced(trunk, lit(C.bark), trunks, true));
  const crown = mottle(new IcosahedronGeometry(1.5, 1), 0.2, rng);
  group.add(instanced(crown, lit(C.canopy, { flat: true, vertexColors: true }), crowns, true));
  group.add(
    instanced(new SphereGeometry(0.13, 8, 6), lit(C.fruit, { roughness: 0.4 }), fruit, false),
  );

  // Shore palms: a leaning trunk, a crown of drooping fronds, three coconuts.
  const palms: Placement[] = [];
  const fronds: Placement[] = [];
  const nuts: Placement[] = [];
  for (let i = 0; i < 10; i += 1) {
    const at = spot(radius - 4, radius - 1.5, 2);
    if (at === undefined) continue;
    const [x, z] = at;
    const out = Math.atan2(x, z);
    const height = 4 + rng() * 1.8;
    const lean = 0.18 + rng() * 0.12;
    palms.push([x, 0, z, 1, height, 1, lean, out, 0]);
    // The top of a trunk leaning `lean` toward the sea.
    const tx = x + Math.sin(out) * Math.sin(lean) * height;
    const tz = z + Math.cos(out) * Math.sin(lean) * height;
    const ty = Math.cos(lean) * height;
    for (let f = 0; f < 7; f += 1) {
      fronds.push([
        tx,
        ty,
        tz,
        1,
        0.9 + rng() * 0.3,
        1,
        1.95 + rng() * 0.3,
        (f / 7) * Math.PI * 2 + rng() * 0.3,
        0,
      ]);
    }
    for (let n = 0; n < 3; n += 1) {
      const a = (n / 3) * Math.PI * 2;
      nuts.push([tx + Math.cos(a) * 0.2, ty - 0.2, tz + Math.sin(a) * 0.2, 1, 1, 1, 0, 0, 0]);
    }
    shade.push([x, z, 1]);
  }
  const palmTrunk = new CylinderGeometry(0.15, 0.24, 1, 7, 5).translate(0, 0.5, 0);
  group.add(instanced(palmTrunk, lit(C.bark, { flat: true }), palms, true));
  // A frond: a flat four-sided blade along +Y, base at the origin, thin in Z.
  const frond = new ConeGeometry(0.42, 2.4, 4).translate(0, 1.2, 0).scale(1, 1, 0.16);
  group.add(instanced(frond, lit(C.palm, { flat: true }), fronds, true));
  group.add(instanced(new SphereGeometry(0.16, 8, 6), lit(C.bark), nuts, false));

  // Bushes: two or three leafy blobs.
  const blobs: Placement[] = [];
  for (let i = 0; i < 40; i += 1) {
    const at = spot(5, radius - 2.5, 1.6);
    if (at === undefined) continue;
    const [x, z] = at;
    const size = 0.5 + rng() * 0.45;
    for (let b = 0; b < 2 + (i % 2); b += 1) {
      const a = spin();
      blobs.push([
        x + Math.cos(a) * 0.5 * size,
        0.35 * size,
        z + Math.sin(a) * 0.5 * size,
        size,
        size * 0.8,
        size,
        0,
        spin(),
        0,
      ]);
    }
    shade.push([x, z, 1.1 * size + 0.3]);
  }
  const bush = mottle(new IcosahedronGeometry(0.8, 1), 0.22, rng);
  group.add(instanced(bush, lit(C.bush, { flat: true, vertexColors: true }), blobs, true));

  // Hedge rows: two arcs of clipped hedge near the rim, broken wherever a route or landmark is.
  const hedges: Placement[] = [];
  for (const [from, to] of [
    [0.75, 1.35],
    [3.55, 4.25],
  ] as const) {
    for (let a = from; a < to; a += 2.1 / (radius - 7)) {
      const x = Math.cos(a) * (radius - 7);
      const z = Math.sin(a) * (radius - 7);
      if (clear(x, z, 1.2)) hedges.push([x, 0, z, 1, 1, 1, 0, -a, 0]);
    }
  }
  // A faceted, lumpy loaf 2.6 m long, so neighbours 2.1 m apart overlap into one leafy row; a plain
  // box read as a placeholder cube.
  const hedge = mottle(
    new IcosahedronGeometry(1, 1).scale(0.55, 0.62, 1.3).translate(0, 0.5, 0),
    0.14,
    rng,
  );
  group.add(instanced(hedge, lit(C.hedge, { flat: true, vertexColors: true }), hedges, true));

  // Flower clusters, one draw per colour, and mushrooms in threes.
  const petals = [C.petalWhite, C.petalPink, C.petalYellow, C.petalLilac];
  const heads: Placement[][] = petals.map(() => []);
  const stems: Placement[] = [];
  for (let i = 0; i < 60; i += 1) {
    const at = spot(3, radius - 1.5, 0.6);
    if (at === undefined) continue;
    const hue = heads[i % petals.length] ?? [];
    for (let f = 0; f < 6; f += 1) {
      const a = spin();
      const r = rng() * 0.9;
      const x = at[0] + Math.cos(a) * r;
      const z = at[1] + Math.sin(a) * r;
      const h = 0.18 + rng() * 0.14;
      stems.push([x, 0, z, 1, h, 1, 0, 0, 0]);
      hue.push([x, h, z, 1, 0.7, 1, 0, spin(), 0]);
    }
  }
  const stem = new CylinderGeometry(0.012, 0.012, 1, 3).translate(0, 0.5, 0);
  group.add(instanced(stem, lit(C.blade), stems, false));
  const head = new OctahedronGeometry(0.08);
  petals.forEach((colour, i) => {
    group.add(instanced(head, lit(colour), heads[i] ?? [], false));
  });
  const caps: Placement[] = [];
  const mushroomStems: Placement[] = [];
  for (let i = 0; i < 12; i += 1) {
    const at = spot(6, radius - 2, 0.8);
    if (at === undefined) continue;
    for (let m = 0; m < 3; m += 1) {
      const a = spin();
      const x = at[0] + Math.cos(a) * 0.35;
      const z = at[1] + Math.sin(a) * 0.35;
      const s = 0.7 + rng() * 0.6;
      mushroomStems.push([x, 0, z, s, s, s, 0, 0, 0]);
      caps.push([x, 0.2 * s, z, s, s, s, 0, 0, 0]);
    }
  }
  const mushroomStem = new CylinderGeometry(0.05, 0.07, 0.22, 7).translate(0, 0.11, 0);
  group.add(instanced(mushroomStem, lit(C.petalWhite), mushroomStems, false));
  const cap = new SphereGeometry(0.16, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  group.add(instanced(cap, lit(C.mushroom, { roughness: 0.5 }), caps, true));

  // Tall grass: clumps of single swaying blades, anywhere the lawn is clear.
  const blades: Placement[] = [];
  for (let i = 0; i < 320; i += 1) {
    const at = spot(2, radius - 0.8, 0.3);
    if (at === undefined) continue;
    for (let b = 0; b < 4; b += 1) {
      const a = spin();
      const h = 0.55 + rng() * 0.5;
      blades.push([
        at[0] + Math.cos(a) * 0.12,
        0,
        at[1] + Math.sin(a) * 0.12,
        1,
        h,
        1,
        Math.cos(a) * 0.3,
        spin(),
        Math.sin(a) * 0.3,
      ]);
    }
  }
  const blade = new ConeGeometry(0.045, 1, 3, 1, true).translate(0, 0.5, 0);
  group.add(instanced(blade, swaying(C.blade, 0.09), blades, false));

  // The path: overlapping dirt discs over a wider worn-grass border, laid along its corners.
  const dirt: Placement[] = [];
  const worn: Placement[] = [];
  site.path.forEach(([x0, z0], i) => {
    const next = site.path[i + 1];
    if (next === undefined) return;
    const [x1, z1] = next;
    const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.7);
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t + (rng() - 0.5) * 0.3;
      const z = z0 + (z1 - z0) * t + (rng() - 0.5) * 0.3;
      dirt.push([x, 0.03, z, 1 + rng() * 0.2, 1, 1 + rng() * 0.2, 0, spin(), 0]);
      worn.push([x, 0.02, z, 1.5, 1, 1.5, 0, 0, 0]);
    }
  });
  const disc = new CircleGeometry(1, 18).rotateX(-Math.PI / 2);
  group.add(instanced(disc, lit(C.dirt), dirt, false));
  group.add(instanced(disc, lit(C.grassDark), worn, false));

  // Contact shade: a soft dark disc under everything that stands on the lawn.
  const shadeMaterial = flat(C.ink, { depthWrite: false, opacity: 0.22 });
  const shadeMesh = instanced(
    disc,
    shadeMaterial,
    shade.map(([x, z, r]) => [x, 0.04, z, r, 1, r, 0, 0, 0] as const),
    false,
  );
  shadeMesh.receiveShadow = false;
  shadeMesh.renderOrder = 1;
  group.add(shadeMesh);

  // Beaches: a sand shelf at the cliff's foot, a darker wet band at the water, and a foam line.
  for (const [x, z, r] of site.shores) {
    const band = (inner: number, outer: number, y: number, material: Material): void => {
      const ring = new RingGeometry(inner, outer, Math.max(24, Math.round(r * 3)), 1).rotateX(
        -Math.PI / 2,
      );
      const mesh = new Mesh(ring, material);
      mesh.position.set(x, site.seaLevel + y, z);
      mesh.receiveShadow = true;
      group.add(mesh);
    };
    band(r - 1, r + 1.1, 0.16, lit(C.sand));
    band(r + 1.1, r + 1.8, 0.1, lit(C.wetSand, { roughness: 0.35 }));
    band(r + 1.8, r + 2.3, 0.06, flat(C.foam, { opacity: 0.7 }));
  }
  return group;
}
