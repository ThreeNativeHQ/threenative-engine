// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Wren, a lantern-bearing wanderer, modelled in code: no mesh file, no skin, no clip. Every joint
// is a group the pose below rotates. Local space is feet at y = 0, facing +Z, so her right is -X.
// The right hand is a real `Bone` named `RightHand`, so the blade is attached with the engine's
// `attachToBone` (a weapon stays in the hand that holds it) instead of being parented by hand.
//
// About 4.5 heads tall. Turned (lathe) and swept (tube) forms rather than stacked primitives: a
// jaw-tapered head with eyes, lids, brows, nose and mouth; side-swept hair locks; a dusk-blue hood
// with a rolled rim and a short soft tip, over a mantle clasped with a cord; a russet tunic with a
// V collar, a folded hem and a baldric; gloves, cuffed boots with soles. Each joint's parts merge
// into one mesh per surface (cloth, leather, metal, skin, hair), so she is a few dozen draws. The
// hood tip, the side locks, the pouch and the lantern are springs: they lag her bounce and stride.
import {
  AdditiveBlending,
  Bone,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  type Material,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  RingGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from "three";
import { flat, glow, lit } from "./materials.js";
import { C } from "./palette.js";

export type HeroPoseName =
  | "idle"
  | "run"
  | "roll"
  | "hop"
  | "slash"
  | "block"
  | "push"
  | "hurt"
  | "dead";

export interface IHeroPose {
  readonly dt: number;
  readonly state: HeroPoseName;
  /** Ground speed, m/s. */
  readonly speed: number;
  /** 0..1 through the current action (slash, roll, hurt). */
  readonly progress: number;
  /** She owns the Ember Blade: the scabbard is on her back. */
  readonly sword: boolean;
  /** The blade is in her hand and the shield on her arm; otherwise both ride her back. */
  readonly drawn: boolean;
  /** 1 the step the shield turns a hit, fading to 0. */
  readonly flash: number;
}

export interface IHeroRig {
  readonly group: Group;
  update(pose: IHeroPose): void;
}

/** Hip height: the body group's origin, and the pivot the run and the roll turn about. */
const HIP = 0.66;
/** The head's centre above the neck joint, and its radius before the jaw taper. */
const HC = 0.17;
const HR = 0.165;
/** How much the jaw narrows toward the chin. */
const JAW = 0.4;
/** The hood: a shell round the head, open over the face from the brim down. */
const HOOD = { r: 0.183, y: HC - 0.004, z: -0.006, brim: 1.1, window: 0.85, hem: 0.93 * Math.PI };
/** The chest's turned profile, [radius, height] from the waist up; its depth is 0.74 of its width. */
const CHEST: readonly (readonly [number, number])[] = [
  [0.142, -0.03],
  [0.148, 0.06],
  [0.165, 0.16],
  [0.18, 0.28],
  [0.183, 0.36],
  [0.168, 0.44],
  [0.125, 0.51],
  [0.065, 0.555],
  [0.001, 0.565],
];
const CHEST_DEPTH = 0.74;

type Surface = "cloth" | "hood" | "drape" | "skin" | "hair" | "leather" | "metal" | "eye";
/** A part: its geometry (already placed in its joint), its colour or a colour per point, its surface. */
type Part = readonly [BufferGeometry, number | ((p: Vector3) => number), Surface];
type Point = readonly [number, number, number];
const CASTS = new Set<Surface>(["cloth", "drape", "leather", "skin"]);

function surfaces(): Record<Surface, Material> {
  return {
    cloth: lit(0xffffff, { detail: true, roughness: 0.92, vertexColors: true }),
    // The hood and the mantle are seen from inside through their openings.
    hood: lit(0xffffff, { detail: true, doubleSided: true, roughness: 0.92, vertexColors: true }),
    drape: lit(0xffffff, { detail: true, doubleSided: true, roughness: 0.92, vertexColors: true }),
    // Skin carries a faint warm glow of its own, like light through it, so a face in shade stays warm.
    skin: lit(0xffffff, { emissive: C.skinGlow, roughness: 0.6, vertexColors: true }),
    hair: lit(0xffffff, { roughness: 0.5, vertexColors: true }),
    leather: lit(0xffffff, { detail: true, roughness: 0.6, vertexColors: true }),
    metal: lit(0xffffff, { metalness: 0.7, roughness: 0.3, vertexColors: true }),
    eye: lit(0xffffff, { roughness: 0.15, vertexColors: true }),
  };
}

/** Scales, turns (x, then y, then z) and moves a geometry in place. */
function at(
  geometry: BufferGeometry,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): BufferGeometry {
  return geometry.scale(sx, sy, sz).rotateX(rx).rotateY(ry).rotateZ(rz).translate(x, y, z);
}

/**
 * A turned form from a [radius, height] profile listed bottom to top (that order faces it
 * outward). The seam sits at the back; `depth` flattens it front to back.
 */
function lathe(
  profile: readonly (readonly [number, number])[],
  segments: number,
  depth = 1,
  phiStart = Math.PI,
  phiLength = Math.PI * 2,
): BufferGeometry {
  const points = profile.map(([r, y]) => new Vector2(r, y));
  return new LatheGeometry(points, segments, phiStart, phiLength).scale(1, 1, depth);
}

/** Moves every vertex through `move`, then relights the result. */
function shape(geometry: BufferGeometry, move: (v: Vector3) => void): BufferGeometry {
  const position = geometry.attributes.position;
  if (position === undefined) return geometry;
  const v = new Vector3();
  for (let i = 0; i < position.count; i += 1) {
    move(v.fromBufferAttribute(position, i));
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** A swept lock, strap or crease: a tube through `points` whose radius follows `radius(t)`. */
function strand(
  points: readonly Point[],
  radius: (t: number) => number,
  radial = 6,
  segments = 8,
): BufferGeometry {
  const curve = new CatmullRomCurve3(points.map(([x, y, z]) => new Vector3(x, y, z)));
  const tube = new TubeGeometry(curve, segments, 1, radial, false);
  const position = tube.attributes.position;
  if (position === undefined) return tube;
  const centre = new Vector3();
  const v = new Vector3();
  for (let i = 0; i <= segments; i += 1) {
    curve.getPointAt(i / segments, centre);
    const r = radius(i / segments);
    for (let j = 0; j <= radial; j += 1) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(position, k).sub(centre).multiplyScalar(r).add(centre);
      position.setXYZ(k, v.x, v.y, v.z);
    }
  }
  return tube;
}

/** Merges a joint's parts into one mesh per surface, coloured per vertex. */
function bake(joint: Object3D, parts: readonly Part[]): void {
  const materials = surfaces();
  const bySurface = new Map<Surface, Part[]>();
  for (const p of parts) bySurface.set(p[2], [...(bySurface.get(p[2]) ?? []), p]);
  const p = new Vector3();
  const tint = new Color();
  for (const [surface, list] of bySurface) {
    const geometries = list.map(([g]) => (g.index === null ? g : g.toNonIndexed()));
    const count = geometries.reduce((n, g) => n + (g.attributes.position?.count ?? 0), 0);
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const colour = new Float32Array(count * 3);
    let offset = 0;
    geometries.forEach((g, i) => {
      const source = g.attributes.position;
      const paint = list[i]?.[1] ?? 0xffffff;
      if (source === undefined) return;
      position.set(source.array, offset * 3);
      normal.set(g.attributes.normal?.array ?? [], offset * 3);
      uv.set(g.attributes.uv?.array ?? [], offset * 2);
      for (let v = 0; v < source.count; v += 1) {
        tint.set(typeof paint === "number" ? paint : paint(p.fromBufferAttribute(source, v)));
        colour.set([tint.r, tint.g, tint.b], (offset + v) * 3);
      }
      offset += source.count;
    });
    const merged = new BufferGeometry();
    merged.setAttribute("position", new BufferAttribute(position, 3));
    merged.setAttribute("normal", new BufferAttribute(normal, 3));
    merged.setAttribute("uv", new BufferAttribute(uv, 2));
    merged.setAttribute("color", new BufferAttribute(colour, 3));
    const mesh = new Mesh(merged, materials[surface]);
    // Only the body's big forms cast. The hood does not, so it never darkens the face it frames;
    // hair and fittings would double her shadow-pass triangles for nothing.
    mesh.castShadow = CASTS.has(surface);
    mesh.receiveShadow = true;
    joint.add(mesh);
  }
}

function part(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A group at (x, y, z) inside `parent`: a joint the pose rotates. */
function joint(parent: Object3D, x = 0, y = 0, z = 0): Group {
  const group = new Group();
  group.position.set(x, y, z);
  parent.add(group);
  return group;
}

/** The chest's front (or, negated, back) surface depth at (x, y) in the body. */
function chestZ(x: number, y: number): number {
  let r = CHEST[0]?.[0] ?? 0;
  for (let i = 1; i < CHEST.length; i += 1) {
    const [r0, y0] = CHEST[i - 1] ?? [0, 0];
    const [r1, y1] = CHEST[i] ?? [0, 0];
    if (y >= y0 && y <= y1) r = r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  }
  return CHEST_DEPTH * Math.sqrt(Math.max(0, r * r - x * x));
}

/** Below the eyes the head narrows and lengthens into a soft jaw and chin. */
function skull(v: Vector3): void {
  const ny = v.y / HR;
  if (ny >= 0) return;
  v.y *= 1.12;
  v.x *= 1 - JAW * ny * ny;
  v.z *= v.z > 0 ? 1 - 0.12 * ny * ny : 1 - 0.3 * ny * ny;
}

/** The face's depth at (x, y) from the head centre, after `skull`. */
function faceZ(x: number, y: number): number {
  if (y >= 0) return Math.sqrt(Math.max(0, HR * HR - x * x - y * y));
  const y0 = y / 1.12;
  const ny = y0 / HR;
  const x0 = x / (1 - JAW * ny * ny);
  return Math.sqrt(Math.max(0, HR * HR - x0 * x0 - y0 * y0)) * (1 - 0.12 * ny * ny);
}

/** Where the cloth gathers into a soft peak, behind and above the crown. */
const PEAK = new Vector3(0, 0.5, -0.87).normalize();
/** The mantle's outline (radius, height on the body), crown to hem; it is 0.8 as deep as wide. */
const MANTLE: readonly (readonly [number, number])[] = [
  [0.262, 0.39],
  [0.255, 0.42],
  [0.225, 0.475],
  [0.17, 0.535],
  [0.12, 0.565],
  [0.1, 0.585],
];
/** The hood centre's height on the body: the head joint, the head centre, the hood's offset. */
const HOOD_ON_BODY = 0.585 + HOOD.y;

/** The mantle's radius at body height `y`, or 0 above it. */
function mantleRadius(y: number): number {
  for (let i = 1; i < MANTLE.length; i += 1) {
    const [r0, y0] = MANTLE[i - 1] as readonly [number, number];
    const [r1, y1] = MANTLE[i] as readonly [number, number];
    if (y <= y1) return MathUtils.lerp(r0, r1, MathUtils.clamp((y - y0) / (y1 - y0), 0, 1));
  }
  return 0;
}

/** The hood rises to a soft peak behind the crown. Below the head it drapes wider and longer, in
 * three broad folds down the back, and lies on the mantle down to a dagged edge. */
function drape(v: Vector3): void {
  const length = v.length();
  const ny = v.y / length;
  const peak = Math.max(0, v.dot(PEAK) / length - 0.8) / 0.2;
  v.addScaledVector(PEAK, 0.03 * peak * peak);
  if (ny >= 0) return;
  const phi = Math.atan2(v.z, -v.x);
  const back = Math.max(0, -Math.sin(phi));
  const fold = 1 - 0.1 * ny * back * (0.5 + 0.5 * Math.cos(6 * (phi - (Math.PI * 3) / 2)));
  v.x *= (1 - 0.15 * ny) * fold;
  v.z *= (1 - 0.2 * ny) * fold;
  v.y *= 1 - 0.5 * ny;
  const on = mantleRadius(v.y + HOOD_ON_BODY) + 0.01;
  const across = Math.hypot(v.x, (v.z + HOOD.z) / 0.8);
  if (across > 1e-4 && across < on) {
    v.x *= on / across;
    v.z = ((v.z + HOOD.z) * on) / across - HOOD.z;
  }
  if (ny < -0.95) v.y -= 0.025 * Math.max(0, Math.sin(8 * phi)) ** 2;
}

/** Where the face opening's arch closes, as a polar angle on the hood. */
const ARCH = HOOD.brim - 0.15;

/** Half the face opening's width, in radians round the hood, at polar angle `theta`: closed above the
 * arch, rounding open to the brim, then widening toward the hem. */
function opening(theta: number): number {
  if (theta <= ARCH) return 0;
  if (theta < HOOD.brim) return HOOD.window * 0.55 * Math.sqrt((theta - ARCH) / (HOOD.brim - ARCH));
  const u = MathUtils.clamp((theta - HOOD.brim) / 0.45, 0, 1);
  return HOOD.window * (0.55 + 0.45 * Math.sin((u * Math.PI) / 2));
}

/** Spreads the hood's side piece, cut at the widest opening, so its edge follows `opening`. */
function narrow(v: Vector3): void {
  const r = v.length();
  const theta = Math.acos(MathUtils.clamp(v.y / r, -1, 1));
  const from = Math.PI / 2 + HOOD.window;
  let phi = Math.atan2(v.z, -v.x);
  while (phi < from - 1e-4) phi += Math.PI * 2;
  const w = opening(theta);
  const spread = (Math.PI * 2 - 2 * w) / (Math.PI * 2 - 2 * HOOD.window);
  const turned = Math.PI / 2 + w + (phi - from) * spread;
  v.set(
    -r * Math.cos(turned) * Math.sin(theta),
    r * Math.cos(theta),
    r * Math.sin(turned) * Math.sin(theta),
  );
}

/** A point on the hood at sphere angles (phi, theta), in the head joint. */
function hoodPoint(phi: number, theta: number): Point {
  const v = new Vector3(
    -HOOD.r * Math.cos(phi) * Math.sin(theta),
    HOOD.r * Math.cos(theta),
    HOOD.r * Math.sin(phi) * Math.sin(theta),
  );
  drape(v);
  return [v.x, v.y + HOOD.y, v.z + HOOD.z];
}

/** The Ember Blade: a bevelled short sword with a glowing fuller, gripped at its own origin. */
export function createBlade(): Group {
  const blade = new Group();
  const outline = new Shape();
  outline.moveTo(-0.019, 0.1);
  outline.lineTo(0.019, 0.1);
  outline.lineTo(0.016, 0.55);
  outline.lineTo(0, 0.66);
  outline.lineTo(-0.016, 0.55);
  outline.closePath();
  const edge = new ExtrudeGeometry(outline, {
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.008,
    bevelThickness: 0.006,
    depth: 0.003,
  }).translate(0, 0, -0.0015);
  const grip: [number, number][] = [];
  for (let i = 0; i <= 10; i += 1) grip.push([i % 2 === 0 ? 0.019 : 0.0225, -0.085 + i * 0.015]);
  bake(blade, [
    [edge, C.blade, "metal"],
    [lathe(grip, 10), C.leather, "leather"],
    [
      strand(
        [
          [-0.1, 0.105, 0],
          [-0.05, 0.08, 0],
          [0, 0.076, 0],
          [0.05, 0.08, 0],
          [0.1, 0.105, 0],
        ],
        (t) => 0.009 + 0.008 * Math.sin(Math.PI * t),
        8,
        12,
      ),
      C.brass,
      "metal",
    ],
    [at(new SphereGeometry(0.024, 10, 8), 0, 0.08, 0, 0, 0, 0, 1, 0.8, 0.7), C.brass, "metal"],
    [at(new SphereGeometry(0.027, 10, 8), 0, -0.1, 0), C.brass, "metal"],
  ]);
  blade.add(part(new BoxGeometry(0.01, 0.42, 0.0165), glow(C.ember, 3), 0, 0.33));
  return blade;
}

/** The round shield, face toward +Z: a domed wooden board, an ochre cross, a brass rim and boss. */
function createShield(): Group {
  const shield = new Group();
  const face = lathe(
    [
      [0, -0.012],
      [0.19, -0.012],
      [0.2, -0.004],
      [0.2, 0],
      [0.17, 0.012],
      [0.145, 0.019],
      [0.105, 0.026],
      [0.06, 0.031],
      [0, 0.034],
    ],
    24,
  ).rotateX(Math.PI / 2);
  // The dome's height at a radius, for the cross that lies on it.
  const dome = (r: number): number => {
    const top = [0.034, 0.031, 0.026, 0.019, 0.012, 0];
    const rs = [0, 0.06, 0.105, 0.145, 0.17, 0.2];
    const i = Math.max(0, rs.findIndex((x) => x >= r) - 1);
    const t = MathUtils.clamp((r - (rs[i] ?? 0)) / ((rs[i + 1] ?? 1) - (rs[i] ?? 0)), 0, 1);
    return (top[i] ?? 0) + ((top[i + 1] ?? 0) - (top[i] ?? 0)) * t;
  };
  const cross = [0, Math.PI / 2].map((turn) => {
    const points: Point[] = [];
    for (let i = 0; i <= 8; i += 1) {
      const t = -0.17 + (0.34 * i) / 8;
      points.push([Math.cos(turn) * t, Math.sin(turn) * t, dome(Math.abs(t)) + 0.003]);
    }
    return [strand(points, () => 0.012, 6, 16), C.tunicTrim, "leather"] as const;
  });
  bake(shield, [
    [face, (p) => (Math.hypot(p.x, p.y) > 0.17 ? C.belt : C.shield), "leather"],
    ...cross,
    [new TorusGeometry(0.2, 0.014, 6, 28), C.brass, "metal"],
    [
      at(new SphereGeometry(0.042, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0, 0.03, Math.PI / 2),
      C.brass,
      "metal",
    ],
  ]);
  return shield;
}

export function createHero(): IHeroRig {
  const root = new Group();
  const body = joint(root, 0, HIP, 0);

  // Torso: a turned chest with a V collar over the cream undershirt; it breathes.
  const chest = joint(body);
  const vNeck = (p: Vector3): number =>
    p.z > 0.03 && p.y > 0.37 + 1.8 * Math.abs(p.x) ? C.undershirt : C.tunic;
  const collar = [-1, 1].map((s) => {
    const points: Point[] = [];
    for (let i = 0; i <= 4; i += 1) {
      const x = s * 0.088 * (1 - i / 4);
      const y = 0.37 + 1.8 * Math.abs(x);
      points.push([x, y, chestZ(x, y) + 0.004]);
    }
    return [strand(points, () => 0.009, 6, 6), C.tunicTrim, "cloth"] as const;
  });
  bake(chest, [[lathe(CHEST, 24, CHEST_DEPTH), vNeck, "cloth"], ...collar]);

  // Belt with a square brass buckle, the pouch on her right hip, the lantern on her left.
  bake(body, [
    [
      at(
        new TorusGeometry(0.153, 0.022, 6, 32).rotateX(Math.PI / 2),
        0,
        0.02,
        0,
        0,
        0,
        0,
        1,
        1,
        0.76,
      ),
      C.belt,
      "leather",
    ],
    [
      at(new TorusGeometry(0.026, 0.0065, 6, 4), 0, 0.02, 0.136, 0, 0, Math.PI / 4),
      C.brass,
      "metal",
    ],
    [at(new CylinderGeometry(0.048, 0.05, 0.12, 12, 1, true), 0, 0.59, 0), C.skin, "skin"],
  ]);
  const pouch = joint(body, -0.16, -0.005, 0.07);
  pouch.rotation.y = -0.8;
  bake(pouch, [
    [
      at(new SphereGeometry(0.05, 10, 8), 0, -0.055, 0, 0, 0, 0, 1, 1.1, 0.65),
      C.leather,
      "leather",
    ],
    [
      at(
        new SphereGeometry(0.052, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2),
        0,
        -0.035,
        0.004,
        0,
        0,
        0,
        1,
        0.6,
        0.72,
      ),
      C.belt,
      "leather",
    ],
    [at(new SphereGeometry(0.009, 6, 4), 0, -0.05, 0.036), C.brass, "metal"],
  ]);
  const lamp = joint(body, 0.18, 0, 0.085);
  bake(lamp, [
    [at(new TorusGeometry(0.012, 0.003, 4, 10), 0, -0.012, 0), C.iron, "metal"],
    [at(new ConeGeometry(0.045, 0.04, 8), 0, -0.045, 0), C.iron, "metal"],
    [at(new CylinderGeometry(0.042, 0.042, 0.014, 8), 0, -0.142, 0), C.iron, "metal"],
    ...[0, 1, 2, 3].map(
      (i) =>
        [
          at(
            new CylinderGeometry(0.004, 0.004, 0.08, 4),
            0.036 * Math.cos((i * Math.PI) / 2 + 0.785),
            -0.1,
            0.036 * Math.sin((i * Math.PI) / 2 + 0.785),
          ),
          C.iron,
          "metal",
        ] as const,
    ),
  ]);
  lamp.add(part(new CylinderGeometry(0.032, 0.032, 0.075, 8), glow(C.lamp, 3.5), 0, -0.1));

  // The skirt of the tunic: a front and a back panel, lapped at the sides, flaring and folding toward
  // a hem with an ochre band. It swings with the stride, and each leg pushes its panel open over the
  // trousers.
  const skirt = joint(body, 0, 0.03, 0);
  const folds = (v: Vector3): void => {
    const depth = MathUtils.clamp(-v.y / 0.33, 0, 1);
    const phi = Math.atan2(v.x, v.z / 0.82);
    const flare = 1 + 0.085 * depth * Math.sin(7 * phi);
    v.x *= flare;
    v.z *= flare;
    v.y += 0.012 * depth * Math.sin(7 * phi + 0.8);
  };
  bake(skirt, [
    [
      lathe(
        [
          [0.15, -0.2],
          [0.15, -0.12],
          [0.14, 0],
        ],
        16,
      ),
      C.trousers,
      "cloth",
    ],
  ]);
  const panels = [0, Math.PI].map((facing) => {
    const panel = joint(skirt);
    // The back panel sits a hair outside the front one where they lap.
    if (facing > 0) panel.scale.set(1.012, 1, 1.012);
    const from = facing - 1.6;
    bake(panel, [
      [
        shape(
          lathe(
            [
              [0.25, -0.342],
              [0.262, -0.335],
              [0.258, -0.31],
              [0.235, -0.24],
              [0.2, -0.14],
              [0.165, -0.05],
              [0.15, 0.005],
            ],
            14,
            0.82,
            from,
            3.2,
          ),
          folds,
        ),
        C.tunic,
        "drape",
      ],
      [
        shape(
          lathe(
            [
              [0.254, -0.344],
              [0.266, -0.337],
              [0.264, -0.302],
            ],
            14,
            0.82,
            from,
            3.2,
          ),
          folds,
        ),
        C.hem,
        "drape",
      ],
    ]);
    return panel;
  });

  // The baldric runs from her right shoulder to her left hip, front and back, with the scabbard.
  const baldric = joint(body);
  bake(
    baldric,
    [1, -1].map((side) => {
      const points: Point[] = [];
      for (let i = 0; i <= 5; i += 1) {
        const x = -0.15 + 0.06 * i;
        const y = 0.45 - 0.082 * i;
        points.push([x, y, side * (chestZ(x, y) + 0.011)]);
      }
      return [strand(points, () => 0.013, 6, 10), C.belt, "leather"] as const;
    }),
  );

  // Head: a jaw-tapered skull, big dark eyes with lids and catchlights, brows, a small nose, a
  // smile, warm cheeks; hair under the brim, a side-swept fringe.
  const head = joint(body, 0, HOOD_ON_BODY - HOOD.y, 0);
  const face: Part[] = [[at(shape(new SphereGeometry(HR, 24, 18), skull), 0, HC), C.skin, "skin"]];
  const onFace = (x: number, y: number, lift: number): Point => [x, HC + y, faceZ(x, y) + lift];
  const sparkle = glow(0xffffff, 1.5);
  for (const s of [-1, 1]) {
    const ex = 0.058 * s;
    const ey = -0.022;
    const z = faceZ(ex, ey);
    face.push([
      at(new SphereGeometry(0.03, 10, 8), ex, HC + ey, z - 0.008, -0.1, 0.38 * s, 0, 1, 1.25, 0.5),
      C.sclera,
      "eye",
    ]);
    face.push([
      at(
        new SphereGeometry(0.024, 10, 8),
        ex - 0.003 * s,
        HC + ey - 0.002,
        z,
        -0.1,
        0.3 * s,
        0,
        1,
        1.2,
        0.5,
      ),
      C.iris,
      "eye",
    ]);
    head.add(
      part(
        new SphereGeometry(0.0055, 6, 4),
        sparkle,
        ex - 0.003 * s + 0.008,
        HC + ey + 0.01,
        z + 0.011,
      ),
    );
    const lid = [Math.PI + 0.25, Math.PI - 0.35, Math.PI / 2, 0.4, -0.05].map((a) =>
      onFace(ex + s * 0.034 * Math.cos(a), ey + 0.04 * Math.sin(a), 0.006),
    );
    face.push([strand(lid, (t) => 0.0025 + 0.003 * t, 5, 10), C.lid, "eye"]);
    const brow = [
      onFace(s * 0.026, 0.036, 0.006),
      onFace(s * 0.058, 0.05, 0.006),
      onFace(s * 0.094, 0.042, 0.006),
    ];
    face.push([strand(brow, (t) => 0.0075 - 0.004 * t, 5, 8), C.hair, "hair"]);
    face.push([
      at(
        new SphereGeometry(0.026, 10, 6),
        s * 0.09,
        HC - 0.062,
        faceZ(s * 0.09, -0.062) - 0.003,
        0,
        0.5 * s,
        0,
        1,
        0.6,
        0.22,
      ),
      C.blush,
      "skin",
    ]);
  }
  face.push([
    at(
      new SphereGeometry(0.019, 8, 6),
      0,
      HC - 0.056,
      faceZ(0, -0.056) - 0.002,
      -0.35,
      0,
      0,
      0.72,
      1.2,
      0.95,
    ),
    C.skin,
    "skin",
  ]);
  const mouth = [
    onFace(-0.024, -0.097, 0.003),
    onFace(-0.01, -0.103, 0.003),
    onFace(0.01, -0.103, 0.003),
    onFace(0.024, -0.097, 0.003),
  ];
  face.push([strand(mouth, (t) => 0.0016 + 0.0026 * Math.sin(Math.PI * t), 5, 8), C.mouth, "eye"]);
  face.push([
    at(new SphereGeometry(0.168, 20, 6, 0, Math.PI * 2, 0, 1), 0, HC + 0.002, -0.006),
    C.hair,
    "hair",
  ]);
  for (let i = 0; i < 6; i += 1) {
    const x = -0.09 + 0.033 * i;
    const drop = (i % 2) * 0.01;
    const lock = [
      onFace(x, 0.085, 0.004),
      onFace(x + 0.012, 0.078, 0.012),
      onFace(x + 0.026, 0.075 - drop, 0.01),
      onFace(x + 0.034, 0.062 - drop, 0.004),
    ];
    face.push([
      strand(lock, (t) => 0.016 * (1 - t) + 0.003, 6, 8),
      i % 2 === 1 ? C.hairLight : C.hair,
      "hair",
    ]);
  }

  // The hood: one shell open over the face, a rolled rim round the opening, a mantle below.
  const shell = new SphereGeometry(
    HOOD.r,
    28,
    18,
    Math.PI / 2 + HOOD.window,
    Math.PI * 2 - 2 * HOOD.window,
    0,
    HOOD.hem,
  );
  // The rim runs up one side of the opening, round the arch and down the other: dense at the arch.
  const edge = [
    ...Array.from({ length: 8 }, (_, i) => HOOD.hem - ((HOOD.hem - HOOD.brim) * i) / 8),
    ...Array.from({ length: 7 }, (_, i) => ARCH + (HOOD.brim - ARCH) * ((6 - i) / 6) ** 2),
  ];
  const rim: Point[] = [
    ...edge.map((theta) => hoodPoint(Math.PI / 2 + opening(theta), theta)),
    ...[...edge]
      .reverse()
      .slice(1)
      .map((theta) => hoodPoint(Math.PI / 2 - opening(theta), theta)),
  ];
  face.push(
    [
      at(
        shape(shell, (v) => {
          narrow(v);
          drape(v);
        }),
        0,
        HOOD.y,
        HOOD.z,
      ),
      C.cap,
      "hood",
    ],
    // A lighter lining rolled over the edge, so the opening reads from any side.
    [strand(rim, () => 0.009, 6, 48), C.capLining, "cloth"],
  );
  bake(head, face);

  // Side locks and the hood's tip hang on their own joints: springs move them.
  const locks = [-1, 1].map((s) => {
    const lock = joint(head, s * 0.105, HC + 0.03, 0.11);
    const hang = (dx: number, dz: number, length: number): Part => [
      strand(
        [
          [dx, 0.012, dz],
          [dx + s * 0.014, -0.05, dz + 0.004],
          [dx + s * 0.016, -length * 0.7, dz + 0.006],
          [dx + s * 0.006, -length, dz],
        ],
        (t) => 0.024 * (1 - t) + 0.004,
        6,
        8,
      ),
      dz < 0 ? C.hairLight : C.hair,
      "hair",
    ];
    bake(lock, [hang(0, 0, 0.17), hang(s * 0.008, -0.03, 0.14)]);
    return lock;
  });
  // The tip gathers at the back of the head: a short tapering tail of the hood's cloth falling down
  // her back, a little to one side, half sunk in the hood where it starts.
  const tipRadius = (t: number): number =>
    0.042 * Math.sin((Math.PI / 2) * Math.min(1, t / 0.3)) * (1 - t) ** 1.3 + 0.006;
  const tipAt = (t: number): Vector3 => {
    const [x, y, z] = hoodPoint((Math.PI * 3) / 2 + 0.25 * t, 1.45 + 1.25 * t);
    const out = 1 + (Math.min(1, 0.5 + t) * tipRadius(t)) / HOOD.r;
    return new Vector3(x * out, (y - HOOD.y) * out + HOOD.y, (z - HOOD.z) * out + HOOD.z);
  };
  const tipRoot = tipAt(0);
  const hoodTip = joint(head, tipRoot.x, tipRoot.y, tipRoot.z);
  bake(hoodTip, [
    [
      strand(
        [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => tipAt(t).sub(tipRoot).toArray()),
        tipRadius,
        8,
        16,
      ),
      C.cap,
      "drape",
    ],
  ]);

  // The mantle over her shoulders, open at the front over the V collar, clasped with a cord.
  const gap = 0.55;
  // The hem is dagged: it hangs in soft points.
  const wave = (phi: number, y: number): number =>
    -0.03 * MathUtils.clamp((0.44 - y) / 0.05, 0, 1) * Math.max(0, Math.sin(8 * phi)) ** 2;
  const mantle = shape(lathe(MANTLE, 40, 0.8, gap, Math.PI * 2 - 2 * gap), (v) => {
    v.y += wave(Math.atan2(v.x, v.z / 0.8), v.y);
  });
  const around = (phi: number, [r, y]: readonly [number, number]): Point => [
    r * Math.sin(phi),
    y + wave(phi, y),
    0.8 * r * Math.cos(phi),
  ];
  const hem: Point[] = [];
  for (let i = 0; i <= 48; i += 1)
    hem.push(around(gap + ((Math.PI * 2 - 2 * gap) * i) / 48, [0.264, 0.39]));
  const clasp = (s: number): Point => around(s * gap, [0.188, 0.515]);
  bake(body, [
    [mantle, C.cap, "drape"],
    [strand(hem, () => 0.01, 5, 64), C.capDark, "cloth"],
    ...[-1, 1].map(
      (s) =>
        [
          strand(
            MANTLE.map((p) => around(s * gap, p)),
            () => 0.009,
            6,
            8,
          ),
          C.capDark,
          "cloth",
        ] as const,
    ),
    ...[-1, 1].map(
      (s) => [at(new SphereGeometry(0.014, 8, 6), ...clasp(s)), C.brass, "metal"] as const,
    ),
    [
      strand([clasp(-1), [0, 0.49, chestZ(0, 0.49) + 0.012], clasp(1)], () => 0.0045, 5, 10),
      C.brass,
      "metal",
    ],
  ]);

  // Back gear. The scabbard runs from her right shoulder to her left hip under the shield, with
  // the sheathed hilt over her shoulder; the shield sits on the scabbard.
  const scabbard = joint(body, 0, 0.2, -0.17);
  scabbard.rotation.z = 0.55;
  bake(scabbard, [
    [
      lathe(
        [
          [0, -0.33],
          [0.026, -0.315],
          [0.036, -0.24],
          [0.04, 0.3],
          [0.042, 0.37],
          [0, 0.371],
        ],
        10,
        0.45,
      ),
      C.leather,
      "leather",
    ],
    [
      lathe(
        [
          [0.046, 0.33],
          [0.046, 0.385],
        ],
        10,
        0.5,
      ),
      C.brass,
      "metal",
    ],
    [
      lathe(
        [
          [0, -0.345],
          [0.03, -0.32],
          [0.04, -0.26],
        ],
        10,
        0.5,
      ),
      C.brass,
      "metal",
    ],
  ]);
  const sheathed = createBlade();
  sheathed.rotation.z = Math.PI;
  sheathed.position.y = 0.48;
  scabbard.add(sheathed);
  const backShield = createShield();
  backShield.position.set(0.02, 0.2, -0.24);
  backShield.scale.setScalar(0.85);
  backShield.rotation.y = Math.PI;
  body.add(backShield);

  // Arms: a puffed russet sleeve with an ochre band, a cream undersleeve at the elbow, a cuffed
  // leather glove and a gloved fist. Legs: dark trousers into boots with a folded cuff and a sole.
  const arms = { left: new Group(), right: new Group() };
  const fores = { left: new Group(), right: new Group() };
  const legs = { left: new Group(), right: new Group() };
  const shins = { left: new Group(), right: new Group() };
  for (const [name, side] of [
    ["left", 1],
    ["right", -1],
  ] as const) {
    const arm = arms[name];
    arm.position.set(0.2 * side, 0.43, 0);
    body.add(arm);
    bake(arm, [
      [new SphereGeometry(0.068, 12, 8), C.tunic, "cloth"],
      [
        lathe(
          [
            [0.05, -0.275],
            [0.056, -0.245],
            [0.073, -0.13],
            [0.085, -0.06],
            [0.078, 0],
          ],
          14,
        ),
        C.tunic,
        "cloth",
      ],
      [
        lathe(
          [
            [0.06, -0.275],
            [0.063, -0.25],
          ],
          14,
        ),
        C.tunicTrim,
        "cloth",
      ],
    ]);
    const fore = fores[name];
    fore.position.y = -0.24;
    arm.add(fore);
    bake(fore, [
      [new SphereGeometry(0.05, 10, 8), C.tunic, "cloth"],
      [
        lathe(
          [
            [0.038, -0.215],
            [0.04, -0.19],
            [0.046, -0.15],
            [0.062, -0.13],
            [0.064, -0.105],
            [0.05, -0.09],
            [0.045, -0.08],
            [0.049, -0.03],
          ],
          14,
        ),
        (p) => (p.y > -0.086 ? C.tunic : p.y > -0.135 ? C.bootCuff : C.gloves),
        "leather",
      ],
      [
        at(new SphereGeometry(0.052, 10, 8), 0, -0.248, 0.004, 0, 0, 0, 0.8, 1.05, 0.68),
        C.gloves,
        "leather",
      ],
      ...[-0.021, -0.007, 0.007, 0.021].map(
        (z, k) =>
          [
            strand(
              [
                [side * 0.004, -0.262, z + 0.004],
                [-side * 0.014, -0.29 + Math.abs(k - 1.5) * 0.004, z + 0.002],
                [-side * 0.03, -0.272, z],
              ],
              (t) => 0.0125 - 0.003 * t,
              5,
              5,
            ),
            C.gloves,
            "leather",
          ] as const,
      ),
      [
        strand(
          [
            [-side * 0.008, -0.228, 0.026],
            [-side * 0.022, -0.252, 0.04],
            [-side * 0.03, -0.268, 0.03],
          ],
          (t) => 0.0145 - 0.004 * t,
          5,
          5,
        ),
        C.gloves,
        "leather",
      ],
    ]);
    const leg = legs[name];
    leg.position.set(0.085 * side, -0.04, 0);
    body.add(leg);
    bake(leg, [
      [
        lathe(
          [
            [0.058, -0.3],
            [0.066, -0.24],
            [0.076, -0.09],
            [0.078, 0.02],
          ],
          14,
        ),
        C.trousers,
        "cloth",
      ],
      [at(new SphereGeometry(0.058, 10, 8), 0, -0.3, 0), C.trousers, "cloth"],
    ]);
    const shin = shins[name];
    shin.position.y = -0.3;
    leg.add(shin);
    bake(shin, [
      [
        lathe(
          [
            [0.05, -0.265],
            [0.062, -0.245],
            [0.047, -0.205],
            [0.058, -0.17],
            [0.075, -0.115],
            [0.07, -0.075],
            [0.09, -0.06],
            [0.092, -0.01],
            [0.06, 0.0],
          ],
          16,
        ),
        (p) => (p.y > -0.066 ? C.bootCuff : C.leather),
        "leather",
      ],
      [
        at(new SphereGeometry(0.062, 12, 8), 0, -0.265, 0.045, -0.12, 0, 0, 0.95, 0.72, 1.75),
        C.leather,
        "leather",
      ],
      [
        at(new CylinderGeometry(0.064, 0.064, 0.022, 16), 0, -0.309, 0.045, 0, 0, 0, 1, 1, 1.8),
        C.sole,
        "leather",
      ],
    ]);
  }

  // The right hand is a bone: `Hero.ts` attaches the blade to it once Wren has one.
  const hand = new Bone();
  hand.name = "RightHand";
  hand.position.set(0, -0.265, 0.02);
  hand.rotation.x = Math.PI / 2;
  fores.right.add(hand);

  // The shield on the left forearm, face out, while drawn; a block turns it to face forward.
  const armShield = createShield();
  fores.left.add(armShield);
  const flashMaterial = new MeshBasicMaterial({
    blending: AdditiveBlending,
    color: C.flash,
    depthWrite: false,
    opacity: 0,
    side: DoubleSide,
    transparent: true,
  });
  const flash = new Mesh(new CircleGeometry(0.34, 24), flashMaterial);
  flash.position.z = 0.04;
  flash.renderOrder = 3;
  armShield.add(flash);

  // The slash arc: a 120° fan in front of her at blade height, revealed right to left as the cut
  // sweeps, then faded. Its index order follows the angle, so the draw range is the reveal.
  const ARC_SEGMENTS = 24;
  const arcMaterial = new MeshBasicMaterial({
    blending: AdditiveBlending,
    color: C.slash,
    depthWrite: false,
    opacity: 0,
    side: DoubleSide,
    transparent: true,
  });
  const arc = new Mesh(
    new RingGeometry(0.5, 1.5, ARC_SEGMENTS, 1, -Math.PI / 2 - 1.05, 2.1),
    arcMaterial,
  );
  arc.rotation.x = -Math.PI / 2 - 0.35;
  arc.position.y = HIP + 0.3;
  arc.renderOrder = 3;
  arc.visible = false;
  root.add(arc);

  // A blob under the feet keeps her planted on bright grass where the shadow map's own is faint.
  const blob = new Mesh(new CircleGeometry(0.36, 18), flat(0x0b1408, 0.32));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.015;
  blob.renderOrder = 2;
  root.add(blob);

  // Springs: an angle that chases a target and overshoots a little, so cloth and hair lag.
  const springs = { tip: [0, 0], tipSide: [0, 0], locks: [0, 0], pouch: [0, 0], lamp: [0, 0] };
  const chase = (s: number[], target: number, dt: number, stiffness = 80, damping = 9): number => {
    const angle = s[0] ?? 0;
    const speed = (s[1] ?? 0) + ((target - angle) * stiffness - (s[1] ?? 0) * damping) * dt;
    s[0] = angle + speed * dt;
    s[1] = speed;
    return s[0];
  };

  let time = 0;
  let guard = 0;
  let lastY = HIP;
  return {
    group: root,
    update({ dt, drawn, flash: flashing, progress, speed, state, sword }: IHeroPose): void {
      time += dt;
      const run = Math.min(1, speed / 3);
      const cycle = time * (5 + run * 6);
      const swing = Math.sin(cycle) * 0.9 * run;
      const breath = Math.sin(time * 2.4) * (1 - run);
      guard += ((state === "block" ? 1 : 0) - guard) * Math.min(1, dt * 18);

      // Gear: the blade in hand and the shield on the arm only while drawn or blocking.
      const armed = drawn || state === "block";
      scabbard.visible = sword;
      baldric.visible = sword;
      sheathed.visible = sword && !drawn;
      armShield.visible = armed;
      backShield.visible = !armed;

      body.scale.setScalar(1);
      body.position.set(0, HIP + Math.abs(Math.sin(cycle)) * 0.05 * run + breath * 0.006, 0);
      body.rotation.set(run * 0.14, 0, 0);
      chest.scale.set(1 + breath * 0.01, 1 + breath * 0.008, 1 + breath * 0.012);
      skirt.rotation.set(-swing * 0.08 - run * 0.1, 0, swing * 0.05);
      skirt.scale.setScalar(1);
      legs.left.rotation.set(swing, 0, 0);
      legs.right.rotation.set(-swing, 0, 0);
      // A knee folds as its foot leaves the ground behind her; an elbow bends more at a run.
      shins.left.rotation.set(0.08 + run * (0.15 + 1.1 * Math.max(0, Math.sin(cycle - 0.3))), 0, 0);
      shins.right.rotation.set(
        0.08 + run * (0.15 + 1.1 * Math.max(0, -Math.sin(cycle - 0.3))),
        0,
        0,
      );
      arms.left.rotation.set(-swing * 0.85 + 0.25 * run, 0, 0.1 + breath * 0.02);
      arms.right.rotation.set(
        swing * 0.85 + 0.25 * run - (drawn ? 0.3 : 0),
        0,
        -0.1 - breath * 0.02,
      );
      fores.left.rotation.set(-0.3 - 0.45 * run, 0, 0);
      fores.right.rotation.set(-0.3 - 0.45 * run - (drawn ? 0.3 : 0), 0, 0);
      head.rotation.set(-run * 0.1, Math.sin(time * 0.9) * 0.08 * (1 - run), 0);
      armShield.position.set(0.055, -0.12, 0);
      armShield.rotation.set(0, Math.PI / 2, 0);
      flashMaterial.opacity = flashing * 0.85;
      flash.scale.setScalar(1 + (1 - flashing) * 0.6);
      arc.visible = false;

      if (state === "slash") {
        // Windup cocks the blade over the right shoulder; the cut sweeps across to the left.
        const cut = progress < 0.33 ? progress / 0.33 : 1;
        const recover = progress > 0.58 ? (progress - 0.58) / 0.42 : 0;
        arms.right.rotation.set(
          -2.2 + cut * 1.1 + recover * 1.1,
          0,
          -0.9 + cut * 2.1 - recover * 1.2,
        );
        fores.right.rotation.set(-0.2, 0, 0);
        body.rotation.y = 0.5 - cut * 1.1 + recover * 0.6;
        arms.left.rotation.set(-0.6, 0, 0.5);
        const reveal = MathUtils.clamp((progress - 0.3) / 0.22, 0, 1);
        const fade = 1 - MathUtils.clamp((progress - 0.58) / 0.2, 0, 1);
        arc.visible = drawn && reveal > 0 && fade > 0;
        arc.geometry.setDrawRange(0, Math.ceil(reveal * ARC_SEGMENTS) * 6);
        arcMaterial.opacity = 0.9 * fade;
      } else if (state === "block" || guard > 0.01) {
        // The shield comes up across her chest, face forward; she braces lower.
        arms.left.rotation.set(-1.45 * guard, 0, MathUtils.lerp(0.1, -0.3, guard));
        fores.left.rotation.set(MathUtils.lerp(-0.3, 0, guard), 0, 0);
        armShield.position.set(
          MathUtils.lerp(0.055, 0, guard),
          MathUtils.lerp(-0.12, -0.14, guard),
          0,
        );
        armShield.rotation.set((Math.PI / 2) * guard, (Math.PI / 2) * (1 - guard), 0);
        body.position.y -= 0.06 * guard;
        body.rotation.x += 0.14 * guard;
      }
      if (state === "push") {
        // Both palms on the block's face: the body leans in from a step back, so her feet stay
        // out of the block while the stride stays short and behind her.
        const step = Math.sin(cycle) * 0.3 * run;
        body.position.z = -0.12;
        body.rotation.x = 0.3;
        arms.left.rotation.set(-1.25, 0, -0.2);
        arms.right.rotation.set(-1.25, 0, 0.2);
        fores.left.rotation.set(-0.3, 0, 0);
        fores.right.rotation.set(-0.3, 0, 0);
        legs.left.rotation.set(-0.35 + step, 0, 0);
        legs.right.rotation.set(-0.35 - step, 0, 0);
        shins.left.rotation.set(0.3, 0, 0);
        shins.right.rotation.set(0.3, 0, 0);
      } else if (state === "roll") {
        // A tucked somersault: knees to chest, head down, the ball turning about its own middle
        // (0.3 m above the hip, before the squash), which stays high enough that the hood never dips under the floor.
        const tuck = Math.sin(progress * Math.PI);
        const turn = progress * Math.PI * 2;
        // The spine squashes, cartoon-style, so she reads as a ball rather than a turning plank.
        const scale = 1 - 0.45 * tuck;
        const middle = MathUtils.lerp(HIP + 0.3, 0.42, tuck);
        body.rotation.x = turn;
        body.scale.set(1 - 0.15 * tuck, scale, 1 - 0.15 * tuck);
        body.position.set(0, middle - 0.3 * scale * Math.cos(turn), -0.3 * scale * Math.sin(turn));
        head.rotation.x = 0.7 * tuck;
        skirt.scale.set(1 - 0.45 * tuck, 1 - 0.5 * tuck, 1 - 0.45 * tuck);
        legs.left.rotation.x = -2.1 * tuck;
        legs.right.rotation.x = -2.1 * tuck;
        shins.left.rotation.x = 2.3 * tuck;
        shins.right.rotation.x = 2.3 * tuck;
        arms.left.rotation.set(-0.5 * tuck, 0, 0.35);
        arms.right.rotation.set(-0.5 * tuck, 0, -0.35);
        fores.left.rotation.x = -2.2 * tuck;
        fores.right.rotation.x = -2.2 * tuck;
      } else if (state === "hop") {
        legs.left.rotation.x = -0.5;
        legs.right.rotation.x = 0.4;
        shins.left.rotation.x = 0.6;
        shins.right.rotation.x = 0.3;
        arms.left.rotation.z = 0.6;
        arms.right.rotation.z = -0.6;
      } else if (state === "hurt") {
        body.rotation.x = -0.35 * (1 - progress);
        arms.left.rotation.z = 0.5;
        arms.right.rotation.z = -0.5;
      } else if (state === "dead") {
        body.rotation.x = MathUtils.lerp(0, -1.45, Math.min(1, progress * 2));
        body.position.y = MathUtils.lerp(HIP, 0.3, Math.min(1, progress * 2));
      }

      // Secondary motion. Each hanging part chases where her motion would throw it: back with
      // speed, up as she drops, side to side with the stride, a slow sway at rest.
      const step = Math.min(dt, 1 / 30);
      const lift = MathUtils.clamp((body.position.y - lastY) / Math.max(dt, 1e-3), -3, 3);
      lastY = body.position.y;
      const idle = Math.sin(time * 1.7) * (1 - run);
      const thighs = [legs.left.rotation.x, legs.right.rotation.x];
      panels[0]?.rotation.set(Math.max(-0.6, Math.min(0, ...thighs) * 0.7), 0, 0);
      panels[1]?.rotation.set(Math.max(0, ...thighs) * 0.7, 0, 0);
      hoodTip.rotation.set(
        chase(springs.tip, run * 0.12 - lift * 0.3 + idle * 0.04, step),
        0,
        chase(springs.tipSide, Math.sin(cycle) * 0.1 * run + Math.sin(time * 1.1) * 0.04, step),
      );
      const sway = chase(springs.locks, run * 0.35 - lift * 0.18 + idle * 0.04, step, 110, 10);
      for (const [i, lock] of locks.entries())
        lock.rotation.set(sway, 0, (i === 0 ? -1 : 1) * (0.04 + 0.05 * run));
      pouch.rotation.x = chase(
        springs.pouch,
        run * 0.4 - lift * 0.2 + Math.sin(cycle) * 0.2 * run + idle * 0.05,
        step,
        60,
        7,
      );
      lamp.rotation.x = chase(
        springs.lamp,
        run * 0.45 - lift * 0.25 - Math.sin(cycle) * 0.25 * run + idle * 0.06,
        step,
        50,
        6,
      );
    },
  };
}
