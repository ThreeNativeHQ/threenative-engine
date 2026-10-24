// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The vale's planting and its floor. Three kinds of tree (broadleaf, pine, dead) and stumps,
// bushes, ferns, flower clusters, tall grass and meadow tufts that sway, ivy and hanging vines on
// the stone, mushrooms, fallen logs, rocks, path pebbles and a few fireflies. Every kind is one
// `InstancedMesh`, so about 3,000 plants cost about two dozen draws and no light of their own.
// Nothing here is solid: `level/Vale.ts` decides where the trunks block.
//
// The floor is one vertex-coloured plane: flat where Wren walks, rising into mounds at the walls
// and hills beyond them; grass, moss, dirt and leaf-litter patches; a worn path with soft edges;
// and contact shade under trunks, rocks and along the foot of every wall.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  type Material,
  Mesh,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  SphereGeometry,
} from "three";
import { cos, hash, instanceIndex, positionLocal, sin, time, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { lit, mottle } from "./materials.js";
import { C, palette } from "./palette.js";

/** x, y, z, scale x, y, z, rotation x, y, z. */
type Placement = readonly [number, number, number, number, number, number, number, number, number];

/** Where the vale may be planted, and what already stands in it. */
export interface IValeSite {
  readonly rng: () => number;
  /** The clearing's walkable box, x from -half to half, z from north to south. */
  readonly clearing: { readonly half: number; readonly north: number; readonly south: number };
  /** The path's centre line: x at a given z. */
  pathX(z: number): number;
  /** Whether a plant this wide may stand at (x, z) inside the clearing: off the play spaces. */
  clear(x: number, z: number, width: number): boolean;
  /** Trees: x, z, scale, kind. */
  readonly trees: readonly (readonly [number, number, number, "broadleaf" | "pine" | "dead"])[];
  /** Ivy and vines: wall faces as x, y, z of the face's centre, its width, height and yaw. */
  readonly walls: readonly (readonly [number, number, number, number, number, number])[];
}

const dummy = new Object3D();
dummy.rotation.order = "YXZ";

export function instanced(
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

/** One geometry from parts, each with its own vertex colour: a plant is one draw. */
function merge(parts: readonly (readonly [BufferGeometry, number])[]): BufferGeometry {
  const flat = parts.map(([g, color]) => [g.index === null ? g : g.toNonIndexed(), color] as const);
  const count = flat.reduce((sum, [g]) => sum + (g.attributes.position?.count ?? 0), 0);
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const colour = new Float32Array(count * 3);
  let at = 0;
  const tint = new Color();
  for (const [g, color] of flat) {
    if (g.attributes.normal === undefined) g.computeVertexNormals();
    const n = g.attributes.position?.count ?? 0;
    position.set(g.attributes.position?.array ?? [], at * 3);
    normal.set(g.attributes.normal?.array ?? [], at * 3);
    tint.setHex(color);
    for (let i = 0; i < n; i += 1) colour.set([tint.r, tint.g, tint.b], (at + i) * 3);
    at += n;
  }
  const merged = new BufferGeometry();
  merged.setAttribute("position", new BufferAttribute(position, 3));
  merged.setAttribute("normal", new BufferAttribute(normal, 3));
  merged.setAttribute("color", new BufferAttribute(colour, 3));
  return merged;
}

/** A lit plant material whose vertices above y = 0 sway with the wind, each instance on its own phase. */
function swaying(amount: number, vertexColors = true, color = 0xffffff): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ color, roughness: 0.85, vertexColors });
  const phase = hash(instanceIndex).mul(6.28);
  const height = positionLocal.y.max(0);
  const bend = height.mul(height).mul(amount);
  material.positionNode = positionLocal.add(
    vec3(
      sin(time.mul(1.7).add(phase)).mul(bend),
      0,
      sin(time.mul(1.2).add(phase.mul(1.7)))
        .mul(bend)
        .mul(0.6),
    ),
  );
  return material;
}

/** A fan of thin cones leaning out from the root: grass blades or fern fronds. */
function fan(
  blades: number,
  radius: number,
  length: number,
  lean: number,
  color: number,
  flatten = 1,
): BufferGeometry {
  return merge(
    Array.from({ length: blades }, (_, i) => {
      const yaw = (i / blades) * Math.PI * 2 + i * 0.7;
      const blade = new ConeGeometry(radius, length * (0.75 + ((i * 37) % 10) / 40), 3)
        .translate(0, length / 2, 0)
        .scale(1, 1, flatten)
        .rotateX(lean * (0.7 + ((i * 13) % 5) / 10))
        .rotateY(yaw);
      return [blade, color] as const;
    }),
  );
}

/** Plants the clearing and the hills round it. Returns the group and the contact-shade spots. */
export function plantVale(site: IValeSite): {
  readonly group: Group;
  readonly shade: readonly (readonly [number, number, number])[];
} {
  const { rng, clearing, clear } = site;
  const group = new Group();
  group.name = "planting";
  const spin = (): number => rng() * Math.PI * 2;
  const shade: [number, number, number][] = [];
  const P = (x: number, y: number, z: number, s: number, sy = s, yaw = spin()): Placement => [
    x,
    y,
    z,
    s,
    sy,
    s,
    0,
    yaw,
    0,
  ];

  // Trees. Broadleaf: a trunk and three crown blobs in two greens. Pine: a trunk and a stack of
  // cones. Dead: bare grey wood with two limbs. A stump beside some.
  const trunks: Placement[] = [];
  const crowns: Placement[] = [];
  const crownsLight: Placement[] = [];
  const pines: Placement[] = [];
  const dead: Placement[] = [];
  const stumps: Placement[] = [];
  for (const [x, z, s, kind] of site.trees) {
    shade.push([x, z, 1.4 * s]);
    if (kind === "dead") {
      dead.push(P(x, 0, z, s));
      continue;
    }
    if (kind === "pine") {
      pines.push(P(x, 0, z, s * (0.9 + rng() * 0.4), s * (1 + rng() * 0.5)));
      continue;
    }
    const h = (3.2 + rng() * 1.6) * s;
    trunks.push([x, 0, z, s, h, s, 0, spin(), 0]);
    for (let i = 0; i < 3; i += 1) {
      const r = (1.1 + rng() * 0.6) * s;
      (i === 0 ? crowns : crownsLight).push([
        x + (rng() - 0.5) * 1.2 * s,
        h + (rng() - 0.2) * 0.8 * s,
        z + (rng() - 0.5) * 1.2 * s,
        r,
        r * 0.8,
        r,
        0,
        spin(),
        0,
      ]);
    }
    if (rng() < 0.3) stumps.push(P(x + 1.6, 0, z + 1.1, 0.8 + rng() * 0.5));
  }
  const bark = lit(C.bark);
  group.add(
    instanced(new CylinderGeometry(0.18, 0.32, 1, 7).translate(0, 0.5, 0), bark, trunks, true),
    instanced(new IcosahedronGeometry(1, 1), lit(C.leaf, { flat: true }), crowns, true),
    instanced(new IcosahedronGeometry(1, 1), lit(C.leafLight, { flat: true }), crownsLight, true),
    instanced(
      merge([
        [new CylinderGeometry(0.12, 0.22, 1.4, 6).translate(0, 0.7, 0), C.bark],
        [new ConeGeometry(1.3, 1.8, 8).translate(0, 1.7, 0), C.pine],
        [new ConeGeometry(1.0, 1.5, 8).translate(0, 2.6, 0), C.pine],
        [new ConeGeometry(0.65, 1.3, 8).translate(0, 3.4, 0), C.pineLight],
      ]),
      lit(0xffffff, { flat: true, vertexColors: true }),
      pines,
      true,
    ),
    instanced(
      merge([
        [new CylinderGeometry(0.1, 0.24, 3, 6).translate(0, 1.5, 0), C.deadwood],
        [
          new CylinderGeometry(0.04, 0.08, 1.3, 5)
            .translate(0, 0.65, 0)
            .rotateZ(0.9)
            .translate(0, 1.9, 0),
          C.deadwood,
        ],
        [
          new CylinderGeometry(0.03, 0.07, 1, 5)
            .translate(0, 0.5, 0)
            .rotateZ(-0.8)
            .translate(0, 2.4, 0),
          C.deadwood,
        ],
      ]),
      lit(0xffffff, { vertexColors: true }),
      dead,
      true,
    ),
    instanced(
      merge([
        [new CylinderGeometry(0.28, 0.36, 0.45, 8).translate(0, 0.22, 0), C.bark],
        [new CylinderGeometry(0.27, 0.27, 0.03, 8).translate(0, 0.46, 0), C.woodRing],
      ]),
      lit(0xffffff, { vertexColors: true }),
      stumps,
      true,
    ),
  );
  for (const [x, , z, s] of stumps) shade.push([x, z, 0.6 * s]);

  // Undergrowth inside the clearing, mostly along the walls and round the trees; the path, the
  // spawn yard and the fights stay open. `edge` picks a spot within `band` metres of a wall.
  const inside = (band: number, width: number): [number, number] | undefined => {
    for (let tries = 0; tries < 10; tries += 1) {
      const side = rng();
      const d = rng() * band;
      const along = rng();
      const x =
        side < 0.35
          ? -clearing.half + d
          : side < 0.7
            ? clearing.half - d
            : -clearing.half + along * clearing.half * 2;
      const z =
        side < 0.7
          ? clearing.north + along * (clearing.south - clearing.north)
          : side < 0.85
            ? clearing.north + d
            : clearing.south - d;
      if (clear(x, z, width)) return [x, z];
    }
    return undefined;
  };
  const anywhere = (width: number): [number, number] | undefined => {
    for (let tries = 0; tries < 10; tries += 1) {
      const x = (rng() * 2 - 1) * clearing.half;
      const z = clearing.north + rng() * (clearing.south - clearing.north);
      if (clear(x, z, width)) return [x, z];
    }
    return undefined;
  };
  // And the hills outside the walls, out to `reach`, where nothing needs to stay open.
  const outside = (reach: number): [number, number] => {
    const angle = spin();
    const r = 24 + rng() * reach;
    return [Math.cos(angle) * r, Math.sin(angle) * r * 0.9 - 2];
  };

  const bushes: Placement[] = [];
  const bushesLight: Placement[] = [];
  for (let i = 0; i < 70; i += 1) {
    const spot = i < 40 ? inside(4, 1.2) : outside(18);
    if (spot === undefined) continue;
    const s = 0.5 + rng() * 0.6;
    (rng() < 0.5 ? bushes : bushesLight).push(P(spot[0], 0.1, spot[1], s, s * 0.7));
    shade.push([spot[0], spot[1], 0.8 * s]);
  }
  group.add(
    instanced(new IcosahedronGeometry(1, 1), lit(C.bush, { flat: true }), bushes, true),
    instanced(new IcosahedronGeometry(1, 1), lit(C.leafLight, { flat: true }), bushesLight, true),
  );

  const ferns: Placement[] = [];
  for (let i = 0; i < 90; i += 1) {
    const spot = i < 60 ? inside(5, 0.8) : outside(10);
    if (spot !== undefined) ferns.push(P(spot[0], 0, spot[1], 0.7 + rng() * 0.6));
  }
  group.add(instanced(fan(7, 0.1, 0.8, 1.05, C.fern, 0.3), swaying(0.12), ferns, false));

  // Flower clusters: five heads on thin stems, one colour per cluster.
  const cluster = (head: number): BufferGeometry =>
    merge(
      Array.from({ length: 5 }, (_, i) => {
        const a = i * 1.3;
        const r = 0.08 + (i % 3) * 0.07;
        const h = 0.22 + (i % 2) * 0.1;
        return [
          [
            new CylinderGeometry(0.008, 0.01, h, 3).translate(
              Math.cos(a) * r,
              h / 2,
              Math.sin(a) * r,
            ),
            C.grassDark,
          ],
          [new IcosahedronGeometry(0.045, 0).translate(Math.cos(a) * r, h, Math.sin(a) * r), head],
        ] as const;
      }).flat(),
    );
  for (const head of [C.flowerGold, C.flowerWhite, C.flowerViolet]) {
    const placements: Placement[] = [];
    for (let i = 0; i < 45; i += 1) {
      const spot = anywhere(0.5);
      if (spot !== undefined) placements.push(P(spot[0], 0, spot[1], 0.9 + rng() * 0.5));
    }
    group.add(instanced(cluster(head), swaying(0.5), placements, false));
  }

  // Meadow tufts everywhere but the path, tall grass in clumps along the walls.
  const tufts: Placement[] = [];
  for (let i = 0; i < 1500; i += 1) {
    const x = (rng() * 2 - 1) * clearing.half;
    const z = clearing.north + rng() * (clearing.south - clearing.north);
    if (Math.abs(x - site.pathX(z)) < 1.6) continue;
    tufts.push(P(x, 0, z, 0.7 + rng() * 0.9, 0.6 + rng() * 0.9));
  }
  const tall: Placement[] = [];
  for (let i = 0; i < 160; i += 1) {
    const spot = i < 110 ? inside(3, 0.6) : outside(8);
    if (spot !== undefined) tall.push(P(spot[0], 0, spot[1], 0.8 + rng() * 0.5, 0.8 + rng() * 0.7));
  }
  group.add(
    instanced(fan(3, 0.04, 0.38, 0.35, C.grassTip), swaying(1.1), tufts, false),
    instanced(fan(6, 0.035, 0.95, 0.3, C.grassTall), swaying(0.35), tall, false),
  );

  // Mushrooms in rings under the trees, fallen logs, and rocks and pebbles.
  const mushrooms: Placement[] = [];
  for (const [x, z] of site.trees.slice(0, 12)) {
    for (let i = 0; i < 4; i += 1) {
      const a = spin();
      mushrooms.push(P(x + Math.cos(a) * 1.1, 0, z + Math.sin(a) * 1.1, 0.7 + rng() * 0.6));
    }
  }
  group.add(
    instanced(
      merge([
        [new CylinderGeometry(0.035, 0.045, 0.16, 6).translate(0, 0.08, 0), C.mushroomStem],
        [
          new SphereGeometry(0.11, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.15, 0),
          C.mushroomCap,
        ],
        [new CylinderGeometry(0.025, 0.035, 0.1, 6).translate(0.12, 0.05, 0.05), C.mushroomStem],
        [
          new SphereGeometry(0.07, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2).translate(
            0.12,
            0.09,
            0.05,
          ),
          C.mushroomCap,
        ],
      ]),
      lit(0xffffff, { vertexColors: true }),
      mushrooms,
      false,
    ),
  );
  const logs: Placement[] = [];
  for (let i = 0; i < 7; i += 1) {
    const spot = i < 4 ? inside(4, 3) : outside(10);
    if (spot === undefined) continue;
    logs.push([spot[0], 0, spot[1], 1, 1, 0.8 + rng() * 0.6, 0, spin(), 0]);
    shade.push([spot[0], spot[1], 1.3]);
  }
  group.add(
    instanced(
      merge([
        [
          new CylinderGeometry(0.26, 0.3, 1, 8)
            .rotateX(Math.PI / 2)
            .scale(1, 1, 3)
            .translate(0, 0.24, 0),
          C.bark,
        ],
        [new BoxGeometry(0.3, 0.05, 2.2).translate(0, 0.5, 0), C.moss],
      ]),
      lit(0xffffff, { vertexColors: true }),
      logs,
      true,
    ),
  );
  const rocks: Placement[] = [];
  for (let i = 0; i < 46; i += 1) {
    const spot = i < 26 ? inside(3, 1.5) : outside(16);
    if (spot === undefined) continue;
    const s = 0.6 + rng() * 1.1;
    rocks.push([
      spot[0],
      s * 0.3,
      spot[1],
      s * (1 + rng() * 0.4),
      s * (0.6 + rng() * 0.3),
      s,
      0,
      spin(),
      0,
    ]);
    shade.push([spot[0], spot[1], 1.2 * s]);
  }
  const pebbles: Placement[] = [];
  for (let i = 0; i < 60; i += 1) {
    const z = clearing.north + rng() * (clearing.south - clearing.north);
    const side = rng() < 0.5 ? -1 : 1;
    const s = 0.08 + rng() * 0.14;
    pebbles.push([
      site.pathX(z) + side * (1 + rng() * 0.6),
      0,
      z,
      s * 1.3,
      s * 0.6,
      s,
      0,
      spin(),
      0,
    ]);
  }
  const stone = lit(palette.stone, { flat: true, vertexColors: true });
  group.add(
    instanced(mottle(new DodecahedronGeometry(1, 0), 0.25, rng), stone, rocks, true),
    instanced(mottle(new DodecahedronGeometry(1, 0), 0.25, rng), stone, pebbles, false),
  );

  // Ivy clumps on the wall faces and vines hanging from their tops.
  const ivy: Placement[] = [];
  const vines: Placement[] = [];
  for (const [x, y, z, w, h, yaw] of site.walls) {
    const across = (u: number): [number, number] => [
      x + Math.cos(yaw) * (u - 0.5) * w,
      z - Math.sin(yaw) * (u - 0.5) * w,
    ];
    // Ivy grows in patches that spill from the top of a wall: a dense head of leaves, a few
    // trailing clumps under it, and vines hanging lower still.
    const patches = Math.max(1, Math.round(w * 0.22));
    for (let i = 0; i < patches; i += 1) {
      const u = (i + 0.2 + rng() * 0.6) / patches;
      for (let k = 0; k < 7; k += 1) {
        const [cx, cz] = across(u + (rng() - 0.5) * (1.6 / w));
        const drop = k < 4 ? rng() * 0.6 : 0.6 + rng() * h * 0.45;
        const s = (k < 4 ? 0.45 : 0.3) + rng() * 0.25;
        ivy.push([cx, y + h / 2 - drop, cz, s * 1.5, s, s * 0.3, 0, yaw, rng()]);
      }
      for (let k = 0; k < 3; k += 1) {
        const [vx, vz] = across(u + (rng() - 0.5) * (1.4 / w));
        vines.push([vx, y + h / 2, vz, 1, 0.8 + rng() * h * 0.6, 1, 0, yaw, 0]);
      }
    }
  }
  group.add(
    instanced(new IcosahedronGeometry(1, 0), lit(C.ivy, { flat: true }), ivy, false),
    instanced(
      merge([
        [new BoxGeometry(0.05, 1, 0.05).translate(0, -0.5, 0), C.ivy],
        [new OctahedronGeometry(0.09, 0).translate(0.05, -0.35, 0.02), C.leaf],
        [new OctahedronGeometry(0.08, 0).translate(-0.05, -0.7, 0.02), C.leaf],
      ]),
      lit(0xffffff, { flat: true, vertexColors: true }),
      vines,
      false,
    ),
  );

  // Fireflies: tiny warm glows that wander round where they hang, never a light of their own.
  const flies: Placement[] = [];
  for (let i = 0; i < 40; i += 1) {
    const spot = i < 25 ? inside(5, 0) : outside(6);
    if (spot !== undefined) flies.push(P(spot[0], 0.5 + rng() * 1.6, spot[1], 1));
  }
  const fly = new MeshStandardNodeMaterial({ color: 0x000000, emissive: C.firefly, roughness: 1 });
  fly.emissiveIntensity = 6;
  const drift = hash(instanceIndex).mul(6.28);
  fly.positionNode = positionLocal.add(
    vec3(
      sin(time.mul(0.6).add(drift)).mul(0.5),
      sin(time.mul(0.9).add(drift.mul(1.3))).mul(0.3),
      cos(time.mul(0.5).add(drift)).mul(0.5),
    ),
  );
  group.add(instanced(new OctahedronGeometry(0.035, 0), fly, flies, false));
  return { group, shade };
}

/**
 * The vale's floor: a 140 m vertex-coloured plane. Flat where Wren walks, mounds against the
 * walls, hills beyond; grass, moss, dirt and leaf-litter patches; the worn path; contact shade.
 */
export function valeGround(
  site: IValeSite,
  shade: readonly (readonly [number, number, number])[],
): Mesh {
  const { clearing } = site;
  const geometry = new PlaneGeometry(140, 140, 140, 140).rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  if (position === undefined) throw new Error("valeGround: the plane has no positions.");
  const colour = new Float32Array(position.count * 3);
  const swatch = (hex: number): Color => new Color(hex);
  const grass = swatch(palette.grass);
  const grassDark = swatch(C.grassDark);
  const moss = swatch(C.moss);
  const dirt = swatch(C.dirt);
  const litter = swatch(C.litter);
  const path = swatch(C.path);
  const c = new Color();
  const wave = (x: number, z: number, f: number): number =>
    0.5 + 0.25 * (Math.sin(x * f + z * f * 0.55) + Math.sin(z * f * 1.4 - x * f * 0.37 + 1.3));
  const smooth = (a: number, b: number, t: number): number => {
    const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    // Distance inside the clearing's walls (negative outside them).
    const edge = Math.min(clearing.half - Math.abs(x), z - clearing.north, clearing.south - z);
    // The cave tunnel behind the north cliff keeps its floor at 0.
    const tunnel = Math.abs(x) < 4 && z > clearing.north - 10;
    const hills = edge < 0 && !tunnel ? Math.min(1, -edge / 12) * (0.8 + 3 * wave(x, z, 0.09)) : 0;
    const mound = edge >= 0 && edge < 2.5 ? (1 - edge / 2.5) * 0.3 * wave(x, z, 0.4) : 0;
    position.setY(i, hills + mound);

    c.copy(grass).lerp(grassDark, wave(x, z, 0.21) * 0.8);
    c.lerp(moss, smooth(0.62, 0.8, wave(x + 40, z - 17, 0.33)) * 0.8);
    c.lerp(dirt, smooth(0.74, 0.86, wave(x - 9, z + 31, 0.27)) * 0.7);
    let nearTree = 0;
    for (const [tx, tz, tr] of site.trees) {
      const d = Math.hypot(x - tx, z - tz);
      nearTree = Math.max(nearTree, 1 - smooth(1.2 * tr, 3.4 * tr, d));
    }
    c.lerp(litter, nearTree * 0.75 * (0.6 + 0.4 * wave(x, z, 0.9)));
    if (z > clearing.north - 4 && z < clearing.south) {
      const off = Math.abs(x - site.pathX(z)) + (wave(x, z, 1.3) - 0.5) * 0.6;
      c.lerp(path, (1 - smooth(0.8, 1.6, off)) * 0.9);
    }
    // Contact shade: under every trunk, rock, bush and log, and along the foot of the walls.
    let light = 1;
    for (const [sx, sz, sr] of shade) {
      const d = Math.hypot(x - sx, z - sz);
      if (d < sr * 1.7) light *= 1 - 0.45 * (1 - smooth(sr * 0.5, sr * 1.7, d));
    }
    if (edge >= 0) light *= 0.62 + 0.38 * smooth(0, 1.8, edge);
    c.multiplyScalar(light);
    colour.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colour, 3));
  geometry.computeVertexNormals();
  const ground = new Mesh(geometry, lit(0xffffff, { vertexColors: true }));
  ground.receiveShadow = true;
  return ground;
}
