import {
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Path,
  PlaneGeometry,
  RingGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { noise3 } from "../../vendor/stylized-biome-kit/core.js";
import type { ToyMesh, ToyPart, XYZ } from "./kit.js";

/**
 * Modules snap to a 2 m grid: each stands on y = 0, centred on its cell, and terrain blocks rise in
 * whole metres, so blocks stack and line up into plateaus, cliffs and paths. Platforms are 0.5 m
 * thick; props stand on y = 0 and go on top of any block.
 */
export const CELL = 2;
const H = CELL / 2;

const smooth = (t: number) => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/** Fades the rock relief to nothing at the two vertical edges of a square block's face. */
const blockSeam = (x: number, z: number, nx: number, nz: number) =>
  smooth((H - Math.abs(x * Math.abs(nz) + z * Math.abs(nx))) / 0.07);

/**
 * The four side faces and the underside of a block. Each face keeps its own vertices, so its
 * relief stops at the face border and neighbouring or stacked blocks meet flush.
 */
function walls(height: number): BufferGeometry {
  const faces: BufferGeometry[] = [0, 1, 2, 3].map((quarter) =>
    new PlaneGeometry(CELL, height, 24, Math.round(height * 16))
      .translate(0, height / 2, H)
      .rotateY((quarter * Math.PI) / 2),
  );
  faces.push(new PlaneGeometry(CELL, CELL).rotateX(Math.PI / 2));
  const merged = mergeGeometries(faces);
  if (!merged) throw new Error("Could not merge toybox block walls");
  for (const face of faces) face.dispose();
  return merged;
}

/**
 * Rock sides: uneven courses of chunky slabs. Each slab bulges or sits back by up to 7 cm and
 * tilts its own way, with a dark groove at every joint (baked into the vertex colour as shade).
 * `seam` returns 0 where a neighbouring module joins, so the relief fades there and a row of
 * modules reads as one cliff. Tops and bottoms stay on the grid.
 */
function strata(
  m: ToyMesh,
  shape: BufferGeometry,
  height: number,
  {
    color = m.palette.rock,
    seam = blockSeam,
  }: { color?: number; seam?: (x: number, z: number, nx: number, nz: number) => number } = {},
): void {
  shape.deleteAttribute("uv");
  const g = mergeVertices(shape, 1e-3);
  shape.dispose();
  const p = g.getAttribute("position");
  const n = g.getAttribute("normal");
  const grit = m.rng.seed();
  const shade = new Float32Array(p.count).fill(1);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const nx = n.getX(i);
    const nz = n.getZ(i);
    const side = 1 - n.getY(i) ** 2;
    if (side < 0.05) continue;
    const hold = side * smooth(Math.min(y, height - y) / 0.08) * seam(x, z, nx, nz);
    // distance along the face, shifted per face so the four sides differ
    const along = x * Math.abs(nz) + z * Math.abs(nx) + (nx - nz) * 1.7;
    // a few tall courses of uneven height that drift up and down along the face
    const course =
      y * 1.35 +
      noise3(along * 0.45, y * 0.7, 0.7, grit) * 0.3 +
      noise3(along * 0.15, 2.2, 0.1, grit + 1) * 0.4;
    const row = Math.floor(course);
    // each course cuts its slabs to its own length and offset, on joints that lean a little
    const perMetre = 0.38 + 0.19 * (1 + noise3(row * 7.1 + 0.3, 0.6, 0.2, grit + 3));
    const run =
      along * perMetre +
      noise3(row * 3.17 + 0.4, 0.3, 0.9, grit + 2) * 5 +
      noise3(y * 1.5, along * 0.3, 0.4, grit + 4) * 0.12;
    const slab = Math.floor(run);
    const fy = course - row;
    const fx = run - slab;
    const joint =
      1 - Math.min(1, Math.min(fy, 1 - fy) / 0.1, Math.min(fx, 1 - fx) / (0.08 * perMetre));
    const proud = 0.5 + 0.5 * noise3(row * 5.3 + 0.7, slab * 3.9 + 0.2, 0.5, grit + 5);
    // each slab face tilts its own way, so the cliff breaks into angular facets
    const facet =
      noise3(row * 2.3 + 0.1, slab * 4.7 + 0.6, 1.5, grit + 6) * (fx - 0.5) * 0.12 +
      noise3(row * 6.1 + 0.9, slab * 1.9 + 0.3, 2.5, grit + 8) * (fy - 0.5) * 0.08;
    // broad swells and small chips keep a slab face from reading as a flat brick
    const lump =
      noise3(x * 1.1, y * 1.6, z * 1.1, grit + 7) * 1.6 +
      Math.max(0, noise3(x * 3.1, y * 5, z * 3.1, grit + 10));
    // proud slabs bulge past the grid face and the others sit behind it, so the fixed border of
    // each face reads as a chiselled edge and not as a raised frame
    const dent = hold * ((0.45 - proud) * 0.14 + facet + joint * joint * 0.1 + lump * 0.02);
    p.setXYZ(i, x - nx * dent, y, z - nz * dent);
    shade[i] = (1 - hold * joint * joint * 0.55) * (0.88 + 0.16 * proud);
  }
  g.computeVertexNormals();
  g.setAttribute("shade", new Float32BufferAttribute(shade, 1));
  const dark = new Color(color).multiplyScalar(0.7);
  const light = new Color(color).lerp(new Color(0xffffff), 0.16);
  m.add(g, color, "rock", (x, y, z, out) => {
    const mottle = noise3(x * 1.8, y * 4.5, z * 1.8, grit + 9);
    out.lerp(mottle < 0 ? dark : light, Math.min(1, Math.abs(mottle) * 1.2));
    out.multiplyScalar(0.78 + 0.22 * Math.min(1, y / height + 0.3)); // darker toward the base
  });
}

/**
 * Cross-section of the planter collar that rings a lawn: x is metres out from the block face,
 * y metres above the lawn. Chunky and rounded, it overhangs the rock and stands above the grass.
 */
const COLLAR = { inner: -0.3, outer: 0.09, bottom: -0.24, top: 0.1, radius: 0.1 };
function collarShape(): Shape {
  const { inner, outer, bottom, top, radius: r } = COLLAR;
  const s = new Shape();
  s.moveTo(inner + r, bottom);
  s.lineTo(outer - r, bottom);
  s.absarc(outer - r, bottom + r, r, -Math.PI / 2, 0, false);
  s.lineTo(outer, top - r);
  s.absarc(outer - r, top - r, r, 0, Math.PI / 2, false);
  s.lineTo(inner + r, top);
  s.absarc(inner + r, top - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(inner, bottom + r);
  s.absarc(inner + r, bottom + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Cast-stone finish for a collar piece at lawn height `top`: paler on its crown, shaded below. */
function collarAdd(m: ToyMesh, shape: BufferGeometry, top: number) {
  const grit = m.rng.seed();
  m.add(shape, m.palette.rim, "stone", (x, y, z, out) => {
    out.multiplyScalar(0.74 + 0.3 * smooth((y - top - COLLAR.bottom) / 0.3));
    out.multiplyScalar(0.96 + noise3(x * 1.3, y * 3, z * 1.3, grit) * 0.06);
  });
}

/** A straight collar along the block's +Z edge. */
function collarEdge(m: ToyMesh, top: number) {
  const run = new ExtrudeGeometry(collarShape(), {
    depth: CELL,
    bevelEnabled: false,
    curveSegments: 6,
  });
  collarAdd(m, run.rotateY(-Math.PI / 2).translate(H, top, H), top);
}

/** A collar swept through `arc` radians at `radius` about the Y axis through (cx, cz). */
function collarArc(m: ToyMesh, top: number, radius: number, arc: number, cx = 0, cz = 0) {
  const profile = collarShape()
    .getPoints(6)
    .map((v) => new Vector2(radius + v.x, top + v.y));
  const sweep = new LatheGeometry(profile, Math.max(8, Math.round((radius * arc) / 0.16)), 0, arc);
  collarAdd(m, sweep.translate(cx, 0, cz), top);
  if (arc > Math.PI * 1.99) return;
  for (const end of [0, 1]) {
    const cap = new ExtrudeGeometry(collarShape(), { depth: 0.004, bevelEnabled: false });
    cap.translate(radius, top, -0.002).rotateY(end ? arc - Math.PI / 2 : -Math.PI / 2);
    collarAdd(m, cap.translate(cx, 0, cz), top);
  }
}

/** A grass lid: a soil rim that overhangs the rock a touch, then a carpet of blades. */
function lawn(
  m: ToyMesh,
  top: number,
  inside: (x: number, z: number) => boolean,
  lid?: BufferGeometry,
) {
  if (lid) m.add(lid, m.palette.soil, "soil");
  m.grass(H + 0.05, top, inside);
}

const square = (half: number) => (x: number, z: number) => Math.abs(x) < half && Math.abs(z) < half;
const lid = (height: number) =>
  new RoundedBoxGeometry(CELL + 0.06, 0.12, CELL + 0.06, 2, 0.05).translate(0, height - 0.04, 0);

function grassBlock(m: ToyMesh, height: number) {
  strata(m, walls(height), height);
  lawn(m, height, square(H + 0.02), lid(height));
}

export const grassBlock1: ToyPart = (m) => grassBlock(m, 1);
export const grassBlock2: ToyPart = (m) => grassBlock(m, 2);

/** A plateau edge: a 1 m grass block with the planter collar along its +Z side. */
export const grassEdge: ToyPart = (m) => {
  strata(m, walls(1), 1);
  collarEdge(m, 1);
  const half = H + 0.02;
  lawn(m, 1, (x, z) => Math.abs(x) < half && z > -half && z < H + COLLAR.inner + 0.02, lid(1));
};

/**
 * An outer corner: a quarter round of radius 2 m about the cell's -X -Z corner, 1 m tall, with
 * the planter collar round its curve. It joins a `grassEdge` on each side.
 */
export const grassCorner: ToyPart = (m) => {
  const quarter = (r: number, h: number, rows: number) =>
    new CylinderGeometry(r, r, h, 32, rows, false, 0, Math.PI / 2).translate(-H, h / 2, -H);
  strata(m, quarter(CELL, 1, 16), 1, {
    seam: (x, z) => {
      const a = Math.atan2(x + H, z + H);
      return smooth((Math.min(a, Math.PI / 2 - a) * CELL) / 0.07);
    },
  });
  collarArc(m, 1, CELL, Math.PI / 2, -H, -H);
  const inside = (x: number, z: number) =>
    x > -H - 0.02 && z > -H - 0.02 && Math.hypot(x + H, z + H) < CELL + COLLAR.inner + 0.02;
  lawn(m, 1, inside, quarter(CELL + 0.03, 0.12, 1).translate(0, 1 - 0.1, 0));
};

/** A ramp rising 1 m over one cell toward -Z. */
export const grassRamp: ToyPart = (m) => {
  const profile = new Shape();
  profile.moveTo(-H, 0);
  profile.lineTo(H, 0);
  profile.lineTo(-H, 1);
  profile.closePath();
  const wedge = new ExtrudeGeometry(profile, { depth: CELL, bevelEnabled: false })
    .translate(0, 0, -H)
    .rotateY(-Math.PI / 2);
  wedge.computeVertexNormals();
  m.add(wedge, m.palette.rock, "rock", (_x, y, _z, out) => out.multiplyScalar(0.75 + y * 0.2));
  const rise = (_x: number, z: number) => (H - z) / CELL;
  m.grass(H, (x, z) => rise(x, z) - 0.02, square(H - 0.02));
};

/** Bare layered rock, 2 m tall, with a pale weathered ledge on top. */
export const cliffBlock: ToyPart = (m) => {
  strata(m, walls(2), 2);
  m.rock([0, 1.96, 0], [H * 1.02, 0.12, H * 1.02], { flat: true, color: m.palette.rim });
};

/** A grass block with a sunken pool: the water lies 10 cm below the lawn, pebbles round its rim. */
export const pondBlock: ToyPart = (m) => {
  const p = m.palette;
  const pool = 0.74;
  strata(m, walls(1), 1);
  // the soil lid, cut round the pool
  const top = new Shape();
  const half = H + 0.03;
  top.moveTo(-half, -half);
  top.lineTo(half, -half);
  top.lineTo(half, half);
  top.lineTo(-half, half);
  top.closePath();
  top.holes.push(new Path().absarc(0, 0, pool, 0, Math.PI * 2, true));
  m.add(
    new ExtrudeGeometry(top, { depth: 0.2, bevelEnabled: false, curveSegments: 32 })
      .rotateX(-Math.PI / 2)
      .translate(0, 0.81, 0),
    p.soil,
    "soil",
  );
  m.cylinder(
    [0, 0.8, 0],
    pool + 0.02,
    pool + 0.02,
    0.04,
    new Color(p.soil).multiplyScalar(0.6).getHex(),
    "soil",
  );
  m.cylinder([0, 0.88, 0], pool, pool, 0.04, p.water, "water");
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + m.rng.range(-0.08, 0.08);
    const s = m.rng.range(0.1, 0.17);
    m.rock([Math.cos(a) * 0.8, 0.99, Math.sin(a) * 0.8], [s, s * 0.6, s], { color: p.rim });
  }
  m.grass(H + 0.05, 1, (x, z) => square(H + 0.02)(x, z) && Math.hypot(x, z) > 0.93);
};

/** A white platform slab, 2 m square and 0.5 m thick, with an accent band. */
export const plasticSlab: ToyPart = (m) => {
  const p = m.palette;
  m.box([0, 0.27, 0], [CELL, 0.46, CELL], p.plastic, "plastic", 0.14);
  m.box([0, 0.2, 0], [CELL + 0.03, 0.1, CELL + 0.03], p.accent, "plastic", 0.05);
  m.box([0, 0.02, 0], [CELL - 0.2, 0.04, CELL - 0.2], p.metal, "metal", 0.02);
};

/**
 * A dark metal deck panel: a stone slab set in its top carries glowing traces. The traces run to
 * the middle of each edge, so a row of panels joins into one circuit.
 */
export const techPanel: ToyPart = (m) => {
  const p = m.palette;
  m.box([0, 0.24, 0], [CELL, 0.48, CELL], p.metal, "metal", 0.06);
  m.box(
    [0, 0.47, 0],
    [CELL - 0.16, 0.04, CELL - 0.16],
    new Color(p.rock).multiplyScalar(0.62).getHex(),
    "stone",
    0.02,
  );
  const y = 0.5;
  m.ring([0, y, 0], 0.42, 0.025, p.glow, "glow");
  m.ring([0, y, 0], 0.26, 0.02, p.glow, "glow", Math.PI * 1.4, 0.4);
  m.ring([0, y, 0], 0.12, 0.03, p.glow, "glow", Math.PI * 2, 0, [0.8, 0, 3]);
  for (const [x, z] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const)
    m.rod([x * 0.44, y, z * 0.44], [x * H, y, z * H], 0.025, p.glow, "glow", 6);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      m.ring([sx * 0.62, y, sz * 0.62], 0.12, 0.02, p.glow, "glow");
      m.cylinder([sx * 0.88, 0.49, sz * 0.88], 0.045, 0.045, 0.03, 0xb8bcc4, "metal", 12);
    }
};

/** A metal frame round a glass floor, 0.5 m thick. */
export const glassPanel: ToyPart = (m) => {
  const p = m.palette;
  for (const s of [-1, 1]) {
    m.box([s * 0.92, 0.25, 0], [0.16, 0.5, CELL], p.metal, "metal", 0.04);
    m.box([0, 0.25, s * 0.92], [CELL, 0.5, 0.16], p.metal, "metal", 0.04);
  }
  m.box([0, 0.42, 0], [CELL - 0.3, 0.06, CELL - 0.3], 0xbfe8ff, "glass", 0.01);
  m.rod([-0.84, 0.47, 0], [0.84, 0.47, 0], 0.012, p.glow, "glow", 4);
};

/** A round launch pad, 2 m across, with a checkered band. */
export const checkerPad: ToyPart = (m) => {
  const p = m.palette;
  m.lathe(
    [
      [0, 0],
      [0.98, 0],
      [1, 0.04],
      [1, 0.38],
      [0.96, 0.44],
      [0, 0.44],
    ],
    [0, 0, 0],
    p.plastic,
  );
  const tiles = 28;
  for (let i = 0; i < tiles; i++) {
    const a = (i / tiles) * Math.PI * 2;
    for (const row of [0, 1]) {
      const color = (i + row) % 2 ? 0x15171c : 0xf6f6f6;
      m.box(
        [Math.cos(a) * 1.005, 0.17 + row * 0.11, Math.sin(a) * 1.005],
        [0.03, 0.1, 0.21],
        color,
        "plastic",
        0.01,
        -a,
      );
    }
  }
  m.cylinder([0, 0.45, 0], 0.72, 0.72, 0.04, p.accent2, "plastic");
  m.ring([0, 0.47, 0], 0.72, 0.03, p.glow, "glow");
};

/** Four steps up to 1 m, one cell wide, rising toward -Z. */
export const stairs: ToyPart = (m) => {
  const p = m.palette;
  for (let i = 0; i < 4; i++) {
    const depth = CELL - i * 0.5;
    m.box([0, (i + 1) * 0.125, -H + depth / 2], [CELL, 0.25, depth], p.plastic, "plastic", 0.05);
    m.box(
      [0, (i + 1) * 0.25 - 0.02, H - i * 0.5 - 0.03],
      [CELL - 0.06, 0.04, 0.08],
      p.accent,
      "plastic",
      0.015,
    );
  }
};

/** A bridge spanning two cells (4 m) at deck height 1 m, so it joins two 1 m blocks a cell apart. */
export const bridge: ToyPart = (m) => {
  const p = m.palette;
  const half = CELL;
  for (let i = 0; i < 13; i++) {
    const x = -half + 0.15 + i * ((half * 2 - 0.3) / 12);
    m.box(
      [x, 0.94 + Math.sin((i / 12) * Math.PI) * -0.06, 0],
      [0.26, 0.08, 1.3],
      p.trunk,
      "wood",
      0.02,
      m.rng.range(-0.03, 0.03),
    );
  }
  for (const z of [-0.62, 0.62]) {
    for (const x of [-half + 0.15, 0, half - 0.15]) {
      m.cylinder([x, 1.32, z], 0.06, 0.07, 0.8, p.plastic, "plastic", 16);
      m.sphere([x, 1.74, z], [0.09, 0.09, 0.09], p.accent);
    }
    m.rod([-half + 0.15, 1.6, z], [half - 0.15, 1.6, z], 0.03, p.metal, "metal");
  }
  m.rod([-half, 0.88, -0.5], [half, 0.88, -0.5], 0.04, p.metal, "metal");
  m.rod([-half, 0.88, 0.5], [half, 0.88, 0.5], 0.04, p.metal, "metal");
};

/** A 2 m guard rail for a block or platform edge, along X. */
export const rail: ToyPart = (m) => {
  const p = m.palette;
  for (const x of [-0.9, 0, 0.9]) {
    m.cylinder([x, 0.4, 0], 0.05, 0.06, 0.8, p.plastic, "plastic", 16);
    m.cylinder([x, 0.03, 0], 0.11, 0.12, 0.06, p.metal, "metal", 16);
  }
  m.rod([-1, 0.8, 0], [1, 0.8, 0], 0.045, p.accent, "plastic");
  m.rod([-1, 0.45, 0], [1, 0.45, 0], 0.025, p.metal, "metal");
};

function pipeBands(m: ToyMesh, at: (t: number) => XYZ, axis: "x" | "z", count: number) {
  for (let i = 0; i <= count; i++) {
    const c = at(i / count);
    const ring = new TorusGeometry(0.42, 0.04, 8, 32);
    if (axis === "x") ring.rotateY(Math.PI / 2);
    m.add(ring.translate(...c), m.palette.metal, "metal");
  }
}

/** A 2 m pipe along X, 0.8 m across, lying on the ground. */
export const pipe: ToyPart = (m) => {
  m.rod([-H, 0.42, 0], [H, 0.42, 0], 0.4, m.palette.plastic, "plastic", 40);
  pipeBands(m, (t) => [-H + 0.08 + t * (CELL - 0.16), 0.42, 0], "x", 1);
};

/** A pipe turning 90 degrees inside one cell, from the -X edge to the -Z edge. */
export const pipeElbow: ToyPart = (m) => {
  const p = m.palette;
  const bend = new TorusGeometry(H, 0.4, 24, 32, Math.PI / 2)
    .rotateX(Math.PI / 2)
    .translate(-H, 0.42, -H);
  m.add(bend, p.plastic, "plastic");
  m.add(
    new TorusGeometry(0.42, 0.04, 8, 32).rotateY(Math.PI / 2).translate(-H + 0.08, 0.42, 0),
    p.metal,
    "metal",
  );
  m.add(new TorusGeometry(0.42, 0.04, 8, 32).translate(0, 0.42, -H + 0.08), p.metal, "metal");
};

/** Jump cycle: squash, launch past full height, then a damped spring back; 1 is at rest. */
export function springStretch(seconds: number, period = 2.6): number {
  const u = (((seconds % period) + period) % period) / period;
  if (u < 0.18) return 1 - 0.55 * Math.sin(((u / 0.18) * Math.PI) / 2);
  if (u < 0.26) return 0.45 + 0.95 * ((u - 0.18) / 0.08);
  const k = (u - 0.26) * period;
  return 1 + 0.4 * Math.exp(-k * 4) * Math.cos(k * 18);
}

/** A spring pad: metal base, a coiled spring and a soft accent cap that squash and launch. */
export const bouncePad: ToyPart = (m) => {
  const p = m.palette;
  const phase = m.rng.range(0, 2.6);
  const base = 0.16;
  const rest = 0.52;
  m.cylinder([0, 0.08, 0], 0.62, 0.7, 0.16, p.metal, "metal");
  m.ring([0, 0.165, 0], 0.62, 0.02, p.glow, "glow", Math.PI * 2, 0, [0.7, phase, 2.4]);
  m.pivot(
    "spring",
    [0, base, 0],
    () => {
      const coil = new CatmullRomCurve3(
        Array.from(
          { length: 49 },
          (_, i) =>
            new Vector3(
              Math.cos(i * 0.8) * 0.36,
              base + 0.02 + i * 0.0072,
              Math.sin(i * 0.8) * 0.36,
            ),
        ),
      );
      m.add(new TubeGeometry(coil, 160, 0.035, 8), 0xc8ccd4, "metal");
    },
    (node, t) => {
      node.scale.y = springStretch(t + phase);
    },
  );
  m.pivot(
    "cap",
    [0, rest, 0],
    () => {
      m.lathe(
        [
          [0, 0],
          [0.62, 0],
          [0.66, 0.06],
          [0.6, 0.16],
          [0.4, 0.22],
          [0, 0.24],
        ],
        [0, rest, 0],
        p.accent,
      );
      m.ring([0, rest + 0.08, 0], 0.5, 0.025, 0xffffff, "plastic");
    },
    (node, t) => {
      const s = springStretch(t + phase);
      node.position.y = base + (rest - base) * s;
      const squash = 1 + Math.max(0, 1 - s) * 0.3;
      node.scale.set(squash, 1 / squash, squash);
    },
  );
};

/**
 * A medal star for a coin face: five ridges run from a raised centre to the points, so each of
 * its ten facets catches the light on its own. It faces +Z, or -Z for `side` -1.
 */
function starRelief(side: number): BufferGeometry {
  const rim: XYZ[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.085 : 0.2;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    rim.push([Math.cos(a) * r, Math.sin(a) * r, 0]);
  }
  const positions: number[] = [];
  for (let i = 0; i < 10; i++) {
    const from = rim[i] as XYZ;
    const to = rim[(i + 1) % 10] as XYZ;
    // counter-clockwise seen from the side the star faces
    positions.push(0, 0, 0.045 * side, ...(side > 0 ? from : to), ...(side > 0 ? to : from));
  }
  const star = new BufferGeometry();
  star.setAttribute("position", new Float32BufferAttribute(positions, 3));
  star.computeVertexNormals();
  return star;
}

/** A gold coin that spins and bobs, its centre 0.7 m up. */
export const coin: ToyPart = (m) => {
  const p = m.palette;
  const phase = m.rng.range(0, Math.PI * 2);
  const c = 0.7;
  m.pivot(
    "coin",
    [0, c, 0],
    () => {
      m.add(
        new CylinderGeometry(0.3, 0.3, 0.06, 48).rotateX(Math.PI / 2).translate(0, c, 0),
        p.gold,
        "gold",
      );
      m.add(
        new TorusGeometry(0.305, 0.04, 12, 48).translate(0, c, 0),
        new Color(p.gold).multiplyScalar(0.85).getHex(),
        "gold",
      );
      for (const side of [-1, 1])
        m.add(
          starRelief(side).translate(0, c, side * 0.031),
          new Color(p.gold).lerp(new Color(0xffffff), 0.08).getHex(),
          "gold",
        );
    },
    (node, t) => {
      node.rotation.y = t * 2.4 + phase;
      node.position.y = c + Math.sin(t * 2 + phase) * 0.06;
    },
  );
};

/** A 1 m prize box: accent plastic, metal corner caps, glowing seams. */
export const prizeBox: ToyPart = (m) => {
  const p = m.palette;
  m.box([0, 0.5, 0], [1, 1, 1], p.accent2, "plastic", 0.12);
  for (const x of [-1, 1])
    for (const y of [0, 1])
      for (const z of [-1, 1])
        m.box([x * 0.42, 0.08 + y * 0.84, z * 0.42], [0.2, 0.16, 0.2], p.metal, "metal", 0.05);
  for (const [x, z, yaw] of [
    [0, 0.505, 0],
    [0, -0.505, 0],
    [0.505, 0, Math.PI / 2],
    [-0.505, 0, Math.PI / 2],
  ] as const) {
    m.box([x, 0.5, z], [0.5, 0.06, 0.02], p.glow, "glow", 0.01, yaw);
    m.box([x, 0.5, z], [0.06, 0.5, 0.02], p.glow, "glow", 0.01, yaw);
    m.box([x, 0.5, z], [0.14, 0.14, 0.03], 0xffffff, "glow", 0.02, yaw);
  }
  m.box([0, 1.005, 0], [0.5, 0.02, 0.06], p.glow, "glow", 0.01);
  m.box([0, 1.005, 0], [0.06, 0.02, 0.5], p.glow, "glow", 0.01);
};

/** A checkpoint beacon: white base, metal pole, a spinning ring and a glass dome round a pulsing core. */
export const checkpoint: ToyPart = (m) => {
  const p = m.palette;
  m.lathe(
    [
      [0, 0],
      [0.55, 0],
      [0.58, 0.05],
      [0.5, 0.22],
      [0.2, 0.3],
      [0, 0.3],
    ],
    [0, 0, 0],
    p.plastic,
  );
  m.ring([0, 0.12, 0], 0.55, 0.03, p.accent, "plastic");
  m.cylinder([0, 0.95, 0], 0.06, 0.06, 1.3, p.metal, "metal", 16);
  m.cylinder([0, 1.62, 0], 0.3, 0.34, 0.12, p.metal, "metal");
  m.sphere([0, 1.86, 0], [0.18, 0.2, 0.18], p.accent, "glow");
  m.add(new SphereGeometry(0.11, 16, 12).translate(0, 1.86, 0), 0xffffff, "glow", {
    pulse: [0.9, 0, 2.2],
  });
  m.sphere([0, 1.86, 0], [0.3, 0.3, 0.3], 0xffffff, "glass");
  m.pivot(
    "ring",
    [0, 1.86, 0],
    () => {
      m.add(
        new TorusGeometry(0.4, 0.035, 10, 48).rotateX(1.2).translate(0, 1.86, 0),
        p.plastic,
        "plastic",
      );
      m.sphere([0.4, 1.86, 0], [0.06, 0.06, 0.06], p.glow, "glow");
    },
    (node, t) => {
      node.rotation.y = t * 1.6;
    },
  );
};

/** A floor button: metal ring base with a big accent cap. */
export const button: ToyPart = (m) => {
  const p = m.palette;
  m.lathe(
    [
      [0, 0],
      [0.62, 0],
      [0.62, 0.1],
      [0.5, 0.16],
      [0, 0.16],
    ],
    [0, 0, 0],
    p.metal,
    "metal",
  );
  m.lathe(
    [
      [0, 0],
      [0.42, 0],
      [0.44, 0.08],
      [0.36, 0.2],
      [0, 0.23],
    ],
    [0, 0.14, 0],
    p.accent,
  );
  m.ring([0, 0.13, 0], 0.5, 0.02, p.glow, "glow", Math.PI * 2, 0, [0.8, 0, 3]);
};

/** A flat 2 m boost pad with three glowing chevrons pointing to -Z. */
export const boostPad: ToyPart = (m) => {
  const p = m.palette;
  m.box([0, 0.05, 0], [CELL - 0.1, 0.1, CELL - 0.1], p.metal, "metal", 0.04);
  for (let i = 0; i < 3; i++) {
    const z = 0.5 - i * 0.5;
    for (const s of [-1, 1]) {
      const chevron = new RoundedBoxGeometry(0.62, 0.03, 0.12, 1, 0.01)
        .rotateY(s * 0.7)
        .translate(s * 0.25, 0.11, z);
      m.add(chevron, p.glow, "glow", { pulse: [0.85, -i * 1.4, 6] });
    }
  }
};

/** A cannon on a swivel mount, barrel pointing to +Z and up; it recoils every few seconds. */
export const cannon: ToyPart = (m) => {
  const p = m.palette;
  const tilt = 0.5;
  const axis = new Vector3(0, Math.sin(tilt), Math.cos(tilt));
  const period = m.rng.range(2.8, 3.6);
  m.cylinder([0, 0.15, 0], 0.62, 0.7, 0.3, p.metal, "metal");
  for (const s of [-1, 1]) m.box([s * 0.42, 0.6, 0], [0.12, 0.7, 0.5], p.plastic, "plastic", 0.05);
  const pivot: XYZ = [0, 0.9, 0.2];
  m.pivot(
    "barrel",
    pivot,
    () => {
      m.add(
        new CylinderGeometry(0.3, 0.36, 1.5, 40).rotateX(Math.PI / 2 - tilt).translate(...pivot),
        p.plastic,
        "plastic",
      );
      const at = (d: number): XYZ => [0, pivot[1] + axis.y * d, pivot[2] + axis.z * d];
      m.add(
        new TorusGeometry(0.31, 0.06, 10, 40).rotateX(-tilt).translate(...at(0.75)),
        p.accent,
        "plastic",
      );
      m.add(
        new TorusGeometry(0.36, 0.05, 10, 40).rotateX(-tilt).translate(...at(-0.4)),
        p.metal,
        "metal",
      );
      m.add(
        new CylinderGeometry(0.22, 0.22, 0.02, 32)
          .rotateX(Math.PI / 2 - tilt)
          .translate(...at(0.74)),
        0x101114,
        "plastic",
      );
    },
    (node, t) => {
      const u = ((t % period) + period) % period;
      const kick = u < 0.06 ? (u / 0.06) * 0.22 : 0.22 * Math.exp(-(u - 0.06) * 6);
      node.position.set(pivot[0], pivot[1] - axis.y * kick, pivot[2] - axis.z * kick);
    },
  );
};

/** A hovering tech platform: a 2 m deck that bobs on two thruster glows, 1 m clear of the ground. */
export const hoverPlatform: ToyPart = (m) => {
  const p = m.palette;
  const phase = m.rng.range(0, Math.PI * 2);
  const rest = 1.24;
  m.pivot(
    "deck",
    [0, rest, 0],
    () => {
      m.box([0, 1.24, 0], [CELL, 0.48, CELL], p.metal, "metal", 0.1);
      m.box([0, 1.5, 0], [CELL - 0.2, 0.05, CELL - 0.2], p.plastic, "plastic", 0.02);
      m.ring([0, 1.53, 0], 0.5, 0.025, p.glow, "glow", Math.PI * 2, 0, [0.6, phase, 2]);
      for (const x of [-0.55, 0.55]) {
        m.cylinder([x, 0.92, 0], 0.26, 0.2, 0.2, p.plastic, "plastic");
        m.add(
          new CylinderGeometry(0.17, 0.02, 0.84, 20, 1, true).translate(x, 0.4, 0),
          p.glow,
          "glow",
          { pulse: [0.5, phase + x, 9] },
        );
      }
    },
    (node, t) => {
      node.position.y = rest + Math.sin(t * 1.3 + phase) * 0.14;
      node.rotation.z = Math.sin(t * 0.9 + phase) * 0.03;
      node.rotation.x = Math.cos(t * 0.7 + phase) * 0.02;
    },
  );
};

/** A limb along `points` that tapers from radius `thick` to `thin`; it sways with the canopy. */
function limb(m: ToyMesh, points: Vector3[], thick: number, thin: number, sway: [number, number]) {
  const curve = new CatmullRomCurve3(points);
  const rings = 14;
  const sides = 10;
  const tube = new TubeGeometry(curve, rings, 1, sides);
  const at = tube.getAttribute("position");
  for (let i = 0; i <= rings; i++) {
    const centre = curve.getPointAt(i / rings);
    const r = thick + (thin - thick) * (i / rings);
    for (let j = 0; j <= sides; j++) {
      const k = i * (sides + 1) + j;
      at.setXYZ(
        k,
        centre.x + (at.getX(k) - centre.x) * r,
        centre.y + (at.getY(k) - centre.y) * r,
        centre.z + (at.getZ(k) - centre.z) * r,
      );
    }
  }
  tube.computeVertexNormals();
  m.add(tube, m.palette.trunk, "leaf", {
    sway,
    paint: (_x, y, _z, out) => out.multiplyScalar(0.8 + Math.min(0.3, y * 0.12)),
  });
}

/**
 * A leafy crown: a dark core covered in small rounded leaves that overlap like scales and lift at
 * the tip. The leaves share the crown's normal, so it shades as one dome with a leaf texture,
 * darker underneath and lighter on top.
 */
function crown(
  m: ToyMesh,
  [cx, cy, cz]: XYZ,
  radius: number,
  count: number,
  squash = 0.84,
  leaf = m.palette.leaf,
  cube = false,
) {
  const grit = m.rng.seed();
  const swell = (v: Vector3) =>
    radius *
    (1 +
      noise3(v.x * 1.9, v.y * 1.9, v.z * 1.9, grit) * 0.16 +
      noise3(v.x * 4.3, v.y * 4.3, v.z * 4.3, grit + 3) * 0.06);
  // a cube crown pushes the sphere out to a rounded box: flat top, square sides
  const boxy = (v: Vector3) =>
    cube ? v.clone().divideScalar((v.x ** 4 + v.y ** 4 + v.z ** 4) ** 0.25) : v;
  const surface = (d: Vector3, lift = 1, v = boxy(d)) =>
    new Vector3(
      cx + v.x * swell(v) * lift,
      cy + v.y * swell(v) * squash * lift,
      cz + v.z * swell(v) * lift,
    );
  const sway: [number, number] = [cy - radius * 2.2, radius * 3];
  const top = new Color(leaf).lerp(new Color(0xffffff), 0.3);
  const under = new Color(leaf).multiplyScalar(0.5);
  const paint = (_x: number, y: number, _z: number, out: Color) => {
    const t = Math.max(-1, Math.min(1, (y - cy) / (radius * squash)));
    out.lerp(t > 0 ? top : under, Math.abs(t) * 0.65);
  };

  const core = new SphereGeometry(1, 24, 16);
  const at = core.getAttribute("position");
  for (let i = 0; i < at.count; i++) {
    const v = new Vector3(at.getX(i), at.getY(i), at.getZ(i)).normalize();
    at.setXYZ(i, ...surface(v, 0.9).toArray());
  }
  core.computeVertexNormals();
  m.add(core, new Color(leaf).multiplyScalar(0.55).getHex(), "leaf", { sway, paint });

  const positions: number[] = [];
  const normals: number[] = [];
  const shade: number[] = [];
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    // an even spread of directions (a Fibonacci sphere), jittered
    const y = 1 - ((i + 0.5) / count) * 2;
    const ring = Math.sqrt(1 - y * y);
    const turn = i * 2.399963 + m.rng.range(-0.3, 0.3);
    const out = new Vector3(Math.cos(turn) * ring, y, Math.sin(turn) * ring).normalize();
    // the leaf points down the dome, turned a little to either side
    const down = up.clone().multiplyScalar(-1).addScaledVector(out, out.y);
    if (down.lengthSq() < 1e-4) down.set(1, 0, 0);
    down.normalize().applyAxisAngle(out, m.rng.range(-0.9, 0.9));
    const across = out.clone().cross(down);
    const length = Math.min(0.26, radius * 0.3) * m.rng.range(0.8, 1.2);
    const width = length * 0.95;
    const root = surface(out);
    const point = (along: number, side: number, lift: number) =>
      root
        .clone()
        .addScaledVector(down, along * length)
        .addScaledVector(across, side * width)
        .addScaledVector(out, lift * length);
    // a rounded leaf: stalk, two shoulders, two cheeks and a blunt tip that lifts off the dome
    const outline = [
      point(-0.35, 0, -0.14),
      point(0.05, -0.42, 0.1),
      point(0.6, -0.36, 0.26),
      point(1, 0, 0.3),
      point(0.6, 0.36, 0.26),
      point(0.05, 0.42, 0.1),
    ];
    const light = [0.66, 0.9, 1.08, 1.18, 1.08, 0.9];
    const tone = m.rng.range(0.76, 1.12);
    const normal = out.clone().addScaledVector(down, 0.2).normalize();
    for (const k of [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]) {
      const v = outline[k] as Vector3;
      positions.push(v.x, v.y, v.z);
      normals.push(normal.x, normal.y, normal.z);
      shade.push(tone * (light[k] as number));
    }
  }
  const leaves = new BufferGeometry();
  leaves.setAttribute("position", new Float32BufferAttribute(positions, 3));
  leaves.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  leaves.setAttribute("shade", new Float32BufferAttribute(shade, 1));
  m.add(leaves, leaf, "leaf", { sway, paint });
}

/**
 * A blossom tree: a slim tapering trunk that leans, forks into three short boughs, and carries
 * one dense leafy crown, 3.6 m tall.
 */
export const puffTree: ToyPart = (m) => {
  const lean = m.rng.range(-0.3, 0.3);
  const fork = new Vector3(lean, 1.95, -0.04);
  const sway: [number, number] = [0.4, 6];
  limb(m, [new Vector3(0, 0, 0), new Vector3(lean * 0.35, 0.95, 0.06), fork], 0.15, 0.085, sway);
  m.add(
    new CylinderGeometry(0.17, 0.26, 0.14, 12).translate(0, 0.07, 0),
    new Color(m.palette.trunk).multiplyScalar(0.8).getHex(),
    "leaf",
  );
  const heart: XYZ = [lean * 1.15, 2.75, 0];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + m.rng.range(0, 1);
    const reach = new Vector3(heart[0] + Math.cos(a) * 0.5, 2.45, heart[2] + Math.sin(a) * 0.5);
    limb(
      m,
      [fork.clone().setY(1.85), fork.clone().lerp(reach, 0.5).setY(2.2), reach],
      0.075,
      0.04,
      sway,
    );
  }
  crown(m, heart, 1, 1100, 0.8);
};

/** A round bush, 1.1 m across: one leafy crown sitting on the ground. */
export const puffBush: ToyPart = (m) => crown(m, [0, 0.4, 0], 0.55, 420, 0.8);

/** A cloud puff, 3 m long, centred 1 m up, drifting slowly. */
export const cloud: ToyPart = (m) => {
  const phase = m.rng.range(0, Math.PI * 2);
  m.pivot(
    "puffs",
    [0, 1, 0],
    () => {
      for (let i = 0; i < 6; i++) {
        const s = m.rng.range(0.45, 0.75);
        m.sphere(
          [-1.2 + i * 0.48, 1 + m.rng.range(-0.1, 0.2), m.rng.range(-0.3, 0.3)],
          [s, s * 0.8, s],
          0xffffff,
          "leaf",
          (_x, y, _z, out) => out.multiplyScalar(0.82 + Math.min(0.18, (y - 0.6) * 0.3)),
        );
      }
    },
    (node, t) => {
      node.position.x = Math.sin(t * 0.12 + phase) * 0.8;
      node.position.y = 1 + Math.sin(t * 0.3 + phase) * 0.1;
    },
  );
};

export const boulder: ToyPart = (m) => m.rock([0, 0.45, 0], [0.75, 0.55, 0.65]);

export const rockPile: ToyPart = (m) => {
  for (let i = 0; i < 5; i++) {
    const s = m.rng.range(0.2, 0.42);
    m.rock([m.rng.range(-0.6, 0.6), s * 0.6, m.rng.range(-0.6, 0.6)], [s, s * 0.75, s]);
  }
};

/** A crystal cluster: glass prisms round glowing cores on a rock base. */
export const crystal: ToyPart = (m) => {
  const p = m.palette;
  m.rock([0, 0.15, 0], [0.55, 0.25, 0.5]);
  for (let i = 0; i < 5; i++) {
    const h = i === 0 ? 1.3 : m.rng.range(0.5, 0.9);
    const tilt = i === 0 ? 0 : 0.45;
    const a = (i / 5) * Math.PI * 2;
    const g = new CylinderGeometry(0, 0.14, 0.3, 6).translate(0, h / 2 + 0.15, 0);
    const shaft = new CylinderGeometry(0.14, 0.14, h, 6).translate(0, 0, 0);
    for (const piece of [g, shaft]) {
      piece
        .rotateZ(tilt)
        .rotateY(a)
        .translate(Math.cos(a) * 0.15 * (i ? 1 : 0), 0.2 + h / 2, Math.sin(a) * 0.15 * (i ? 1 : 0));
      const core = piece.clone().scale(0.55, 0.9, 0.55);
      m.add(core, p.glow, "glow", { pulse: [0.6, i, 1.8] });
      m.add(piece, 0xffffff, "glass");
    }
  }
};

/** A 2 m waterfall sheet falling from 2 m to a foam pool; put it against a block face (+Z side). */
export const waterfall: ToyPart = (m) => {
  const p = m.palette;
  const sheet = new CylinderGeometry(1.2, 1.2, 2, 24, 12, true, -0.45, 0.9).translate(0, 1, -1.05);
  const light = new Color(p.water).lerp(new Color(0xffffff), 0.6);
  const grit = m.rng.seed();
  m.add(sheet, p.water, "water", {
    flow: 1.4,
    paint: (x, y, _z, out) => out.lerp(light, Math.max(0, noise3(x * 6, y * 1.2, 0, grit)) * 0.6),
  });
  for (let i = 0; i < 9; i++) {
    const s = m.rng.range(0.16, 0.3);
    m.sphere(
      [m.rng.range(-0.45, 0.45), s * 0.4, 0.22 + m.rng.range(-0.1, 0.15)],
      [s, s * 0.6, s],
      0xf2f8ff,
      "leaf",
    );
  }
  m.cylinder([0, 0.02, 0.25], 0.7, 0.7, 0.04, p.water, "water");
};

/** Flowers for a grass top: a patch of stems and round heads on y = 0. */
export const flowers: ToyPart = (m) => {
  const p = m.palette;
  for (let i = 0; i < 14; i++) {
    const x = m.rng.range(-0.8, 0.8);
    const z = m.rng.range(-0.8, 0.8);
    const h = m.rng.range(0.25, 0.45);
    const c = i % 3 === 0 ? 0xffffff : i % 3 === 1 ? p.accent : p.gold;
    const stem = new CylinderGeometry(0.012, 0.012, h, 5).translate(x, h / 2, z);
    m.add(stem, p.grass, "leaf", { sway: [0, h * 1.6] });
    m.add(new SphereGeometry(1, 12, 8).scale(0.06, 0.04, 0.06).translate(x, h, z), c, "leaf", {
      sway: [0, h * 1.6],
    });
    m.add(
      new SphereGeometry(1, 8, 6).scale(0.025, 0.02, 0.025).translate(x, h + 0.025, z),
      p.gold,
      "leaf",
      { sway: [0, h * 1.6] },
    );
  }
};

/**
 * A floating island 8 m across: a grass top ringed by the planter collar over a tapering rock
 * root. The root's tip stands on y = 0 and the lawn is at 3.2 m.
 */
export const floatingIsland: ToyPart = (m) => {
  const p = m.palette;
  const top = 3.2;
  const g = new CylinderGeometry(4, 0.05, 3.05, 72, 30).translate(0, 1.525, 0);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = y / 3.05;
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    if (r < 1e-4) continue;
    const want = 4 * Math.sqrt(Math.max(0, t)) * (0.98 + 0.02 * t);
    pos.setX(i, (pos.getX(i) / r) * want);
    pos.setZ(i, (pos.getZ(i) / r) * want);
  }
  g.computeVertexNormals();
  strata(m, g, 3.05, { seam: () => 1 });
  collarArc(m, top, 4.06, Math.PI * 2);
  m.cylinder([0, 3.12, 0], 3.75, 3.75, 0.16, p.soil, "soil", 48);
  m.grass(3.8, top, (x, z) => Math.hypot(x, z) < 4.06 + COLLAR.inner + 0.02);
  for (let i = 0; i < 6; i++) {
    const a = m.rng.range(0, Math.PI * 2);
    m.rock([Math.cos(a) * 2.6, 1.6 + m.rng.range(-0.5, 0.5), Math.sin(a) * 2.6], [0.6, 0.4, 0.6]);
  }
};

/** Plank wood for decks, crates and barrels: the theme's trunk colour, sun-warmed. */
const plank = (m: ToyMesh) => new Color(m.palette.trunk).lerp(new Color(0xc8945a), 0.55);

/**
 * A pier tile, 2 m square with its deck at 1 m (level with a grass block): nine planks across,
 * each a little warped and toned, on two cross beams and four chunky posts that stand in the sea.
 */
export const woodDeck: ToyPart = (m) => {
  const wood = plank(m);
  for (let i = 0; i < 9; i++) {
    const tone = wood.clone().multiplyScalar(m.rng.range(0.78, 1.1));
    m.box(
      [-H + 0.111 + i * 0.222, 0.965 + m.rng.range(-0.008, 0.008), m.rng.range(-0.02, 0.02)],
      [0.214, 0.07, CELL - 0.02],
      tone.getHex(),
      "wood",
      0.025,
      m.rng.range(-0.012, 0.012),
    );
  }
  const dark = new Color(m.palette.trunk).multiplyScalar(0.62).getHex();
  for (const z of [-0.72, 0.72]) m.box([0, 0.87, z], [CELL - 0.06, 0.12, 0.18], dark, "wood", 0.03);
  for (const x of [-0.8, 0.8])
    for (const z of [-0.72, 0.72]) {
      m.cylinder([x, 0.46, z], 0.1, 0.12, 0.92, dark, "wood", 14);
      m.cylinder([x, 1.005, z], 0.035, 0.035, 0.012, 0x9aa0a8, "metal", 10);
    }
};

/** A 1 m wooden crate: plank sides in a dark frame, capped with metal corners. */
export const crate: ToyPart = (m) => {
  const wood = plank(m);
  const s = 0.9;
  m.box([0, 0.5, 0], [s, s, s], wood.getHex(), "wood", 0.02, m.rng.range(-0.05, 0.05));
  const frame = wood.clone().multiplyScalar(0.62).getHex();
  const e = 0.47;
  for (const a of [-1, 1])
    for (const b of [-1, 1]) {
      m.box([a * e, 0.5, b * e], [0.13, 1, 0.13], frame, "wood", 0.03);
      m.box([0, 0.5 + a * e, b * e], [1, 0.13, 0.13], frame, "wood", 0.03);
      m.box([a * e, 0.5 + b * e, 0], [0.13, 0.13, 1], frame, "wood", 0.03);
    }
  // a diagonal brace on each side
  for (let k = 0; k < 4; k++) {
    const yaw = (k * Math.PI) / 2;
    const brace = new RoundedBoxGeometry(1.1, 0.11, 0.05, 2, 0.02)
      .rotateZ(Math.PI / 4)
      .translate(0, 0.5, 0.46)
      .rotateY(yaw);
    m.add(brace, frame, "wood");
  }
  for (const a of [-1, 1])
    for (const b of [-1, 1])
      for (const c of [-1, 1])
        m.box([a * 0.47, 0.5 + b * 0.47, c * 0.47], [0.17, 0.17, 0.17], 0x8c939c, "metal", 0.04);
};

/** A bellied barrel, 0.9 m tall: bent staves, two iron hoops and a dark lid. */
export const barrel: ToyPart = (m) => {
  const wood = plank(m);
  const radius = (y: number) => 0.3 + 0.06 * Math.sin((Math.PI * y) / 0.9);
  const profile: [number, number][] = [[0, 0]];
  for (let i = 0; i <= 12; i++) profile.push([radius((i / 12) * 0.9), (i / 12) * 0.9]);
  profile.push([0, 0.9]);
  const staves = new LatheGeometry(
    profile.map(([x, y]) => new Vector2(x, y)),
    48,
  );
  // stave joints: 14 dark seams round the belly
  m.add(staves, wood.getHex(), "wood", (x, _y, z, out) => {
    const a = (Math.atan2(z, x) / (Math.PI * 2)) * 14;
    const seam = Math.min(a - Math.floor(a), Math.ceil(a) - a);
    if (seam < 0.06) out.multiplyScalar(0.55);
  });
  for (const y of [0.17, 0.73]) m.ring([0, y, 0], radius(y) + 0.008, 0.022, 0x4a4f58, "metal");
  m.cylinder([0, 0.905, 0], 0.27, 0.27, 0.02, wood.multiplyScalar(0.6).getHex(), "wood", 32);
};

/**
 * A leaf blade from `root`, heading out along `yaw`, rising at `rise` radians and bending down
 * by `droop` toward the tip; `width(t)` is the half width over its length, as a fraction of it.
 * The blade folds a little along its midrib, which catches the light.
 */
function blade(
  m: ToyMesh,
  root: Vector3,
  yaw: number,
  rise: number,
  droop: number,
  length: number,
  width: (t: number) => number,
  color: Color,
  sway: [number, number],
  paint?: (x: number, y: number, z: number, out: Color) => void,
) {
  const rows = 9;
  const ahead = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const side = new Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
  const spine = root.clone();
  const positions: number[] = [];
  const shade: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    if (i) {
      const a = rise - droop * t;
      spine.addScaledVector(ahead, (Math.cos(a) * length) / rows).y +=
        (Math.sin(a) * length) / rows;
    }
    const w = width(t) * length;
    for (const s of [-1, 0, 1]) {
      const v = spine.clone().addScaledVector(side, s * w);
      v.y -= Math.abs(s) * w * 0.3;
      positions.push(v.x, v.y, v.z);
      shade.push((0.62 + 0.45 * t) * (s ? 0.9 : 1.12));
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rows; i++)
    for (let s = 0; s < 2; s++) {
      const a = i * 3 + s;
      index.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
    }
  const leaf = new BufferGeometry();
  leaf.setAttribute("position", new Float32BufferAttribute(positions, 3));
  leaf.setAttribute("shade", new Float32BufferAttribute(shade, 1));
  leaf.setIndex(index);
  leaf.computeVertexNormals();
  m.add(leaf, color.getHex(), "leaf", { sway, paint });
}

/** The jungle green of a theme's big-leaf plants (icy in Frost Peak, sun-dried in Sand Ruins). */
const jungle = (m: ToyMesh) => new Color(m.palette.grass).lerp(new Color(m.palette.tip), 0.15);

/**
 * A spiky rosette, 1.2 m across: long pointed blades, the inner ones in the theme accent and
 * the outer ones green, arching out from one heart.
 */
export const spikyPlant: ToyPart = (m) => {
  const heart = new Vector3(0, 0.05, 0);
  const sway: [number, number] = [0, 0.9];
  const count = 20;
  for (let i = 0; i < count; i++) {
    const inner = i < 8;
    const color = inner
      ? new Color(m.palette.accent).lerp(new Color(0xffffff), 0.08)
      : jungle(m).lerp(new Color(m.palette.accent), m.rng.range(0, 0.25));
    blade(
      m,
      heart,
      i * 2.399963 + m.rng.range(-0.2, 0.2),
      inner ? m.rng.range(1.1, 1.35) : m.rng.range(0.6, 0.95),
      inner ? 1.1 : 1.5,
      inner ? m.rng.range(0.42, 0.55) : m.rng.range(0.55, 0.72),
      (t) => 0.085 * (1 - t) ** 0.8,
      color.multiplyScalar(m.rng.range(0.88, 1.08)),
      sway,
    );
  }
};

/** A broadleaf plant, 1 m tall: big oval leaves on arching stalks, each folded along its rib. */
export const leafyPlant: ToyPart = (m) => {
  const sway: [number, number] = [0, 1.2];
  const stalk = jungle(m).multiplyScalar(0.75);
  for (let i = 0; i < 8; i++) {
    const yaw = i * 2.399963 + m.rng.range(-0.25, 0.25);
    const reach = m.rng.range(0.25, 0.45);
    const tall = m.rng.range(0.45, 0.85);
    const tip = new Vector3(Math.cos(yaw) * reach, tall, Math.sin(yaw) * reach);
    const stem = new TubeGeometry(
      new CatmullRomCurve3([
        new Vector3(0, 0, 0),
        new Vector3(tip.x * 0.3, tall * 0.7, tip.z * 0.3),
        tip,
      ]),
      8,
      0.018,
      6,
    );
    m.add(stem, stalk.getHex(), "leaf", { sway });
    blade(
      m,
      tip,
      yaw,
      m.rng.range(0.2, 0.55),
      1.5,
      m.rng.range(0.55, 0.8),
      (t) => 0.3 * Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.08)) ** 0.7,
      jungle(m).multiplyScalar(m.rng.range(0.8, 1.1)),
      sway,
    );
  }
};

/**
 * Vines spilling over the +Z edge of a 1 m block: a leafy lip along the top and strands of small
 * leaves hanging down the face. Place it on the same cell and level as the block.
 */
export const hangingVines: ToyPart = (m) => {
  const green = jungle(m).multiplyScalar(0.85);
  const z = H + COLLAR.outer + 0.03;
  const positions: number[] = [];
  const shade: number[] = [];
  // one rounded leaf from `at`: its tip runs along `along`, it faces `face` and cups toward it
  const leaf = (at: Vector3, along: Vector3, face: Vector3, tone: number) => {
    const l = 0.1 * m.rng.range(0.8, 1.25);
    const across = along.clone().cross(face).normalize();
    const point = (a: number, b: number) =>
      at
        .clone()
        .addScaledVector(along, a * l)
        .addScaledVector(across, b * l)
        .addScaledVector(face, Math.abs(b) * l * 0.2 + a * l * 0.15);
    const outline = [
      point(0, 0),
      point(0.3, -0.42),
      point(0.75, -0.32),
      point(1, 0),
      point(0.75, 0.32),
      point(0.3, 0.42),
    ];
    for (const k of [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]) {
      const v = outline[k] as Vector3;
      positions.push(v.x, v.y, v.z);
      shade.push(m.rng.range(0.85, 1.15) * tone);
    }
  };
  const up = new Vector3(0, 1, 0);
  const out = new Vector3(0, 0, 1);
  const stem = green.clone().multiplyScalar(0.55).getHex();
  for (let s = 0; s < 22; s++) {
    const x0 = m.rng.range(-0.9, 0.9);
    const drop = m.rng.range(0.3, 0.85);
    // a few leaves creep back over the collar top, then the strand drops down the face
    for (let back = 0.3; back > 0; back -= 0.08)
      leaf(
        new Vector3(x0, 1.11, z - back),
        new Vector3(m.rng.range(-1, 1), 0, 1).normalize(),
        up,
        1,
      );
    const strand = [new Vector3(x0, 1.11, z - 0.05)];
    for (let y = 1.08; y > 1.08 - drop; y -= 0.05) {
      const at = new Vector3(x0 + Math.sin(y * 9 + s) * 0.03, y, z);
      strand.push(at);
      const side = strand.length % 2 ? 1 : -1;
      leaf(at, new Vector3(side, -0.7, 0).normalize(), out, 0.75 + 0.2 * y);
    }
    if (strand.length > 2)
      m.add(
        new TubeGeometry(new CatmullRomCurve3(strand), strand.length * 2, 0.007, 4),
        stem,
        "leaf",
        {
          sway: [1.12, -0.9],
        },
      );
  }
  const leaves = new BufferGeometry();
  leaves.setAttribute("position", new Float32BufferAttribute(positions, 3));
  leaves.setAttribute("shade", new Float32BufferAttribute(shade, 1));
  const normal = new Float32Array(positions.length);
  for (let i = 0; i < normal.length; i += 3) normal.set([0, 0.35, 1], i);
  leaves.setAttribute("normal", new Float32BufferAttribute(normal, 3));
  // a negative span: the strands swing more toward their free ends
  m.add(leaves, green.getHex(), "leaf", { sway: [1.12, -0.9] });
};

/**
 * A carved stone gateway, 2 m wide and 2.3 m tall: two pillars and a lintel with a zigzag band,
 * mossy on top. The opening is 1 m wide.
 */
export const stoneArch: ToyPart = (m) => {
  const p = m.palette;
  const stone = new Color(p.rim).lerp(new Color(p.rock), 0.45);
  for (const x of [-0.72, 0.72]) {
    m.box([x, 0.85, 0], [0.5, 1.7, 0.62], stone.getHex(), "stone", 0.06);
    m.box(
      [x, 0.08, 0],
      [0.62, 0.16, 0.74],
      stone.clone().multiplyScalar(0.85).getHex(),
      "stone",
      0.04,
    );
  }
  m.box([0, 1.95, 0], [CELL, 0.5, 0.72], stone.getHex(), "stone", 0.07);
  // the carved band: a row of diamonds set into both faces
  const carved = stone.clone().multiplyScalar(0.62).getHex();
  for (const side of [-1, 1])
    for (let i = 0; i < 8; i++) {
      const g = new RoundedBoxGeometry(0.16, 0.16, 0.04, 2, 0.015)
        .rotateZ(Math.PI / 4)
        .translate(-0.84 + i * 0.24, 1.95, side * 0.355);
      m.add(g, carved, "stone");
    }
  for (const side of [-1, 1])
    m.box([0, 1.73, side * 0.36], [1.9, 0.05, 0.03], carved, "stone", 0.01);
  m.box([0, 2.21, 0], [CELL - 0.04, 0.04, 0.68], p.soil, "soil", 0.02);
  m.grass(1, 2.23, (x, z) => Math.abs(x) < 0.96 && Math.abs(z) < 0.32, 380, 0.14);
};

/** The sea's colour: the theme water pushed toward turquoise. */
const seaColor = (m: ToyMesh) => new Color(m.palette.water).lerp(new Color(0x10907a), 0.6);

/**
 * Open sea to the horizon: a 320 m disc of rocking water at y 0 over a dark bed, which fades into
 * the fog. Islands stand in it; ring them with shore foam.
 */
export const openSea: ToyPart = (m) => {
  const sea = seaColor(m);
  const disc = (y: number) => new CircleGeometry(160, 96).rotateX(-Math.PI / 2).translate(0, y, 0);
  m.add(disc(-0.24), sea.clone().multiplyScalar(0.4).getHex(), "water");
  m.add(disc(0.02), sea.getHex(), "water");
};

const SHORE = { from: H - 0.03, width: 0.8 };

/** Shore foam along the +Z side of a cell whose block stands in the sea: it laps and rolls in. */
export const shoreEdge: ToyPart = (m) => {
  const strip = new PlaneGeometry(CELL, SHORE.width, 16, 6)
    .rotateX(-Math.PI / 2)
    .translate(0, 0.05, SHORE.from + SHORE.width / 2);
  m.add(strip, seaColor(m).getHex(), "water", {
    flow: (_x, _y, z) => -0.001 - (z - SHORE.from) / SHORE.width,
  });
};

/** Shore foam round a rounded +X +Z corner (the grass corner's outline). */
export const shoreCorner: ToyPart = (m) => {
  const r = CELL - 0.03;
  const ring = new RingGeometry(r, r + SHORE.width, 32, 6, -Math.PI / 2, Math.PI / 2)
    .rotateX(-Math.PI / 2)
    .translate(-H, 0.05, -H);
  m.add(ring, seaColor(m).getHex(), "water", {
    flow: (x, _y, z) => -0.001 - (Math.hypot(x + H, z + H) - r) / SHORE.width,
  });
};

/**
 * A palm, 4 m tall: a ringed trunk that bows to one side, a tuft of long arching fronds made of
 * paired leaflets, and three nuts under them.
 */
export const palmTree: ToyPart = (m) => {
  const sway: [number, number] = [0.5, 4];
  const bow = m.rng.range(0.5, 0.9);
  const top = new Vector3(bow, 3.7, 0.1);
  const trunk = [
    new Vector3(0, 0, 0),
    new Vector3(bow * 0.15, 1.3, 0),
    new Vector3(bow * 0.55, 2.6, 0.05),
    top,
  ];
  const curve = new CatmullRomCurve3(trunk);
  const tube = new TubeGeometry(curve, 30, 1, 10);
  const at = tube.getAttribute("position");
  for (let i = 0; i <= 30; i++) {
    const c = curve.getPointAt(i / 30);
    const r = 0.17 - 0.07 * (i / 30) + (i % 2 ? 0.012 : 0);
    for (let j = 0; j <= 10; j++) {
      const k = i * 11 + j;
      at.setXYZ(
        k,
        c.x + (at.getX(k) - c.x) * r,
        c.y + (at.getY(k) - c.y) * r,
        c.z + (at.getZ(k) - c.z) * r,
      );
    }
  }
  tube.computeVertexNormals();
  const bark = new Color(m.palette.trunk).lerp(new Color(0xa88a62), 0.5);
  m.add(tube, bark.getHex(), "leaf", {
    sway,
    paint: (_x, y, _z, out) => out.multiplyScalar(Math.sin(y * 26) > 0.6 ? 0.7 : 1),
  });
  const green = jungle(m);
  for (let f = 0; f < 10; f++) {
    const yaw = f * 2.399963 + m.rng.range(-0.2, 0.2);
    const rise = f < 3 ? m.rng.range(0.7, 1) : m.rng.range(0.15, 0.45);
    const length = m.rng.range(1.5, 1.9);
    const ahead = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const spine = top.clone();
    const tone = green.clone().multiplyScalar(m.rng.range(0.8, 1.08));
    const rachis = [spine.clone()];
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      const a = rise - 2 * t;
      spine.addScaledVector(ahead, (Math.cos(a) * length) / 12).y += (Math.sin(a) * length) / 12;
      rachis.push(spine.clone());
      const reach = 0.5 * Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.08)) + 0.06;
      for (const side of [-1, 1])
        blade(
          m,
          spine,
          yaw + side * 1.15,
          a - 0.5,
          0.7,
          reach,
          (u) => 0.13 * (1 - u) ** 0.6,
          tone,
          sway,
        );
    }
    const stem = new TubeGeometry(new CatmullRomCurve3(rachis), 12, 0.022, 5);
    m.add(stem, tone.clone().multiplyScalar(0.7).getHex(), "leaf", { sway });
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    m.sphere(
      [top.x + Math.cos(a) * 0.14, top.y - 0.12, top.z + Math.sin(a) * 0.14],
      [0.11, 0.12, 0.11],
      0x6a4a2a,
      "wood",
    );
  }
};

/** Temple sandstone: the theme's rock warmed toward sand, so the blocks read as cut stone. */
const sandstone = (m: ToyMesh) =>
  new Color(m.palette.rock).lerp(new Color(0x9a8566), 0.55).multiplyScalar(0.88);

/**
 * Masonry walls of a block `w` by `d` from y = 0 to `top`: courses of big cut stones, each stone a
 * rounded box a little proud of or sunk into the face, toned stone by stone.
 */
function masonry(m: ToyMesh, w: number, d: number, top: number, course = 0.5) {
  const stone = sandstone(m);
  const rows = Math.max(1, Math.round(top / course));
  const h = top / rows;
  m.box(
    [0, top / 2, 0],
    [w - 0.1, top - 0.02, d - 0.1],
    stone.clone().multiplyScalar(0.5).getHex(),
    "slab",
    0.02,
  );
  for (const [len, depth, face] of [
    [w, d, 0],
    [d, w, 1],
    [w, d, 2],
    [d, w, 3],
  ] as const) {
    for (let r = 0; r < rows; r++) {
      let at = -len / 2;
      while (at < len / 2 - 0.05) {
        const piece = Math.min(len / 2 - at, m.rng.range(0.45, 0.95));
        const out = m.rng.range(-0.015, 0.03);
        const g = new RoundedBoxGeometry(piece - 0.035, h - 0.035, 0.16, 2, 0.04).translate(
          at + piece / 2,
          r * h + h / 2,
          depth / 2 - 0.08 + out,
        );
        g.rotateY((face * Math.PI) / 2);
        m.add(g, stone.clone().multiplyScalar(m.rng.range(0.78, 1.08)).getHex(), "slab");
        at += piece;
      }
    }
  }
}

/** A top of `n` by `n` worn flagstones over a `size` square at height `top`, some mossy at the edges. */
function flagstones(m: ToyMesh, size: number, n: number, top: number) {
  const stone = sandstone(m).lerp(new Color(0xffffff), 0.08);
  const cell = size / n;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      const lift = m.rng.range(-0.025, 0.02);
      const g = new RoundedBoxGeometry(cell - 0.03, 0.16, cell - 0.03, 2, 0.035)
        .rotateX(m.rng.range(-0.02, 0.02))
        .rotateZ(m.rng.range(-0.02, 0.02))
        .translate(-size / 2 + cell * (i + 0.5), top - 0.08 + lift, -size / 2 + cell * (k + 0.5));
      m.add(g, stone.clone().multiplyScalar(m.rng.range(0.82, 1.06)).getHex(), "flagstone");
    }
  const grit = m.rng.seed();
  m.grass(
    size / 2,
    top + 0.005,
    (x, z) => {
      const edge = Math.min(size / 2 - Math.abs(x), size / 2 - Math.abs(z));
      return edge > 0.02 && noise3(x * 1.6, 0, z * 1.6, grit) - edge * 1.2 > 0.05;
    },
    260,
    0.08,
  );
}

/** The cut-stone platform: a 2 m block of big sandstone courses with a 3 x 3 flagstone top at 1 m. */
export const stonePlatform: ToyPart = (m) => {
  masonry(m, CELL, CELL, 0.86);
  flagstones(m, CELL, 3, 1);
};

/** A stepping pillar: a 1 m square column of three stone courses, its flagstone top at 2 m. */
export const stonePillar: ToyPart = (m) => {
  masonry(m, 1, 1, 1.86, 0.62);
  flagstones(m, 1, 2, 2);
};

/** A floating flagstone raft, 2 m square, hovering 1.2 m up and bobbing; a stepping stone over gaps. */
export const stoneFloat: ToyPart = (m) => {
  const phase = m.rng.range(0, Math.PI * 2);
  const rest = 1.2;
  m.pivot(
    "raft",
    [0, rest, 0],
    () => {
      const stone = sandstone(m).multiplyScalar(0.85).getHex();
      m.box([0, rest - 0.25, 0], [CELL - 0.1, 0.36, CELL - 0.1], stone, "slab", 0.06);
      m.lathe(
        [
          [0.85, 0],
          [0.55, -0.35],
          [0.2, -0.6],
          [0, -0.65],
        ],
        [0, rest - 0.43, 0],
        stone,
        "slab",
        8,
      );
      flagstones(m, CELL, 2, rest);
    },
    (node, t) => {
      node.position.y = rest + Math.sin(t * 1.1 + phase) * 0.12;
      node.rotation.z = Math.sin(t * 0.8 + phase) * 0.02;
    },
  );
};

/** A cut-stone raft that slides 2 m to either side and back: it carries the player over a gap. */
export const sliderPlatform: ToyPart = (m) => {
  const phase = m.rng.range(0, Math.PI * 2);
  m.pivot(
    "raft",
    [0, 1, 0],
    () => {
      masonry(m, CELL, CELL, 0.86, 0.43);
      flagstones(m, CELL, 2, 1);
      for (const x of [-0.6, 0.6])
        m.ring([x, 0.02, 0], 0.18, 0.03, m.palette.glow, "glow", Math.PI * 2, 0, [0.6, phase, 3]);
    },
    (node, t) => {
      node.position.x = Math.sin(t * 0.9 + phase) * CELL;
    },
  );
};

/** The square-key meander carved into a ruin face: a stone ridge path inside a `size` square. */
const KEY: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0.2, 1],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.8, 0.8],
  [0.45, 0.8],
  [0.45, 0.5],
];

/**
 * A carved ruin block, 2 m square and 2 m tall: cut-stone courses with a red panel on each face
 * carved with square-key meanders, and a mossy lawn on top.
 */
export const ruinBlock: ToyPart = (m) => {
  masonry(m, CELL, CELL, 1.86);
  const red = new Color(m.palette.accent).lerp(new Color(0x8a2a1e), 0.85).getHex();
  const ridge = sandstone(m).multiplyScalar(0.8).getHex();
  for (let face = 0; face < 4; face++) {
    const yaw = (face * Math.PI) / 2;
    const panel = new RoundedBoxGeometry(1.5, 1.2, 0.06, 2, 0.02)
      .translate(0, 0.95, H + 0.02)
      .rotateY(yaw);
    m.add(panel, red, "slab");
    // two keys side by side, the second mirrored
    for (const [ox, flip] of [
      [-0.37, 1],
      [0.37, -1],
    ] as const)
      for (let j = 1; j < KEY.length; j++) {
        const [ax, ay] = KEY[j - 1] as [number, number];
        const [bx, by] = KEY[j] as [number, number];
        const s = 0.5;
        const x0 = ox + flip * (ax - 0.5) * s;
        const x1 = ox + flip * (bx - 0.5) * s;
        const y0 = 0.95 + (ay - 0.5) * s * 1.6;
        const y1 = 0.95 + (by - 0.5) * s * 1.6;
        const g = new RoundedBoxGeometry(
          Math.abs(x1 - x0) + 0.08,
          Math.abs(y1 - y0) + 0.08,
          0.08,
          1,
          0.02,
        )
          .translate((x0 + x1) / 2, (y0 + y1) / 2, H + 0.07)
          .rotateY(yaw);
        m.add(g, ridge, "slab");
      }
  }
  m.box([0, 1.93, 0], [CELL - 0.04, 0.14, CELL - 0.04], m.palette.soil, "soil", 0.04);
  m.grass(H, 2, square(H - 0.02), 380, 0.16);
};

/**
 * A lattice glyph pillar, 1 m square and 4.5 m tall: a thin core inside a stack of carved frames.
 * Solid courses alternate with courses pierced by a window in each face, so the sky shows through.
 */
export const glyphPillar: ToyPart = (m) => {
  const stone = sandstone(m).multiplyScalar(0.8);
  m.box([0, 2.2, 0], [0.26, 4.4, 0.26], stone.clone().multiplyScalar(0.5).getHex(), "slab", 0.02);
  for (let c = 0; c < 11; c++) {
    const y = 0.2 + c * 0.4;
    const tone = stone.clone().multiplyScalar(m.rng.range(0.82, 1.1)).getHex();
    const pierced = c % 2 === 1;
    for (let face = 0; face < 4; face++) {
      // a solid course is one long stone; a pierced one is two posts either side of a window
      const pieces: [number, number][] = pierced
        ? [
            [-0.36, 0.2],
            [0.36, 0.2],
          ]
        : [[0, 0.94]];
      for (const [x, w] of pieces) {
        const g = new RoundedBoxGeometry(w, pierced ? 0.4 : 0.36, 0.18, 2, 0.03)
          .translate(x, y, 0.38)
          .rotateY((face * Math.PI) / 2);
        m.add(g, tone, "slab");
      }
    }
  }
  m.box([0, 4.45, 0], [1.05, 0.12, 1.05], stone.getHex(), "slab", 0.03);
  m.grass(0.5, 4.52, square(0.48), 300, 0.12);
};

/**
 * A canopy tree, 4.5 m tall: a pale trunk that forks into crooked boughs, each ending in a flat
 * square pad of leaves.
 */
export const tierTree: ToyPart = (m) => {
  const sway: [number, number] = [0.5, 6];
  const green = jungle(m).multiplyScalar(0.95).getHex();
  const fork = new Vector3(m.rng.range(-0.15, 0.15), 2.2, 0);
  limb(m, [new Vector3(0, 0, 0), new Vector3(0.05, 1.1, 0.04), fork], 0.16, 0.1, sway);
  m.add(
    new CylinderGeometry(0.18, 0.28, 0.16, 12).translate(0, 0.08, 0),
    new Color(m.palette.trunk).multiplyScalar(0.8).getHex(),
    "leaf",
  );
  const pads = 3 + Math.floor(m.rng.range(0, 2));
  for (let i = 0; i < pads; i++) {
    const a = (i / pads) * Math.PI * 2 + m.rng.range(-0.3, 0.3);
    const reach = i === 0 ? 0.15 : m.rng.range(1.2, 1.7);
    const tip = new Vector3(
      fork.x + Math.cos(a) * reach,
      i === 0 ? 4.1 : m.rng.range(2.8, 3.6),
      Math.sin(a) * reach,
    );
    const elbow = fork
      .clone()
      .lerp(tip, 0.5)
      .setY(fork.y + (tip.y - fork.y) * 0.35);
    limb(m, [fork.clone().setY(2.1), elbow, tip], 0.08, 0.045, sway);
    const r = m.rng.range(0.45, 0.6);
    crown(m, [tip.x, tip.y + 0.1, tip.z], r, Math.round(r * r * 560), 0.34, green, true);
  }
};

/** A pile of ripe fruit, 1.6 m across: mango-shaped, blushed red to yellow, each with a stalk. */
export const fruitPile: ToyPart = (m) => {
  const ripe = new Color(0xf2c23a);
  const blush = new Color(0xd8402a);
  for (let i = 0; i < 16; i++) {
    const r = m.rng.range(0.07, 0.1);
    const x = m.rng.range(-0.7, 0.7);
    const z = m.rng.range(-0.7, 0.7);
    const yaw = m.rng.range(0, Math.PI * 2);
    const side = new Vector3(Math.cos(yaw), 0.4, Math.sin(yaw)).normalize();
    const g = new SphereGeometry(1, 16, 12)
      .scale(r * 1.25, r, r * 0.95)
      .rotateY(yaw)
      .translate(x, r * 0.95, z);
    m.add(g, 0xffffff, "plastic", (px, py, pz, out) => {
      const t = Math.max(
        0,
        Math.min(1, (((px - x) * side.x + (py - r) * side.y + (pz - z) * side.z) / r) * 0.6 + 0.5),
      );
      out.copy(ripe).lerp(blush, t);
    });
    m.rod([x, r * 1.9, z], [x, r * 2.15, z], 0.008, 0x5a3a1e, "wood", 5);
  }
};

/** A patch of tulips: cupped heads in the theme's flower colours on stems among long blades. */
export const tulips: ToyPart = (m) => {
  const p = m.palette;
  const sway: [number, number] = [0, 0.7];
  const colors = [0xe8344a, 0xf6c53a, p.accent, 0xffffff];
  for (let i = 0; i < 11; i++) {
    const x = m.rng.range(-0.6, 0.6);
    const z = m.rng.range(-0.6, 0.6);
    const h = m.rng.range(0.32, 0.48);
    m.add(
      new CylinderGeometry(0.01, 0.013, h, 5).translate(x, h / 2, z),
      jungle(m).getHex(),
      "leaf",
      { sway },
    );
    const cup = new LatheGeometry(
      [
        [0, 0],
        [0.045, 0.015],
        [0.06, 0.06],
        [0.052, 0.11],
        [0.03, 0.125],
      ].map(([a, b]) => new Vector2(a, b)),
      6,
    ).translate(x, h - 0.02, z);
    m.add(cup, colors[i % colors.length] as number, "leaf", { sway });
    blade(
      m,
      new Vector3(x, 0.02, z),
      m.rng.range(0, Math.PI * 2),
      1.2,
      1,
      0.28,
      (t) => 0.12 * (1 - t),
      jungle(m),
      sway,
    );
  }
};

/**
 * A spinner: a striped bar 3.6 m long sweeping round a post at waist height. It sits on a 2 m
 * platform and sweeps over its neighbours; jump it.
 */
export const spinner: ToyPart = (m) => {
  const p = m.palette;
  m.cylinder([0, 0.06, 0], 0.42, 0.5, 0.12, p.metal, "metal", 32);
  m.cylinder([0, 0.4, 0], 0.11, 0.13, 0.7, p.plastic, "plastic", 24);
  const speed = 1.4 * (m.rng.range(0, 1) < 0.5 ? 1 : -1);
  m.pivot(
    "bar",
    [0, 0.6, 0],
    () => {
      m.cylinder([0, 0.6, 0], 0.22, 0.22, 0.24, p.accent, "plastic", 32);
      for (let i = 0; i < 9; i++) {
        const x = -1.7 + i * 0.425;
        if (Math.abs(x) < 0.2) continue;
        m.add(
          new CylinderGeometry(0.09, 0.09, 0.42, 20).rotateZ(Math.PI / 2).translate(x, 0.6, 0),
          i % 2 ? 0xf4f4f4 : p.accent,
          "plastic",
        );
      }
      for (const s of [-1, 1]) m.sphere([s * 1.82, 0.6, 0], [0.16, 0.16, 0.16], p.accent2);
    },
    (node, t) => {
      node.rotation.y = t * speed;
    },
  );
};

/** Spike rise over a 3 s cycle: down, a quick rise, a hold, then they sink. 0 down, 1 up. */
export function spikeRise(seconds: number, phase = 0): number {
  const t = (((seconds + phase) % 3) + 3) % 3;
  if (t < 1.4) return 0;
  if (t < 1.55) return (t - 1.4) / 0.15;
  if (t < 2.5) return 1;
  return Math.max(0, 1 - (t - 2.5) / 0.4);
}

/** A spike trap: a 2 m metal floor plate with a 4 x 4 grid of spikes that shoot up and sink again. */
export const spikeTrap: ToyPart = (m) => {
  const p = m.palette;
  m.box([0, 0.05, 0], [CELL, 0.1, CELL], p.metal, "metal", 0.03);
  m.ring([0, 0.105, 0], 0.92, 0.025, p.glow, "glow", Math.PI * 2, 0, [0.9, 0, 4]);
  const phase = m.rng.range(0, 3);
  for (let i = 0; i < 4; i++)
    for (let k = 0; k < 4; k++)
      m.cylinder(
        [-0.66 + i * 0.44, 0.1, -0.66 + k * 0.44],
        0.13,
        0.13,
        0.02,
        0x15171c,
        "metal",
        16,
      );
  m.pivot(
    "spikes",
    [0, 0, 0],
    () => {
      for (let i = 0; i < 4; i++)
        for (let k = 0; k < 4; k++)
          m.add(
            new CylinderGeometry(0, 0.1, 0.5, 8).translate(
              -0.66 + i * 0.44,
              0.25,
              -0.66 + k * 0.44,
            ),
            0xc8ccd4,
            "metal",
          );
    },
    (node, t) => {
      node.position.y = -0.48 + spikeRise(t, phase) * 0.5;
    },
  );
};

/** The finish gate: two posts with checkered bands under a checkered banner, 3.2 m tall. */
export const goalGate: ToyPart = (m) => {
  const p = m.palette;
  const checker = (w: number, h: number, at: XYZ, cols: number, rows: number) => {
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++)
        m.box(
          [at[0] - w / 2 + (w / cols) * (i + 0.5), at[1] - h / 2 + (h / rows) * (j + 0.5), at[2]],
          [w / cols, h / rows, 0.12],
          (i + j) % 2 ? 0x15171c : 0xf6f6f6,
          "plastic",
          0.01,
        );
  };
  for (const x of [-1.05, 1.05]) {
    m.cylinder([x, 0.08, 0], 0.26, 0.3, 0.16, p.metal, "metal", 24);
    m.cylinder([x, 1.6, 0], 0.13, 0.13, 3.0, p.plastic, "plastic", 24);
    m.ring([x, 2.1, 0], 0.15, 0.03, p.accent, "plastic");
    m.sphere([x, 3.15, 0], [0.18, 0.18, 0.18], p.gold, "gold");
  }
  checker(2.0, 0.5, [0, 2.75, 0], 10, 2);
  m.box([0, 2.45, 0], [2.1, 0.08, 0.16], p.accent, "plastic", 0.03);
  m.ring([0, 0.03, 0], 0.85, 0.035, p.glow, "glow", Math.PI * 2, 0, [0.7, 0, 2.5]);
};
