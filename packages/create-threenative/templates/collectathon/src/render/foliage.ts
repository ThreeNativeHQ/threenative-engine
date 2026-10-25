// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The island's planting: a meadow of tall grass combed by travelling gusts, broadleaf trees and
// white birches whose crowns are hundreds of leaf cards, leafy bushes along two hedge arcs, clumps
// of red, orange, white and yellow flowers, butterflies, pebbles on the path and stones in the
// grass, and the islet's beach. The leaves are cut out of one leaf-cluster texture painted in code
// and use Unreal's Two Sided Foliage shading (`twoSidedFoliage`), so the low sun shines through a
// crown seen against it. The bark is the photo textures in `assets/` (`tex-*.webp`). Every kind is one
// `InstancedMesh` (the grass one per 12 m cell, so the camera culls what it does not see), and
// every plant stands on the terrain's own height or on a drum's lawn. Nothing here is solid: the
// hero walks through a bush as it walks through a tree trunk, and the course's metres stay the
// course's. Placement is seeded and asks the course where planting may go (`clear`).
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  InstancedMesh,
  LatheGeometry,
  LinearMipmapLinearFilter,
  type Material,
  Matrix4,
  Mesh,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  RingGeometry,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  Vector3,
} from "three";
import {
  abs,
  dot,
  hash,
  instanceIndex,
  materialColor,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  time,
  vec2,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import { lit, seeded } from "./materials.js";
import { C } from "./palette.js";
import { type ISurfaces, texturedMaterial } from "./surface.js";

/** x, y, z, scale x, y, z, rotation x, y, z. */
type Placement = readonly [number, number, number, number, number, number, number, number, number];

export interface IPlantingSite {
  readonly rng: () => number;
  /** The terrain's extent; planting stays on land inside it. */
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
  /** Whether a plant this wide may stand at (x, z): off the landmarks and the routes. */
  clear(x: number, z: number, width: number): boolean;
  ground(x: number, z: number): number;
  /** The ground normal's up component: under 0.8 is a rock face, where nothing grows. */
  flatness(x: number, z: number): number;
  /** Metres from the nearest dirt path's centre line (the path is about 1.2 m each side). */
  pathDistance(x: number, z: number): number;
  /** Islands that get a sand-and-foam beach ring: x, z, cliff radius at the waterline. */
  readonly shores: readonly (readonly [number, number, number])[];
  /** Drum tops that get the meadow too: x, z, radius, lawn height. */
  readonly lawns: readonly (readonly [number, number, number, number])[];
  readonly seaLevel: number;
  /** Share of the grass tufts drawn past the near ring, 0..1: the tier's (`GRASS_SHARE`). */
  readonly grassShare: number;
  readonly surfaces: ISurfaces;
}

const dummy = new Object3D();
// Yaw last: a placement leans or droops about X, then turns to face its way round Y.
dummy.rotation.order = "YXZ";

function instanced(
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
  castShadow: boolean,
  tints?: readonly Color[],
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, Math.max(1, placements.length));
  mesh.count = placements.length;
  placements.forEach(([x, y, z, sx, sy, sz, rx, ry, rz], i) => {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(rx, ry, rz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    const tint = tints?.[i];
    if (tint !== undefined) mesh.setColorAt(i, tint);
  });
  mesh.computeBoundingSphere();
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

/** The wind: one gust front travelling across the island, 0 in the lull to 1 in the gust. */
function gustAt(xz: Node<"vec2">) {
  const along = dot(xz, vec2(0.21, 0.09));
  return sin(along.sub(time.mul(1.4)))
    .mul(sin(along.mul(0.37).sub(time.mul(0.45)).add(1.3)))
    .mul(0.5)
    .add(0.5);
}

/** Grass: vertices above y = 0 bend with the gust that passes over them, each tuft on its phase. */
function grassMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    color: C.blade,
    roughness: 0.75,
    side: DoubleSide,
    vertexColors: true,
  });
  const phase = hash(instanceIndex).mul(6.28);
  // `positionGeometry`, not `positionLocal`: an instanced mesh's `positionLocal` already carries the
  // instance matrix, so its y is the blade's height above the sea, not above its root.
  const height = positionGeometry.y.max(0);
  const bend = height.mul(height);
  const gust = gustAt(positionLocal.xz);
  const push = gust.mul(gust).mul(0.42).add(0.06);
  material.positionNode = positionLocal.add(
    vec3(
      sin(time.mul(2.3).add(phase)).mul(0.05).add(push).mul(bend),
      push.mul(bend).mul(-0.35),
      sin(time.mul(1.7).add(phase.mul(1.7)))
        .mul(bend)
        .mul(0.06),
    ),
  );
  // A gust lays the blades over and shows their paler, sunlit sides: the wave you see cross a field.
  material.colorNode = materialColor.mul(gustAt(positionWorld.xz).mul(0.24).add(0.9));
  material.twoSidedFoliage = true;
  material.subsurfaceColor = new Color(0.42, 0.55, 0.12);
  return material;
}

/** Blades in one grass tuft: every tuft is this many triangles. */
export const TUFT_BLADES = 14;

/**
 * A clump of single-triangle blades, 1 m tall before scaling, leaning out from its centre and all
 * bending one way, as wind-combed meadow grass does. Every normal points up, so a blade lights like
 * the lawn it grows from, not like a dark sliver edge-on to the sun, and the vertex colour runs
 * from a shaded root to a sunlit yellow-green tip.
 */
function tuftGeometry(rng: () => number, blades = TUFT_BLADES): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  for (let b = 0; b < blades; b += 1) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * 0.3;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = 0.55 + rng() * 0.45;
    // Lean out from the centre, plus a shared comb toward +X.
    const lean = 0.1 + rng() * 0.25;
    const across = a + Math.PI / 2;
    const w = 0.024 + rng() * 0.016;
    const tip = 0.95 + rng() * 0.3;
    positions.push(
      x - Math.cos(across) * w,
      0,
      z - Math.sin(across) * w,
      x + Math.cos(across) * w,
      0,
      z + Math.sin(across) * w,
      x + (Math.cos(a) * lean + 0.18) * h,
      h,
      z + Math.sin(a) * lean * h,
    );
    colors.push(0.5, 0.56, 0.5, 0.5, 0.56, 0.5, 1.25 * tip, 1.18 * tip, 0.62 * tip);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute(
    "normal",
    new BufferAttribute(
      new Float32Array(positions.length).map((_, i) => (i % 3 === 1 ? 1 : 0)),
      3,
    ),
  );
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  return geometry;
}

/**
 * A 256 x 256 cluster of about ninety leaves round a twig, each its own green with a midrib and a
 * darker half where it folds, the rest transparent: the card every crown and bush is built from.
 * Transparent texels keep the leaves' mean colour, so the mip chain does not darken their edges.
 */
function leafTexture(): DataTexture {
  const size = 256;
  const rng = seeded(71);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) data.set([88, 128, 52, 0], i * 4);
  for (let leaf = 0; leaf < 95; leaf += 1) {
    // Leaves fan out from the card's middle: the stem end toward the centre.
    const reach = Math.sqrt(rng()) * 92;
    const around = rng() * Math.PI * 2;
    const cx = 128 + Math.cos(around) * reach;
    const cy = 128 + Math.sin(around) * reach;
    const angle = around + (rng() - 0.5) * 1.4;
    const length = 26 + rng() * 18;
    const width = length * (0.38 + rng() * 0.1);
    const value = 0.72 + rng() * 0.4;
    const warm = rng() * 0.12;
    const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
    for (let y = Math.floor(cy - length); y <= cy + length; y += 1) {
      for (let x = Math.floor(cx - length); x <= cx + length; x += 1) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const u = (x - cx) * dx + (y - cy) * dy + length / 2;
        const v = -(x - cx) * dy + (y - cy) * dx;
        if (u < 0 || u > length) continue;
        const half = (width / 2) * Math.sin((Math.PI * u) / length) ** 0.75;
        if (Math.abs(v) > half) continue;
        const rib = Math.abs(v) < 0.9 ? 0.78 : 1;
        const fold = v > 0 ? 0.86 : 1;
        const edge = 0.9 + 0.1 * (1 - Math.abs(v) / half);
        const k = value * rib * fold * edge;
        data.set(
          [
            Math.min(255, (0.36 + warm) * k * 255),
            Math.min(255, 0.62 * k * 255),
            Math.min(255, 0.2 * k * 255),
            255,
          ],
          (y * size + x) * 4,
        );
      }
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** One leaf card, 1 m square, its normals bent out from its centre so a crown shades round. */
function cardGeometry(): BufferGeometry {
  const geometry = new PlaneGeometry(1, 1);
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const bent = new Vector3();
  for (let i = 0; i < (position?.count ?? 0); i += 1) {
    bent.set(position?.getX(i) ?? 0, position?.getY(i) ?? 0, 0.8).normalize();
    normal?.setXYZ(i, bent.x, bent.y, bent.z);
  }
  return geometry;
}

/** A tapering trunk with a flared foot, base at the origin, 1 m tall; UVs wrap the bark `repeats` times up it. */
function trunkGeometry(repeats: number, flare: number): BufferGeometry {
  const profile = Array.from({ length: 8 }, (_, i) => {
    const y = i / 7;
    return new Vector2(0.12 + 0.05 * (1 - y) + flare * Math.exp(-y * 9), y);
  });
  const geometry = new LatheGeometry(profile, 10);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < (uv?.count ?? 0); i += 1) uv?.setY(i, (uv.getY(i) ?? 0) * repeats);
  return geometry;
}

/** A leaf-card crown: cards scattered through a few clumps, facing out, darker inside and below. */
interface ICrown {
  readonly cards: Matrix4[];
  readonly tints: Color[];
  /** Clump centres, where the branches reach. */
  readonly clumps: Vector3[];
}

function addCrown(
  out: ICrown,
  rng: () => number,
  centre: Vector3,
  radius: Vector3,
  options: { clumps: number; cards: number; card: number; tint: Color },
): Vector3[] {
  const clumps = Array.from({ length: options.clumps }, (_, i) => {
    const a = (i / options.clumps) * Math.PI * 2 + rng();
    const up = i === 0 ? 0.5 : (rng() - 0.35) * 0.9;
    return new Vector3(
      centre.x + Math.cos(a) * radius.x * (i === 0 ? 0 : 0.5),
      centre.y + up * radius.y * 0.6,
      centre.z + Math.sin(a) * radius.z * (i === 0 ? 0 : 0.5),
    );
  });
  const position = new Vector3();
  const facing = new Vector3();
  const turn = new Quaternion();
  const roll = new Quaternion();
  const scale = new Vector3();
  const forward = new Vector3(0, 0, 1);
  for (let c = 0; c < options.cards; c += 1) {
    const clump = clumps[c % clumps.length] as Vector3;
    // A point in the clump, nearer its skin than its middle.
    facing.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
    const depth = 0.45 + 0.55 * Math.sqrt(rng());
    position.set(
      clump.x + facing.x * radius.x * 0.62 * depth,
      clump.y + facing.y * radius.y * 0.62 * depth,
      clump.z + facing.z * radius.z * 0.62 * depth,
    );
    // Face away from the crown's centre, loosely: a card seen edge-on is only a line.
    facing
      .subVectors(position, centre)
      .normalize()
      .add(new Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(0.9))
      .normalize();
    turn.setFromUnitVectors(forward, facing);
    roll.setFromAxisAngle(facing, rng() * Math.PI * 2);
    const size = options.card * (0.75 + rng() * 0.5);
    scale.set(size, size, size);
    out.cards.push(new Matrix4().compose(position, roll.multiply(turn), scale));
    // Light where the sky reaches: the outside and the top; the inside and the underside in shade.
    const out01 = Math.min(1, position.distanceTo(centre) / Math.max(radius.x, radius.y));
    const top = Math.min(1, Math.max(0, (position.y - centre.y) / radius.y + 0.6));
    const shade = (0.45 + 0.55 * out01) * (0.7 + 0.3 * top);
    out.tints.push(options.tint.clone().multiplyScalar(shade * (0.9 + rng() * 0.2)));
  }
  return clumps;
}

/** A branch from `from` to `to`, as the matrix of a unit cylinder standing on its base. */
function branchMatrix(from: Vector3, to: Vector3, radius: number): Matrix4 {
  const along = new Vector3().subVectors(to, from);
  const length = along.length();
  const turn = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), along.normalize());
  return new Matrix4().compose(from, turn, new Vector3(radius, length, radius));
}

/** Two wings hinged on the body's line, flapping on their own phase while the insect wanders. */
function butterflies(placements: readonly Placement[], tints: readonly Color[]): InstancedMesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([
        0, 0, -0.05, -0.11, 0, -0.07, -0.08, 0, 0.06, 0, 0, -0.05, 0.08, 0, 0.06, 0.11, 0, -0.07,
      ]),
      3,
    ),
  );
  geometry.computeVertexNormals();
  const material = new MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.6,
    side: DoubleSide,
  });
  const phase = hash(instanceIndex).mul(6.28);
  const flap = sin(time.mul(17).add(phase)).mul(abs(positionGeometry.x)).mul(1.4);
  material.positionNode = positionLocal.add(
    vec3(
      sin(time.mul(0.45).add(phase)).mul(1.8),
      flap.add(sin(time.mul(1.3).add(phase.mul(2))).mul(0.35)),
      sin(time.mul(0.33).add(phase.mul(3))).mul(1.8),
    ),
  );
  const mesh = instanced(geometry, material, placements, false, tints);
  // The wander leaves the instance bounds; a few metres of slack keep it from being culled early.
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * A five-petal flower head, 12 cm across, facing up: rounded petals round a golden eye (vertex
 * colours: white petals take the instance's colour, the eye stays gold).
 */
function flowerGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  // Ten rim points: alternately a petal tip and the notch between two petals.
  const steps = 10;
  for (let i = 0; i < steps; i += 1) {
    const at = (k: number) => {
      const a = (k / steps) * Math.PI * 2;
      const r = 0.06 * (0.55 + 0.45 * Math.abs(Math.cos((a * 5) / 2)));
      return [Math.cos(a) * r, 0, Math.sin(a) * r];
    };
    positions.push(0, 0.006, 0, ...at(i + 1), ...at(i));
    colors.push(1, 0.72, 0.1, 1, 1, 1, 1, 1, 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** The meadow's distance thinning: call `update` with the camera's position once a frame. */
export interface IMeadow {
  update(eye: { readonly x: number; readonly z: number }): void;
  /** Tufts drawn after the last `update`, and the tier's whole meadow. */
  readonly drawn: number;
  readonly total: number;
}

export function plantIsland(site: IPlantingSite): { group: Group; meadow: IMeadow } {
  const { rng, bounds, clear, ground, surfaces } = site;
  const group = new Group();
  group.name = "planting";
  const spin = () => rng() * Math.PI * 2;
  const onLawn = (x: number, z: number) =>
    site.lawns.some(([lx, lz, r]) => Math.hypot(x - lx, z - lz) < r + 0.4);
  const land = (x: number, z: number): boolean =>
    ground(x, z) > site.seaLevel + 1 && site.flatness(x, z) > 0.8 && !onLawn(x, z);
  /** A random clear spot on grass, off the path, at least `width` from every route, or undefined. */
  const spot = (width: number, pathGap = width + 1.4): [number, number] | undefined => {
    for (let tries = 0; tries < 16; tries += 1) {
      const x = bounds.minX + rng() * (bounds.maxX - bounds.minX);
      const z = bounds.minZ + rng() * (bounds.maxZ - bounds.minZ);
      if (land(x, z) && site.pathDistance(x, z) > pathGap && clear(x, z, width)) return [x, z];
    }
    return undefined;
  };

  const leaves: ICrown = { cards: [], clumps: [], tints: [] };
  const branches: Matrix4[] = [];

  // Broadleaf trees: a flared trunk, four or five boughs, and a round crown of about 130 cards.
  const trunks: Placement[] = [];
  for (let i = 0; i < 22; i += 1) {
    const at = spot(3.5);
    if (at === undefined) continue;
    const [x, z] = at;
    const size = 0.9 + rng() * 0.6;
    const height = 3.4 * size;
    const y = ground(x, z) - 0.2;
    trunks.push([x, y, z, 1.5 * size, height + 1, 1.5 * size, (rng() - 0.5) * 0.08, spin(), 0]);
    const tint = new Color(i % 3 === 0 ? 0xc8e0b0 : 0xffffff);
    const centre = new Vector3(x, y + height + 1.5 * size, z);
    const clumps = addCrown(leaves, rng, centre, new Vector3(2.6, 2.1, 2.6).multiplyScalar(size), {
      card: 1.5 * size,
      cards: 130,
      clumps: 6,
      tint,
    });
    const fork = new Vector3(x, y + height * 0.75, z);
    for (const clump of clumps.slice(1))
      branches.push(branchMatrix(fork, fork.clone().lerp(clump, 0.85), 0.09 * size));
  }
  const bark = texturedMaterial(surfaces, "bark", { normalScale: 1.6, roughness: 0.92 });
  group.add(instanced(trunkGeometry(2, 0.12), bark, trunks, true));

  // Birches: tall white trunks with a light, narrow crown of smaller cards up their top half.
  const birches: Placement[] = [];
  for (let i = 0; i < 14; i += 1) {
    const at = spot(2);
    if (at === undefined) continue;
    const [x, z] = at;
    const height = 8 + rng() * 3.5;
    const y = ground(x, z) - 0.2;
    birches.push([x, y, z, 0.8, height, 0.8, (rng() - 0.5) * 0.06, spin(), 0]);
    const centre = new Vector3(x, y + height * 0.72, z);
    const clumps = addCrown(leaves, rng, centre, new Vector3(1.7, height * 0.3, 1.7), {
      card: 1.1,
      cards: 80,
      clumps: 5,
      tint: new Color(1.15, 1.2, 0.85),
    });
    const fork = new Vector3(x, y + height * 0.5, z);
    for (const clump of clumps.slice(1))
      branches.push(branchMatrix(fork, fork.clone().lerp(clump, 0.8), 0.045));
  }
  group.add(
    instanced(
      trunkGeometry(14, 0.05),
      texturedMaterial(surfaces, "birch-bark", { roughness: 0.7 }),
      birches,
      true,
    ),
  );

  // Bushes: low clumps of the same leaves, and two hedge arcs of them near the rim.
  const bush = (x: number, z: number, size: number): void => {
    addCrown(
      leaves,
      rng,
      new Vector3(x, ground(x, z) + 0.45 * size, z),
      new Vector3(0.95, 0.7, 0.95).multiplyScalar(size),
      { card: 0.9 * size, cards: 26, clumps: 2, tint: new Color(0.8, 0.9, 0.78) },
    );
  };
  for (let i = 0; i < 40; i += 1) {
    const at = spot(1.6);
    if (at !== undefined) bush(at[0], at[1], 0.8 + rng() * 0.6);
  }
  for (const [from, to] of [
    [0.75, 1.35],
    [3.55, 4.25],
  ] as const) {
    for (let a = from; a < to; a += 1.8 / 29) {
      const x = Math.cos(a) * 29;
      const z = Math.sin(a) * 29;
      if (clear(x, z, 1.2) && land(x, z) && site.pathDistance(x, z) > 2) bush(x, z, 1.25);
    }
  }

  // Every leaf card on the island is one draw: cut out of the cluster texture, both faces lit, the
  // sun shining through the ones seen against it, and a slow flutter on each card's own phase.
  const leafMaterial = new MeshStandardNodeMaterial({
    alphaTest: 0.4,
    map: leafTexture(),
    roughness: 0.7,
    side: DoubleSide,
  });
  const flutter = hash(instanceIndex).mul(6.28);
  leafMaterial.positionNode = positionLocal.add(
    vec3(
      sin(time.mul(1.9).add(flutter)).mul(0.03),
      sin(time.mul(2.6).add(flutter.mul(1.3))).mul(0.02),
      0,
    ),
  );
  leafMaterial.twoSidedFoliage = true;
  leafMaterial.subsurfaceColor = new Color(0.3, 0.46, 0.1);
  const cards = new InstancedMesh(cardGeometry(), leafMaterial, leaves.cards.length);
  leaves.cards.forEach((matrix, i) => {
    cards.setMatrixAt(i, matrix);
    cards.setColorAt(i, leaves.tints[i] as Color);
  });
  cards.computeBoundingSphere();
  cards.castShadow = true;
  cards.receiveShadow = true;
  cards.name = "leaves";
  group.add(cards);
  const boughs = new InstancedMesh(
    new CylinderGeometry(0.55, 1, 1, 6, 1, true).translate(0, 0.5, 0),
    bark,
    branches.length,
  );
  branches.forEach((matrix, i) => boughs.setMatrixAt(i, matrix));
  boughs.computeBoundingSphere();
  boughs.castShadow = true;
  group.add(boughs);

  // Flowers: clumps in the grass, thickest along the path's edges, one draw per colour, on stems
  // that sway with it.
  const petals = [C.petalRed, C.petalOrange, C.petalWhite, C.petalYellow, C.wingBlue];
  const heads: Placement[][] = petals.map(() => []);
  const stems: Placement[] = [];
  for (let i = 0; i < 260; i += 1) {
    const at = i % 3 === 0 ? spot(0.6, 1.6) : spot(0.6, 1.4);
    if (at === undefined) continue;
    const hue = heads[i % petals.length] ?? [];
    const count = 6 + Math.floor(rng() * 9);
    for (let f = 0; f < count; f += 1) {
      const a = spin();
      const r = rng() ** 0.7 * 0.9;
      const x = at[0] + Math.cos(a) * r;
      const z = at[1] + Math.sin(a) * r;
      const h = 0.3 + rng() * 0.3;
      const y = ground(x, z);
      stems.push([x, y, z, 1, h, 1, 0, 0, 0]);
      const s = 0.8 + rng() * 0.5;
      hue.push([x, y + h, z, s, s, s, (rng() - 0.5) * 0.6, spin(), (rng() - 0.5) * 0.6]);
    }
  }
  const stem = new CylinderGeometry(0.01, 0.012, 1, 3, 1, true).translate(0, 0.5, 0);
  group.add(instanced(stem, lit(C.blade), stems, false));
  const head = flowerGeometry();
  petals.forEach((colour, i) => {
    group.add(
      instanced(head, lit(colour, { roughness: 0.6, vertexColors: true }), heads[i] ?? [], false),
    );
  });

  // Butterflies over the flowers: orange, white and blue.
  const flyers: Placement[] = [];
  const wingTints: Color[] = [];
  const wings = [C.petalOrange, C.petalWhite, C.wingBlue];
  for (let i = 0; i < 20; i += 1) {
    const at = spot(0.5, 1);
    if (at === undefined) continue;
    flyers.push([at[0], ground(at[0], at[1]) + 0.7 + rng() * 0.6, at[1], 1, 1, 1, 0, spin(), 0]);
    wingTints.push(new Color(wings[i % wings.length]));
  }
  group.add(butterflies(flyers, wingTints));

  // Pebbles thick along the path, and a few stones in the grass, half sunk into the ground.
  const pebbles: Placement[] = [];
  const pebbleTints: Color[] = [];
  const stones: Placement[] = [];
  const stoneTints: Color[] = [];
  const pebbleBase = new Color(C.pebble);
  for (let i = 0; i < 30000; i += 1) {
    const x = bounds.minX + rng() * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + rng() * (bounds.maxZ - bounds.minZ);
    const onPath = site.pathDistance(x, z) < 1.4;
    // A grass stone casts a shadow and counts as a prop: it keeps the planting's clearances.
    if ((!onPath && (rng() > 0.006 || !clear(x, z, 0.4))) || ground(x, z) < site.seaLevel + 0.4)
      continue;
    const s = onPath ? 0.025 + rng() ** 3 * 0.11 : 0.1 + rng() ** 2 * 0.3;
    const at: Placement = [
      x,
      ground(x, z) + s * 0.12,
      z,
      s,
      s * 0.55,
      s * (0.8 + rng() * 0.4),
      rng(),
      spin(),
      rng(),
    ];
    (onPath ? pebbles : stones).push(at);
    (onPath ? pebbleTints : stoneTints).push(pebbleBase.clone().multiplyScalar(0.45 + rng() * 0.7));
  }
  const pebble = new OctahedronGeometry(1, 0);
  const pebbleMaterial = lit(0xffffff, { flat: true });
  // Too small to throw a shadow worth its draw.
  const pathPebbles = instanced(pebble, pebbleMaterial, pebbles, false, pebbleTints);
  pathPebbles.name = "path-pebbles";
  const grassStones = instanced(pebble, pebbleMaterial, stones, true, stoneTints);
  grassStones.name = "stones";
  group.add(pathPebbles, grassStones);

  // The meadow: grass tufts on a jittered 0.5 m grid over all the land and every drum's lawn, shorter
  // on the mown routes and beside the path, one `InstancedMesh` per 12 m cell. Each cell is
  // shuffled, so drawing a prefix of it thins it evenly: `update` draws every tuft within 10 m of
  // the eye at every tier (the foreground is what hides the ground), then the tier's share, thinning
  // to an eighth of it by 46 m, where the ground's own grass texture carries the field.
  const tuft = tuftGeometry(rng);
  const grass = grassMaterial();
  const cells = new Map<
    string,
    { placements: Placement[]; tints: Color[]; x: number; z: number }
  >();
  const meadow = new Color(C.blade);
  const step = 0.5;
  const plant = (tx: number, tz: number, y: number, h: number): void => {
    const ix = Math.floor(tx / 12);
    const iz = Math.floor(tz / 12);
    const key = `${ix},${iz}`;
    const cell = cells.get(key) ?? {
      placements: [],
      tints: [],
      x: (ix + 0.5) * 12,
      z: (iz + 0.5) * 12,
    };
    cells.set(key, cell);
    cell.placements.push([tx, y - 0.03, tz, 1, h, 1, 0, (rng() - 0.5) * 0.8, 0]);
    // Hue drifts between a yellow-green and a blue-green in 20 m patches, value in 6 m ones.
    const drift = 0.5 + 0.5 * Math.sin(tx * 0.11 + tz * 0.07) * Math.cos(tz * 0.13 - tx * 0.05);
    const patch = Math.sin(tx * 0.9 + Math.sin(tz * 0.7)) * Math.cos(tz * 0.8 - tx * 0.3);
    cell.tints.push(
      new Color(meadow).offsetHSL(0.05 * drift - 0.025, 0, 0.05 * patch + 0.04 * (rng() - 0.5)),
    );
  };
  for (let z = bounds.minZ; z < bounds.maxZ; z += step) {
    for (let x = bounds.minX; x < bounds.maxX; x += step) {
      const tx = x + (rng() - 0.5) * step;
      const tz = z + (rng() - 0.5) * step;
      const scale = rng();
      const path = site.pathDistance(tx, tz);
      if (path < 0.95 || !land(tx, tz)) continue;
      const mown = clear(tx, tz, 0) ? 1 : 0.6;
      const edge = Math.min(1, (path - 0.95) / 1.6);
      plant(tx, tz, ground(tx, tz), (0.5 + scale * 0.45) * mown * (0.45 + 0.55 * edge));
    }
  }
  for (const [lx, lz, radius, top] of site.lawns) {
    for (let z = lz - radius; z < lz + radius; z += step) {
      for (let x = lx - radius; x < lx + radius; x += step) {
        const tx = x + (rng() - 0.5) * step;
        const tz = z + (rng() - 0.5) * step;
        const scale = rng();
        if (Math.hypot(tx - lx, tz - lz) > radius - 0.2) continue;
        plant(tx, tz, top, (0.5 + scale * 0.4) * (clear(tx, tz, 0) ? 1 : 0.6));
      }
    }
  }
  const meadowCells: { mesh: InstancedMesh; all: number; share: number; x: number; z: number }[] =
    [];
  for (const { placements, tints, x, z } of cells.values()) {
    for (let i = placements.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [placements[i], placements[j]] = [placements[j] as Placement, placements[i] as Placement];
      [tints[i], tints[j]] = [tints[j] as Color, tints[i] as Color];
    }
    const mesh = instanced(tuft, grass, placements, false, tints);
    mesh.name = "grass";
    group.add(mesh);
    meadowCells.push({
      all: placements.length,
      mesh,
      share: Math.round(placements.length * site.grassShare),
      x,
      z,
    });
  }
  let drawn = 0;
  const meadowLod: IMeadow = {
    get drawn() {
      return drawn;
    },
    total: meadowCells.reduce((sum, cell) => sum + cell.share, 0),
    update(eye) {
      drawn = 0;
      for (const cell of meadowCells) {
        // The cell's nearest point to the eye, so a cell the camera stands in is near however big.
        const d = Math.max(0, Math.hypot(cell.x - eye.x, cell.z - eye.z) - 6);
        const keep = d < 10 ? 1 : Math.max(1 / 8, 1 - (d - 10) / 34) * site.grassShare;
        cell.mesh.count = Math.min(cell.all, Math.round(cell.all * keep));
        drawn += cell.mesh.count;
      }
    },
  };

  // Beaches: a sand shelf at the cliff's foot and a darker wet band at the water; the sea's own
  // shader breaks the foam along it (`water.ts`).
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
  }
  return { group, meadow: meadowLod };
}
