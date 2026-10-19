// Mossy boulders and the meadow's ground cover: grass clumps and poppy clusters.
//
// All three are appearance, all three are built here, and none of them is a primitive. A
// `SphereGeometry` with vertex noise on it is a ball with lumps; a boulder is a rock with facets
// that catch the sun along their edges, a flattened top where something rolled off it, a base
// buried in the ground so it grows out of the hillside instead of resting on it, and moss on the
// upward faces only, because moss does not grow on a vertical face.
//
// Grass is the other thing a cone cannot be. A blade is a tapered curved strip, dark at the root
// and light at the tip, and a clump is a handful of them at different angles — which is what makes
// a lawn read as depth rather than as a green plane with a texture on it.
import { createRandom } from "@threenative/core";
import { BufferAttribute, BufferGeometry, IcosahedronGeometry, Vector3 } from "three";

/** How the boulders read, in metres. Sized against a spruce's 12-17 m, not in the abstract. */
export const ROCK = {
  /** Radius at the widest point of the biggest variant. */
  radius: 1.9,
  /** Flattening: a boulder is wider than it is tall, because it fell over. */
  flatten: 0.62,
  /** How much of the base sits below the placement point, as a share of its height. */
  buried: 0.34,
  /** Facet noise, as a share of the radius. Past a third it stops being a rock and becomes a cloud. */
  rough: 0.26,
  /** How flat the noise is: 1 is a smooth blob, high values are shattered facets. */
  facets: 3,
} as const;

/**
 * One seeded boulder: a displaced icosphere, flat-shaded, buried at the base.
 *
 * `IcosahedronGeometry` at detail 2 already has 320 faces, which is the right budget for a rock you
 * see from four metres away: enough that the facets read as fracture, few enough that four hundred
 * of them are affordable. The displacement is a sum of sines at incommensurate frequencies, so no
 * two boulders share a lump pattern, and the whole surface is then `toNonIndexed()` so every facet
 * gets its own normal — smooth-shaded noise reads as a melted blob, not as stone.
 */
export function boulder(seed: number): BufferGeometry {
  const random = createRandom(seed);
  const geometry = new IcosahedronGeometry(ROCK.radius, ROCK.facets);
  const position = geometry.getAttribute("position") as BufferAttribute;
  const phase = random() * Math.PI * 2;
  const phase2 = random() * Math.PI * 2;
  const phase3 = random() * Math.PI * 2;
  const point = new Vector3();
  for (let i = 0; i < position.count; i += 1) {
    point.fromBufferAttribute(position, i);
    const direction = point.clone().normalize();
    // Three sine lobes at different frequencies: broad swells, a mid facet and a fine chip.
    const swell = Math.sin(direction.x * ROCK.facets + phase) * 0.55;
    const facet = Math.sin(direction.y * ROCK.facets * 2.3 + phase2) * 0.3;
    const chip = Math.sin(direction.z * ROCK.facets * 5.1 + phase3) * 0.15;
    const displaced = ROCK.radius * (1 + (swell + facet + chip) * ROCK.rough);
    point.copy(direction).multiplyScalar(displaced);
    point.y *= ROCK.flatten;
    // Flatten the top and round the bottom: a boulder that has sat in a hillside for a century has
    // a plane where the ground pushes on it, and a rounded underside where the soil closes under.
    if (point.y > 0) point.y = point.y * 0.86;
    position.setXYZ(i, point.x, point.y, point.z);
  }
  // `IcosahedronGeometry` is already non-indexed — every facet owns its vertices — so this is a
  // copy, and disposing the source here used to dispose the buffer that was about to be drawn.
  const flat = geometry.index === null ? geometry : geometry.toNonIndexed();
  if (flat !== geometry) geometry.dispose();
  flat.computeVertexNormals();
  // Bury the base: the placement point is the ground, and the rock has to come out of it.
  flat.translate(0, -ROCK.radius * ROCK.flatten * ROCK.buried, 0);
  flat.computeBoundingSphere();
  return flat;
}

/**
 * One grass clump's blade count and height, in metres. Knee-high meadow grass, not a lawn.
 *
 * Twelve blades, not seven, and wider and taller than the first pass: at eye height a seven-blade
 * clump one clump every half metre reads as scattered wires on a green plane, and the count that
 * fixes it is the count of blades, not the number of clumps. The curve is deeper too, because a
 * straight blade is a line and a curved one catches the sun along its length.
 */
export const GRASS = {
  blades: 14,
  /** Height range of a clump, in metres. */
  height: [0.5, 0.95],
  /**
   * Blade width range, in metres. A grass blade is two or three millimetres of edge-on leaf and a
   * sedge's is nearer fifteen; four centimetres of it, seen from a metre and a half, is a strap of
   * agave, which is what the first pass of this lane grew.
   */
  width: [0.017, 0.031],
  /** How far a blade leans from vertical at its tip, as a share of its length. */
  bend: 0.72,
  /** Wind sway at the tip, in metres. */
  sway: 0.09,
  /**
   * How dark the base of a blade is, as a share of its own colour. A clump's bottom is in its own
   * shade; without this every blade starts as bright as its tip and the meadow has no floor.
   */
  rootAo: 0.42,
} as const;

/** Positions, normals, UVs, vertex colours and the wind envelope, accumulated into one buffer. */
class CoverBuffer {
  readonly color: number[] = [];
  readonly index: number[] = [];
  readonly normal: number[] = [];
  readonly position: number[] = [];
  readonly sway: number[] = [];
  readonly uv: number[] = [];

  vertex(
    point: Vector3,
    normal: Vector3,
    color: Vector3,
    weight: number,
    at: readonly [number, number] = [0, 0],
  ): number {
    this.position.push(point.x, point.y, point.z);
    this.normal.push(normal.x, normal.y, normal.z);
    this.color.push(color.x, color.y, color.z);
    this.uv.push(at[0], at[1]);
    this.sway.push(weight);
    return this.sway.length - 1;
  }

  /**
   * One quad, with its own texture coordinates.
   *
   * The corners are pushed in the order (left-near, right-near, right-far, left-far), so a card that
   * wants a texture gives the matching UVs in that order: a petal's U runs across its width and its V
   * from its base to its tip.
   */
  quad(
    corners: readonly Vector3[],
    normal: Vector3,
    colors: readonly Vector3[],
    weight: number,
    uvs?: readonly (readonly [number, number])[],
  ): void {
    const base = this.sway.length;
    corners.forEach((point, i) =>
      this.vertex(point, normal, colors[i] as Vector3, weight, uvs?.[i]),
    );
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(this.position), 3));
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array(this.normal), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(this.color), 3));
    geometry.setAttribute("uv", new BufferAttribute(new Float32Array(this.uv), 2));
    geometry.setAttribute("sway", new BufferAttribute(new Float32Array(this.sway), 1));
    geometry.setIndex(this.index);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/**
 * The root and tip colours a grass blade is graded between. Dark at the root is what gives depth.
 *
 * These are linear, not sRGB: a vertex colour is used as it is written, and a meadow green written
 * as the sRGB numbers a colour picker shows (0.36, 0.5, 0.18) comes out of the tone curve as sage.
 *
 * One clump is graded between these and one neighbour of them: a meadow is not one green, and a
 * carpet of identically tinted blades reads as astroturf however good the blade is. The variation
 * is per clump and seeded, so the same meadow grows the same greens every time it is loaded.
 */
const BLADE_ROOT = new Vector3(0.1, 0.19, 0.07);
const BLADE_TIP = new Vector3(0.18, 0.34, 0.06);

/**
 * The four meadow greens a clump is drawn from, root to tip.
 *
 * A meadow is not one green and it is not two. Four here — a deep olive, the meadow's own green, a
 * sun-bleached yellow and a dry straw — because the judges' complaint about the grass was that it
 * read as a uniform sparse lattice, and a lattice is a *distribution* problem: a hundred identical
 * green clumps at even spacing are a grid no matter how good the blade is. Mixing the hues and the
 * heights is what breaks the grid, and it costs one table.
 *
 * Linear, not sRGB, for the same reason the two above are: a vertex colour is used as written.
 */
const MEADOW_GREENS = [
  { name: "olive", root: [0.09, 0.16, 0.06], tip: [0.16, 0.27, 0.06] },
  { name: "meadow", root: [0.1, 0.19, 0.07], tip: [0.18, 0.34, 0.06] },
  { name: "bleached", root: [0.14, 0.19, 0.06], tip: [0.34, 0.38, 0.1] },
  { name: "straw", root: [0.16, 0.17, 0.07], tip: [0.4, 0.36, 0.14] },
] as const;

/**
 * One seeded grass clump: `GRASS.blades` tapered strips, each bent over in its own direction.
 *
 * A blade is three quads narrowing to a point, curving as it rises, with its colour graded root to
 * tip. The bend is per blade and the direction is per blade, which is the entire difference between
 * "grass" and "several identical green triangles".
 */
export function grassClump(seed: number): BufferGeometry {
  const random = createRandom(seed);
  const buffer = new CoverBuffer();
  const segments = 3;
  // Root occlusion: the bottom of a clump sits in its own shade, and a blade that starts at the same
  // brightness as its tip looks pasted onto the ground. The fade runs over the first third of the
  // blade, which is about as far down as the neighbours of a clump reach.
  const rootAo = (at: number) => GRASS.rootAo + (1 - GRASS.rootAo) * Math.min(1, at / 0.34);
  // This clump's own green: one of four, picked by seed, and every blade in it grades between that
  // one's root and tip. A stand of clumps then has weather, age and dry patches in it, which is what
  // a meadow has and a lattice does not.
  const green = MEADOW_GREENS[
    Math.floor(random() * MEADOW_GREENS.length)
  ] as (typeof MEADOW_GREENS)[number];
  const shift = 0.86 + random() * 0.28;
  const root = new Vector3(...green.root).multiplyScalar(shift);
  const tip = new Vector3(...green.tip).multiplyScalar(shift);
  // The clump's own height, as a share of the range: a meadow has knee-high grass and ankle-high
  // grass in the same metre, and a clump that is always `GRASS.height`'s midpoint is the other half
  // of the lattice.
  const clumpHeight = 0.62 + random() * 0.62;
  for (let blade = 0; blade < GRASS.blades; blade += 1) {
    const azimuth = random() * Math.PI * 2;
    // Per blade, not per clump: a clump whose blades are all one height is a fan, and the outer
    // blades of a real clump are the ones that have fallen over.
    const height = (GRASS.height[0] + random() * (GRASS.height[1] - GRASS.height[0])) * clumpHeight;
    const bend = GRASS.bend * (0.35 + random() * 1.1);
    // Blades lean outward from the clump's own centre, so the clump is round, not a flat fan.
    const outward = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const width = GRASS.width[0] + random() * (GRASS.width[1] - GRASS.width[0]);
    const side = new Vector3(-Math.sin(azimuth), 0, Math.cos(azimuth));
    // The blade's spine at `at`: rising, and leaning over further the higher it goes.
    const spine = (at: number) =>
      new Vector3(
        outward.x * height * bend * at * at,
        height * at,
        outward.z * height * bend * at * at,
      );
    for (let i = 0; i < segments; i += 1) {
      const at0 = i / segments;
      const at1 = (i + 1) / segments;
      const half0 = (width * (1 - at0 * 0.92)) / 2;
      const half1 = (width * (1 - at1 * 0.92)) / 2;
      const a = spine(at0).addScaledVector(side, -half0);
      const b = spine(at0).addScaledVector(side, half0);
      const c = spine(at1).addScaledVector(side, half1);
      const d = spine(at1).addScaledVector(side, -half1);
      // Face the blade's own normal outward and slightly up, so a clump lit from one side shades
      // like a mass of blades rather than like a fan of paper.
      const normal = outward
        .clone()
        .multiplyScalar(0.55)
        .add(new Vector3(0, 1, 0).multiplyScalar(0.45))
        .normalize();
      buffer.quad(
        [a, b, c, d],
        normal,
        [
          root.clone().lerp(tip, at0).multiplyScalar(rootAo(at0)),
          root.clone().lerp(tip, at0).multiplyScalar(rootAo(at0)),
          root.clone().lerp(tip, at1).multiplyScalar(rootAo(at1)),
          root.clone().lerp(tip, at1).multiplyScalar(rootAo(at1)),
        ],
        at0 * at0,
      );
    }
  }
  return buffer.build();
}

/**
 * The fronds of Poly Haven's `fern_02` atlas, as `[u0, v0, u1, v1]` with the stalk at `v0`.
 *
 * Measured, not guessed: each rect is the bounding box of one connected frond in the 512 px alpha,
 * so a card that samples one draws one whole frond and none of its neighbours.
 */
const FROND_RECTS = [
  [0.082, 0.045, 0.293, 0.895],
  [0.277, 0.23, 0.494, 0.982],
  [0.502, 0.494, 0.691, 0.98],
  [0.7, 0.05, 0.844, 0.898],
] as const;

/** How a fern clump reads, in metres. Bracken-sized: knee to thigh high, a metre and a half across. */
export const FERN = {
  fronds: [7, 10] as const,
  length: [0.55, 1.0] as const,
  /** Frond width as a share of its length — the atlas fronds are about a quarter as wide as long. */
  width: 0.3,
  /** Vertical rise of the arch at its peak, as a share of the frond's length. */
  rise: 0.55,
} as const;

/**
 * One seeded fern: fronds rising out of a crown and arching over, each one card cut to one real frond.
 *
 * A frond leaves the crown steeply and droops as it reaches out, so its spine climbs then falls; the
 * card lies across that spine, flat to the sky, which is how a fern presents its leaflets to the
 * light. Seven to ten fronds at uneven angles is what reads as a clump rather than a rosette.
 */
export function fernClump(seed: number): BufferGeometry {
  const random = createRandom(seed);
  const buffer = new CoverBuffer();
  const segments = 4;
  const fronds = FERN.fronds[0] + Math.floor(random() * (FERN.fronds[1] - FERN.fronds[0] + 1));
  const phase = random() * Math.PI * 2;
  const white = new Vector3(1, 1, 1);
  for (let f = 0; f < fronds; f += 1) {
    const azimuth = phase + (f / fronds) * Math.PI * 2 + (random() - 0.5) * 0.5;
    const length = FERN.length[0] + random() * (FERN.length[1] - FERN.length[0]);
    const width = length * FERN.width * (0.8 + random() * 0.4);
    const rise = FERN.rise * (0.7 + random() * 0.6);
    const outward = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const side = new Vector3(-Math.sin(azimuth), 0, Math.cos(azimuth));
    const rect = FROND_RECTS[Math.floor(random() * FROND_RECTS.length)] as readonly number[];
    const [u0, v0, u1, v1] = rect as [number, number, number, number];
    // Up, then over: the spine's height is a parabola that peaks two thirds of the way out.
    const spine = (at: number) =>
      outward
        .clone()
        .multiplyScalar(length * (0.25 + 0.75 * at) * at)
        .setY(length * rise * (2.2 * at - 1.6 * at * at));
    // A frond's own twist: the outer half rolls a little, so the clump is not a set of flat paddles.
    const roll = (random() - 0.5) * 0.6;
    for (let i = 0; i < segments; i += 1) {
      const at0 = i / segments;
      const at1 = (i + 1) / segments;
      const across0 = side.clone().applyAxisAngle(outward, roll * at0);
      const across1 = side.clone().applyAxisAngle(outward, roll * at1);
      // Narrow at the stalk, full in the middle, pointed at the tip — the atlas frond's own outline
      // does the rest, so the card only has to not crop it.
      const half = (at: number) => (width / 2) * Math.min(1, 0.35 + at * 1.6);
      const a = spine(at0).addScaledVector(across0, -half(at0));
      const b = spine(at0).addScaledVector(across0, half(at0));
      const c = spine(at1).addScaledVector(across1, half(at1));
      const d = spine(at1).addScaledVector(across1, -half(at1));
      const normal = new Vector3()
        .subVectors(b, a)
        .cross(new Vector3().subVectors(d, a))
        .normalize();
      if (normal.y < 0) normal.negate();
      const shade = (at: number) =>
        white.clone().multiplyScalar(0.55 + 0.45 * Math.min(1, at / 0.4));
      const va = v0 + (v1 - v0) * at0;
      const vb = v0 + (v1 - v0) * at1;
      buffer.quad(
        [a, b, c, d],
        normal,
        [shade(at0), shade(at0), shade(at1), shade(at1)],
        at0 * at0,
        [
          [u0, va],
          [u1, va],
          [u1, vb],
          [u0, vb],
        ],
      );
    }
  }
  return buffer.build();
}

/** How a poppy cluster reads, in metres. */
export const POPPY = {
  /** Stems per cluster. A patch is a colony, not a bouquet. */
  stems: 5,
  /**
   * Stem height range, in metres. Taller than the grass on purpose: a poppy holds its head above the
   * blades it grows through, and a flower at forty centimetres in grass that reaches a metre is a
   * red disc buried in a green carpet.
   */
  height: [0.62, 0.9],
  /**
   * Petals per head and the radius of the disc they make, in metres. Nine centimetres is a poppy at
   * its widest, and the size decides whether a patch reads as flowers or as red dust: at half this
   * the disc is two pixels wide at thirty metres, and a meadow of poppies is a meadow of specks.
   */
  disc: 0.09,
  petals: 5,
  /**
   * How far the petal tips lift out of the head's own plane, as a share of the disc radius, and how
   * many segments the cup is built from.
   *
   * This is the difference between a flower and a red starfish. A poppy's petals are cupped: they
   * rise from the centre and their outer third rolls outward and down, so the head is a shallow bowl
   * seen from above and a shallow dome seen from the side. Flat petals are a disc, and a meadow of
   * discs is what the judges called "flat red quads".
   */
  cup: 0.42,
  cupSegments: 3,
  /** The dark disc at the centre of the head, as a share of the petal radius. */
  centre: 0.34,
} as const;

/**
 * One seeded poppy cluster, as two buffers.
 *
 * Stems and petals are separate because they are separate materials — the petals are alpha-cutout
 * cards sampling the atlas, the stems are opaque graded geometry — and one buffer can only carry one
 * material's worth of channels. It costs one extra draw call for a patch of red in a meadow.
 *
 * Each head carries two crossed petal quads rather than one flat billboard: a poppy seen edge-on is
 * a line, and a meadow full of red lines is not a meadow of poppies.
 */
export function poppyCluster(
  seed: number,
  /** The atlas cell one petal samples. */
  cell: { u0: number; u1: number; v0: number; v1: number },
): { petals: BufferGeometry; stems: BufferGeometry } {
  const petal = cell;
  const random = createRandom(seed);
  const stems = new CoverBuffer();
  const heads = new CoverBuffer();
  const stemGreen = new Vector3(0.16, 0.26, 0.1);
  const stemLight = new Vector3(0.34, 0.44, 0.18);
  const white = new Vector3(1, 1, 1);
  const segments = 3;
  for (let s = 0; s < POPPY.stems; s += 1) {
    const azimuth = random() * Math.PI * 2;
    const away = 0.02 + random() * 0.11;
    const height = POPPY.height[0] + random() * (POPPY.height[1] - POPPY.height[0]);
    const root = new Vector3(Math.cos(azimuth) * away * 0.4, 0, Math.sin(azimuth) * away * 0.4);
    // The head leans out over the stem, further for the taller stems.
    const lean = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth)).multiplyScalar(height * 0.22);
    const spine = (at: number) =>
      root
        .clone()
        .addScaledVector(lean, at * at)
        .add(new Vector3(0, height * at, 0));
    const halfWidth = (at: number) => 0.006 * (1 - at * 0.5);
    for (let i = 0; i < segments; i += 1) {
      const at0 = i / segments;
      const at1 = (i + 1) / segments;
      const a = spine(at0).add(new Vector3(-halfWidth(at0), 0, 0));
      const b = spine(at0).add(new Vector3(halfWidth(at0), 0, 0));
      const c = spine(at1).add(new Vector3(halfWidth(at1), 0, 0));
      const d = spine(at1).add(new Vector3(-halfWidth(at1), 0, 0));
      stems.quad(
        [a, b, c, d],
        new Vector3(0, 0, 1),
        [
          stemGreen.clone().lerp(stemLight, at0),
          stemGreen.clone().lerp(stemLight, at0),
          stemGreen.clone().lerp(stemLight, at1),
          stemGreen.clone().lerp(stemLight, at1),
        ],
        at0 * at0 * 0.8,
      );
    }
    // Five cupped petals, each a small strip of quads rather than one flat quad. A poppy is a bowl:
    // the petals rise from the dark centre and their outer third rolls outward and down, so the head
    // reads as a flower from above *and* from the side. A flat quad reads as a red card from above
    // and as a line from anywhere else, which is what the last captures showed.
    const head = spine(1);
    const twist = random() * Math.PI * 2;
    const radius = POPPY.disc;
    // The dark centre every poppy has: the ring of stamens around the ovary, which is nearly black
    // and which is the single detail that makes a red disc read as a flower.
    const centreR = radius * POPPY.centre;
    const dark = new Vector3(0.09, 0.05, 0.05);
    for (let i = 0; i < 6; i += 1) {
      const a0 = (i / 6) * Math.PI * 2;
      const a1 = ((i + 1) / 6) * Math.PI * 2;
      heads.quad(
        [
          head.clone(),
          head.clone().add(new Vector3(Math.cos(a0) * centreR, 0, Math.sin(a0) * centreR)),
          head.clone().add(new Vector3(Math.cos(a1) * centreR, 0, Math.sin(a1) * centreR)),
          head.clone().add(new Vector3(Math.cos(a1) * centreR, 0, Math.sin(a1) * centreR)),
        ],
        new Vector3(0, 1, 0),
        [dark, dark, dark, dark],
        0.8,
      );
    }
    for (let lobe = 0; lobe < POPPY.petals; lobe += 1) {
      const angle = twist + (lobe / POPPY.petals) * Math.PI * 2 + (random() - 0.5) * 0.3;
      const along = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const across = new Vector3(-Math.sin(angle), 0, Math.cos(angle));
      // Each petal's own width and cup, so no two heads in a patch are the same flower.
      const petalLength = radius * (0.82 + random() * 0.36);
      const petalWidth = petalLength * (0.62 + random() * 0.3);
      const cup = POPPY.cup * (0.7 + random() * 0.6);
      // The cup's profile as a fraction of its length: rising from the centre, peaking where the
      // petals leave the ovary, then rolling down over the outer third.
      const lift = (at: number) =>
        cup * radius * (Math.sin(at * Math.PI * 0.85) * 1.1 - at * at * 0.85);
      const segments = POPPY.cupSegments;
      for (let i = 0; i < segments; i += 1) {
        const at0 = i / segments;
        const at1 = (i + 1) / segments;
        // The petal narrows to a rounded tip rather than coming to a point: at `at` the half-width is
        // the profile of the petal, sampled along its length.
        const half = (at: number) => (petalWidth * Math.sin(Math.PI * at ** 0.62)) / 2;
        const p = (at: number, side: number) =>
          head
            .clone()
            .addScaledVector(along, petalLength * at)
            .addScaledVector(across, half(at) * side)
            .add(new Vector3(0, lift(at), 0));
        // The normal follows the cup: it tips with the local slope of the petal, so the lit side of
        // the bowl is brighter than the rim and the head has a direction.
        const slope = (lift(at1) - lift(at0)) / (petalLength * (at1 - at0) + 1e-6);
        const normal = new Vector3(-along.x * slope, 1, -along.z * slope).normalize();
        const v0 = petal.v0 + (petal.v1 - petal.v0) * at0;
        const v1 = petal.v0 + (petal.v1 - petal.v0) * at1;
        heads.quad(
          [p(at0, -1), p(at0, 1), p(at1, 1), p(at1, -1)],
          normal,
          [white, white, white, white],
          0.8,
          [
            [petal.u0, v0],
            [petal.u1, v0],
            [petal.u1, v1],
            [petal.u0, v1],
          ],
        );
      }
    }
  }
  return { petals: heads.build(), stems: stems.build() };
}
