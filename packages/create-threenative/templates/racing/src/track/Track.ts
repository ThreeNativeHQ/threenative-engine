import { type ICtx, InstancedBatch } from "@threenative/core";
import { Heightfield } from "@threenative/core/world";
import { Area3D, CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Raycaster,
  Vector3,
} from "three";
import { Boost } from "../kart/boost.js";
import { createMaterials } from "../render/materials.js";
import { grandstand, treeGeometry, tyreStackGeometry } from "../render/shapes.js";
import type { GameState } from "../state.js";
import { Checkline, type ChecklineId } from "./Checkline.js";
import type { IRayHit, IntersectRay } from "./TrackSector.js";
import {
  BARRIER_OFFSET,
  CIRCUIT,
  GRID_SLOTS,
  HALF,
  type ICircuitSample,
  KERB_HEIGHT,
  KERB_WIDTH,
  LINE_AT,
  PLAYER_SLOT,
  ROAD_LIFT,
  RUNOFF,
  TRACK_WIDTH,
  gridSlot,
  groundHeight,
  lineDistance,
  terrainHeight,
} from "./circuit.js";

export type TrackCtx = ICtx<GameState, IPhysicsContext>;

export const TOTAL_LAPS = 3;

/**
 * Godot's `collision_layer` for the circuit, so a car's `collision_mask` can say what it may hit.
 *
 * The kerbs are on the road's layer: a wheel ray that finds one rides over it, which is what a
 * kerb is for, and a car that puts two wheels on the rumble strip gets the same bump a real one
 * does instead of stopping dead against an invisible wall.
 */
export const LAYER = { barrier: 8, car: 1, field: 4, road: 2 } as const;

/** One station of the build: the centreline here, and the surfaces derived from it. */
/** The kerb's inner edge is a ramp this long, not a step. See `buildKerbs`. */
const CHAMFER = 0.35;

/**
 * How much of the local radius the drivable surface may claim, as a fraction.
 *
 * A fixed-width ribbon cannot follow a hairpin: this circuit's tightest corner is 15.5 m of radius
 * and the two legs of the loop pass 25 m apart, so a 22 m-wide ribbon puts its inside edge within
 * 1.5 m of the corner's centre — where it **crosses the other leg's ribbon** at a different height.
 * The result is a 40-degree wall of tarmac in the middle of the hairpin, which is what the demo
 * driver kept driving into. Inside 55% of the radius the ribbon stops and the infield takes over,
 * which is also what the inside of a real hairpin is.
 */
const DRIVABLE_RADIUS_SHARE = 0.55;

function drivableHalf(station: IStation): number {
  const radius = station.sample.radius;
  if (!Number.isFinite(radius)) return HALF + RUNOFF;
  return Math.min(HALF + RUNOFF, Math.max(2.2, radius * DRIVABLE_RADIUS_SHARE));
}

interface IStation {
  readonly distance: number;
  readonly sample: ICircuitSample;
  /** The banking rise, positive raising the outside edge. */
  readonly bank: number;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * A point `offset` metres right of the centreline, on the banked tarmac surface.
 *
 * The height is the **centreline's** ground height tilted by the banking, not the ground height
 * under the point: that is what makes the cross-section a plane pivoting on the crown of the road,
 * which is what `terrainHeight` then cuts and fills the ground to meet.
 */
function onTrack(
  station: IStation,
  offset: number,
  lift = ROAD_LIFT,
  target = new Vector3(),
): Vector3 {
  const { point, right } = station.sample;
  target.set(point.x + right.x * offset, 0, point.z + right.z * offset);
  target.y = point.y - ROAD_LIFT + lift - offset * station.bank;
  return target;
}

/** A point `offset` metres right of the centreline, on the ground rather than on the tarmac. */
function onGround(station: IStation, offset: number, lift = 0, target = new Vector3()): Vector3 {
  const { point, right } = station.sample;
  target.set(point.x + right.x * offset, 0, point.z + right.z * offset);
  target.y = terrainHeight(target.x, target.z) + lift;
  return target;
}

function stationAt(distance: number): IStation {
  const sample = CIRCUIT.at(distance, CIRCUIT.createSample());
  return { bank: sample.bank, distance, sample };
}

/** Every `every`-th station around the lap. */
function stations(every: number): IStation[] {
  const built: IStation[] = [];
  for (let distance = 0; distance < CIRCUIT.totalLength; distance += CIRCUIT.spacing * every) {
    built.push(stationAt(distance));
  }
  return built;
}

/**
 * A quad strip from cross-sections.
 *
 * Every surface on this circuit is a ribbon — the road, the white lines, the run-off, the kerbs,
 * the armco and the pit wall are all "a row of cross-sections, one per station, stitched into
 * quads". One function for all of them is the difference between five hundred draw calls and six.
 *
 * The winding is not negotiable: rows advance along the driving direction and points inside a row
 * advance to the driver's right, which puts the road's normals **up**. A strip wound the other way
 * is invisible from the chase camera and green in every assertion.
 */
function quadStrip(
  rows: readonly (readonly Vector3[])[],
  uv: (row: number, column: number) => [number, number],
): BufferGeometry {
  const width = rows[0]?.length ?? 0;
  if (width < 2) throw new Error("quadStrip needs at least two points per cross-section.");
  const positions = new Float32Array(rows.length * width * 3);
  const uvs = new Float32Array(rows.length * width * 2);
  const indices: number[] = [];
  for (let row = 0; row < rows.length; row += 1) {
    const section = rows[row];
    if (section === undefined || section.length !== width)
      throw new Error("quadStrip cross-sections must all have the same width.");
    for (let column = 0; column < width; column += 1) {
      const point = section[column];
      if (point === undefined) throw new Error("quadStrip cross-section point is missing.");
      positions.set([point.x, point.y, point.z], (row * width + column) * 3);
      const [u, v] = uv(row, column);
      uvs.set([u, v], (row * width + column) * 2);
    }
  }
  for (let row = 0; row + 1 < rows.length; row += 1) {
    for (let column = 0; column + 1 < width; column += 1) {
      const a = row * width + column;
      indices.push(a, a + 1, a + width, a + 1, a + width + 1, a + width);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Closes a ribbon back on itself, so the last station joins the first. */
function looped<T>(rows: readonly T[]): readonly T[] {
  const first = rows[0];
  if (first === undefined) throw new Error("looped needs at least one row.");
  return [...rows, first];
}

/**
 * A fixed trimesh for a surface the car drives on or hits.
 *
 * The geometry is already in world coordinates and the mesh sits at the origin, so the body's
 * translation is zero and the collider is the triangles on screen. One body for the whole road
 * rather than one box per segment: 750 boxes for a smooth ribbon is 750 shapes a wheel ray
 * considers every step.
 */
function fixedTrimesh(
  ctx: TrackCtx,
  mesh: Mesh,
  collisionLayer: number,
  name: string,
): RigidBody3D {
  mesh.name = name;
  return new RigidBody3D({
    collisionLayer,
    collisionMask: LAYER.car,
    object: mesh,
    physics: ctx.physics,
    shape: CollisionShape3D.fromMesh(mesh, "trimesh"),
    type: "fixed",
  });
}

/** The ground is drawn this far below the height the road is laid to. A 5 m grid cannot follow a
 *  banked cross-section exactly, and where it errs high the grass shows through the tarmac in
 *  patches; sinking it 30 cm turns that into a road bed standing proud of the field. */
const TERRAIN_SINK = 0.3;

/**
 * How far the grass collider sits below the drawn grass under the road.
 *
 * The 5 m ground grid can interpolate a few centimetres above the banked ribbon on a tight corner
 * even after {@link TERRAIN_SINK}; a wheel ray that finds it rides the grass and beaches the car.
 * Under the ribbon that disagreement is hidden by the tarmac, so the collider is lowered there and
 * the drawn grass is left alone — outside the corridor the collider is the drawn surface exactly.
 */
const GROUND_CLEARANCE = 0.4;

/** The widest drivable ribbon plus one cell: every collider vertex that can be under the tarmac. */
const GROUND_CORRIDOR = HALF + RUNOFF + 1;

const groundProbe = new Vector3();
const groundProjection = {
  curvature: 0,
  distance: 0,
  lateral: 0,
  point: new Vector3(),
  tangent: new Vector3(),
};

function buildTerrain(ctx: TrackCtx, materials: ReturnType<typeof createMaterials>): void {
  // The ground is a grid over the circuit's bounding box and a long way past it, its height read
  // from the same {@link groundHeight} the road is draped on. That is why nothing here can be
  // airborne over a crest: the tarmac cannot be somewhere the ground is not.
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const station of stations(4)) {
    minX = Math.min(minX, station.sample.point.x);
    maxX = Math.max(maxX, station.sample.point.x);
    minZ = Math.min(minZ, station.sample.point.z);
    maxZ = Math.max(maxZ, station.sample.point.z);
  }
  const margin = 180;
  const step = 5;
  // The column and row counts are computed from the bounds rather than counted inside the loop:
  // counting a running total and then using it as the row stride builds an index buffer for a
  // 63-by-4977 grid, which Rapier rejects as an out-of-range index rather than as a bad shape.
  const minColumn = minX - margin;
  const minRow = minZ - margin;
  const width = Math.floor((maxX + margin - minColumn) / step) + 1;
  const rows = Math.floor((maxZ + margin - minRow) / step) + 1;
  const positions = new Float32Array(rows * width * 3);
  const uvs = new Float32Array(rows * width * 2);
  const heights = new Float32Array(rows * width);
  const indices: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const x = minColumn + column * step;
      const z = minRow + row * step;
      const at = row * width + column;
      const surface = terrainHeight(x, z) - TERRAIN_SINK;
      const lateral = Math.abs(CIRCUIT.project(groundProbe.set(x, 0, z), groundProjection).lateral);
      const height = lateral <= GROUND_CORRIDOR ? surface - GROUND_CLEARANCE : surface;
      positions[at * 3] = x;
      positions[at * 3 + 1] = height;
      positions[at * 3 + 2] = z;
      heights[at] = height;
      uvs[at * 2] = x / 9;
      uvs[at * 2 + 1] = z / 9;
      if (row + 1 < rows && column + 1 < width) {
        indices.push(at, at + width, at + 1, at + 1, at + width, at + width + 1);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // The grass is a surface the wheels can stand on, not just a picture: a car that gets past the
  // armco (a jump, or the rail's old floating collider) lands on it instead of falling to the
  // rescue. One heightfield shares the drawn grid's samples, so the collider is the visible grass
  // outside the ribbon and a clearance below it under the tarmac, where the 5 m grid could
  // otherwise interpolate above the banked road and beach the car. The field layer is deliberate:
  // wheel rays scan it, and `TrackSector`'s road probe does not, so grass is not mistaken for road.
  const ground = new Mesh(geometry, materials.grass);
  ground.receiveShadow = true;
  ctx.add(ground);
  const field = new Heightfield({
    columns: width,
    rows,
    width: (width - 1) * step,
    depth: (rows - 1) * step,
    origin: {
      x: minColumn + ((width - 1) * step) / 2,
      z: minRow + ((rows - 1) * step) / 2,
    },
    heights,
  });
  new RigidBody3D({
    collisionLayer: LAYER.field,
    collisionMask: LAYER.car,
    physics: ctx.physics,
    position: { x: field.origin.x, y: 0, z: field.origin.z },
    shape: CollisionShape3D.heightfield(field.rows, field.columns, field.toColliderHeights(), {
      x: field.width,
      y: 1,
      z: field.depth,
    }),
    type: "fixed",
  });
}

function buildRoad(
  ctx: TrackCtx,
  materials: ReturnType<typeof createMaterials>,
): readonly IStation[] {
  const all = stations(1);
  // `u` spans the road once, `v` runs 8 m per tile: the asphalt texture carries the racing-line
  // rubber across the width, so the u axis must not repeat.
  const tarmacUV = (row: number, column: number): [number, number] => [
    column,
    (all[row]?.distance ?? 0) / 8,
  ];
  // The drivable surface, and the one body the wheels touch. It runs the full width of the road
  // **and** its run-off as a single ribbon, because two coplanar trimeshes meeting at the white line
  // leave a seam a wheel ray can fall through, and a seam under a car at speed is a bump.
  // It is not drawn: the tarmac and the run-off are drawn on top of it, a few millimetres up.
  const drivable = new Mesh(
    quadStrip(
      looped(
        all.map((station) => {
          const half = drivableHalf(station);
          return [onTrack(station, -half), onTrack(station, half)];
        }),
      ),
      tarmacUV,
    ),
    materials.road,
  );
  drivable.visible = false;
  ctx.add(drivable);
  fixedTrimesh(ctx, drivable, LAYER.road, "road");

  // The tarmac: 9 m of it, drawn on the drivable ribbon.
  const road = new Mesh(
    quadStrip(
      looped(all.map((station) => [onTrack(station, -HALF, 0.004), onTrack(station, HALF, 0.004)])),
      tarmacUV,
    ),
    materials.road,
  );
  road.receiveShadow = false;
  ctx.add(road);

  // The paved run-off past the white line: a different surface, drivable, and lighter. One strip
  // per side and **not under the tarmac**: run underneath it, it sat 2 mm below the road and
  // z-fought it into light and dark bands across the whole width at any distance.
  for (const side of [1, -1] as const) {
    const runoff = new Mesh(
      quadStrip(
        looped(
          all.map((station) => {
            const edge = onTrack(station, side * HALF, 0.002);
            const far = onTrack(station, side * drivableHalf(station), 0.002);
            return side > 0 ? [edge, far] : [far, edge];
          }),
        ),
        (row, column) => [column * RUNOFF, (all[row]?.distance ?? 0) / 8],
      ),
      materials.runoff,
    );
    runoff.receiveShadow = true;
    ctx.add(runoff);
  }

  // White edge lines, laid on the tarmac and a centimetre above it.
  // One strip per side: interleaving the two edges into one strip joins them with a quad across
  // the whole road, which draws as a white transverse bar at every station.
  for (const [from, to] of [
    [-HALF, -HALF + 0.4],
    [HALF - 0.4, HALF],
  ] as const) {
    const edge = new Mesh(
      quadStrip(
        looped(
          all.map((station) => [
            onTrack(station, from, ROAD_LIFT + 0.012),
            onTrack(station, to, ROAD_LIFT + 0.012),
          ]),
        ),
        (row, column) => [column, row * 1.1],
      ),
      materials.line,
    );
    ctx.add(edge);
  }
  return all;
}

/** Where a kerb stands: the inside of every corner, and the outside of the tight ones. */
function kerbSides(station: IStation): { left: number; right: number } {
  const curvature = station.sample.curvature;
  const inside = Math.abs(curvature) > 1 / 150;
  const outside = Math.abs(curvature) > 1 / 42;
  return {
    left: curvature < 0 ? (inside ? 1 : 0) : outside ? 1 : 0,
    right: curvature > 0 ? (inside ? 1 : 0) : outside ? 1 : 0,
  };
}

function buildKerbs(
  ctx: TrackCtx,
  all: readonly IStation[],
  materials: ReturnType<typeof createMaterials>,
): void {
  // Every second station: a 15 m hairpin still turns within 3 cm of its design radius at 2.2 m.
  const coarse = all.filter((_station, index) => index % 2 === 0);
  let runs = 0;
  for (const side of [1, -1] as const) {
    // **Only real kerb becomes geometry.** A station with no kerb would contribute a cross-section
    // of zero width, and the quads between two of those are zero-area triangles — which a Rapier
    // trimesh happily accepts and a wheel ray then reports a meaningless normal for. The car ends
    // up pitched onto its nose with the strut at maximum compression, and no throttle moves it.
    // Measured: the demo driver beached on a straight, in the middle of the road, twice.
    //
    // So the stations are grouped into **runs** and each run is its own strip, its own mesh and its
    // own collider. A circuit has a handful of kerbed corners, so a handful of draws.
    let run: Vector3[][] = [];
    const flush = (): void => {
      if (run.length < 2) {
        run = [];
        return;
      }
      runs += 1;
      const kerbs = new Mesh(
        quadStrip(run, (row, column) => [column, (row * 2.2) / 1.2]),
        materials.kerb,
      );
      kerbs.castShadow = true;
      kerbs.receiveShadow = true;
      ctx.add(kerbs);
      fixedTrimesh(ctx, kerbs, LAYER.road, `kerbs-${side > 0 ? "right" : "left"}-${runs}`);
      run = [];
    };
    for (const station of coarse) {
      const sides = kerbSides(station);
      const width = KERB_WIDTH * (side > 0 ? sides.right : sides.left);
      if (width <= 0) {
        flush();
        continue;
      }
      const inner = side * HALF;
      const outer = side * (HALF + width);
      const rise = KERB_HEIGHT;
      // **Chamfered**, and that is the whole reason the kerb is a kerb. A 5 cm vertical face is a
      // step: at 14 m/s a wheel that finds one is launched, and the car leaves the road sideways.
      // A kerb is a rumble strip, so it is a ramp: 5 cm over 35 cm, which any speed rolls over.
      const shoulder = side * (HALF + Math.min(CHAMFER, width));
      run.push(
        side > 0
          ? [
              onTrack(station, inner, 0.004),
              onTrack(station, shoulder, 0.004 + rise),
              onTrack(station, outer, 0.004 + rise),
              onTrack(station, outer, 0.004),
            ]
          : [
              onTrack(station, outer, 0.004),
              onTrack(station, shoulder, 0.004 + rise),
              onTrack(station, inner, 0.004 + rise),
              onTrack(station, inner, 0.004),
            ],
      );
    }
    flush();
  }
}

/**
 * The barrier line's **distance** from the centreline, in metres, at one station and side.
 *
 * A constant offset does not work on a 10 m hairpin — the inside barrier would land on the
 * centreline — so the inside follows the local radius and stops 1.2 m past the white line, while
 * the outside keeps the full run-off. The caller owns the **sign**: the returned distance is always
 * positive, and forgetting `side *` built both barriers on the right and none on the left — which
 * is exactly how a car left the circuit onto the grass.
 */
function barrierOffset(station: IStation, side: 1 | -1): number {
  const curvature = station.sample.curvature;
  if (curvature * side <= 1 / 90) return BARRIER_OFFSET;
  return clamp(station.sample.radius - HALF - 1.2, 0.4, BARRIER_OFFSET);
}

function buildBarriers(
  ctx: TrackCtx,
  all: readonly IStation[],
  materials: ReturnType<typeof createMaterials>,
): void {
  const coarse = all.filter((_station, index) => index % 3 === 0);

  // Two rails, one per side. They cannot be one strip: a strip's rows run along the track, so
  // alternating the sides station by station would stitch a deck across the circuit.
  for (const side of [1, -1] as const) {
    const rail = coarse.map((station) => {
      const offset = side * barrierOffset(station, side);
      const inner = offset - side * 0.14;
      const outer = offset + side * 0.14;
      const low = 0.4;
      const high = 1.04;
      // Closed profile: the fifth point is the first again, so the inner face exists. Without it
      // the rail is an open shell, and on the side whose winding faces away it is neither visible
      // nor collidable from the track.
      return side > 0
        ? [
            onGround(station, inner, low),
            onGround(station, outer, low),
            onGround(station, outer, high),
            onGround(station, inner, high),
            onGround(station, inner, low),
          ]
        : [
            onGround(station, outer, low),
            onGround(station, inner, low),
            onGround(station, inner, high),
            onGround(station, outer, high),
            onGround(station, outer, low),
          ];
    });
    const armco = new Mesh(
      quadStrip(looped(rail), (row, column) => [column, row * 3.3]),
      materials.armco,
    );
    armco.castShadow = true;
    ctx.add(armco);

    // The rail floats 40 cm above the ground and the car's chassis is lower than that: it drove
    // under the rail. This wall starts below the drawn grass and ends at the rail's top, with both
    // windings so a solver that culls back faces still meets it from the track. It is never drawn.
    const wall = coarse.map((station) => {
      const offset = side * barrierOffset(station, side);
      const low = onGround(station, offset, -TERRAIN_SINK - 0.5);
      const high = onGround(station, offset, 1.04);
      // [low, high] then its mirror: the degenerate top edge between them has no area.
      return [low, high, high, low];
    });
    const barrier = new Mesh(
      quadStrip(looped(wall), (row, column) => [column, row * 3.3]),
      materials.armco,
    );
    barrier.visible = false;
    ctx.add(barrier);
    fixedTrimesh(ctx, barrier, LAYER.barrier, `armco-${side > 0 ? "right" : "left"}`);
  }

  // The posts. Decoration: the wall is the collider, and a hundred-odd fixed bodies for the same
  // line was the cost `buildStaticColliders` used to pay.
  const posts = new InstancedBatch({
    geometry: new BoxGeometry(0.16, 1.2, 0.16),
    material: materials.structure,
  });
  for (const station of all) {
    if (station.distance % 8 >= CIRCUIT.spacing) continue;
    for (const side of [1, -1] as const) {
      const at = onGround(station, side * barrierOffset(station, side), 0.6);
      posts.place({
        position: [at.x, at.y, at.z],
        rotation: [0, Math.atan2(station.sample.right.z, station.sample.right.x), 0],
        scale: [1, 1, 1],
      });
    }
  }
  const postMesh = posts.build({ castShadow: true, name: "armco-posts" });
  if (postMesh !== undefined) ctx.add(postMesh);
}

function gate(
  ctx: TrackCtx,
  id: ChecklineId,
  fraction: number,
  materials: ReturnType<typeof createMaterials>,
): Checkline {
  const distance = lineDistance(fraction);
  const station = stationAt(distance);
  const at = onTrack(station, 0, 0, new Vector3());
  const forward = station.sample.tangent.clone();
  const along = Math.abs(forward.x) > Math.abs(forward.z);
  const group = new Group();
  const span = TRACK_WIDTH + 3;
  for (const side of [-1, 1] as const) {
    const post = new Mesh(new BoxGeometry(0.34, 6, 0.34), materials.structure);
    post.position.set((side * span) / 2, 3, 0);
    post.castShadow = true;
    group.add(post);
  }
  const beam = new Mesh(new BoxGeometry(span + 0.4, 0.4, 0.4), materials.armco);
  beam.position.y = 5.9;
  beam.castShadow = true;
  const banner = new Mesh(
    new BoxGeometry(span - 2, 1.1, 0.12),
    id === "finish" ? materials.boost : materials.structure,
  );
  banner.position.y = 4.9;
  banner.castShadow = true;
  group.add(beam, banner);
  group.position.copy(at);
  // The gantry spans the road, so it turns with the road. Unrotated it lies along the racing line
  // and reads as a bar going nowhere.
  group.rotation.y = along ? Math.PI / 2 : 0;
  ctx.add(group);
  // The line is where the gantry's posts stand, and it is as wide as the road plus a car's width:
  // a car that is off the tarmac is not crossing the start line.
  void along;
  return new Checkline(id, at, forward, TRACK_WIDTH / 2 + 1.8);
}

function boostPad(
  ctx: TrackCtx,
  fraction: number,
  materials: ReturnType<typeof createMaterials>,
): { area: Area3D; boost: Boost } {
  const station = stationAt(lineDistance(fraction));
  const at = onTrack(station, 0, 0, new Vector3());
  const along = Math.abs(station.sample.tangent.x) > Math.abs(station.sample.tangent.z);
  const pad = new Group();
  const base = new Mesh(new BoxGeometry(3.6, 0.04, TRACK_WIDTH - 1), materials.carbon);
  base.position.y = 0.02;
  base.receiveShadow = true;
  pad.add(base);
  for (let index = 0; index < 3; index += 1) {
    for (const side of [-1, 1] as const) {
      const arm = new Mesh(new BoxGeometry(1.7, 0.05, 0.46), materials.boost);
      arm.position.set(-1.2 + index * 1.2, 0.045, side * 1.2);
      arm.rotation.y = side * 0.6;
      arm.receiveShadow = true;
      pad.add(arm);
    }
  }
  pad.position.copy(at);
  pad.rotation.y = along ? 0 : Math.PI / 2;
  ctx.add(pad);
  const boost = new Boost();
  const half = TRACK_WIDTH / 2 - 0.5;
  const area = new Area3D({
    collisionMask: LAYER.car,
    entity: "boost-pad",
    physics: ctx.physics,
    position: { x: at.x, y: at.y + 0.45, z: at.z },
    shape: along ? CollisionShape3D.box(1.8, 0.5, half) : CollisionShape3D.box(half, 0.5, 1.8),
  });
  return { area, boost };
}

/**
 * Everything beside the road, placed off the same centreline.
 *
 * Delete a line here and that piece of furniture is gone; nothing else depends on it. Every
 * repeated prop goes into an `InstancedBatch` and every static run into one merged mesh, because
 * the performance playtest bounds the race at 330 draw calls and 135,000 triangles: the circuit
 * and six cars, about 5,300 triangles each (measured 126,202 with the full field).
 */
function dressCircuit(
  ctx: TrackCtx,
  all: readonly IStation[],
  materials: ReturnType<typeof createMaterials>,
): void {
  const at = (fraction: number, offset: number, lift = 0, target = new Vector3()): Vector3 =>
    onGround(stationAt(lineDistance(fraction)), offset, lift, target);
  const heading = (fraction: number): number => {
    const sample = CIRCUIT.at(lineDistance(fraction), CIRCUIT.createSample());
    return Math.atan2(sample.tangent.z, sample.tangent.x);
  };

  // **The finish line**: the one transverse mark the road is allowed to carry. It is a `quadStrip`,
  // like every other surface here, so it sits on the banked tarmac rather than a flat plane through it.
  const finishRows = [
    stationAt(lineDistance(LINE_AT.finish) - 3),
    stationAt(lineDistance(LINE_AT.finish)),
  ].map((station) => [
    onTrack(station, -HALF, ROAD_LIFT + 0.014),
    onTrack(station, HALF, ROAD_LIFT + 0.014),
  ]);
  const finishLine = new Mesh(
    quadStrip(finishRows, (row, column) => [column * 4, row * 2]),
    materials.checker,
  );
  ctx.add(finishLine);

  // **Start lights**: two rows of five on the finish gantry. This is the one piece of furniture a
  // first frame cannot be without, because it is what says *this is a start line*.
  const lights = new InstancedBatch({
    geometry: new BoxGeometry(0.4, 0.72, 0.4),
    material: materials.taillamp,
  });
  for (let row = 0; row < 2; row += 1)
    for (let column = 0; column < 5; column += 1) {
      const lamp = at(LINE_AT.finish, -2.6 + column * 1.3, 4.1 + row * 0.9);
      lights.place({
        position: [lamp.x, lamp.y, lamp.z],
        rotation: [0, heading(LINE_AT.finish), 0],
        scale: [1, 1, 1],
      });
    }
  const lightMesh = lights.build({ name: "start-lights" });
  if (lightMesh !== undefined) ctx.add(lightMesh);

  // **Grandstands**, set back past the barriers: close in they climbed into the chase camera and
  // hid the corner the driver was aiming at. The crowd is one batch for the whole circuit.
  const crowd = new InstancedBatch({
    geometry: new BoxGeometry(0.36, 0.72, 0.32),
    material: materials.crowd,
  });
  const stands: [number, number, number][] = [];
  for (const fraction of [0.015, 0.1, 0.44, 0.52]) {
    const sample = CIRCUIT.at(lineDistance(fraction), CIRCUIT.createSample());
    const side = sample.curvature > 0 ? -1 : 1;
    stands.push([
      fraction,
      side * (HALF + RUNOFF + 7),
      sample.curvature > 0 ? Math.PI / 2 : -Math.PI / 2,
    ]);
  }
  for (const [fraction, offset, turn] of stands) {
    const stand = grandstand(materials.structure, materials.line);
    const origin = at(fraction, offset);
    stand.group.position.copy(origin);
    stand.group.rotation.y = turn;
    ctx.add(stand.group);
    for (const [seatX, seatY, seatZ] of stand.crowd) {
      const turned = new Vector3(seatX, seatY, seatZ).applyAxisAngle(new Vector3(0, 1, 0), turn);
      crowd.place({
        position: [origin.x + turned.x, origin.y + turned.y, origin.z + turned.z],
        scale: [1, 1, 1],
      });
    }
  }
  const crowdMesh = crowd.build({ castShadow: true, name: "grandstand-crowd" });
  if (crowdMesh !== undefined) ctx.add(crowdMesh);

  // **Pit lane and pit wall**, on the inside of the main straight. Both read the straight's own
  // distance, so the lane is parallel to it by construction and cannot drift onto the track.
  const pitStations: IStation[] = [];
  for (let distance = lineDistance(0.005); distance <= lineDistance(0.145); distance += 2.4)
    pitStations.push(stationAt(distance));
  const pit = new Mesh(
    quadStrip(
      pitStations.map((station) => [
        onGround(station, HALF + 0.5, 0.02),
        onGround(station, HALF + 7.4, 0.02),
      ]),
      (row, column) => [column * 7, row * 2.4],
    ),
    materials.runoff,
  );
  pit.receiveShadow = true;
  ctx.add(pit);
  const pitWall = new Mesh(
    quadStrip(
      pitStations.map((station) => [
        onGround(station, HALF + 7.4, 0),
        onGround(station, HALF + 7.7, 0),
        onGround(station, HALF + 7.7, 1.15),
        onGround(station, HALF + 7.4, 1.15),
      ]),
      (row, column) => [column, row * 2.4],
    ),
    materials.armco,
  );
  pitWall.castShadow = true;
  ctx.add(pitWall);
  fixedTrimesh(ctx, pitWall, LAYER.barrier, "pit-wall");

  // **Marshal posts** on the outside of the corners, where a flag marshal would stand.
  const posts = new InstancedBatch({
    geometry: new BoxGeometry(2.8, 2.6, 1.9),
    material: materials.structure,
  });
  for (const fraction of [0.2, 0.4, 0.58, 0.72]) {
    const sample = CIRCUIT.at(lineDistance(fraction), CIRCUIT.createSample());
    const side = sample.curvature > 0 ? -1 : 1;
    const origin = at(fraction, side * (HALF + RUNOFF + 3.5));
    posts.place({
      position: [origin.x, origin.y + 1.3, origin.z],
      rotation: [0, heading(fraction), 0],
      scale: [1, 1, 1],
    });
  }
  const postMesh = posts.build({ castShadow: true, name: "marshal-posts" });
  if (postMesh !== undefined) ctx.add(postMesh);

  // **Tyre walls** on the outside of every corner tight enough to run wide at.
  const tyres = new InstancedBatch({ geometry: tyreStackGeometry(3), material: materials.tire });
  for (let index = 0; index < all.length; index += 7) {
    const station = all[index];
    if (station === undefined || Math.abs(station.sample.curvature) < 1 / 70) continue;
    const side = station.sample.curvature > 0 ? -1 : 1;
    const origin = onGround(station, side * (HALF + KERB_WIDTH + 3), 0, new Vector3());
    tyres.place({
      position: [origin.x, origin.y, origin.z],
      rotation: [0, heading(station.distance / CIRCUIT.totalLength), 0],
      scale: [1, 1, 1],
    });
  }
  const tyreMesh = tyres.build({ castShadow: true, name: "tyre-walls" });
  if (tyreMesh !== undefined) ctx.add(tyreMesh);

  let midX = 0;
  let midZ = 0;
  for (const station of all) {
    midX += station.sample.point.x;
    midZ += station.sample.point.z;
  }
  midX /= all.length;
  midZ /= all.length;

  // **Trees** beyond the circuit, on a seeded jitter so two captures frame the same world. The
  // distance test is why a conifer never stands in the run-off.
  const pine = treeGeometry();
  const trunks = new InstancedBatch({ geometry: pine.trunk, material: materials.trunk });
  const canopies = new InstancedBatch({ geometry: pine.canopy, material: materials.canopy });
  let seed = 6132;
  const jitter = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let index = 0; index < 190; index += 1) {
    const angle = (index / 190) * Math.PI * 2 + jitter() * 0.09;
    const reach = 230 + jitter() * 150;
    const x = midX + Math.cos(angle) * reach;
    const z = midZ + Math.sin(angle) * reach;
    let near = Number.POSITIVE_INFINITY;
    for (const station of all) {
      const gap = (station.sample.point.x - x) ** 2 + (station.sample.point.z - z) ** 2;
      if (gap < near) near = gap;
    }
    if (near < 36 * 36) continue;
    const scale = 1.7 + jitter() * 2.4;
    const placement = {
      position: [x, terrainHeight(x, z), z] as [number, number, number],
      rotation: [0, jitter() * Math.PI, 0] as [number, number, number],
      scale: [scale, scale, scale] as [number, number, number],
    };
    trunks.place(placement);
    canopies.place(placement);
  }
  for (const [batch, name] of [
    [trunks, "treeline-trunks"],
    [canopies, "treeline-canopies"],
  ] as const) {
    const mesh = batch.build({ castShadow: true, name });
    if (mesh !== undefined) ctx.add(mesh);
  }

  // **Distant hills**, so the horizon has a shape instead of a line. Placed relative to the
  // circuit's own centre and at least 380 m out: a fixed world coordinate here reads as a nearby
  // wall the moment the circuit's layout or orientation changes, because the two stop agreeing on
  // where "far away" is. Several boxes per hill, jittered in height and offset, so the skyline is
  // a ridge rather than one flat-faced slab.
  let hillSeed = 4021;
  const hillJitter = (): number => {
    hillSeed = (hillSeed * 1103515245 + 12345) & 0x7fffffff;
    return hillSeed / 0x7fffffff;
  };
  // Small and far, and buried to three quarters of their own height: a box this close to the
  // camera's forward view reads as a wall, not a hill, the moment it is tall enough to fill more
  // than a sliver of the horizon. A real hill's silhouette is a low ridge, not a slab.
  for (const [angle, radius, reach] of [
    [0.15, 55, 620],
    [1.9, 70, 660],
    [3.4, 50, 640],
    [5.0, 60, 700],
  ] as const) {
    const cx = midX + Math.cos(angle) * reach;
    const cz = midZ + Math.sin(angle) * reach;
    for (let lump = 0; lump < 4; lump += 1) {
      const lumpRadius = radius * (0.6 + hillJitter() * 0.5);
      const x = cx + (hillJitter() - 0.5) * radius * 2.2;
      const z = cz + (hillJitter() - 0.5) * radius * 2.2;
      const hill = new Mesh(
        new BoxGeometry(lumpRadius * 2, lumpRadius, lumpRadius * 2),
        materials.distant,
      );
      hill.rotation.y = hillJitter() * Math.PI;
      hill.position.set(x, terrainHeight(x, z) - lumpRadius * 0.78, z);
      ctx.add(hill);
    }
  }
}

export function gridPosition(slot: number, target: Vector3): Vector3 {
  const { distance, side } = gridSlot(slot);
  return onTrack(stationAt(distance), side, 0.05, target);
}

/** The direction a car on the grid is pointing: down the main straight. */
export function gridHeading(slot: number): number {
  const sample = CIRCUIT.at(gridSlot(slot).distance, CIRCUIT.createSample());
  return Math.atan2(sample.tangent.z, sample.tangent.x);
}

function normalizeRayHit(value: unknown): IRayHit | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const distance = record.distance;
  if (typeof distance !== "number" || !Number.isFinite(distance)) return undefined;
  const normal = record.normal;
  const normalY =
    typeof normal === "object" &&
    normal !== null &&
    typeof (normal as { y?: unknown }).y === "number"
      ? (normal as { y: number }).y
      : undefined;
  return { distance, ...(normalY === undefined ? {} : { normalY }) };
}

type PhysicsQueryPoint = Pick<Vector3, "x" | "y" | "z">;

interface IPhysicsDirectSpaceState {
  intersectRay(options: {
    readonly collisionMask?: number;
    readonly from: PhysicsQueryPoint;
    readonly to: PhysicsQueryPoint;
  }): unknown;
}

type QueryPhysics = IPhysicsContext & {
  readonly directSpaceState: IPhysicsDirectSpaceState;
};

/** Uses PRD-088's optional physics query when installed, with a local visual probe fallback. */
export function intersectRay(physics: IPhysicsContext, fallback: IntersectRay): IntersectRay {
  const directSpaceState = (physics as Partial<QueryPhysics>).directSpaceState;
  if (directSpaceState === undefined) return fallback;
  return (origin, direction, maxDistance) => {
    const to = origin.clone().addScaledVector(direction, maxDistance);
    const result = directSpaceState.intersectRay({
      collisionMask: LAYER.road,
      from: origin,
      to,
    });
    return normalizeRayHit(result);
  };
}

const raycaster = new Raycaster();

/** The visual probe: it finds the same tarmac the physics does, from the road mesh itself. */
export function roadRayProbe(meshes: readonly Mesh[]): IntersectRay {
  return (origin, direction, maxDistance) => {
    raycaster.set(origin, direction);
    const hit = raycaster.intersectObjects([...meshes], false)[0];
    if (hit === undefined || hit.distance > maxDistance) return undefined;
    return { distance: hit.distance, normalY: hit.face?.normal.y };
  };
}

export interface ITrackBuild {
  readonly boost: Boost;
  readonly boostArea: Area3D;
  readonly gates: readonly Checkline[];
  readonly roadMeshes: readonly Mesh[];
}

export function buildTrack(ctx: TrackCtx): ITrackBuild {
  const materials = createMaterials();
  buildTerrain(ctx, materials);
  const all = buildRoad(ctx, materials);
  buildKerbs(ctx, all, materials);
  buildBarriers(ctx, all, materials);
  // Finish first, then the two sector lines in driving order: `Lap` arms gate 0 and a car on the
  // grid crosses it first, so a lap is measured on the start/finish line and nowhere else.
  const gates = [
    gate(ctx, "finish", LINE_AT.finish, materials),
    gate(ctx, "sector-1", LINE_AT.sector1, materials),
    gate(ctx, "sector-2", LINE_AT.sector2, materials),
  ];
  const pad = boostPad(ctx, 0.3, materials);
  dressCircuit(ctx, all, materials);
  const road = ctx.scene.getObjectByName("road");
  return {
    boost: pad.boost,
    boostArea: pad.area,
    gates,
    roadMeshes: road instanceof Mesh ? [road] : [],
  };
}

export {
  CIRCUIT,
  GRID_SLOTS,
  PLAYER_SLOT,
  HALF,
  KERB_HEIGHT,
  KERB_WIDTH,
  LINE_AT,
  RUNOFF,
  TRACK_WIDTH,
  groundHeight,
  lineDistance,
  terrainHeight,
};
export type { ICircuitSample, IntersectRay };
