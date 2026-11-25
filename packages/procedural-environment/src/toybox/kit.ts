import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  type InterleavedBufferAttribute,
  LatheGeometry,
  Mesh,
  type Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { RNG, noise3 } from "../../vendor/stylized-biome-kit/core.js";
import { type Finish, toyboxMaterials } from "./materials.js";

export { toyboxMaterials, toyboxPush, toyboxPushers, loadToyboxScans } from "./materials.js";

export type XYZ = [number, number, number];

/**
 * The Toybox kit sits between the two collections: toy proportions (chunky, rounded, bright) with
 * realistic surfaces (clearcoat plastic, brushed metal, displaced rock, dense grass blades) lit by
 * an environment map. It does not use the Biome Kit's flat painted finish.
 */
export const TOYBOX_THEMES = ["Sky Garden", "Frost Peak", "Sand Ruins"] as const;
export const TOYBOX_BIOMES = ["forest", "tundra", "desert"] as const;

export interface IToyPalette {
  grass: number;
  tip: number;
  soil: number;
  rock: number;
  rim: number;
  plastic: number;
  accent: number;
  accent2: number;
  metal: number;
  glow: number;
  leaf: number;
  trunk: number;
  water: number;
  gold: number;
  /** Lawn blades: how dense and how tall next to the Sky Garden lawn (1, 1). */
  turf: [density: number, height: number];
}

const PALETTES: readonly IToyPalette[] = [
  {
    grass: 0x3f8f2a,
    tip: 0xa8d860,
    soil: 0x2f5a1e,
    rock: 0x9a8e84,
    rim: 0xcdbcb2,
    plastic: 0xf3f4f6,
    accent: 0xe8457a,
    accent2: 0x3b7cf0,
    metal: 0x3a3e46,
    glow: 0xffc63a,
    leaf: 0xf0649a,
    trunk: 0x8a6a5c,
    water: 0x58cdee,
    gold: 0xffbf2e,
    turf: [1, 1],
  },
  {
    grass: 0xc2d6e8,
    tip: 0xf6faff,
    soil: 0xc8d8e8,
    rock: 0x6c7684,
    rim: 0xc2cedc,
    plastic: 0xf4f7fb,
    accent: 0x3cb6ff,
    accent2: 0xff5468,
    metal: 0x2b323e,
    glow: 0x6fe8ff,
    leaf: 0xc4e6ff,
    trunk: 0x5a4c54,
    water: 0x3a8fd6,
    gold: 0xffc94a,
    turf: [0.6, 0.6],
  },
  {
    grass: 0xb08a3a,
    tip: 0xf0d48c,
    soil: 0x8a6a34,
    rock: 0xc49468,
    rim: 0xd2b88e,
    plastic: 0xf6f1ea,
    accent: 0xff8a2a,
    accent2: 0x22b0a4,
    metal: 0x3a3330,
    glow: 0xffd640,
    leaf: 0x8cc850,
    trunk: 0x7a5a3a,
    water: 0x2fb6d6,
    gold: 0xffc22e,
    turf: [0.75, 1.15],
  },
];

type Paint = (x: number, y: number, z: number, out: Color) => void;

export interface IAddOptions {
  paint?: Paint;
  /** Leaves: height where sway starts, and the height over which it reaches full. */
  sway?: [from: number, span: number];
  /** Glows: [depth 0..1, phase, speed]; depth 0 holds steady. */
  pulse?: [depth: number, phase: number, speed: number];
  /**
   * Water: speed of the falling foam streaks; 0 is still water with waves. A function gives each
   * vertex its own value: a negative one, -(0..1), is the distance out from a shore, for lapping foam.
   */
  flow?: number | ((x: number, y: number, z: number) => number);
}

/** Runs each frame on an animated part, with its node and the time in seconds. */
export type Animate = (node: Object3D, seconds: number) => void;

function flows(
  positions: BufferAttribute | InterleavedBufferAttribute,
  flow: IAddOptions["flow"] = 0,
): Float32Array {
  const values = new Float32Array(positions.count);
  if (typeof flow === "number") return values.fill(flow);
  for (let i = 0; i < values.length; i++)
    values[i] = flow(positions.getX(i), positions.getY(i), positions.getZ(i));
  return values;
}

/** The per-vertex motion inputs each animated finish's shader reads (see materials.ts). */
function motion(
  finish: Finish,
  positions: BufferAttribute | InterleavedBufferAttribute,
  {
    sway,
    pulse,
    flow,
  }: { sway?: [number, number]; pulse: [number, number, number]; flow: IAddOptions["flow"] },
): [string, Float32Array, number][] {
  const count = positions.count;
  if (finish === "grass" || finish === "leaf") {
    const weights = new Float32Array(count);
    if (sway)
      for (let i = 0; i < count; i++)
        weights[i] = Math.min(1, Math.max(0, (positions.getY(i) - sway[0]) / sway[1]));
    return [["sway", weights, 1]];
  }
  if (finish === "glow") {
    const values = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) values.set(pulse, i * 3);
    return [["pulse", values, 3]];
  }
  if (finish === "water") return [["flow", flows(positions, flow), 1]];
  return [];
}

export class ToyMesh {
  readonly rng: RNG;
  readonly palette: IToyPalette;
  private parts = new Map<Finish, BufferGeometry[]>();
  private readonly pivots: Group[] = [];

  constructor(
    readonly seed: number,
    theme: number,
  ) {
    this.rng = new RNG(seed);
    const palette = PALETTES[theme];
    if (!palette) throw new Error(`Invalid toybox theme variant ${theme}`);
    this.palette = palette;
  }

  /**
   * Smooth-shaded: keeps the shape's normals, adds a vertex colour, and files it under its finish.
   * A `shade` attribute on the shape (one float per vertex) multiplies that colour: baked occlusion.
   */
  add(shape: BufferGeometry, color: number, finish: Finish, options: Paint | IAddOptions = {}) {
    const {
      paint,
      sway,
      pulse = [0, 0, 0],
      flow = 0,
    } = typeof options === "function" ? { paint: options } : options;
    for (const name of Object.keys(shape.attributes))
      if (name !== "position" && name !== "normal" && name !== "shade") shape.deleteAttribute(name);
    if (!shape.getAttribute("normal")) shape.computeVertexNormals();
    const geometry = shape.index ? shape.toNonIndexed() : shape;
    if (geometry !== shape) shape.dispose();
    const positions = geometry.getAttribute("position");
    const shade = geometry.getAttribute("shade");
    const count = positions.count;
    const colors = new Float32Array(count * 3);
    const base = new Color(color).multiplyScalar(this.rng.range(0.96, 1.04));
    const tint = new Color();
    for (let i = 0; i < count; i++) {
      tint.copy(base);
      paint?.(positions.getX(i), positions.getY(i), positions.getZ(i), tint);
      if (shade) tint.multiplyScalar(shade.getX(i));
      tint.toArray(colors, i * 3);
    }
    geometry.deleteAttribute("shade");
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    for (const [name, values, size] of motion(finish, positions, { sway, pulse, flow }))
      geometry.setAttribute(name, new BufferAttribute(values, size));
    const list = this.parts.get(finish) ?? [];
    list.push(geometry);
    this.parts.set(finish, list);
  }

  /**
   * Build a moving part: everything `build` adds goes into its own node, pivoting at `origin`,
   * and `animate` drives that node each frame (see `createStylizedAsset(...).update`).
   */
  pivot(name: string, origin: XYZ, build: () => void, animate: Animate): void {
    const saved = this.parts;
    this.parts = new Map();
    build();
    const node = this.merge(name, origin);
    this.parts = saved;
    node.position.set(...origin);
    node.userData.animate = animate;
    this.pivots.push(node);
  }

  box(
    center: XYZ,
    [w, h, d]: XYZ,
    color: number,
    finish: Finish = "plastic",
    radius = 0.08,
    yaw = 0,
  ) {
    const r = Math.min(radius, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
    const shape = new RoundedBoxGeometry(w, h, d, 3, Math.max(0.001, r));
    if (yaw) shape.rotateY(yaw);
    this.add(shape.translate(...center), color, finish);
  }

  cylinder(
    center: XYZ,
    top: number,
    bottom: number,
    height: number,
    color: number,
    finish: Finish = "plastic",
    sides = 40,
  ) {
    this.add(new CylinderGeometry(top, bottom, height, sides).translate(...center), color, finish);
  }

  /** A rod from `a` to `b`. */
  rod(a: XYZ, b: XYZ, r: number, color: number, finish: Finish = "metal", sides = 12) {
    const from = new Vector3(...a);
    const dir = new Vector3(...b).sub(from);
    const shape = new CylinderGeometry(r, r, dir.length(), sides);
    shape.applyQuaternion(
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize()),
    );
    this.add(shape.translate(...from.lerp(new Vector3(...b), 0.5).toArray()), color, finish);
  }

  /** A flat ring lying on XZ (tube `r`), or an arc of one from `start` through `arc` radians. */
  ring(
    center: XYZ,
    radius: number,
    r: number,
    color: number,
    finish: Finish = "plastic",
    arc = Math.PI * 2,
    start = 0,
    pulse?: [number, number, number],
  ) {
    const shape = new TorusGeometry(
      radius,
      r,
      10,
      Math.max(12, Math.round(radius * 40 * (arc / Math.PI / 2))),
      arc,
    );
    shape.rotateZ(start).rotateX(-Math.PI / 2);
    this.add(shape.translate(...center), color, finish, { pulse });
  }

  sphere(
    center: XYZ,
    [sx, sy, sz]: XYZ,
    color: number,
    finish: Finish = "plastic",
    paint?: Paint | IAddOptions,
  ) {
    this.add(
      new SphereGeometry(1, 32, 20).scale(sx, sy, sz).translate(...center),
      color,
      finish,
      paint,
    );
  }

  /** Revolve an XY profile (x = radius) about Y. */
  lathe(
    profile: [number, number][],
    at: XYZ,
    color: number,
    finish: Finish = "plastic",
    sides = 48,
  ) {
    const shape = new LatheGeometry(
      profile.map(([x, y]) => new Vector2(x, y)),
      sides,
    );
    this.add(shape.translate(...at), color, finish);
  }

  /** A lumpy displaced rock: smooth normals, darker in the cracks, `flat` cuts its top level. */
  rock(center: XYZ, [sx, sy, sz]: XYZ, { flat = false, color = this.palette.rock } = {}) {
    const grit = this.rng.seed();
    let shape: BufferGeometry = new IcosahedronGeometry(1, 4);
    shape.deleteAttribute("normal");
    shape.deleteAttribute("uv");
    shape = mergeVertices(shape);
    const p = shape.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const v = new Vector3(p.getX(i), p.getY(i), p.getZ(i));
      const n =
        noise3(v.x * 1.3, v.y * 1.3, v.z * 1.3, grit) * 0.22 +
        noise3(v.x * 3.4, v.y * 3.4, v.z * 3.4, grit + 7) * 0.08 +
        Math.abs(noise3(v.x * 7, v.y * 7, v.z * 7, grit + 3)) * -0.05;
      v.multiplyScalar(1 + n);
      if (flat && v.y > 0.55) v.y = 0.55 + (v.y - 0.55) * 0.08;
      p.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
    }
    shape.computeVertexNormals();
    shape.translate(...center);
    const dark = new Color(color).multiplyScalar(0.55);
    const light = new Color(color).lerp(new Color(0xffffff), 0.18);
    this.add(shape, color, "rock", (x, y, z, out) => {
      const crack = noise3(x * 2.1, y * 2.4, z * 2.1, grit + 11);
      out.lerp(crack < 0 ? dark : light, Math.min(1, Math.abs(crack) * 1.6));
    });
  }

  /**
   * A carpet of grass blades over the area `inside(x, z)` accepts, inside a `radius` square, at
   * height `y` (or `heightAt`). Blades are three-triangle tapered cards, dark at the root and light
   * at the tip, with a per-blade hue shift; they grow in clumps, with a tall tuft here and there.
   * Density is blades per square metre; the theme's `turf` scales it and the height.
   */
  grass(
    radius: number,
    y: number | ((x: number, z: number) => number),
    inside: (x: number, z: number) => boolean,
    density = 420,
    height = 0.2,
  ) {
    const ground = typeof y === "number" ? () => y : y;
    const p = this.palette;
    const [thick, tall] = p.turf;
    const count = Math.round(radius * radius * 4 * density * thick);
    const positions: number[] = [];
    const colors: number[] = [];
    const sway: number[] = [];
    const root = new Color(p.soil).multiplyScalar(0.7);
    const tip = new Color();
    const mid = new Color();
    for (let i = 0; i < count; i++) {
      const x = this.rng.range(-radius, radius);
      const z = this.rng.range(-radius, radius);
      if (!inside(x, z)) continue;
      const patch = noise3(x * 0.6, 0, z * 0.6, this.seed);
      // clumps: lush, sun-bleached and darker patches, then per-blade jitter
      const clump = noise3(x * 1.7, 3, z * 1.7, this.seed + 1);
      const tuft = this.rng.range(0, 1) < 0.05 ? 1.7 : 1;
      const h = height * tall * this.rng.range(0.55, 1.3) * (1 + Math.max(0, clump) * 0.7) * tuft;
      const w = this.rng.range(0.03, 0.055);
      const yaw = this.rng.range(0, Math.PI * 2);
      const lean = this.rng.range(0.15, 0.5) * h * tuft;
      const cx = Math.cos(yaw);
      const sz = Math.sin(yaw);
      this.bladeTip(tip, patch, clump);
      mid.set(p.grass).multiplyScalar(this.rng.range(0.85, 1.1));
      // root pair, middle pair, tip: the blade leans out along its yaw as it rises
      const at = (t: number, side: number): number[] => [
        x + cx * side * w * (1 - t) - sz * lean * t * t,
        ground(x, z) + h * t,
        z - sz * side * w * (1 - t) - cx * lean * t * t,
      ];
      const v = [at(0, -1), at(0, 1), at(0.55, -1), at(0.55, 1), at(1, 0)];
      const c = [root, root, mid, mid, tip];
      const s = [0, 0, 0.55, 0.55, 1];
      for (const [a, b, d] of [
        [0, 1, 2],
        [2, 1, 3],
        [2, 3, 4],
      ] as const) {
        for (const k of [a, b, d]) {
          positions.push(...(v[k] as number[]));
          colors.push((c[k] as Color).r, (c[k] as Color).g, (c[k] as Color).b);
          sway.push(s[k] as number);
        }
      }
    }
    if (!positions.length) return;
    const blades = new BufferGeometry();
    blades.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    blades.computeVertexNormals();
    // Normals point up so the carpet lights like a lawn, not like scattered cards.
    const normal = blades.getAttribute("normal");
    for (let i = 0; i < normal.count; i++)
      normal.setXYZ(i, normal.getX(i) * 0.3, 1, normal.getZ(i) * 0.3);
    const list = this.parts.get("grass") ?? [];
    blades.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
    blades.setAttribute("sway", new BufferAttribute(new Float32Array(sway), 1));
    list.push(blades);
    this.parts.set("grass", list);
  }

  /** A blade tip's colour: lush, sun-bleached in clumps, darker in patches, jittered per blade. */
  private bladeTip(tip: Color, patch: number, clump: number) {
    const p = this.palette;
    tip.set(p.tip).lerp(new Color(p.grass), 0.35 + patch * 0.45 + this.rng.range(-0.15, 0.15));
    if (clump > 0.25) tip.lerp(new Color(0xf2e28a), (clump - 0.25) * 0.5);
    tip.offsetHSL(this.rng.range(-0.015, 0.015), 0, this.rng.range(-0.04, 0.04));
  }

  private merge(name: string, origin: XYZ = [0, 0, 0]): Group {
    const group = new Group();
    group.name = name;
    for (const [finish, parts] of this.parts) {
      const merged = mergeGeometries(parts);
      if (!merged) throw new Error(`Could not merge ${name} ${finish} geometry`);
      merged.translate(-origin[0], -origin[1], -origin[2]);
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, toyboxMaterials[finish]);
      mesh.name = `${name}:${finish}`;
      mesh.castShadow = !["glow", "glass", "water", "grass"].includes(finish);
      mesh.receiveShadow = finish !== "glow";
      // shore foam (negative flow) draws after the sea it lies on
      const flow = merged.getAttribute("flow");
      if (flow && (flow.array as Float32Array).some((v) => v < 0)) mesh.renderOrder = 1;
      group.add(mesh);
      for (const part of parts) part.dispose();
    }
    return group;
  }

  finish(id: string): Group {
    const group = this.merge(`toybox-${id}`);
    if (this.pivots.length) group.add(...this.pivots);
    return group;
  }
}

export type ToyPart = (m: ToyMesh) => void;
