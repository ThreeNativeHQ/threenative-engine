// Generated for you: ordinary Three.js. ThreeNative does not read this file, and the look of the
// race is decided here and in `palette.ts` — nowhere in a package.
//
// The car is a **lofted hull**, not a stack of boxes. A box chassis with four cylinders is what
// this file used to hold, and the first frame read as a brick with wheels: no wedge, no shoulder,
// no arches, so nothing in the silhouette said "car" except the colour. `loftHull` stitches a
// series of cross-sections along the car's length instead, which is how a real body is drawn, and
// it costs about the same number of lines.
//
// Every colour, roughness and metalness arrives as an argument. Re-livery the car by editing
// `materials.ts`; change its shape by moving the numbers in `CAR_STATIONS`. Neither needs the
// other.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  type Material,
  MathUtils,
  Mesh,
  Vector2,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

type Materials = ReturnType<typeof import("./materials.js").createMaterials>;

/**
 * One cross-section of a lofted body.
 *
 * `topScale` is what makes a car look like a car: below 1 the section narrows towards its roof, so
 * the shoulder above the wheels stays the widest part of the body and the greenhouse sits inboard
 * of it. At 1 the section is a rounded slab and the read is a bus.
 */
interface IHullStation {
  readonly bottom: number;
  readonly halfWidth: number;
  readonly top: number;
  readonly topScale: number;
  readonly x: number;
}

const RING_SEGMENTS = 20;
/** Superellipse exponent. 2 is an ellipse, large is a box; 3.4 keeps a crisp shoulder crease. */
const RING_SHARPNESS = 3.4;

function ringPoint(station: IHullStation, index: number): [number, number, number] {
  const theta = (index / RING_SEGMENTS) * Math.PI * 2;
  const cz = Math.cos(theta);
  const cy = Math.sin(theta);
  const exponent = 2 / RING_SHARPNESS;
  const sz = Math.sign(cz) * Math.abs(cz) ** exponent;
  const sy = Math.sign(cy) * Math.abs(cy) ** exponent;
  const halfHeight = (station.top - station.bottom) / 2;
  const centre = (station.top + station.bottom) / 2;
  // Lerp the half-width from full at the sill to `topScale` at the roof.
  const width = station.halfWidth * (1 + (station.topScale - 1) * ((sy + 1) / 2));
  return [station.x, centre + halfHeight * sy, width * sz];
}

/**
 * Stitch cross-sections into a closed hull with capped ends.
 *
 * Winding is chosen so the outward normal points away from the length axis; `computeVertexNormals`
 * then gives the smooth shading a hand-built box stack cannot.
 */
function loftHull(input: readonly IHullStation[]): BufferGeometry {
  if (input.length < 2) throw new Error("loftHull needs at least two stations.");
  // Sorted, not taken as given. The winding that makes a face point outwards depends on the sign
  // of the step in x, so a station list authored nose-first builds the whole hull inside-out —
  // backface culling then hides the body and shows its interior, and every part mounted on it
  // appears to float in a hollow shell. Sorting here means the profile below can be read in
  // whichever direction is clearer.
  const stations = [...input].sort((a, b) => a.x - b.x);
  const positions: number[] = [];
  const push = (point: readonly [number, number, number]): void => {
    positions.push(point[0], point[1], point[2]);
  };
  for (let s = 0; s < stations.length - 1; s += 1) {
    const near = stations[s];
    const far = stations[s + 1];
    if (near === undefined || far === undefined) continue;
    for (let i = 0; i < RING_SEGMENTS; i += 1) {
      const next = (i + 1) % RING_SEGMENTS;
      const a = ringPoint(near, i);
      const b = ringPoint(far, i);
      const c = ringPoint(far, next);
      const d = ringPoint(near, next);
      push(a);
      push(b);
      push(c);
      push(a);
      push(c);
      push(d);
    }
  }
  const cap = (station: IHullStation, outwards: boolean): void => {
    const centre: [number, number, number] = [station.x, (station.top + station.bottom) / 2, 0];
    for (let i = 0; i < RING_SEGMENTS; i += 1) {
      const next = (i + 1) % RING_SEGMENTS;
      push(centre);
      push(ringPoint(station, outwards ? i : next));
      push(ringPoint(station, outwards ? next : i));
    }
  };
  const first = stations[0];
  const last = stations[stations.length - 1];
  if (first !== undefined) cap(first, false);
  if (last !== undefined) cap(last, true);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The car's profile, nose (+X) to tail (-X), in metres.
 *
 * Read down the `top` column and you can see the wedge; read down `halfWidth` and you can see the
 * hourglass — narrow over the front axle, waisted at the doors, widest over the rear arches.
 */
const CAR_STATIONS: readonly IHullStation[] = [
  { bottom: 0.2, halfWidth: 0.36, top: 0.44, topScale: 0.82, x: 2.02 },
  { bottom: 0.15, halfWidth: 0.66, top: 0.5, topScale: 0.8, x: 1.72 },
  { bottom: 0.13, halfWidth: 0.81, top: 0.56, topScale: 0.78, x: 1.16 },
  { bottom: 0.13, halfWidth: 0.78, top: 0.6, topScale: 0.8, x: 0.46 },
  { bottom: 0.14, halfWidth: 0.72, top: 0.62, topScale: 0.84, x: -0.2 },
  { bottom: 0.14, halfWidth: 0.79, top: 0.64, topScale: 0.82, x: -0.92 },
  { bottom: 0.16, halfWidth: 0.86, top: 0.66, topScale: 0.82, x: -1.5 },
  { bottom: 0.22, halfWidth: 0.7, top: 0.58, topScale: 0.86, x: -1.9 },
  { bottom: 0.3, halfWidth: 0.4, top: 0.5, topScale: 0.9, x: -2.06 },
];

/**
 * The cabin shell, inboard of the body so the shoulder reads as a separate surface.
 *
 * It stops at x = -1.05. Run back to the tail it covered the rear deck as well, and since glass is
 * a very dark material the chase camera then saw a black car with red slivers at the edges: the
 * body was rendering perfectly and almost none of it was in view. Behind the cabin the fastback is
 * **bodywork**, which is both how the class is built and what puts the livery colour where the
 * player is looking.
 */
const CABIN_STATIONS: readonly IHullStation[] = [
  { bottom: 0.5, halfWidth: 0.4, top: 0.58, topScale: 0.72, x: 0.58 },
  { bottom: 0.52, halfWidth: 0.52, top: 0.86, topScale: 0.66, x: 0.14 },
  { bottom: 0.54, halfWidth: 0.55, top: 0.95, topScale: 0.74, x: -0.4 },
  { bottom: 0.54, halfWidth: 0.52, top: 0.9, topScale: 0.74, x: -0.78 },
  { bottom: 0.52, halfWidth: 0.44, top: 0.74, topScale: 0.7, x: -1.05 },
];

function part(geometry: BufferGeometry, material: Material): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Collects the pieces of one rigid assembly and emits **one mesh per material**.
 *
 * A car authored as forty-two little meshes is forty-two draw calls, and with a rival on track and
 * a shadow pass that alone put the production-performance playtest at seven hundred draws against a
 * budget of a hundred and ninety-five. None of these parts ever moves relative to the body, so
 * there is nothing to lose by baking them: the six materials stay separate and separately
 * editable, and the car costs six draws.
 */
class RigidAssembly {
  readonly #byMaterial = new Map<Material, Mesh[]>();

  add(mesh: Mesh): void {
    const bucket = this.#byMaterial.get(mesh.material as Material);
    if (bucket === undefined) this.#byMaterial.set(mesh.material as Material, [mesh]);
    else bucket.push(mesh);
  }

  /** `castShadow` is taken from the first piece in each bucket, which is how they are authored. */
  attachTo(root: Group): void {
    for (const [material, meshes] of this.#byMaterial) {
      const geometry = mergeGeometries(
        meshes.map((mesh) => {
          mesh.updateMatrix();
          // De-indexed and stripped to position alone. `mergeGeometries` refuses a mix of indexed
          // and non-indexed inputs, and a lofted hull is non-indexed while every Three.js
          // primitive is indexed — the merge failed at the first box and the scene never loaded.
          const placed = mesh.geometry.clone().applyMatrix4(mesh.matrix);
          const cloned = placed.index === null ? placed : placed.toNonIndexed();
          for (const name of Object.keys(cloned.attributes)) {
            if (name !== "position") cloned.deleteAttribute(name);
          }
          return cloned;
        }),
        false,
      );
      if (geometry === null) throw new Error("mergeGeometries returned null for a car part.");
      geometry.computeVertexNormals();
      const merged = new Mesh(geometry, material);
      merged.castShadow = meshes[0]?.castShadow ?? true;
      merged.receiveShadow = true;
      root.add(merged);
    }
  }
}

/**
 * One wheel: a lathed tyre with a rounded shoulder, a dished rim and a five-spoke star.
 *
 * The tyre is lathed rather than a torus because a torus has no flat contact patch and no sidewall,
 * and both of those are what the eye uses to tell a wheel from a doughnut at chase-camera distance.
 */
function wheel(materials: Materials, radius: number): Group {
  const root = new Group();
  const rim = new RigidAssembly();
  const halfWidth = radius * 0.4;
  const rimRadius = radius * 0.66;
  // The profile is **closed**: it starts and ends on the axis, so the lathe produces a solid tyre
  // rather than an open tube whose inside face shows through at the top of every wheel.
  const profile = [
    new Vector2(0.0001, -halfWidth),
    new Vector2(rimRadius, -halfWidth),
    new Vector2(radius * 0.94, -halfWidth * 0.94),
    new Vector2(radius, -halfWidth * 0.5),
    new Vector2(radius, halfWidth * 0.5),
    new Vector2(radius * 0.94, halfWidth * 0.94),
    new Vector2(rimRadius, halfWidth),
    new Vector2(0.0001, halfWidth),
  ];
  const tyre = part(new LatheGeometry(profile, 16), materials.tire);
  tyre.rotation.x = Math.PI / 2;
  rim.add(tyre);

  // One flat alloy face per side, set proud of the sidewall. A cylinder buried inside the tyre is
  // invisible from every angle a player ever sees, which is why the old wheels read as black discs.
  for (const face of [-1, 1]) {
    const disc = part(new CircleGeometry(rimRadius, 20), materials.alloy);
    disc.position.z = face * halfWidth * 1.02;
    disc.rotation.y = face > 0 ? 0 : Math.PI;
    rim.add(disc);
  }
  const hub = part(
    new CylinderGeometry(radius * 0.14, radius * 0.14, halfWidth * 2.3, 8),
    materials.carbon,
  );
  hub.rotation.x = Math.PI / 2;
  rim.add(hub);

  // Radial array: one spoke authored, five placed. Change the count here and the wheel restyles.
  const spokes = 5;
  for (const face of [-1, 1]) {
    for (let index = 0; index < spokes; index += 1) {
      const spoke = part(
        new BoxGeometry(rimRadius * 1.7, radius * 0.13, radius * 0.05),
        materials.hubDark,
      );
      spoke.rotation.z = (index / spokes) * Math.PI * 2 + 0.31;
      spoke.position.z = face * halfWidth * 1.06;
      rim.add(spoke);
    }
  }
  rim.attachTo(root);
  return root;
}

// There is no separate wheel-arch lip. Seven boxes read as a caterpillar track and a torus arc
// read as a chrome grab handle standing outboard of the tyre; both were louder than the car. The
// flare in `CAR_STATIONS` — 0.86 half-width over the rear axle against 0.72 at the doors — is the
// arch, and it costs no geometry at all.

export function vehicle(materials: Materials): Group {
  const root = new Group();
  const shell = new RigidAssembly();

  // blockout + structural pass: the two lofted shells.
  shell.add(part(loftHull(CAR_STATIONS), materials.body));
  const cabin = part(loftHull(CABIN_STATIONS), materials.glass);
  cabin.castShadow = false;
  shell.add(cabin);

  // Front aero: splitter blade proud of the nose, and a recessed dark mouth above it.
  const splitter = part(new BoxGeometry(0.5, 0.05, 1.62), materials.carbon);
  splitter.position.set(2.06, 0.11, 0);
  shell.add(splitter);
  for (const side of [-1, 1]) {
    const endPlate = part(new BoxGeometry(0.34, 0.16, 0.05), materials.carbon);
    endPlate.position.set(2.0, 0.18, side * 0.8);
    shell.add(endPlate);
  }
  const intake = part(new BoxGeometry(0.16, 0.2, 1.06), materials.carbon);
  intake.position.set(1.96, 0.3, 0);
  shell.add(intake);

  // Bonnet crown with a pair of louvre slots, so the flat panel above the front axle has a read.
  const crown = part(new BoxGeometry(0.9, 0.06, 0.6), materials.body);
  crown.position.set(1.2, 0.57, 0);
  shell.add(crown);
  for (const side of [-1, 1]) {
    const louvre = part(new BoxGeometry(0.34, 0.03, 0.12), materials.carbon);
    louvre.position.set(1.1, 0.6, side * 0.2);
    louvre.rotation.z = -0.12;
    shell.add(louvre);
  }

  // Roll hoop and mirrors: small, but they are most of what says "race car" rather than "coupe".
  const hoop = part(new CapsuleGeometry(0.05, 0.5, 4, 8), materials.alloy);
  hoop.rotation.z = Math.PI / 2;
  hoop.position.set(-0.98, 1.06, 0);
  shell.add(hoop);
  for (const side of [-1, 1]) {
    const stalk = part(new CylinderGeometry(0.015, 0.015, 0.12, 6), materials.alloy);
    stalk.rotation.z = Math.PI / 2.4;
    stalk.position.set(0.52, 0.62, side * 0.6);
    shell.add(stalk);
    const pod = part(new BoxGeometry(0.08, 0.07, 0.04), materials.carbon);
    pod.position.set(0.48, 0.66, side * 0.66);
    shell.add(pod);
  }

  // Rear wing on swan-neck stays, with a gurney flap and end plates.
  // The wing sits clear of the deck. Held at 0.98 it overlapped the tail in the chase camera and
  // the whole back of the car merged into one dark mass — the single worst read in the frame,
  // because the chase camera never looks at anything else.
  const wing = part(new BoxGeometry(0.32, 0.05, 1.52), materials.wing);
  wing.position.set(-1.94, 1.06, 0);
  wing.rotation.z = 0.16;
  shell.add(wing);
  const gurney = part(new BoxGeometry(0.05, 0.07, 1.52), materials.wing);
  gurney.position.set(-2.08, 1.1, 0);
  shell.add(gurney);
  for (const side of [-1, 1]) {
    const plate = part(new BoxGeometry(0.4, 0.26, 0.04), materials.wing);
    plate.position.set(-1.94, 1.08, side * 0.78);
    shell.add(plate);
    const stay = part(new BoxGeometry(0.06, 0.5, 0.05), materials.alloy);
    stay.position.set(-1.82, 0.95, side * 0.4);
    shell.add(stay);
  }

  // Diffuser and its strake array.
  const diffuser = part(new BoxGeometry(0.36, 0.14, 1.34), materials.carbon);
  diffuser.position.set(-2.02, 0.17, 0);
  diffuser.rotation.z = -0.34;
  shell.add(diffuser);
  for (let index = 0; index < 3; index += 1) {
    const strake = part(new BoxGeometry(0.32, 0.13, 0.04), materials.alloy);
    strake.position.set(-2.02, 0.16, MathUtils.lerp(-0.44, 0.44, index / 2));
    strake.rotation.z = -0.34;
    shell.add(strake);
  }

  // Livery: a roundel and two stripes as thin coplanar discs and quads. Decals, not textures, so
  // the template ships no image and the colours stay editable in `materials.ts`.
  for (const side of [-1, 1]) {
    const roundel = part(new CircleGeometry(0.19, 20), materials.livery);
    roundel.position.set(-0.3, 0.5, side * 0.83);
    roundel.rotation.y = side > 0 ? 0 : Math.PI;
    roundel.castShadow = false;
    shell.add(roundel);
  }
  for (const offset of [-0.13, 0.13]) {
    // Bonnet only. Run the length of the car the stripe passes straight through the cabin hull and
    // the buried part surfaces through its roof as stray white tabs; carried onto the rear deck it
    // read as road markings painted on the car.
    const bonnet = part(new BoxGeometry(1.5, 0.012, 0.11), materials.livery);
    bonnet.position.set(1.24, 0.598, offset);
    bonnet.castShadow = false;
    shell.add(bonnet);
  }

  // A tail light bar across the full width. The tail is where the wing, the diffuser and the body
  // all meet, and without one bright horizontal the eye finds nothing to hold there — which
  // matters more than any other detail, because the chase camera looks at this face all game.
  // A pale *deck* panel was tried here first and swallowed the whole rear: a light plate that
  // large stops being a highlight and becomes the shape.
  const tailBar = part(new BoxGeometry(0.06, 0.08, 1.06), materials.taillamp);
  tailBar.position.set(-2.02, 0.5, 0);
  tailBar.castShadow = false;
  shell.add(tailBar);

  // Emissive corner strips, so the car still reads when the sun is low or the tier drops post.
  for (const side of [-1, 1] as const) {
    const lamp = part(new BoxGeometry(0.06, 0.1, 0.3), materials.headlamp);
    lamp.position.set(2.0, 0.44, side * 0.5);
    lamp.castShadow = false;
    shell.add(lamp);
  }

  // Running gear. Rear tyres are larger, which is both true of the class and the cheapest way to
  // make the tail read as the driven end. The four groups are **named and kept as direct children
  // of the returned root**, because they are the suspension's only handle on the visual: a car's
  // physics reads their own names to build `VehicleBody3D`'s wheel list (so the physics and the
  // mesh can never disagree about which wheel is the steered one) and writes spin and steer back
  // into them each frame.
  for (const [x, radius] of [
    [1.28, 0.33],
    [-1.42, 0.37],
  ] as const) {
    for (const side of [-1, 1] as const) {
      const group = wheel(materials, radius);
      group.position.set(x, radius, side * 0.72);
      group.scale.z = side;
      group.name = `wheel-${x > 0 ? "front" : "rear"}-${side > 0 ? "left" : "right"}`;
      root.add(group);
    }
  }
  // The shell goes in a group of its own so the **body can lean on its suspension** while the
  // wheels stay planted: rotating the whole root would tilt the contact patches off the road.
  // `body.rotation` is the car's own roll and pitch; nothing else in the scene writes it.
  const body = new Group();
  body.name = "body";
  shell.attachTo(body);
  root.add(body);
  return root;
}

/** The chequered pennant at the finish line: a pole and a triangular pennant, not two boxes. */
export function flag(material: Material): Group {
  const root = new Group();
  const pole = new Mesh(new CylinderGeometry(0.04, 0.05, 2.4, 8), material);
  pole.position.y = 1.2;
  pole.castShadow = true;
  const pennant = new Mesh(new ConeGeometry(0.3, 0.9, 3), material);
  pennant.rotation.z = -Math.PI / 2;
  pennant.rotation.y = Math.PI / 2;
  pennant.position.set(0.45, 2.05, 0);
  pennant.castShadow = true;
  root.add(pole, pennant);
  return root;
}

/**
 * Trackside furniture, authored as **geometry** rather than as groups of meshes.
 *
 * There are sixty-odd trees, twenty-eight hoardings and twenty tyre stacks around this circuit. As
 * `Group`s of meshes that is nineteen hundred draw calls and the performance playtest fails on the
 * spot. Each prop is instead merged into one geometry per material here, and `Track.ts` places
 * every copy into an `InstancedBatch` — the same circuit in a handful of draws.
 *
 * Each function returns the geometry in metres with its base at y = 0, ready to be placed.
 */

/** Bake a mesh's own transform into its geometry so a group can be merged into one buffer. */
function baked(mesh: Mesh): BufferGeometry {
  mesh.updateMatrix();
  return mesh.geometry.clone().applyMatrix4(mesh.matrix);
}

function merged(meshes: readonly Mesh[]): BufferGeometry {
  const geometry = mergeGeometries(meshes.map(baked), false);
  if (geometry === null) throw new Error("mergeGeometries returned null for a trackside prop.");
  geometry.computeVertexNormals();
  return geometry;
}

/** A stack of three tyres: the cheapest piece of trackside furniture that reads instantly. */
export function tyreStackGeometry(height = 3): BufferGeometry {
  // Eight segments and five profile points. Twenty stacks of three at twelve segments each was
  // nine thousand triangles of scenery nobody looks at directly.
  const profile = [
    new Vector2(0.0001, -0.11),
    new Vector2(0.34, -0.11),
    new Vector2(0.38, 0),
    new Vector2(0.34, 0.11),
    new Vector2(0.0001, 0.11),
  ];
  const parts: Mesh[] = [];
  for (let index = 0; index < height; index += 1) {
    const tyre = new Mesh(new LatheGeometry(profile, 8));
    tyre.position.y = 0.11 + index * 0.22;
    tyre.rotation.y = index * 0.7;
    parts.push(tyre);
  }
  return merged(parts);
}

/** A conifer, in two pieces: trunk and canopy, so each takes its own material. */
export function treeGeometry(): { canopy: BufferGeometry; trunk: BufferGeometry } {
  const stem = new Mesh(new CylinderGeometry(0.14, 0.2, 1.6, 6));
  stem.position.y = 0.8;
  const tiers: Mesh[] = [];
  for (let index = 0; index < 3; index += 1) {
    const tier = new Mesh(new ConeGeometry(1.1 - index * 0.26, 1.5 - index * 0.2, 7));
    tier.position.y = 1.5 + index * 0.7;
    tiers.push(tier);
  }
  return { canopy: merged(tiers), trunk: merged([stem]) };
}

/** A grandstand: a raked deck on legs with a canopy, and a crowd placed into its own batch. */
export function grandstand(
  structure: Material,
  seats: Material,
): {
  crowd: readonly [number, number, number][];
  group: Group;
} {
  const root = new Group();
  const rows = 5;
  const decks: Mesh[] = [];
  const crowd: [number, number, number][] = [];
  for (let index = 0; index < rows; index += 1) {
    const deck = new Mesh(new BoxGeometry(11, 0.5, 1.5));
    deck.position.set(0, 0.7 + index * 0.6, -index * 1.35);
    decks.push(deck);
    for (let seat = 0; seat < 9; seat += 1) {
      crowd.push([
        MathUtils.lerp(-4.6, 4.6, seat / 8) + (index % 2 === 0 ? 0.3 : -0.3),
        1.24 + index * 0.6,
        -index * 1.35,
      ]);
    }
  }
  const deckMesh = new Mesh(merged(decks), seats);
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  root.add(deckMesh);

  const frame: Mesh[] = [];
  for (const side of [-1, 1]) {
    const leg = new Mesh(new BoxGeometry(0.4, 3.4, 7));
    leg.position.set(side * 5.2, 1.7, -2.7);
    frame.push(leg);
    const post = new Mesh(new CylinderGeometry(0.12, 0.12, 5.2, 6));
    post.position.set(side * 5.2, 2.6, 0.8);
    frame.push(post);
  }
  const canopy = new Mesh(new BoxGeometry(11.6, 0.22, 8));
  canopy.position.set(0, 5.1, -2.6);
  canopy.rotation.x = -0.1;
  frame.push(canopy);
  const frameMesh = new Mesh(merged(frame), structure);
  frameMesh.castShadow = true;
  root.add(frameMesh);
  return { crowd, group: root };
}
