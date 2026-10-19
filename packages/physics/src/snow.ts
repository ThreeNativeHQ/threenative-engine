import {
  type IHeightfieldRegionBounds,
  type ISnowFootprint,
  type ISnowFootprintSample,
  type SnowField,
  snowDiscFootprint,
} from "@threenative/core/world";
import type { IPhysicsColliderHandle } from "./handles.js";
import type { IPhysicsContext, PhysicsBody3D } from "./plugin.js";
import {
  type IPhysicsShapeDescriptor,
  PHYSICS_CONTACT_STRIDE,
  type PhysicsShapeKind,
} from "./simulation.js";

/** The smallest window covering both. */
function unionBounds(
  current: IHeightfieldRegionBounds | undefined,
  next: IHeightfieldRegionBounds,
): IHeightfieldRegionBounds {
  if (current === undefined) return next;
  const column = Math.min(current.column, next.column);
  const row = Math.min(current.row, next.row);
  return {
    column,
    columns: Math.max(current.column + current.columns, next.column + next.columns) - column,
    row,
    rows: Math.max(current.row + current.rows, next.row + next.rows) - row,
  };
}

const ZERO_SAMPLE: ISnowFootprintSample = {
  bank: 0,
  coverage: 0,
  disturbance: 0,
  relief: 0,
  shape: 0,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`attachSnowPhysics ${name} must be a positive finite number.`);
  return value;
}

/**
 * A stadium contact: a rectangle of half-length `halfHeight` and half-width `radius`, capped by
 * two half-discs of `radius`. The shape a capsule lies on, so a knocked-over body sinks along a
 * line instead of at a point. Coverage is full across the body's own width and fades just
 * outside it, so the body's edge never rests on a half-pressed rim; the bank rises beyond that.
 * @situation let a fallen capsule, limb or barrel leave a linear imprint in snow
 * @situation give a capsule a shape-appropriate snow contact instead of a sphere's dot
 * @constraint radius and halfHeight are metres and never grow with load
 * @example const footprint = capsuleFootprint(0.5, 0.2);
 * @requires npm i @threenative/physics
 */
export function capsuleFootprint(halfHeight: number, radius: number): ISnowFootprint {
  positive(radius, "capsule radius");
  if (!Number.isFinite(halfHeight) || halfHeight < 0)
    throw new Error("attachSnowPhysics capsule halfHeight must be a non-negative finite number.");
  const softness = 0.2 * radius;
  return {
    extent: halfHeight + radius + 2 * softness,
    sample: (x, z) => {
      // Distance beyond the body: from the spine, a segment from -halfHeight to +halfHeight on z.
      const along = clamp(z, -halfHeight, halfHeight);
      return edgeSample(Math.hypot(x, z - along) - radius, softness);
    },
  };
}

/**
 * A rectangular contact: the face a box rests on, in the contact's own frame. Coverage is full
 * across the face and fades just outside it; the bank rises beyond that.
 * @situation let a crate, platform or plank press a rectangular pit into snow
 * @situation imprint a box's own footprint rather than a circle around it
 * @constraint halfWidth and halfDepth are metres; rotation comes from the contact, not the footprint
 * @example const footprint = boxFootprint(0.4, 0.25);
 * @requires npm i @threenative/physics
 */
export function boxFootprint(halfWidth: number, halfDepth: number): ISnowFootprint {
  positive(halfWidth, "box halfWidth");
  positive(halfDepth, "box halfDepth");
  const edge = 0.15 * Math.min(halfWidth, halfDepth);
  return {
    extent: Math.hypot(halfWidth + 2 * edge, halfDepth + 2 * edge),
    sample: (x, z) => edgeSample(Math.max(Math.abs(x) - halfWidth, Math.abs(z) - halfDepth), edge),
  };
}

/**
 * One sample of a solid body's print by its distance `outside` the body's own outline: fully
 * covered inside, fading to nothing over `edge` beyond it, then a bank over the next `edge`.
 */
function edgeSample(outside: number, edge: number): ISnowFootprintSample {
  if (outside >= 2 * edge) return ZERO_SAMPLE;
  if (outside >= edge) {
    const bank = 1 - (outside - edge) / edge;
    return { bank, coverage: 0, disturbance: bank * 0.5, relief: 0, shape: 1 };
  }
  const coverage = outside <= 0 ? 1 : 1 - smoothstep(0, edge, outside);
  return { bank: 0, coverage, disturbance: coverage, relief: 0, shape: 1 };
}

/** Shape kinds `attachSnowPhysics` can derive an automatic contact profile for. */
const SUPPORTED_SHAPES: readonly PhysicsShapeKind[] = ["sphere", "box", "capsule"];

interface IQuaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** A local unit axis rotated into world space. */
function rotateAxis(q: IQuaternion, axis: 0 | 1 | 2): [number, number, number] {
  const { w, x, y, z } = q;
  if (axis === 0) return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  if (axis === 1) return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}

interface IWatchedBody {
  readonly body: PhysicsBody3D;
  /** Load this body pressed into the snow in the last consumed step, newtons. */
  load: number;
  readonly shape: IPhysicsShapeDescriptor | undefined;
  readonly custom: ISnowFootprint | undefined;
  readonly cache: Map<number, ISnowFootprint>;
  impulse: number;
}

/**
 * The footprint a body presses with its current orientation, where it is centred, and its yaw.
 *
 * The footprint is centred under the body, never on the contact centroid: a rocking box touches
 * one corner at a time, and centring its whole face on that corner would smear the print. A
 * sphere is a disc whatever its rotation. A box presses whichever face is most nearly facing
 * down; a capsule presses a stadium whose length is its spine's horizontal projection, so an
 * upright capsule leaves a disc and a fallen one a trough.
 */
function orientedFootprint(
  watched: IWatchedBody,
  transform: IBodyPose,
  cellSize: number,
): IOrientedFootprint {
  const { position, rotation } = transform;
  if (watched.custom !== undefined) {
    const forward = rotateAxis(rotation, 2);
    return {
      footprint: watched.custom,
      rotation: Math.atan2(forward[0], forward[2]),
      x: position.x,
      z: position.z,
    };
  }
  const shape = watched.shape;
  if (shape === undefined) throw new Error("attachSnowPhysics watched body lost its shape.");
  if (shape.kind === "box") return boxPrint(watched.cache, shape, transform);
  if (shape.kind === "capsule") return capsulePrint(watched.cache, shape, transform, cellSize);
  return {
    footprint: cached(watched.cache, 0, () => snowDiscFootprint(shape.x)),
    rotation: 0,
    x: position.x,
    z: position.z,
  };
}

interface IBodyPose {
  readonly position: { readonly x: number; readonly z: number };
  readonly rotation: IQuaternion;
}

interface IOrientedFootprint {
  readonly footprint: ISnowFootprint;
  readonly rotation: number;
  readonly x: number;
  readonly z: number;
}

function cached(
  cache: Map<number, ISnowFootprint>,
  key: number,
  create: () => ISnowFootprint,
): ISnowFootprint {
  let footprint = cache.get(key);
  if (footprint === undefined) {
    footprint = create();
    cache.set(key, footprint);
  }
  return footprint;
}

/** A box presses whichever face is most nearly facing down, centred on that face. */
function boxPrint(
  cache: Map<number, ISnowFootprint>,
  shape: IPhysicsShapeDescriptor,
  { position, rotation }: IBodyPose,
): IOrientedFootprint {
  const axes = [rotateAxis(rotation, 0), rotateAxis(rotation, 1), rotateAxis(rotation, 2)];
  const halves = [shape.x, shape.y, shape.z];
  let down = 0;
  for (let axis = 1; axis < 3; axis += 1)
    if (Math.abs(axes[axis]?.[1] ?? 0) > Math.abs(axes[down]?.[1] ?? 0)) down = axis;
  const across = down === 0 ? 1 : 0;
  const along = down === 2 ? 1 : 2;
  // The resting face's centre, which a tilted box offsets horizontally from its own centre.
  const normal = axes[down] as [number, number, number];
  const toFace = (halves[down] as number) * (normal[1] > 0 ? -1 : 1);
  const axis = axes[across] as [number, number, number];
  return {
    footprint: cached(cache, down, () =>
      boxFootprint(halves[across] as number, halves[along] as number),
    ),
    rotation: Math.atan2(-axis[2], axis[0]),
    x: position.x + normal[0] * toFace,
    z: position.z + normal[2] * toFace,
  };
}

/** A capsule presses a stadium as long as its spine's horizontal projection. */
function capsulePrint(
  cache: Map<number, ISnowFootprint>,
  shape: IPhysicsShapeDescriptor,
  { position, rotation }: IBodyPose,
  cellSize: number,
): IOrientedFootprint {
  // Rapier's spine runs along the body's local y.
  const spine = rotateAxis(rotation, 1);
  const reach = shape.x * Math.hypot(spine[0], spine[2]);
  // Footprints are cached per half-cell of projected length, so a tumbling capsule reuses them.
  const key = Math.round(reach / (cellSize / 2));
  return {
    footprint: cached(cache, key, () => capsuleFootprint((key * cellSize) / 2, shape.y)),
    rotation: Math.atan2(spine[0], spine[2]),
    x: position.x,
    z: position.z,
  };
}

export interface ISnowPhysicsOptions {
  /** The physics context whose solved steps drive the deformation. */
  readonly physics: IPhysicsContext;
  /** The snow surface these bodies deform. */
  readonly snow: SnowField;
  /** Bodies to watch from the start. Register more later with `add`. */
  readonly bodies?: readonly PhysicsBody3D[];
  /** Collision layer of the generated snow surface collider. Default 1. */
  readonly collisionLayer?: number;
  /** Collision mask of the generated snow surface collider. Default 0xffff. */
  readonly collisionMask?: number;
  /** Multiplier turning a solved contact impulse into load. Default 1. */
  readonly loadScale?: number;
  /** Smallest contact-normal height that counts as support. Default 0.35. */
  readonly supportNormal?: number;
  /**
   * Largest gap, in metres, the live collider may keep from the canonical surface before it is
   * rebuilt. Default 0.0005. A resting body's print converges geometrically, so rebuilding on
   * every sub-millimetre change would wake it every step and it would never sleep.
   */
  readonly colliderTolerance?: number;
  /** Snowfall deposition in metres per second, forwarded to `SnowField.recover`. Default 0. */
  readonly deposition?: number;
  /** Wind erosion rate, forwarded to `SnowField.recover`. Default 0. */
  readonly wind?: number;
}

/** What the last consumed step observed, for a registry snapshot or a playtest probe. */
export interface ISnowPhysicsObservation {
  /** Solved snow-contact manifolds read in the most recent step. */
  readonly contacts: number;
  /** Bodies whose supported, downward-loaded contacts pressed the snow in that step. */
  readonly supported: number;
  /** Summed load those bodies pressed with, in newtons. */
  readonly load: number;
  /** How `load` was obtained. It is estimated from solver impulses, never measured. */
  readonly loadProvenance: "solver-impulse-per-step";
  /** Canonical snow surface version. */
  readonly version: number;
  /** Canonical version the live collider was last reconciled with. */
  readonly colliderVersion: number;
  /** Largest gap between the collider's source samples and the canonical surface, in metres. */
  readonly colliderError: number;
}

export interface ISnowPhysicsBinding {
  /** The generated snow surface collider. Its identity survives every deformation. */
  readonly surface: IPhysicsColliderHandle;
  /** Canonical surface version the live collider was last reconciled with. */
  readonly surfaceVersion: number;
  /** Solved contact manifolds read in the most recent step. */
  readonly contacts: number;
  /** Bodies that pressed the snow in the most recent step. */
  readonly supported: number;
  /** Snow surface version at the last step this binding ran. */
  readonly version: number;
  /** Live snowfall deposition in metres per second; checked at the next step. */
  deposition: number;
  /** Live wind erosion rate; checked at the next step. */
  wind: number;
  add(body: PhysicsBody3D, footprint?: ISnowFootprint): void;
  remove(body: PhysicsBody3D): void;
  /** Load one watched body pressed into the snow in the last step, newtons; 0 when airborne. */
  loadOf(body: PhysicsBody3D): number;
  /**
   * Consume one solved step: read contacts, deform the snow, let it recover, then publish the
   * changed surface to collision. Call it once per fixed step, after the physics step and before
   * the next one.
   */
  step(deltaTime: number): void;
  /** The last step's observation, with the collider measured against the canonical surface. */
  observe(): ISnowPhysicsObservation;
  /** Idempotent cleanup: removes the surface body and forgets every watched body. */
  dispose(): void;
}

/**
 * Drive a `SnowField` from real solved contacts.
 *
 * The binding creates the snow surface collider from the field's own canonical samples and keeps
 * it in step with them, so a body lands on the surface a query would report. Each fixed step it
 * reads the solver's persistent contacts — not collision start/stop events, which carry no point
 * or load — deforms the snow only where a contact is supported and loaded downward, then
 * republishes the surface before the next step. Airborne bodies, side contacts and unrelated
 * colliders never deform anything.
 *
 * A dropped sphere settles on the surface it made; a pushed one rotates and carves a connected
 * track without its transform being copied anywhere. Footprints come from the body's own
 * collision shape and orientation unless the game supplies one.
 *
 * Contact load is `impulse / deltaTime * loadScale`: a solver impulse over a step, which
 * estimates a contact force and is not measured. `observe().loadProvenance` says so.
 * @situation leave footprints and tracks where physical bodies actually touch snow
 * @situation let a dropped or pushed sphere carve and settle into deformable snow
 * @situation make a crate, capsule or ball compress the surface it rests on
 * @constraint register `rapier()` before attaching, and call `step` once per fixed step after the physics step
 * @constraint the backend must expose persistent solved contacts and in-place shape refresh; one that does not fails at attach
 * @constraint verified on browser WebGPU and the native Linux desktop host; Android and iOS share the native seam but have not run it
 * @constraint automatic profiles cover sphere, box and capsule; any other shape needs an explicit footprint
 * @override loadScale, supportNormal, colliderTolerance, deposition, wind, collisionLayer and collisionMask name the binding's own behaviour
 * @requires @threenative/core/world SnowField as the surface it deforms
 * @example const snowPhysics = attachSnowPhysics({ physics: ctx.physics, snow, bodies: [ball] });
 * afterPhysics(ctx, (dt) => snowPhysics.step(dt));
 */
export function attachSnowPhysics(options: ISnowPhysicsOptions): ISnowPhysicsBinding {
  const simulation = options.physics.simulation;
  if (
    typeof simulation.readContacts !== "function" ||
    typeof simulation.setColliderShape !== "function" ||
    typeof simulation.readBodyTransform !== "function"
  )
    throw new Error(
      "attachSnowPhysics requires a physics backend with persistent solved contacts, in-place shape refresh and body transform reads.",
    );
  const readContacts = simulation.readContacts.bind(simulation);
  const setColliderShape = simulation.setColliderShape.bind(simulation);
  const readBodyTransform = simulation.readBodyTransform.bind(simulation);
  const snow = options.snow;
  const field = snow.field;
  const loadScale = finiteOr(options.loadScale, 1, "loadScale");
  const supportNormal = clamp(finiteOr(options.supportNormal, 0.35, "supportNormal"), 0, 1);
  const cellSize = Math.min(snow.cellWidth, snow.cellDepth);
  const colliderTolerance = finiteOr(options.colliderTolerance, 0.0005, "colliderTolerance");
  if (colliderTolerance < 0)
    throw new Error("attachSnowPhysics colliderTolerance must be non-negative.");

  const watched = new Map<number, IWatchedBody>();
  let colliderHeights = field.toColliderHeights();
  // The window that may differ from the installed collider: everything written since the last
  // rebuild. Comparing only it is what keeps a resting body from costing a whole-field scan per
  // step (measured: 1.0 of 1.3 ms per step on a 401-sample field).
  const changes = field.trackChanges();
  let unsynced: IHeightfieldRegionBounds | undefined;
  let surfaceVersion = snow.version;
  let contacts = 0;
  let supported = 0;
  let load = 0;
  let version = snow.version;
  let disposed = false;

  function surfaceDescriptor(): IPhysicsShapeDescriptor {
    return {
      collisionLayer: options.collisionLayer ?? 1,
      collisionMask: options.collisionMask ?? 0xffff,
      columns: field.columns,
      heights: colliderHeights,
      kind: "heightfield",
      rows: field.rows,
      // Rapier's heightfield scale is the full extent, and its own axis order is the transposed
      // buffer `toColliderHeights` already produced.
      scale: { x: field.width, y: 1, z: field.depth },
      sensor: false,
      x: 0,
      y: 0,
      z: 0,
    };
  }

  const registration = simulation.createBody({
    entity: "threenative.snow.surface",
    mass: 0,
    position: { x: field.origin.x, y: 0, z: field.origin.z },
    rotation: { w: 1, x: 0, y: 0, z: 0 },
    sensor: false,
    shape: surfaceDescriptor(),
    type: "fixed",
  });
  const surface = registration.collider;
  const surfaceBody = registration.body;

  let contactBuffer = new Float32Array(PHYSICS_CONTACT_STRIDE * 64);
  let colliderScratch = new Uint32Array(8);

  /** Largest gap between the live collider's samples and the given canonical samples. */
  function colliderGap(canonical: Float32Array): number {
    let gap = 0;
    for (let index = 0; index < canonical.length; index += 1)
      gap = Math.max(
        gap,
        Math.abs((canonical[index] as number) - (colliderHeights[index] as number)),
      );
    return gap;
  }

  /** Largest gap between the live collider and the canonical surface inside one window. */
  function windowGap(window: IHeightfieldRegionBounds): number {
    let gap = 0;
    const rows = field.rows;
    for (let column = window.column; column < window.column + window.columns; column += 1) {
      for (let row = window.row; row < window.row + window.rows; row += 1) {
        const installed = colliderHeights[column * rows + row] as number;
        gap = Math.max(gap, Math.abs(field.colliderHeight(row, column) - installed));
      }
    }
    return gap;
  }

  function refreshSurface(): void {
    const changed = changes.take();
    if (changed !== undefined) unsynced = unionBounds(unsynced, changed);
    if (unsynced !== undefined && windowGap(unsynced) > colliderTolerance) {
      colliderHeights = field.toColliderHeights();
      setColliderShape(surface, surfaceDescriptor());
      unsynced = undefined;
    }
    surfaceVersion = snow.version;
  }

  function colliderIds(): Uint32Array {
    if (colliderScratch.length < watched.size) colliderScratch = new Uint32Array(watched.size * 2);
    let index = 0;
    for (const id of watched.keys()) {
      colliderScratch[index] = id;
      index += 1;
    }
    return colliderScratch.subarray(0, index);
  }

  /** Read every solved manifold, growing the buffer rather than dropping any. */
  function readAll(ids: Uint32Array): number {
    let found = readContacts(surface, ids, contactBuffer);
    if (found * PHYSICS_CONTACT_STRIDE > contactBuffer.length) {
      contactBuffer = new Float32Array(found * 2 * PHYSICS_CONTACT_STRIDE);
      found = readContacts(surface, ids, contactBuffer);
      if (found * PHYSICS_CONTACT_STRIDE > contactBuffer.length)
        throw new Error("attachSnowPhysics contact count changed between two reads of one step.");
    }
    return found;
  }

  function add(body: PhysicsBody3D, footprint?: ISnowFootprint): void {
    if (disposed) throw new Error("attachSnowPhysics binding is disposed.");
    const shape = "shape" in body ? body.shape.descriptor : undefined;
    if (footprint === undefined && !SUPPORTED_SHAPES.includes(shape?.kind as PhysicsShapeKind))
      throw new Error(
        `attachSnowPhysics cannot derive a contact profile for a '${shape?.kind ?? "unknown"}' shape; supported shapes are ${SUPPORTED_SHAPES.join(", ")}. Pass an explicit footprint instead.`,
      );
    watched.set(body.collider.id, {
      body,
      cache: new Map(),
      custom: footprint,
      impulse: 0,
      load: 0,
      shape,
    });
  }

  for (const body of options.bodies ?? []) add(body);

  /** Sum each watched body's supported, downward-loaded impulse from the step's manifolds. */
  function gather(): void {
    const found = readAll(colliderIds());
    contacts = found;
    for (let index = 0; index < found; index += 1) {
      const offset = index * PHYSICS_CONTACT_STRIDE;
      const entry = watched.get(contactBuffer[offset] as number);
      // Only the surface pushing up on a body, with the body pressing back, deforms snow.
      if (entry === undefined || (contactBuffer[offset + 5] as number) < supportNormal) continue;
      entry.impulse += Math.max(0, contactBuffer[offset + 7] as number);
    }
  }

  function press(deltaTime: number): void {
    gather();
    // One contact per body per step, under the body: the load is its whole supported impulse,
    // spread over its footprint's own area.
    for (const entry of watched.values()) {
      entry.load = 0;
      if (entry.impulse <= 0) continue;
      const transform = readBodyTransform(entry.body.body.id);
      if (transform === undefined) throw new Error("attachSnowPhysics lost a watched body.");
      const oriented = orientedFootprint(entry, transform, cellSize);
      const bodyLoad = (entry.impulse / deltaTime) * loadScale;
      snow.stamp({
        area: footprintArea(oriented.footprint),
        duration: deltaTime,
        footprint: oriented.footprint,
        load: bodyLoad,
        rotation: oriented.rotation,
        x: oriented.x,
        z: oriented.z,
      });
      supported += 1;
      load += bodyLoad;
      entry.load = bodyLoad;
      entry.impulse = 0;
    }
  }

  const binding: ISnowPhysicsBinding = {
    add,
    deposition: finiteOr(options.deposition, 0, "deposition"),
    wind: finiteOr(options.wind, 0, "wind"),
    get contacts() {
      return contacts;
    },
    get supported() {
      return supported;
    },
    get surface() {
      return surface;
    },
    get surfaceVersion() {
      return surfaceVersion;
    },
    get version() {
      return version;
    },
    observe(): ISnowPhysicsObservation {
      return {
        colliderError: colliderGap(field.toColliderHeights()),
        colliderVersion: surfaceVersion,
        contacts,
        load,
        loadProvenance: "solver-impulse-per-step",
        supported,
        version: snow.version,
      };
    },
    remove(body: PhysicsBody3D): void {
      watched.delete(body.collider.id);
    },
    loadOf(body: PhysicsBody3D): number {
      return watched.get(body.collider.id)?.load ?? 0;
    },
    step(deltaTime: number): void {
      if (disposed) return;
      if (!Number.isFinite(deltaTime) || deltaTime <= 0)
        throw new Error("attachSnowPhysics step requires a positive finite delta time.");
      contacts = 0;
      supported = 0;
      load = 0;
      if (watched.size > 0) press(deltaTime);
      const deposition = Math.max(0, finiteOr(binding.deposition, 0, "deposition"));
      const wind = Math.max(0, finiteOr(binding.wind, 0, "wind"));
      if (deposition > 0 || wind > 0) snow.recover(deltaTime, deposition, wind);
      refreshSurface();
      version = snow.version;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      changes.dispose();
      watched.clear();
      simulation.removeBody(surfaceBody.id);
    },
  };
  return binding;
}
function finiteOr(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error(`attachSnowPhysics ${name} must be finite.`);
  return value;
}

/**
 * Smallest area a contact is allowed to claim.
 *
 * The snow model divides load by area, so a degenerate profile that reports a near-zero area
 * would produce an unbounded pressure. The floor is the model's own guard, not a physical claim.
 */
const MIN_CONTACT_AREA = 1e-4;

const footprintAreas = new WeakMap<ISnowFootprint, number>();

/**
 * The area a footprint actually covers, measured once per profile and then remembered.
 *
 * A footprint is a shape, never a load, so its supported area is a property of the shape. It is
 * measured with a bounded sweep rather than trusted to a hardcoded constant, and floored so a
 * degenerate profile cannot turn a finite load into an unbounded pressure.
 */
function footprintArea(footprint: ISnowFootprint): number {
  const cached = footprintAreas.get(footprint);
  if (cached !== undefined) return cached;
  const steps = 24;
  const step = (footprint.extent * 2) / steps;
  let area = 0;
  for (let row = 0; row < steps; row += 1) {
    const z = -footprint.extent + (row + 0.5) * step;
    for (let column = 0; column < steps; column += 1) {
      const x = -footprint.extent + (column + 0.5) * step;
      area += footprint.sample(x, z).coverage * step * step;
    }
  }
  const measured = Math.max(area, MIN_CONTACT_AREA);
  footprintAreas.set(footprint, measured);
  return measured;
}
