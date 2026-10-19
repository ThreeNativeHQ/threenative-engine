// Generated for you. Geometry and surface choices for the sailing kit live in this file, and
// ThreeNative does not read it.
//
// The ship is `assets/ship.glb` — Poly Haven's `dutch_ship_medium` (CC0; James Ray Cock, Rico
// Cilliers, Nicolò Zubbini) — cooked to fit the android-decodable budget. This file only wraps it:
// `createShipModel` orients the loaded scene to this game's -Z bow convention and enables its
// shadows. The sail cloth below is unrelated to the model's own geometry and stays: `SHIP_SAILS`
// is simulated canvas driven by `SoftBody3D`, and the source GLB's baked sail mesh is stripped at
// cook time so the two never double up.
import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  type Material,
  MathUtils,
  Mesh,
  type Object3D,
  SphereGeometry,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { ISailingMaterials } from "./materials.js";

/**
 * A sail with a belly in it.
 *
 * A `PlaneGeometry` is the wrong shape for canvas under load and it shows: flat, it catches the
 * key light as one even value and reads as card. Bulging the grid on its own normal gives the
 * gradient across the cloth that says "this is full of wind", and it is one `sin` per axis.
 */
function belliedSail(width: number, height: number, belly: number, taper = 1): BufferGeometry {
  const columns = 8;
  const rows = 6;
  const positions: number[] = [];
  const at = (u: number, v: number): [number, number, number] => {
    // `taper` narrows the head, which is the difference between a square course and a lateen.
    const spread = MathUtils.lerp(1, taper, v);
    return [
      (u - 0.5) * width * spread,
      (v - 0.5) * height,
      Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * belly,
    ];
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const u0 = column / columns;
      const u1 = (column + 1) / columns;
      const v0 = row / rows;
      const v1 = (row + 1) / rows;
      const a = at(u0, v0);
      const b = at(u1, v0);
      const c = at(u1, v1);
      const d = at(u0, v1);
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * One sail, authored flat, ready for `SoftBody3D` to put the wind in it.
 *
 * `belliedSail` bakes the belly into the vertices, which is the right answer for a sail that will
 * never move and the wrong one for a sail that will: a baked curve is the same curve in a flat
 * calm and a gale, and this game already shows the player a wind percentage counting down. Cloth
 * gets the belly from the simulation instead, so the canvas fills as the wind rises and goes slack
 * as it dies — which is the one thing the whole passage turns on and the only part of the ship
 * that ever said it.
 *
 * The grid is flat and a good deal finer than `belliedSail`'s: springs are built from the
 * triangles, so the tessellation *is* the cloth's resolution, and six rows of canvas bends like a
 * garage door.
 */
function sailCloth(
  width: number,
  height: number,
  taper: number,
  belly: number,
): { geometry: BufferGeometry; pinned: number[] } {
  // The cloth's own resolution. Springs are built from the triangles, so this grid is how many
  // springs the canvas has: at ten by eight a course bends in four visible facets and reads as a
  // folded card rather than as a sheet of sailcloth. Fourteen by ten still solves in a fraction of
  // a millisecond and gives the belly eight segments to curve through.
  const columns = 14;
  const rows = 10;
  const positions: number[] = [];
  const pinned: number[] = [];
  const at = (u: number, v: number): [number, number, number] => {
    // `taper` narrows the **foot**, which is the difference between a square course and a lateen.
    //
    // The other way round — the way `belliedSail` reads it, because that sail hangs from its
    // centre — puts the narrow end at the head, and the head is the edge bent to the yard: the
    // mizzen came out as a wedge suspended from a point and widening downwards, which is a lateen
    // upside down.
    const spread = MathUtils.lerp(taper, 1, v);
    // The cut carries a belly, and that is what gives the cloth room to move.
    //
    // Springs hold *distances*, so a sail cut dead flat and bent at its head and both clews can
    // only fill by stretching, and the solver answers a stretch with a restoring force: at any
    // stiffness that keeps the canvas its own size, the wind cannot get into it at all. Cutting
    // the belly in gives the interior slack it can spend — the sail deepens as the wind rises and
    // sags back towards its cut as the wind dies, without a single spring leaving its rest length.
    return [
      (u - 0.5) * width * spread,
      (v - 1) * height,
      Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * belly,
    ];
  };
  const push = (u: number, v: number): void => {
    const index = positions.length / 3;
    positions.push(...at(u, v));
    // The head, bent to the yard, and nothing else.
    //
    // Pinning the clews as well is what a set course actually has, and it was tried both ways.
    // Held at three edges the canvas has nowhere to put the wind but into its own slack, and it
    // gathers: the courses came back as lumps balled against the masts rather than as sails. Hung
    // from the head alone the sail swings, which is a motion the springs never resist, and it
    // reads as a square rig running before the wind — which is the passage this game is.
    if (v === 1) pinned.push(index);
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const u0 = column / columns;
      const u1 = (column + 1) / columns;
      const v0 = row / rows;
      const v1 = (row + 1) / rows;
      push(u0, v0);
      push(u1, v0);
      push(u1, v1);
      push(u0, v0);
      push(u1, v1);
      push(u0, v1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return { geometry, pinned };
}

/**
 * Where each sail hangs in the ship model's own space, and how big it is.
 *
 * The cloth cannot be a child of the hull: `SoftBody3D` detaches itself permanently the moment it
 * is removed from the scene, and `ctx.add` is what attaches it to the renderer — so parenting it
 * to the ship after adding would tear it down on the same frame. It lives at the scene root and
 * `Ship` carries each one to its yard every frame instead. These are the yards.
 *
 * `ship.glb` is authored close to real-world scale (a ~22 m hull), unlike the caravel this
 * replaces (a ~6 m one), so every number here is in the *model's own* raw units, which
 * `Ship#trimSails` carries through `model.matrixWorld` — the same normalisation factor that
 * shrinks the hull to 4.6 m shrinks these to size. `x`/`y`/`z` were found by bucketing the source
 * mesh's own vertices along its length: the mainmast sits at raw x ≈ -1.5 (tallest, top ≈ 22.7),
 * the foremast at raw x ≈ 6.5 (top ≈ 20.2), both well inside the hull, with only a low, thin
 * bowsprit reaching past it at the +x end — so bow is +x there, and the +90° yaw in
 * `createShipModel` turns that into this game's -z bow, which is why a source +x becomes -z here.
 * There is no third mast in the source geometry the same scan could find, so the mizzen below is
 * placed proportionately aft of the mainmast, at the caravel's own mainmast-to-mizzen fraction of
 * the hull's remaining length, and wants the most visual re-checking of the three.
 *
 * `width`/`height`/`belly` are **not** the caravel's own numbers: `ship.glb`'s hull is half the
 * caravel's beam for its length (measured — see `measureHull`), and a sail sized for the wider
 * hull draped past the bow and covered the whole ship. Each is the caravel's final, on-screen size
 * rescaled by this hull's own beam ratio (0.51), then converted back to this model's raw units by
 * the same factor as `x`/`y`/`z`.
 */
export const SHIP_SAILS = [
  // Fore course, bent to the fore yard.
  { belly: 0.82, height: 4.4, pitch: 0, taper: 1, width: 5.75, x: 0, y: 13.7, yaw: 0, z: -6.5 },
  // Main course, bent to the main yard. The deepest cut of the three, because it is the sail the
  // chase camera looks at most and the one whose belly has to read as canvas under load.
  { belly: 1.15, height: 5.6, pitch: 0, taper: 1, width: 7.4, x: 0, y: 15.2, yaw: 0, z: 1.5 },
  // The mizzen lateen: fore-and-aft, so it is turned side-on and raked with its yard. Its wind
  // therefore pushes it to leeward rather than aft, which falls out of the rotation for free —
  // `SoftBody3D` takes wind in the cloth's own local space.
  {
    belly: 0.82,
    height: 5.89,
    pitch: 0.85,
    taper: 0.24,
    width: 4.25,
    x: 0.2,
    y: 12.4,
    yaw: Math.PI / 2,
    z: 6.8,
  },
] as const;

/** The cloth meshes for `SHIP_SAILS`, in the same order. */
export function createSails(materials: ISailingMaterials): {
  mesh: Mesh;
  pinned: number[];
}[] {
  return SHIP_SAILS.map((sail) => {
    const { geometry, pinned } = sailCloth(sail.width, sail.height, sail.taper, sail.belly);
    const mesh = new Mesh(geometry, materials.sail);
    mesh.castShadow = true;
    mesh.name = "sail-cloth";
    return { mesh, pinned };
  });
}

/**
 * Collects rigid pieces and emits one mesh per material.
 *
 * A ship authored as a hundred and thirty little meshes is a hundred and thirty draw calls, and
 * with the shadow pass that put the production-performance playtest at eight hundred against a
 * budget of a hundred and twenty. None of the hull, rig or trim ever moves relative to the ship,
 * so baking them costs nothing: the six materials stay separate and separately editable. Anything
 * a game might want to animate — the sails, the pennant — is added outside this and stays its own
 * transform.
 */
class RigidAssembly {
  readonly #byMaterial = new Map<Material, Mesh[]>();

  add(mesh: Mesh): void {
    const bucket = this.#byMaterial.get(mesh.material as Material);
    if (bucket === undefined) this.#byMaterial.set(mesh.material as Material, [mesh]);
    else bucket.push(mesh);
  }

  attachTo(root: Group): void {
    for (const [material, meshes] of this.#byMaterial) {
      const geometry = mergeGeometries(
        meshes.map((mesh) => {
          mesh.updateMatrix();
          // `mergeGeometries` refuses a mix of indexed and non-indexed inputs, and a lofted hull is
          // non-indexed while every Three.js primitive is indexed.
          const placed = mesh.geometry.clone().applyMatrix4(mesh.matrix);
          const cloned = placed.index === null ? placed : placed.toNonIndexed();
          for (const name of Object.keys(cloned.attributes)) {
            if (name !== "position") cloned.deleteAttribute(name);
          }
          return cloned;
        }),
        false,
      );
      if (geometry === null) throw new Error("mergeGeometries returned null for a ship part.");
      geometry.computeVertexNormals();
      const merged = new Mesh(geometry, material);
      merged.castShadow = meshes[0]?.castShadow ?? true;
      merged.receiveShadow = true;
      root.add(merged);
    }
  }
}

/**
 * The hull and rig, oriented to this game's convention: bow at -Z, y = 0 at the design waterline.
 *
 * The source model is X-forward, with the bowsprit at +X — a bearing check on the raw vertex data
 * found the tallest mast at x ≈ -1.5 (the mainmast) and a second, shorter one at x ≈ 6.5 (the
 * foremast), both well inside the hull's -10.3..13.7 span, with a thin spar reaching past the hull
 * only at the +X end — a bowsprit, and nowhere else. Rotating +90° about Y turns that +X bow into
 * this game's -Z one, exactly the mapping `Ship.forward` already assumes.
 *
 * `y = 0` is the file's own origin, which Poly Haven ships at the design waterline for a model
 * meant to float — `Ship.ts` writes `Buoyancy3D` hull points against this origin unmoved, same as
 * the caravel this replaces.
 *
 * The GLB's own "sails" mesh never reaches this file: it is stripped at cook time (see the file
 * header), because `SHIP_SAILS` below is simulated canvas and a second, static sail baked into the
 * hull would double every course.
 */
export function createShipModel(model: { readonly scene: Object3D }): Group {
  const ship = new Group();
  const hull = model.scene;
  hull.rotation.y = Math.PI / 2;
  hull.traverse((child) => {
    const mesh = child as Partial<Mesh> & { readonly isMesh?: boolean };
    if (mesh.isMesh !== true) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  ship.add(hull);
  return ship;
}

let loadedShipModel: { readonly scene: Object3D } | undefined;

/**
 * Fetch `ship.glb`. Called from `Boot.load()`, alongside `loadSky`, and for exactly the same
 * reason: a scene that awaited its own load would still have no entities registered the instant
 * its `enter()` returns, which is when a playtest runner reads the registry — so every scenario
 * with a component assertion would abort on `runtime.components` before taking a frame. Keeping
 * the fetch in the *start* scene's `load()` is what keeps `Sailing.enter()` synchronous.
 */
export async function loadShipModel(assets: {
  model<T>(path: string): Promise<T>;
}): Promise<void> {
  loadedShipModel = await assets.model<{ scene: Object3D }>("ship.glb");
}

/** The cached `ship.glb`, read synchronously. Must run after `loadShipModel`. */
export function getShipModel(): { readonly scene: Object3D } {
  if (loadedShipModel === undefined) throw new Error("getShipModel must run after loadShipModel.");
  return loadedShipModel;
}

/**
 * A spar buoy: a float, a mast and a flag, standing about three and a half metres out of the sea.
 *
 * It used to stand 1.2 m, which is the height of a real harbour mark and completely wrong for
 * this game. The course now runs a hundred and twenty metres around a headland, and at thirty
 * metres — the gap between two marks — a 1.2 m buoy was four pixels of red against a moving sea
 * and the player had nothing to steer towards. A mark you cannot see is not a mark.
 */
export function createBuoy(materials: ISailingMaterials): Group {
  const buoy = new Group();
  const rigid = new RigidAssembly();
  const body = new Mesh(new CylinderGeometry(0.34, 0.44, 1.1, 12), materials.buoy);
  body.position.y = 0.2;
  body.castShadow = true;
  const band = new Mesh(new CylinderGeometry(0.37, 0.37, 0.22, 12), materials.trim);
  band.position.y = 0.42;
  band.castShadow = true;
  const cap = new Mesh(new SphereGeometry(0.38, 12, 8), materials.buoy);
  cap.position.y = 0.78;
  cap.scale.y = 0.6;
  cap.castShadow = true;
  const pole = new Mesh(new CylinderGeometry(0.05, 0.06, 2.6, 6), materials.spar);
  pole.position.y = 2.05;
  pole.castShadow = true;
  const flag = new Mesh(belliedSail(1.05, 0.62, 0.12, 0.4), materials.trim);
  flag.rotation.y = Math.PI / 2;
  flag.position.set(0, 2.85, 0.44);
  flag.castShadow = true;
  for (const part of [body, band, cap, pole, flag]) rigid.add(part);
  rigid.attachTo(buoy);
  return buoy;
}

/**
 * A headland: a beach that meets the water in a ring, a rock mass and a stand of palms.
 *
 * The island this replaces sat at y = -0.88 with a height of 1.5, so its crown was thirteen
 * centimetres *below* the waterline and the frame contained no land at all. The sea needs
 * something with a horizon behind it or there is no sense of a passage being sailed.
 *
 * The beach is the other half of that sentence. It used to be a 9.5 m sand **disc** lying flat with
 * its top face 40 cm proud of the water — a pale pancake floating beside the island, which is the
 * thing the owner pointed at. What a beach is, and what the frame needs, is a slope: a skirt that
 * starts as a dune under the palms and runs out under the surface, so the line where sand meets
 * water is a *ring* the swell runs over. The radius below is jittered per segment so the ring is a
 * shoreline and not a compass circle.
 */
export function createIsland(materials: ISailingMaterials): Group {
  const island = new Group();
  const rigid = new RigidAssembly();
  // A cone frustum from a 3.4 m dune at 0.6 m above the water out to a 8.6 m shelf 2.2 m below it,
  // so the waterline sits about 5 m out and everything past that is under the sea. The first cut was
  // twice this and read as a sandbank two boat-lengths across rather than as a beach.
  const beach = new Mesh(new CylinderGeometry(3.4, 8.6, 2.8, 30, 1, true), materials.sand);
  const shore = beach.geometry.getAttribute("position") as BufferAttribute;
  // Jitter the rim only: the top ring is under the palms and the bottom ring is underwater, so the
  // ring that shows is the one that moves. A seeded walk, so two captures frame the same island.
  let seed = 7;
  const jitter = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let index = 0; index < shore.count; index += 1) {
    const y = shore.getY(index);
    if (y > 0.9) continue;
    const stretch = 1 + (jitter() - 0.5) * 0.34;
    shore.setX(index, shore.getX(index) * stretch);
    shore.setZ(index, shore.getZ(index) * stretch);
  }
  shore.needsUpdate = true;
  beach.geometry.computeVertexNormals();
  // The dune's own cap, so the top is sand rather than a hole.
  const dune = new Mesh(new CylinderGeometry(3.4, 3.9, 0.9, 30), materials.sand);
  beach.position.y = -0.2;
  beach.scale.z = 0.78;
  beach.receiveShadow = true;
  rigid.add(beach);
  dune.position.y = 1.25;
  dune.scale.z = 0.78;
  dune.receiveShadow = true;
  rigid.add(dune);

  const headland = new Mesh(new SphereGeometry(3.7, 14, 9), materials.island);
  headland.position.set(-1.2, 1.1, -1.1);
  headland.scale.set(1, 0.72, 0.8);
  headland.castShadow = true;
  headland.receiveShadow = true;
  rigid.add(headland);
  const knoll = new Mesh(new SphereGeometry(2.2, 12, 8), materials.island);
  knoll.position.set(2.6, 0.95, 1.1);
  knoll.scale.set(1, 0.58, 0.85);
  knoll.castShadow = true;
  rigid.add(knoll);
  // A darker rock at the water's edge on one side, which is the half of an island the swell has
  // been working on and the reason its silhouette is not a dome.
  const stack = new Mesh(new SphereGeometry(1.3, 9, 7), materials.rock);
  stack.position.set(-4.2, 0.1, 2.2);
  stack.scale.set(1, 1.35, 0.9);
  stack.castShadow = true;
  rigid.add(stack);

  // A stand of palms, placed by a seeded jitter so two captures frame the same headland.
  seed = 41;
  for (let index = 0; index < 9; index += 1) {
    const angle = (index / 9) * Math.PI * 2 + jitter();
    const radius = 0.9 + jitter() * 2.0;
    const height = 1.9 + jitter() * 1.1;
    const trunk = new Mesh(new CylinderGeometry(0.1, 0.17, height, 5), materials.spar);
    trunk.position.set(Math.cos(angle) * radius, 1.55 + height / 2, Math.sin(angle) * radius * 0.7);
    trunk.rotation.z = (jitter() - 0.5) * 0.24;
    trunk.castShadow = true;
    rigid.add(trunk);
    for (let frond = 0; frond < 5; frond += 1) {
      const blade = new Mesh(new ConeGeometry(0.22, 1.4, 4), materials.foliage);
      blade.position.copy(trunk.position);
      blade.position.y += height / 2 + 0.12;
      blade.rotation.z = Math.PI / 2 - 0.5;
      blade.rotation.y = (frond / 5) * Math.PI * 2;
      blade.translateY(0.56);
      blade.castShadow = true;
      rigid.add(blade);
    }
  }

  rigid.attachTo(island);
  island.position.set(-15, 0, -19);
  return island;
}
