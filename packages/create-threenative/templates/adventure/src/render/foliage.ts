// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The vale's planting and its floor, an old misty forest built in code. Giant gnarled trees (a
// twisted trunk with ridged bark, thick roots and limbs, moss on every upward face) under broad
// crowns of leaf clumps that sway; far trees in a lighter cut; big lobed broadleaf plants, ferns,
// purple and pink flowers and grass tufts; mossy boulders; an irregular flagstone path; a stream;
// mushrooms and logs; ivy and vines on the cliff. Every kind is one `InstancedMesh`, so a forest
// costs a few dozen draws and no light of its own. Nothing here is solid: `level/Vale.ts` decides
// what blocks, and its height function is the floor everything here stands on.
//
// The floor is two vertex-coloured grids over that height function: a fine one where Wren walks
// (it is also her collider) and a coarse one for the hills. Soil, moss and leaf litter, rock where
// the slope passes the walk limit, dark soil under the path, a wet stream bed, contact shade.
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  type Material,
  Mesh,
  Object3D,
  OctahedronGeometry,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from "three";
import {
  cameraPosition,
  cos,
  hash,
  instanceIndex,
  positionLocal,
  positionWorld,
  sin,
  step,
  time,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { lit } from "./materials.js";
import { C, palette } from "./palette.js";
import { SUN_DIRECTION, sunShafts } from "./sky.js";

/** Where the sun shafts meet the floor, x, z and radius: down the path ahead and between giants. */
const SHAFTS = [
  [-2.5, -1, 0.7],
  [2.8, -6, 0.9],
  [-5.5, -8.5, 0.6],
  [1.2, -11.5, 0.8],
  [7.5, -1.5, 0.7],
  [-8.5, 0.5, 0.9],
  [9, -9, 0.6],
  [-2.8, 3.5, 0.5],
  [-10, -11, 0.8],
] as const;

/** x, y, z, scale x, y, z, rotation x, y, z. */
type Placement = readonly [number, number, number, number, number, number, number, number, number];

/** Where the vale may be planted, and what already stands in it. */
export interface IValeSite {
  readonly rng: () => number;
  /** The clearing's walkable box, x from -half to half, z from north to south. */
  readonly clearing: { readonly half: number; readonly north: number; readonly south: number };
  /** The ground's height at (x, z): everything here stands on it. */
  height(x: number, z: number): number;
  /** The path's centre line: x at a given z. */
  pathX(z: number): number;
  /** Whether a plant this wide may stand at (x, z) inside the clearing: off the play spaces. */
  clear(x: number, z: number, width: number): boolean;
  /** The stream: its centre line, its water level and the distance to it. */
  readonly stream: {
    readonly points: readonly (readonly [number, number])[];
    readonly water: number;
    distance(x: number, z: number): number;
  };
  /** Trees: x, z, scale, kind. */
  readonly trees: readonly (readonly [number, number, number, "giant" | "far"])[];
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

/** Gives a geometry one flat vertex colour. */
function paint(geometry: BufferGeometry, color: number): BufferGeometry {
  const g = geometry.index === null ? geometry : geometry.toNonIndexed();
  const n = g.attributes.position?.count ?? 0;
  const tint = new Color(color);
  const colour = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) colour.set([tint.r, tint.g, tint.b], i * 3);
  g.setAttribute("color", new BufferAttribute(colour, 3));
  return g;
}

/** One geometry from coloured parts (each with a `color` attribute): a plant is one draw. */
function mergeAll(parts: readonly BufferGeometry[]): BufferGeometry {
  const flat = parts.map((g) => (g.index === null ? g : g.toNonIndexed()));
  const count = flat.reduce((sum, g) => sum + (g.attributes.position?.count ?? 0), 0);
  const withUv = flat.every((g) => g.attributes.uv !== undefined);
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const colour = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let at = 0;
  for (const g of flat) {
    if (g.attributes.normal === undefined) g.computeVertexNormals();
    position.set(g.attributes.position?.array ?? [], at * 3);
    normal.set(g.attributes.normal?.array ?? [], at * 3);
    colour.set(g.attributes.color?.array ?? [], at * 3);
    if (withUv) uv.set(g.attributes.uv?.array ?? [], at * 2);
    at += g.attributes.position?.count ?? 0;
  }
  const merged = new BufferGeometry();
  merged.setAttribute("position", new BufferAttribute(position, 3));
  merged.setAttribute("normal", new BufferAttribute(normal, 3));
  merged.setAttribute("color", new BufferAttribute(colour, 3));
  if (withUv) merged.setAttribute("uv", new BufferAttribute(uv, 2));
  return merged;
}

/** Parts with one flat colour each, merged. */
function merge(parts: readonly (readonly [BufferGeometry, number])[]): BufferGeometry {
  return mergeAll(parts.map(([g, color]) => paint(g, color)));
}

/** A lit plant material whose vertices above y = 0 sway with the wind, each instance on its own phase. */
function swaying(amount: number, vertexColors = true, color = 0xffffff): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    color,
    roughness: 0.8,
    side: DoubleSide,
    vertexColors,
  });
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
  // A plant the camera has pushed into is cut away within a metre and a half of the lens, so a
  // leaf never fills the frame; its shadow stays.
  material.alphaTest = 0.5;
  material.opacityNode = step(1.5, positionWorld.distance(cameraPosition));
  return material;
}

/** A crown's leaf clumps: the whole clump rocks slowly in the wind, the far side of it more. */
function canopyMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.75,
    side: DoubleSide,
    vertexColors: true,
  });
  const phase = hash(instanceIndex).mul(6.28);
  const reach = positionLocal.length().mul(0.06);
  material.positionNode = positionLocal.add(
    vec3(
      sin(time.mul(0.8).add(phase)),
      sin(time.mul(1.3).add(phase.mul(2))).mul(0.4),
      cos(time.mul(0.6).add(phase)),
    ).mul(reach),
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

/** The outline of a broad leaf, across (x) and along (y), base at the origin, tip at y = 1. */
const LEAF_OUTLINE: readonly (readonly [number, number])[] = [
  [0, 0],
  [-0.3, 0.14],
  [-0.46, 0.36],
  [-0.4, 0.6],
  [-0.2, 0.84],
  [0, 1],
  [0.2, 0.84],
  [0.4, 0.6],
  [0.46, 0.36],
  [0.3, 0.14],
];

/** One broad leaf, `length` long, cupped along its midrib, base colour fading to `tip`. */
function leaf(length: number, width: number, base: Color, tip: Color, cup = 0.12): BufferGeometry {
  const centre: readonly [number, number] = [0, 0.45];
  const position: number[] = [];
  const colour: number[] = [];
  const vertex = (x: number, y: number): void => {
    position.push(x * width, y * length, -cup * length * (x * 2) ** 2);
    const c = base.clone().lerp(tip, y);
    colour.push(c.r, c.g, c.b);
  };
  for (let i = 0; i < LEAF_OUTLINE.length; i += 1) {
    const a = LEAF_OUTLINE[i] ?? [0, 0];
    const b = LEAF_OUTLINE[(i + 1) % LEAF_OUTLINE.length] ?? [0, 0];
    vertex(centre[0], centre[1]);
    vertex(a[0], a[1]);
    vertex(b[0], b[1]);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(position), 3));
  g.setAttribute("color", new BufferAttribute(new Float32Array(colour), 3));
  g.computeVertexNormals();
  return g;
}

/**
 * A clump of broad leaves round its centre, facing out and up, in two greens: a piece of crown.
 * `leaves` sets the cost: a near crown wants 14, a far one 6 bigger ones.
 */
function leafClump(leaves: number, leafLength: number, rng: () => number): BufferGeometry {
  const deep = new Color(C.leafDeep);
  const sun = new Color(C.leafSun);
  const holder = new Object3D();
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < leaves; i += 1) {
    // Out from the centre, biased up: the crown's top catches the light.
    const u = rng() * 2 - 1 + 0.35;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - Math.min(1, u) ** 2));
    const out = new Vector3(Math.cos(a) * r, Math.min(1, u), Math.sin(a) * r).normalize();
    holder.position.copy(out).multiplyScalar(0.35 + rng() * 0.7);
    holder.lookAt(
      holder.position
        .clone()
        .add(out)
        .add(new Vector3(0, 0.6, 0)),
    );
    holder.rotateZ(rng() * Math.PI * 2);
    holder.updateMatrix();
    const light = 0.25 + 0.75 * (out.y * 0.5 + 0.5) * rng();
    const tint = deep.clone().lerp(sun, light);
    const g = leaf(
      leafLength * (0.8 + rng() * 0.4),
      leafLength * 0.75,
      deep.clone().lerp(tint, 0.5),
      tint,
    );
    g.translate(0, -leafLength * 0.4, 0);
    parts.push(g.applyMatrix4(holder.matrix));
  }
  return mergeAll(parts);
}

/** A tube along `points` whose radius follows `radius(t)`, with twisted ridges: bark, root or limb. */
function limb(
  points: readonly Vector3[],
  radius: (t: number) => number,
  segments: number,
  sides: number,
  ridges: number,
): BufferGeometry {
  const curve = new CatmullRomCurve3([...points]);
  const tube = new TubeGeometry(curve, segments, 1, sides, false);
  const position = tube.attributes.position;
  if (position === undefined) throw new Error("limb: the tube has no positions.");
  const centre = new Vector3();
  const p = new Vector3();
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    curve.getPointAt(t, centre);
    for (let j = 0; j <= sides; j += 1) {
      const k = i * (sides + 1) + j;
      const angle = (j / sides) * Math.PI * 2;
      const ridge =
        1 + ridges * (0.6 * Math.sin(angle * 3 + t * 9) + 0.4 * Math.sin(angle * 5 - t * 14));
      p.fromBufferAttribute(position, k)
        .sub(centre)
        .multiplyScalar(radius(t) * ridge)
        .add(centre);
      position.setXYZ(k, p.x, p.y, p.z);
    }
  }
  tube.computeVertexNormals();
  return tube;
}

/** Colours bark by its normal: moss on every face that looks up, bark below, darker at the foot. */
export function mossBark(geometry: BufferGeometry, moss: number): BufferGeometry {
  const g = geometry.index === null ? geometry : geometry.toNonIndexed();
  g.computeVertexNormals();
  const normal = g.attributes.normal;
  const position = g.attributes.position;
  if (normal === undefined || position === undefined) return g;
  const bark = new Color(C.bark);
  const deep = new Color(C.barkDeep);
  const green = new Color(C.forestMoss);
  const bright = new Color(C.mossBright);
  const colour = new Float32Array(position.count * 3);
  const c = new Color();
  for (let i = 0; i < position.count; i += 1) {
    const ny = normal.getY(i);
    const y = position.getY(i);
    const grain = 0.5 + 0.5 * Math.sin(position.getX(i) * 7.1 + y * 3.3 + position.getZ(i) * 5.7);
    c.copy(deep).lerp(bark, 0.4 + 0.6 * grain);
    const onTop = Math.min(1, Math.max(0, (ny - 0.15) / 0.5));
    const atFoot = Math.max(0, 1 - y / 2.2);
    c.lerp(
      green.clone().lerp(bright, grain * 0.6),
      Math.min(1, onTop * moss + atFoot * 0.5 * moss),
    );
    colour.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("color", new BufferAttribute(colour, 3));
  return g;
}

interface ITreeModel {
  readonly wood: BufferGeometry;
  /** Crown clump centres, in the tree's own space, with a clump scale each. */
  readonly crown: readonly (readonly [number, number, number, number])[];
}

/**
 * One gnarled tree, about 9 m tall at scale 1: a leaning, twisting trunk with flared ridged bark,
 * `roots` thick roots that arc out and dive into the soil, and `limbs` limbs ending in crown
 * clumps. `rich` adds rings and sides for a tree near the path.
 */
function gnarledTree(rng: () => number, roots: number, limbs: number, rich: boolean): ITreeModel {
  const height = 5.6 + rng() * 1.4;
  const lean = new Vector3(rng() - 0.5, 0, rng() - 0.5).multiplyScalar(1.6);
  const spine: Vector3[] = [];
  for (let i = 0; i <= 5; i += 1) {
    const t = i / 5;
    spine.push(
      new Vector3(
        lean.x * t * t + Math.sin(t * 4 + rng()) * 0.35,
        -0.4 + t * height,
        lean.z * t * t + Math.cos(t * 3.4 + rng()) * 0.35,
      ),
    );
  }
  const trunkRadius = (t: number): number =>
    0.42 + 0.5 * (1 - t) ** 3 + 0.55 * Math.max(0, 0.12 - t) * 8;
  const parts = [limb(spine, trunkRadius, rich ? 14 : 8, rich ? 10 : 6, rich ? 0.16 : 0.1)];
  const at = (t: number): Vector3 => new CatmullRomCurve3(spine).getPointAt(t);
  for (let i = 0; i < roots; i += 1) {
    const a = (i / roots) * Math.PI * 2 + rng() * 0.6;
    const reach = 1.8 + rng() * 1.4;
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const root = [
      new Vector3(0, 0.9 + rng() * 0.5, 0).addScaledVector(out, 0.2),
      new Vector3(0, 0.5, 0).addScaledVector(out, reach * 0.35),
      new Vector3(0, 0.2 + rng() * 0.15, 0).addScaledVector(out, reach * 0.7),
      new Vector3(0, -0.35, 0).addScaledVector(out, reach),
    ];
    parts.push(limb(root, (t) => 0.42 * (1 - t) ** 1.3 + 0.05, rich ? 7 : 4, rich ? 6 : 4, 0.08));
  }
  const crown: [number, number, number, number][] = [];
  const top = at(1);
  crown.push([top.x, top.y + 0.6, top.z, 1.9]);
  for (let i = 0; i < limbs; i += 1) {
    const t = 0.38 + (i / limbs) * 0.45;
    const from = at(t);
    const a = (i / limbs) * Math.PI * 2 + rng() * 0.8;
    const reach = 2.4 + rng() * 2;
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const end = from
      .clone()
      .addScaledVector(out, reach)
      .add(new Vector3(0, 1.2 + rng() * 1.6, 0));
    const kink = from
      .clone()
      .addScaledVector(out, reach * 0.45)
      .add(new Vector3(0, 0.2 + rng() * 0.6, 0));
    parts.push(
      limb([from, kink, end], (u) => 0.24 * (1 - u) + 0.06, rich ? 6 : 4, rich ? 5 : 4, 0.06),
    );
    crown.push([end.x, end.y + 0.3, end.z, 1.4 + rng() * 0.6]);
    crown.push([kink.x + out.x * 0.4, kink.y + 0.9, kink.z + out.z * 0.4, 1 + rng() * 0.4]);
  }
  return {
    crown,
    wood: mossBark(mergeAll(parts.map((g) => paint(g, 0xffffff))), rich ? 0.9 : 0.6),
  };
}

/** Rotation x and z (in a YXZ euler with yaw `yaw`) that stand an object on a slope of normal `n`. */
function tiltTo(n: Vector3, yaw: number): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const lx = n.x * c - n.z * s;
  const lz = n.x * s + n.z * c;
  return [Math.atan2(lz, n.y), Math.asin(Math.max(-1, Math.min(1, -lx)))];
}

/** Plants the clearing and the hills round it. Returns the group, the contact-shade spots and the path. */
export function plantVale(site: IValeSite): {
  readonly group: Group;
  readonly shade: readonly (readonly [number, number, number])[];
  readonly path: { readonly stones: number; readonly cover: number };
} {
  const { rng, clearing, clear, height } = site;
  const group = new Group();
  group.name = "planting";
  const spin = (): number => rng() * Math.PI * 2;
  const shade: [number, number, number][] = [];
  const P = (x: number, y: number, z: number, s: number, sy = s, yaw = spin()): Placement => [
    x,
    height(x, z) + y,
    z,
    s,
    sy,
    s,
    0,
    yaw,
    0,
  ];
  const normalAt = (x: number, z: number): Vector3 =>
    new Vector3(
      height(x - 0.3, z) - height(x + 0.3, z),
      0.6,
      height(x, z - 0.3) - height(x, z + 0.3),
    ).normalize();

  // ------------------------------------------------------------------------------ old trees
  // Three giant cuts and two far cuts; every tree is one of them, scaled and turned.
  const giants = [0, 1, 2].map(() => gnarledTree(rng, 6, 5, true));
  const fars = [0, 1].map(() => gnarledTree(rng, 3, 2, false));
  const wood = { far: fars.map((): Placement[] => []), giant: giants.map((): Placement[] => []) };
  const nearClumps: Placement[] = [];
  const farClumps: Placement[] = [];
  site.trees.forEach(([x, z, s, kind], i) => {
    const models = kind === "giant" ? giants : fars;
    const which = i % models.length;
    const model = models[which];
    if (model === undefined) return;
    const yaw = spin();
    const y = height(x, z);
    (kind === "giant" ? wood.giant : wood.far)[which]?.push([x, y, z, s, s, s, 0, yaw, 0]);
    shade.push([x, z, 1.8 * s]);
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    for (const [cx, cy, cz, cs] of model.crown) {
      // The clump centre turned with the tree: three's Y rotation, x' = x c + z s, z' = -x s + z c.
      const k = cs * s * (0.9 + rng() * 0.25);
      (kind === "giant" ? nearClumps : farClumps).push([
        x + (cx * c + cz * sn) * s,
        y + cy * s,
        z + (-cx * sn + cz * c) * s,
        k,
        k * 0.8,
        k,
        rng() * 0.4,
        spin(),
        rng() * 0.4,
      ]);
    }
  });
  const bark = lit(0xffffff, { detail: true, vertexColors: true });
  giants.forEach((model, i) => {
    group.add(instanced(model.wood, bark, wood.giant[i] ?? [], true));
  });
  // The far rings stand outside the sun's shadow window: they cast nothing.
  fars.forEach((model, i) => {
    group.add(instanced(model.wood, bark, wood.far[i] ?? [], false));
  });
  const canopy = canopyMaterial();
  group.add(
    // The crowns cast nothing: the canopy's shade (below) dapples the floor for far fewer triangles.
    instanced(leafClump(14, 0.75, rng), canopy, nearClumps, false),
    instanced(leafClump(6, 1.2, rng), canopy, farClumps, false),
  );

  // Undergrowth inside the clearing, mostly along the banks and round the trees; the path, the
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
      if (clear(x, z, width) && site.stream.distance(x, z) > 2) return [x, z];
    }
    return undefined;
  };
  const anywhere = (width: number): [number, number] | undefined => {
    for (let tries = 0; tries < 10; tries += 1) {
      const x = (rng() * 2 - 1) * clearing.half;
      const z = clearing.north + rng() * (clearing.south - clearing.north);
      if (clear(x, z, width) && site.stream.distance(x, z) > 1.6) return [x, z];
    }
    return undefined;
  };
  /** Along the path's edges, just off the stones: where the reference's foreground plants grow. */
  const verge = (width: number): [number, number] | undefined => {
    for (let tries = 0; tries < 10; tries += 1) {
      const z = clearing.north + 2 + rng() * (clearing.south - clearing.north - 2);
      const x = site.pathX(z) + (rng() < 0.5 ? -1 : 1) * (2.3 + rng() * 2.5);
      if (clear(x, z, width) && site.stream.distance(x, z) > 1.6) return [x, z];
    }
    return undefined;
  };
  // And the hills outside the walls, out to `reach`, where nothing needs to stay open.
  const outside = (reach: number): [number, number] => {
    const angle = spin();
    const r = 23 + rng() * reach;
    return [Math.cos(angle) * r, Math.sin(angle) * r * 0.9 - 2];
  };

  // Big lobed broadleaf plants: six cupped leaves raised round a crown, dark at the heart.
  const broad = new Color(C.broadleaf);
  const broadTip = new Color(C.leafSun);
  const broadleaf = mergeAll(
    Array.from({ length: 6 }, (_, i) =>
      leaf(
        0.62 + (i % 3) * 0.1,
        0.62,
        broad.clone().multiplyScalar(0.7),
        broad.clone().lerp(broadTip, 0.35),
        0.18,
      )
        .rotateX(-1.15 - (i % 2) * 0.22)
        .rotateY((i / 6) * Math.PI * 2 + i * 0.3),
    ),
  );
  const broadPlants: Placement[] = [];
  for (let i = 0; i < 90; i += 1) {
    const spot = i < 40 ? verge(1.2) : i < 75 ? inside(5, 1.2) : outside(8);
    if (spot === undefined) continue;
    const s = 0.75 + rng() * 0.7;
    broadPlants.push(P(spot[0], 0, spot[1], s, s * (0.8 + rng() * 0.3)));
  }
  group.add(instanced(broadleaf, swaying(0.05), broadPlants, true));

  const ferns: Placement[] = [];
  for (let i = 0; i < 130; i += 1) {
    const spot = i < 40 ? verge(0.8) : i < 105 ? inside(5, 0.8) : outside(10);
    if (spot !== undefined) ferns.push(P(spot[0], 0, spot[1], 0.8 + rng() * 0.7));
  }
  group.add(instanced(fan(8, 0.11, 0.95, 1.0, C.fern, 0.25), swaying(0.1), ferns, false));

  // Flower clusters: five star heads on thin stems, one colour per cluster; violet and pink most.
  const cluster = (head: number): BufferGeometry =>
    merge(
      Array.from({ length: 5 }, (_, i) => {
        const a = i * 1.3;
        const r = 0.08 + (i % 3) * 0.07;
        const h = 0.24 + (i % 2) * 0.12;
        return [
          [
            new CylinderGeometry(0.008, 0.01, h, 3, 1, true).translate(
              Math.cos(a) * r,
              h / 2,
              Math.sin(a) * r,
            ),
            C.grassDark,
          ],
          [
            new CircleGeometry(0.045, 5)
              .rotateX(-Math.PI / 2)
              .translate(Math.cos(a) * r, h, Math.sin(a) * r),
            head,
          ],
        ] as const;
      }).flat(),
    );
  for (const [head, count] of [
    [C.flowerViolet, 70],
    [C.flowerPink, 55],
    [C.flowerWhite, 18],
  ] as const) {
    const placements: Placement[] = [];
    for (let i = 0; i < count; i += 1) {
      const spot = i < count * 0.45 ? verge(0.5) : anywhere(0.5);
      if (spot !== undefined) placements.push(P(spot[0], 0, spot[1], 1 + rng() * 0.6));
    }
    group.add(instanced(cluster(head), swaying(0.5), placements, false));
  }

  // Grass tufts in the open spaces off the path, where the canopy lets light in.
  const tufts: Placement[] = [];
  for (let i = 0; i < 340; i += 1) {
    // Half of them fringe the path, where the cobbles meet the moss.
    const z = clearing.north + rng() * (clearing.south - clearing.north);
    const x =
      i % 2 === 0
        ? site.pathX(z) + (rng() < 0.5 ? -1 : 1) * (1.75 + rng() * 1.4)
        : (rng() * 2 - 1) * clearing.half;
    if (Math.abs(x - site.pathX(z)) < 1.7 || site.stream.distance(x, z) < 1.4) continue;
    tufts.push(P(x, 0, z, 0.7 + rng() * 0.9, 0.6 + rng() * 0.9));
  }
  group.add(instanced(fan(4, 0.04, 0.42, 0.4, C.grassTip), swaying(1.1), tufts, false));

  // Mushrooms in rings under the giants, fallen logs, and mossy boulders.
  const mushrooms: Placement[] = [];
  for (const [x, z, s, kind] of site.trees) {
    if (kind !== "giant") continue;
    for (let i = 0; i < 5; i += 1) {
      const a = spin();
      const r = (1.3 + rng() * 1.2) * s;
      mushrooms.push(P(x + Math.cos(a) * r, 0, z + Math.sin(a) * r, 0.7 + rng() * 0.7));
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
  for (let i = 0; i < 6; i += 1) {
    const spot = i < 3 ? inside(4, 3) : outside(10);
    if (spot === undefined) continue;
    logs.push(P(spot[0], 0.05, spot[1], 1, 1));
    shade.push([spot[0], spot[1], 1.3]);
  }
  group.add(
    instanced(
      mossBark(
        mergeAll([
          paint(
            new CylinderGeometry(0.3, 0.34, 3, 9, 4).rotateX(Math.PI / 2).translate(0, 0.28, 0),
            0xffffff,
          ),
        ]),
        1,
      ),
      lit(0xffffff, { detail: true, vertexColors: true }),
      logs,
      true,
    ),
  );

  // Boulders: lumpy, grained stone with moss on every face that looks up. Some sit at the banks'
  // feet, some crown the outcrops, a few line the stream.
  const boulder = (() => {
    const g = new IcosahedronGeometry(1, 1).toNonIndexed();
    const position = g.attributes.position;
    if (position !== undefined) {
      const v = new Vector3();
      for (let i = 0; i < position.count; i += 1) {
        v.fromBufferAttribute(position, i);
        const bump =
          1 + 0.16 * Math.sin(v.x * 4.1 + v.y * 2.3) + 0.1 * Math.sin(v.z * 5.3 - v.x * 3.1);
        v.multiplyScalar(bump);
        position.setXYZ(i, v.x, v.y * 0.8, v.z);
      }
    }
    g.computeVertexNormals();
    const normal = g.attributes.normal;
    const colour = new Float32Array((position?.count ?? 0) * 3);
    const rock = new Color(C.rock);
    const moss = new Color(C.forestMoss);
    const c = new Color();
    for (let i = 0; i < (position?.count ?? 0); i += 1) {
      const up = Math.min(1, Math.max(0, ((normal?.getY(i) ?? 0) - 0.25) / 0.45));
      c.copy(rock).lerp(moss, up * 0.92);
      colour.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute("color", new BufferAttribute(colour, 3));
    // Planar uvs for the stone grain.
    const uv = new Float32Array((position?.count ?? 0) * 2);
    for (let i = 0; i < (position?.count ?? 0); i += 1)
      uv.set(
        [
          (position?.getX(i) ?? 0) * 0.8,
          (position?.getY(i) ?? 0) * 0.8 + (position?.getZ(i) ?? 0) * 0.5,
        ],
        i * 2,
      );
    g.setAttribute("uv", new BufferAttribute(uv, 2));
    return g;
  })();
  const rocks: Placement[] = [];
  const rockAt = (x: number, z: number, s: number): void => {
    const yaw = spin();
    const [rx, rz] = tiltTo(normalAt(x, z), yaw);
    rocks.push([
      x,
      height(x, z) + s * 0.15,
      z,
      s * (1 + rng() * 0.4),
      s * (0.6 + rng() * 0.3),
      s,
      rx,
      yaw,
      rz,
    ]);
    shade.push([x, z, 1.1 * s]);
  };
  for (let i = 0; i < 40; i += 1) {
    const spot = i < 26 ? inside(4, 1.5) : outside(14);
    if (spot !== undefined) rockAt(spot[0], spot[1], 0.5 + rng() * 1.1);
  }
  for (const [x, z] of site.stream.points)
    for (let i = 0; i < 3; i += 1)
      rockAt(x + (rng() - 0.5) * 3, z + (rng() - 0.5) * 3, 0.3 + rng() * 0.4);
  const stone = lit(0xffffff, { detail: true, vertexColors: true });
  group.add(instanced(boulder, stone, rocks, true));

  // The path: rounded cobbles, two to four across, a few centimetres proud of the dark soil and
  // its moss, each tipped to the slope it lies on.
  const slab = (() => {
    const g = new SphereGeometry(1, 9, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    const position = g.attributes.position;
    if (position !== undefined) {
      for (let i = 0; i < position.count; i += 1) {
        const x = position.getX(i);
        const z = position.getZ(i);
        const a = Math.atan2(z, x);
        const k = 1 + 0.16 * Math.sin(a * 3 + 1.1) + 0.1 * Math.sin(a * 5 + 0.4);
        // A flat-topped dome: the crown is broad, the edge rolls down into the soil.
        const y = Math.min(1, position.getY(i) * 1.6) * 0.11;
        position.setXYZ(i, x * k, y, z * k);
      }
    }
    g.computeVertexNormals();
    const uv = new Float32Array((position?.count ?? 0) * 2);
    for (let i = 0; i < (position?.count ?? 0); i += 1)
      uv.set([(position?.getX(i) ?? 0) * 0.6, (position?.getZ(i) ?? 0) * 0.6], i * 2);
    g.setAttribute("uv", new BufferAttribute(uv, 2));
    return g;
  })();
  const slabs: [Placement[], Placement[]] = [[], []];
  const laid: [number, number, number][] = [];
  for (let z = clearing.south - 0.4; z > clearing.north - 0.4; z -= 0.62 + rng() * 0.1) {
    const across = rng() < 0.5 ? [-0.75, -0.25, 0.25, 0.75] : [-0.62, 0, 0.62];
    for (const offset of across) {
      if (rng() < 0.1) continue;
      const x = site.pathX(z) + offset + (rng() - 0.5) * 0.2;
      const sz = z + (rng() - 0.5) * 0.14;
      const r = (across.length === 4 ? 0.23 : 0.28) + rng() * 0.06;
      const yaw = spin();
      const [rx, rz] = tiltTo(normalAt(x, sz), yaw);
      (rng() < 0.5 ? slabs[0] : slabs[1]).push([
        x,
        height(x, sz) - 0.05,
        sz,
        r * (1 + rng() * 0.25),
        0.7 + rng() * 0.6,
        r,
        rx,
        yaw,
        rz,
      ]);
      laid.push([x, sz, r]);
    }
  }
  group.add(
    instanced(slab, lit(C.flagstoneDark, { detail: true, roughness: 0.9 }), slabs[0], false),
    instanced(slab, lit(C.flagstone2, { detail: true, roughness: 0.9 }), slabs[1], false),
  );
  // How much of the path's centre line a slab covers: the playtest's proof the path is laid.
  let covered = 0;
  let samples = 0;
  for (let z = clearing.south - 1; z > clearing.north; z -= 0.25) {
    samples += 1;
    const x = site.pathX(z);
    if (laid.some(([sx, sz, r]) => Math.hypot(x - sx, z - sz) < r)) covered += 1;
  }

  // The stream's water: a dark, smooth ribbon down its bed, which the reflections pick up.
  const water = (() => {
    const position: number[] = [];
    const points = site.stream.points;
    for (let i = 1; i < points.length; i += 1) {
      const [ax, az] = points[i - 1] ?? [0, 0];
      const [bx, bz] = points[i] ?? [0, 0];
      const len = Math.hypot(bx - ax, bz - az);
      const nx = (-(bz - az) / len) * 1.9;
      const nz = ((bx - ax) / len) * 1.9;
      const y = site.stream.water;
      position.push(ax - nx, y, az - nz, bx - nx, y, bz - nz, bx + nx, y, bz + nz);
      position.push(ax - nx, y, az - nz, bx + nx, y, bz + nz, ax + nx, y, az + nz);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(position), 3));
    g.computeVertexNormals();
    return new Mesh(g, lit(C.water, { doubleSided: true, roughness: 0.08 }));
  })();
  water.receiveShadow = true;
  group.add(water);

  // Ivy clumps on the cliff faces and the ruin, and vines hanging from their tops.
  const ivy: Placement[] = [];
  const vines: Placement[] = [];
  for (const [x, y, z, w, h, yaw] of site.walls) {
    const across = (u: number): [number, number] => [
      x + Math.cos(yaw) * (u - 0.5) * w,
      z - Math.sin(yaw) * (u - 0.5) * w,
    ];
    const patches = Math.max(1, Math.round(w * 0.3));
    for (let i = 0; i < patches; i += 1) {
      const u = (i + 0.2 + rng() * 0.6) / patches;
      for (let k = 0; k < 7; k += 1) {
        const [cx, cz] = across(u + (rng() - 0.5) * (1.6 / w));
        const drop = k < 4 ? rng() * 0.6 : 0.6 + rng() * h * 0.45;
        const s = (k < 4 ? 0.45 : 0.3) + rng() * 0.25;
        ivy.push([cx, y + h / 2 - drop, cz, s * 1.5, s, s * 0.3, 0, yaw, rng()]);
      }
      for (let k = 0; k < 4; k += 1) {
        const [vx, vz] = across(u + (rng() - 0.5) * (1.4 / w));
        vines.push([vx, y + h / 2, vz, 1, 0.8 + rng() * h * 0.7, 1, 0, yaw, 0]);
      }
    }
  }
  group.add(
    instanced(new IcosahedronGeometry(1, 0), lit(C.ivy, { flat: true }), ivy, false),
    instanced(
      merge([
        [new CylinderGeometry(0.03, 0.03, 1, 4, 1, true).translate(0, -0.5, 0), C.ivy],
        [new OctahedronGeometry(0.09, 0).translate(0.05, -0.35, 0.02), C.leaf],
        [new OctahedronGeometry(0.08, 0).translate(-0.05, -0.7, 0.02), C.leaf],
      ]),
      lit(0xffffff, { flat: true, vertexColors: true }),
      vines,
      false,
    ),
  );
  // The canopy's shade: leaf-sized discs high over the clearing that only cast shadow, so the
  // floor is dappled. Its gaps sit where the sun shafts come down, so each shaft lands in light.
  const canopyY = 10;
  const gaps = SHAFTS.map(([x, z, r]) => {
    const t = (canopyY - height(x, z)) / SUN_DIRECTION.y;
    return [x + SUN_DIRECTION.x * t, z + SUN_DIRECTION.z * t, r * 1.5] as const;
  });
  const discs: BufferGeometry[] = [];
  for (let i = 0; i < 1600; i += 1) {
    const x = (rng() * 2 - 1) * 30 - 6;
    const z = -30 + rng() * 52;
    const r = 0.7 + rng() * 0.75;
    if (gaps.some(([gx, gz, gr]) => Math.hypot(x - gx, z - gz) < gr + r * 0.5)) continue;
    if (Math.sin(x * 0.7) * Math.cos(z * 0.6) + Math.sin(x * 0.23 + z * 0.31) > 1.65) continue;
    discs.push(
      new CircleGeometry(r, 6)
        .rotateX(-Math.PI / 2)
        .scale(1, 1, 0.6 + rng() * 0.6)
        .rotateY(spin())
        .translate(x, canopyY + rng() * 2.5, z),
    );
  }
  const shadeMaterial = new MeshStandardNodeMaterial({
    colorWrite: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const canopyShade = new Mesh(mergeAll(discs), shadeMaterial);
  canopyShade.name = "canopy-shade";
  canopyShade.castShadow = true;
  group.add(canopyShade, sunShafts(SHAFTS, height));
  return {
    group,
    path: { cover: samples === 0 ? 0 : covered / samples, stones: laid.length },
    shade,
  };
}

/** A grid of the height function from x0..x1, z0..z1 at `step`; `skip` drops a cell. */
function heightGrid(
  site: IValeSite,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  step: number,
  lower: (x: number, z: number) => number,
  skip?: (x: number, z: number) => boolean,
): BufferGeometry {
  const nx = Math.round((x1 - x0) / step);
  const nz = Math.round((z1 - z0) / step);
  const position = new Float32Array((nx + 1) * (nz + 1) * 3);
  const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
  for (let j = 0; j <= nz; j += 1) {
    for (let i = 0; i <= nx; i += 1) {
      const x = x0 + i * step;
      const z = z0 + j * step;
      const k = j * (nx + 1) + i;
      position.set([x, site.height(x, z) - lower(x, z), z], k * 3);
      uv.set([x * 0.3, z * 0.3], k * 2);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nz; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      if (skip?.(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step) === true) continue;
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(position, 3));
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** The fine floor's extent: the clearing, its banks and the cave tunnel. */
const INNER = { x0: -26.25, x1: 26.25, z0: -30, z1: 22.5, step: 0.75 };

/**
 * The vale's floor: a fine grid where Wren walks (`inner`, also her collider) and a coarse one for
 * the hills (`outer`), both over the height function. Soil, moss and litter; rock past the walk
 * limit; dark soil under the path; a wet stream bed; contact shade under trunks, rocks and logs.
 */
export function valeGround(
  site: IValeSite,
  shade: readonly (readonly [number, number, number])[],
): { readonly inner: Mesh; readonly outer: Mesh } {
  const swatch = (hex: number): Color => new Color(hex);
  const soil = swatch(C.soil);
  const litter = swatch(C.litter);
  const moss = swatch(C.forestMoss);
  const mossBright = swatch(C.mossBright);
  const meadow = swatch(palette.grass);
  const rock = swatch(C.cliff);
  const wet = swatch(C.soilWet);
  const c = new Color();
  const wave = (x: number, z: number, f: number): number =>
    0.5 + 0.25 * (Math.sin(x * f + z * f * 0.55) + Math.sin(z * f * 1.4 - x * f * 0.37 + 1.3));
  const smooth = (a: number, b: number, t: number): number => {
    const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  const paintGround = (geometry: BufferGeometry): void => {
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    if (position === undefined || normal === undefined)
      throw new Error("valeGround: no positions.");
    const colour = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const z = position.getZ(i);
      // Moss and soil in patches, a lighter meadow green where the canopy opens, litter round trees.
      c.copy(soil).lerp(moss, 0.35 + 0.55 * smooth(0.35, 0.75, wave(x + 40, z - 17, 0.27)));
      c.lerp(mossBright, smooth(0.6, 0.85, wave(x - 3, z + 5, 0.45)) * 0.5);
      c.lerp(meadow, smooth(0.66, 0.82, wave(x * 0.7, z * 0.7 + 9, 0.21)) * 0.3);
      let nearTree = 0;
      for (const [tx, tz, ts] of site.trees) {
        const d = Math.hypot(x - tx, z - tz);
        if (d < 5 * ts) nearTree = Math.max(nearTree, 1 - smooth(1.4 * ts, 4.5 * ts, d));
      }
      c.lerp(litter, nearTree * 0.6 * (0.6 + 0.4 * wave(x, z, 0.9)));
      // Dark soil under the path, the flagstones on top of it.
      const off = Math.abs(x - site.pathX(z)) + (wave(x, z, 1.3) - 0.5) * 0.5;
      if (z > site.clearing.north - 9 && z < site.clearing.south + 1)
        c.lerp(soil, (1 - smooth(1.2, 1.9, off)) * 0.85);
      // Rock wherever the ground is steeper than Wren can climb (45°), moss on its gentler shoulders.
      const up = normal.getY(i);
      c.lerp(rock, smooth(0.8, 0.68, up));
      // The stream bed: wet and dark.
      c.lerp(wet, 1 - smooth(1.2, 2.6, site.stream.distance(x, z)));
      // Contact shade: under every trunk, rock and log.
      let light = 1;
      for (const [sx, sz, sr] of shade) {
        const d = Math.hypot(x - sx, z - sz);
        if (d < sr * 1.7) light *= 1 - 0.4 * (1 - smooth(sr * 0.5, sr * 1.7, d));
      }
      c.multiplyScalar(light);
      colour.set([c.r, c.g, c.b], i * 3);
    }
    geometry.setAttribute("color", new BufferAttribute(colour, 3));
  };
  const material = lit(0xffffff, { detail: true, vertexColors: true });
  const inner = heightGrid(site, INNER.x0, INNER.x1, INNER.z0, INNER.z1, INNER.step, () => 0);
  paintGround(inner);
  // The coarse hills skip what the fine grid covers, and dip a little under its rim so the two
  // never fight where they overlap.
  const outer = heightGrid(
    site,
    -72,
    72,
    -72,
    72,
    4,
    (x, z) =>
      x > INNER.x0 - 4 && x < INNER.x1 + 4 && z > INNER.z0 - 4 && z < INNER.z1 + 4 ? 0.25 : 0,
    (x, z) => x > INNER.x0 + 2 && x < INNER.x1 - 2 && z > INNER.z0 + 2 && z < INNER.z1 - 2,
  );
  paintGround(outer);
  const meshes = { inner: new Mesh(inner, material), outer: new Mesh(outer, material) };
  meshes.inner.receiveShadow = true;
  meshes.outer.receiveShadow = true;
  meshes.inner.name = "vale-floor";
  return meshes;
}
