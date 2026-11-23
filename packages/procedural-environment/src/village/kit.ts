import { BoxGeometry, Color, ConeGeometry, ExtrudeGeometry, Shape, Vector2 } from "three";
import { DungeonMesh, type IKitPalette, type XYZ } from "../dungeon/mesh.js";

export const VILLAGE_THEMES = ["Meadow Village", "Snowy Village", "Desert Village"] as const;
export const VILLAGE_BIOMES = ["forest", "tundra", "desert"] as const;

export interface IVillagePalette extends IKitPalette {
  plaster: number;
  roof: number;
  ridge: number;
  door: number;
  glass: number;
  flower: number;
  hay: number;
  leaf: number;
  ground: number;
  path: number;
  water: number;
  /** How much of the growth colour (grass, snow or sand) settles on tops. */
  cover: number;
}

// Kit tones (vendor/stylized-biome-kit/palettes.js): ROCK, BARK, LEAF, GRASS and GROUND per biome.
const PALETTES: readonly IVillagePalette[] = [
  {
    stone: 0xa2a8b6,
    joint: 0x6e7488,
    growth: 0x78c644,
    wood: 0x6b4433,
    iron: 0x6a5a50,
    cloth: 0xc0453a,
    fire: 0xff962c,
    pale: 0xf4ca82,
    plaster: 0xf2e4c4,
    roof: 0xd4683f,
    ridge: 0xa84a30,
    door: 0x4f7fc0,
    glass: 0x3d5a80,
    flower: 0xf25c8a,
    hay: 0xf0c860,
    leaf: 0x2f8f3c,
    ground: 0x55b93e,
    path: 0xd9c9a0,
    water: 0x4fb4e0,
    cover: 0.25,
  },
  {
    stone: 0xc2d2ea,
    joint: 0x90a6d0,
    growth: 0xffffff,
    wood: 0x5a4a52,
    iron: 0x5c5560,
    cloth: 0x3f6fc4,
    fire: 0xffa040,
    pale: 0xf6faff,
    plaster: 0xb84a3c,
    roof: 0x4a5878,
    ridge: 0x36405a,
    door: 0x2f5a8a,
    glass: 0x6a8fc0,
    flower: 0xffd75e,
    hay: 0xe8d6a0,
    leaf: 0x5a8ccc,
    ground: 0xdfeafb,
    path: 0xc7d8f2,
    water: 0x7fb7ec,
    cover: 1.15,
  },
  {
    stone: 0xd88e7c,
    joint: 0xaf5348,
    growth: 0xe6a876,
    wood: 0x8a6a4c,
    iron: 0x5a4a44,
    cloth: 0x3f9aa8,
    fire: 0xff8a2c,
    pale: 0xffe2a8,
    plaster: 0xe8b089,
    roof: 0xc8705a,
    ridge: 0x9d4d46,
    door: 0x3fa0a0,
    glass: 0x3d5a80,
    flower: 0xf5b648,
    hay: 0xf6dc9c,
    leaf: 0xb89a2e,
    ground: 0xe8b089,
    path: 0xd99a78,
    water: 0x33a2e6,
    cover: 0.2,
  },
];

export type VillageMesh = DungeonMesh<IVillagePalette>;
export type VillagePart = (model: VillageMesh) => void;

export function villageMesh(seed: number, theme: number): VillageMesh {
  const m = new DungeonMesh(seed, theme, PALETTES);
  m.painted.set(m.palette.roof, 0.7).set(m.palette.ridge, 0.7);
  return m;
}

/** Extrude a closed XY profile through `depth` on Z, centred, then turn it by `yaw` and place it. */
export function prism(
  m: VillageMesh,
  points: [number, number][],
  depth: number,
  at: XYZ,
  color: number,
  { yaw = 0, cover = 0, wear = 0.18 }: { yaw?: number; cover?: number; wear?: number } = {},
): void {
  const shape = new Shape(points.map(([x, y]) => new Vector2(x, y)));
  const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  geometry.translate(0, 0, -depth / 2);
  if (yaw) geometry.rotateY(yaw);
  geometry.translate(...at);
  m.add(geometry, color, "solid", wear, cover);
}

/**
 * A gable roof along Z: `span` wide eave to eave, `rise` from eave to ridge, `length` along the
 * ridge, eave at `at`. Staggered tiles, each its own shade with the odd darker or sun-bleached one,
 * lie on a dark underlay so the gaps read as grooves; barge boards trim the gable ends and snow,
 * grass or sand settles on the tiles.
 */
export function roof(
  m: VillageMesh,
  at: XYZ,
  span: number,
  rise: number,
  length: number,
  { rows = 5, thick = 0.12, yaw = 0 }: { rows?: number; thick?: number; yaw?: number } = {},
): void {
  const p = m.palette;
  const half = span / 2;
  const slope = Math.hypot(half, rise);
  const cover = p.cover * 1.3;
  const bleached = new Color(p.roof).lerp(new Color(p.pale), 0.35).getHex();
  m.painted.set(bleached, 0.7);
  const tiles = Math.max(3, Math.round(length / 0.46));
  const tile = length / tiles;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const world = (px: number, py: number, along: number): XYZ => [
    at[0] + px * c + along * s,
    at[1] + py,
    at[2] - px * s + along * c,
  ];
  for (const side of [-1, 1]) {
    const nx = (side * rise) / slope;
    const ny = half / slope;
    const point = (t: number, lift: number): [number, number] => [
      side * half * (1 - t) + nx * lift,
      rise * t + ny * lift,
    ];
    const under = [point(0, -thick * 0.5), point(0, 0.02), point(1, 0.02), point(1, -thick * 0.5)];
    prism(m, side > 0 ? under : under.reverse(), length, at, p.ridge, { yaw, wear: 0.05 });
    for (let row = 0; row < rows; row++) {
      const t0 = row / rows;
      const t1 = Math.min(1, (row + 1) / rows + 0.08);
      const stagger = row % 2 ? tile / 2 : 0;
      for (let i = -1; i < tiles; i++) {
        const a = Math.max(-length / 2, -length / 2 + i * tile + stagger);
        const b = Math.min(length / 2, -length / 2 + (i + 1) * tile + stagger);
        if (b - a < tile * 0.3) continue;
        const butt = thick * m.rng.range(1.4, 2.1);
        const profile = [point(t0, 0.02), point(t0, butt), point(t1, thick), point(t1, 0.02)];
        const pick = m.rng.next();
        const color = pick < 0.1 ? p.ridge : pick < 0.2 ? bleached : p.roof;
        prism(
          m,
          side > 0 ? profile : profile.reverse(),
          b - a - 0.035,
          world(0, 0, (a + b) / 2),
          color,
          {
            yaw,
            cover,
            wear: 0.3,
          },
        );
      }
    }
    for (const end of [-1, 1]) {
      const along = end * (length / 2 + 0.03);
      const [ex, ey] = point(0, thick * 1.2);
      const [rx, ry] = point(1, thick * 1.2);
      m.rod(world(ex, ey, along), world(rx, ry, along), 0.07, p.wood, "solid", 0.07, 4);
    }
  }
  const reach = length / 2 + 0.05;
  const end = (k: number): XYZ => world(0, rise + thick * 1.4, k * reach);
  m.rod(end(-1), end(1), thick * 1.25, p.ridge, "solid", thick * 1.25, 6);
}

/**
 * A pointed roof over a regular polygon (4 sides is a pyramid, 8 to 10 reads as a cone): staggered
 * tiles laid face by face on a dark underlay, hip ridges down each corner, a wood eave trim and a
 * finial. `radius` reaches the corners; `turn` matches ConeGeometry.rotateY.
 */
export function spire(
  m: VillageMesh,
  at: XYZ,
  radius: number,
  height: number,
  sides: number,
  turn = 0,
): void {
  const p = m.palette;
  const cover = p.cover * 1.3;
  const corner = (k: number, t: number): [number, number] => {
    const a = turn + (k * Math.PI * 2) / sides;
    return [Math.sin(a) * radius * (1 - t), Math.cos(a) * radius * (1 - t)];
  };
  const apothem = radius * Math.cos(Math.PI / sides);
  const rows = Math.max(3, Math.round(Math.hypot(apothem, height) / 0.42));
  const tile = new BoxGeometry(1, 1, 1);
  for (let k = 0; k < sides; k++) {
    const mid = turn + ((k + 0.5) * Math.PI * 2) / sides;
    const slant = Math.hypot(apothem, height);
    const normal: XYZ = [
      (Math.sin(mid) * height) / slant,
      apothem / slant,
      (Math.cos(mid) * height) / slant,
    ];
    const surface = (f: number, t: number, lift: number): XYZ => {
      const [ax, az] = corner(k, t);
      const [bx, bz] = corner(k + 1, t);
      return [
        at[0] + ax + (bx - ax) * f + normal[0] * lift,
        at[1] + height * t + normal[1] * lift,
        at[2] + az + (bz - az) * f + normal[2] * lift,
      ];
    };
    for (let row = 0; row < rows; row++) {
      const t0 = row / rows;
      const t1 = Math.min(0.97, (row + 1) / rows + 0.07);
      const width = 2 * radius * Math.sin(Math.PI / sides) * (1 - (t0 + t1) / 2);
      const count = Math.max(1, Math.round(width / 0.42));
      const stagger = row % 2 && count > 1 ? 0.5 / count : 0;
      for (let i = -1; i < count; i++) {
        const f0 = Math.max(0, i / count + stagger + 0.012);
        const f1 = Math.min(1, (i + 1) / count + stagger - 0.012);
        if (f1 - f0 < 0.25 / count) continue;
        const butt = 0.12 * m.rng.range(1.3, 2);
        const shape = tile.clone();
        const pos = shape.getAttribute("position");
        for (let v = 0; v < pos.count; v++) {
          const f = pos.getX(v) < 0 ? f0 : f1;
          const top = pos.getY(v) > 0;
          const out = pos.getZ(v) > 0;
          pos.setXYZ(v, ...surface(f, top ? t1 : t0, out ? (top ? 0.1 : butt) : 0.02));
        }
        const pick = m.rng.next();
        m.add(
          shape,
          pick < 0.12
            ? p.ridge
            : pick < 0.22
              ? new Color(p.roof).lerp(new Color(p.pale), 0.35).getHex()
              : p.roof,
          "solid",
          0.3,
          cover,
        );
      }
    }
    const [ex, ez] = corner(k, 0);
    m.rod(
      [at[0] + ex * 1.01, at[1] + 0.1, at[2] + ez * 1.01],
      [at[0], at[1] + height + 0.05, at[2]],
      0.08,
      p.ridge,
      "solid",
      0.05,
      5,
    );
    const [fx, fz] = corner(k + 1, 0);
    m.rod(
      [at[0] + ex, at[1] + 0.02, at[2] + ez],
      [at[0] + fx, at[1] + 0.02, at[2] + fz],
      0.07,
      p.wood,
      "solid",
      0.07,
      4,
    );
  }
  tile.dispose();
  m.painted.set(new Color(p.roof).lerp(new Color(p.pale), 0.35).getHex(), 0.7);
  m.add(
    new ConeGeometry(radius * 0.99, height, sides, 1)
      .rotateY(turn)
      .translate(at[0], at[1] + height / 2, at[2]),
    p.ridge,
    "solid",
    0.05,
  );
  m.rod(
    [at[0], at[1] + height, at[2]],
    [at[0], at[1] + height + 0.35, at[2]],
    0.05,
    p.iron,
    "solid",
    0.04,
    5,
  );
  m.gem([at[0], at[1] + height + 0.4, at[2]], [0.1, 0.12, 0.1], p.pale, "solid", 1);
}

/** A triangular gable end, `span` wide and `rise` tall, standing on `at` and facing Z. */
export function gable(
  m: VillageMesh,
  at: XYZ,
  span: number,
  rise: number,
  color: number,
  yaw = 0,
): void {
  prism(
    m,
    [
      [-span / 2, 0],
      [span / 2, 0],
      [0, rise],
    ],
    0.2,
    at,
    color,
    { yaw, wear: 0.1 },
  );
}

/** Draw in a local frame: `u` runs along a face, `v` points out of it, turned by `yaw` about `origin`. */
export function face(m: VillageMesh, origin: XYZ, yaw = 0) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = ([u, y, v]: XYZ): XYZ => [
    origin[0] + u * c + v * s,
    origin[1] + y,
    origin[2] - u * s + v * c,
  ];
  return {
    m,
    at,
    yaw,
    block: (center: XYZ, size: XYZ, color: number, bevel = 0.02) =>
      m.block(at(center), size, color, "solid", bevel, yaw),
    stone: (center: XYZ, size: XYZ, cover = 0) => m.stone(at(center), size, cover, 0.05, yaw),
    rod: (a: XYZ, b: XYZ, r: number, color: number, sides = 5) =>
      m.rod(at(a), at(b), r, color, "solid", r, sides),
    gem: (center: XYZ, scale: XYZ, color: number, detail = 0) =>
      m.gem(at(center), scale, color, "solid", detail, yaw),
  };
}

export type Face = ReturnType<typeof face>;
