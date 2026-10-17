import type { ICtx, IGameObservationSampleRequest, IGamePluginHooks } from "@threenative/core";
import type { Object3D } from "three";
import type { Area3D } from "./Area3D.js";
import type { Buoyancy3D } from "./Buoyancy3D.js";
import { CharacterBody3D } from "./CharacterBody3D.js";
import { PhysicsDirectSpaceState3D } from "./PhysicsDirectSpaceState3D.js";
import { RigidBody3D } from "./RigidBody3D.js";
import { physicsHandle, physicsWorldHandle } from "./handles.js";
import type { INavigationContext } from "./navigation/index.js";
import {
  type IPhysicsInputSnapshot,
  type IPhysicsRuntimeSimulation,
  type IPhysicsSimulation,
  PHYSICS_COLLISION_EVENT_STRIDE,
  PHYSICS_SLEEP_STATE_STRIDE,
  PHYSICS_TRANSFORM_STRIDE,
  physicsSimulationBackend,
} from "./simulation.js";

export interface IPhysicsOptions {
  readonly gravity?: { readonly x: number; readonly y: number; readonly z: number };
  /**
   * Give each scene a pristine simulation, so restarting a scene reproduces its predecessor
   * exactly. Default false.
   *
   * Disposing the bodies is not enough on its own: the solver, island manager and broad phase
   * carry state from everything that has already happened, so an identical authored layout
   * settles differently in a reused world. A sandbox build measured settle hashes `a2f87bad`
   * versus `658eb6f8` at 240 versus 266 ticks, diverging during the initial drop before any
   * input, and had no way to fix it from game code.
   *
   * Opt-in because it frees the backend world at scene exit. Anything still holding a
   * `body.raw`, `collider.raw` or `world.raw` from the previous scene is reading freed memory
   * afterwards. Those references are already documented as non-portable, and a scene that has
   * exited has disposed its bodies, but the failure mode is a hard backend fault rather than a
   * quiet `false` — so a game asks for this rather than inheriting it.
   */
  readonly deterministicRestart?: boolean;
}

export type PhysicsBody3D = RigidBody3D | CharacterBody3D;

export interface IPhysicsContext {
  readonly world: ReturnType<typeof physicsWorldHandle>;
  readonly eventQueue: ReturnType<typeof physicsHandle>;
  readonly simulation: IPhysicsSimulation;
  readonly directSpaceState: PhysicsDirectSpaceState3D;
  navigation?: INavigationContext;
  /** Engine-owned draw history; optional for standalone physics contexts. */
  resetInterpolation?(object: Object3D): void;
  updateInterpolation?(body: PhysicsBody3D): void;
  add(body: PhysicsBody3D): void;
  numBodies(): number;
  kinematicMotion?(
    colliderHandle: number,
  ): { readonly x: number; readonly y: number; readonly z: number } | undefined;
  remove(body: PhysicsBody3D): void;
  addArea(area: Area3D): void;
  removeArea(area: Area3D): void;
  addBuoyancy(buoyancy: Buoyancy3D): void;
  removeBuoyancy(buoyancy: Buoyancy3D): void;
}

export type PhysicsPlugin = IGamePluginHooks<Record<string, unknown>, IPhysicsContext>;

const PHYSICS_DEBUG_BODY_LIMIT = 100;
const PHYSICS_DEBUG_SAMPLE_LIMIT = 100;
// A backend that keeps refusing a larger buffer is malformed; bound retries so the frame loop
// fails closed instead of allocating forever. The bound is independent of the plugin registry
// because callers can still reach the simulation's raw createBody seam.
const PHYSICS_BUFFER_RESIZE_ATTEMPTS = 12;

interface IPhysicsDebugSample {
  readonly label: string;
  readonly snapshot: Record<string, unknown>;
  readonly tick: number;
}

interface IAreaMembershipBuffers {
  current: Map<number, PhysicsBody3D>;
  previous: Map<number, PhysicsBody3D>;
}

function growFloat(
  buffer: Float32Array<ArrayBufferLike>,
  records: number,
): Float32Array<ArrayBufferLike> {
  if (buffer.length >= records * PHYSICS_TRANSFORM_STRIDE) return buffer;
  return new Float32Array(
    Math.max(records, Math.max(1, buffer.length / PHYSICS_TRANSFORM_STRIDE) * 2) *
      PHYSICS_TRANSFORM_STRIDE,
  );
}

function growEvents(
  buffer: Uint32Array<ArrayBufferLike>,
  bodyCount: number,
): Uint32Array<ArrayBufferLike> {
  const required = Math.max(64, bodyCount * 2 * PHYSICS_COLLISION_EVENT_STRIDE);
  let length = buffer.length;
  while (length < required) length *= 2;
  return length === buffer.length ? buffer : new Uint32Array(length);
}

function isSmallBufferError(error: unknown): boolean {
  return error instanceof Error && /buffer is too small/i.test(error.message);
}

function visibleId(buffer: Readonly<Float32Array>, offset: number): number {
  const value = buffer[offset];
  if (value === undefined || !Number.isInteger(value) || value < 0)
    throw new Error("IPhysicsSimulation returned an invalid visible body id.");
  return value;
}

export function rapier(options: IPhysicsOptions = {}): PhysicsPlugin {
  const backend = physicsSimulationBackend();
  let simulation: IPhysicsSimulation | undefined;
  let context: IPhysicsContext | undefined;
  const bodies = new Set<PhysicsBody3D>();
  const bodiesById = new Map<number, PhysicsBody3D>();
  const areas = new Map<number, Area3D>();
  const buoyancies = new Set<Buoyancy3D>();
  const areaMembershipBuffers = new Map<number, IAreaMembershipBuffers>();
  const kinematicMotions = new Map<
    number,
    { readonly x: number; readonly y: number; readonly z: number }
  >();
  let kinematic: Float32Array<ArrayBufferLike> = new Float32Array(PHYSICS_TRANSFORM_STRIDE * 16);
  let visible: Float32Array<ArrayBufferLike> = new Float32Array(PHYSICS_TRANSFORM_STRIDE * 16);
  let visibleCount = 0;
  let sleepStates: Float32Array<ArrayBufferLike> = new Float32Array(
    PHYSICS_SLEEP_STATE_STRIDE * 16,
  );
  let events: Uint32Array<ArrayBufferLike> = new Uint32Array(64);
  const activeContacts = new Map<string, readonly [number, number]>();
  let debugSeries: IPhysicsDebugSample[] = [];
  // Steps this plugin actually completed, counted after the call returns. The game loop's tick is
  // not this: a frame can render without a physics step, and a step can be refused. A lifecycle
  // phase therefore reads this to say whether the simulation moved, which no device counter and no
  // game-authored state can answer. Monotone for the plugin's lifetime, scene restarts included.
  let completedSteps = 0;
  let gameContext: ICtx<Record<string, unknown>, IPhysicsContext> | undefined;
  const interpolationRemovals = new Map<PhysicsBody3D, () => void>();
  function updateInterpolation(body: PhysicsBody3D): void {
    interpolationRemovals.get(body)?.();
    interpolationRemovals.delete(body);
    if (body.interpolate && body.object !== undefined && gameContext?.interpolate !== undefined)
      interpolationRemovals.set(body, gameContext.interpolate(body.object));
  }
  let unregisterObservations: (() => void) | undefined;

  function buildContext(selected: IPhysicsRuntimeSimulation): IPhysicsContext {
    return {
      resetInterpolation: (object) => gameContext?.resetInterpolation?.(object),
      updateInterpolation,
      add: (body) => {
        updateInterpolation(body);
        bodies.add(body);
        bodiesById.set(body.body.id, body);
      },
      addArea: (area) => {
        areas.set(area.body.id, area);
        areaMembershipBuffers.set(area.body.id, {
          current: new Map(),
          previous: new Map(),
        });
      },
      addBuoyancy: (buoyancy) => buoyancies.add(buoyancy),
      eventQueue: physicsHandle(selected.rawEventQueue),
      kinematicMotion: (colliderHandle) => kinematicMotions.get(colliderHandle),
      numBodies: () => bodies.size,
      remove: (body) => {
        interpolationRemovals.get(body)?.();
        interpolationRemovals.delete(body);
        bodies.delete(body);
        bodiesById.delete(body.body.id);
        removeContactsFor(body.body.id);
      },
      removeArea: (area) => {
        areas.delete(area.body.id);
        areaMembershipBuffers.delete(area.body.id);
        removeContactsFor(area.body.id);
      },
      removeBuoyancy: (buoyancy) => buoyancies.delete(buoyancy),
      directSpaceState: new PhysicsDirectSpaceState3D(selected),
      simulation: selected,
      world: physicsWorldHandle(selected.rawWorld, selected),
    };
  }

  return {
    setup: async (ctx: ICtx<Record<string, unknown>, IPhysicsContext>, runtime) => {
      gameContext = ctx;
      await backend.initialize();
      const selected = backend.createSimulation(options);
      simulation = selected;
      if (runtime !== undefined) runtime.rapier = selected.version;
      context = buildContext(selected);
      ctx.physics = context;
      unregisterObservations = runtime?.observations?.contribute({
        capabilities: ["runtime.physics"],
        sample: (request) => physicsObservations(ctx, runtime, request),
      });
      return unregisterObservations;
    },
    update: (_ctx, dt) => {
      if (simulation === undefined) throw new Error("Physics plugin updated before setup.");
      kinematicMotions.clear();
      let count = 0;
      kinematic = growFloat(kinematic, bodies.size + areas.size);
      for (const body of bodies) {
        if (body instanceof RigidBody3D && body.type === "kinematic") {
          kinematicMotions.set(body.collider.id, body.kinematicMotion());
          body.writeKinematic(kinematic, count * PHYSICS_TRANSFORM_STRIDE);
          count += 1;
        }
      }
      for (const body of bodies) {
        if (body instanceof CharacterBody3D) {
          body.writeKinematic(kinematic, count * PHYSICS_TRANSFORM_STRIDE);
          count += 1;
        }
      }
      for (const area of areas.values()) {
        area.writeKinematic(kinematic, count * PHYSICS_TRANSFORM_STRIDE);
        count += 1;
      }
      const input: IPhysicsInputSnapshot = {
        kinematicCount: count,
        kinematicTransforms: kinematic,
      };
      for (const buoyancy of buoyancies) buoyancy.apply(dt);
      simulation.step(dt, input);
      completedSteps += 1;

      visible = growFloat(visible, bodies.size + areas.size);
      // The simulation may own more bodies than this registry (the deprecated raw-world node
      // path and direct createBody are both reachable), so a small-buffer refusal grows the
      // bulk buffer instead of killing every future frame.
      let visibleResizeAttempts = 0;
      for (;;) {
        try {
          visibleCount = simulation.readVisibleTransforms(visible);
          break;
        } catch (error) {
          if (!isSmallBufferError(error) || visibleResizeAttempts >= PHYSICS_BUFFER_RESIZE_ATTEMPTS)
            throw error;
          visibleResizeAttempts += 1;
          visible = growFloat(visible, Math.ceil(visible.length / PHYSICS_TRANSFORM_STRIDE) * 2);
        }
      }
      for (let index = 0; index < visibleCount; index += 1) {
        const offset = index * PHYSICS_TRANSFORM_STRIDE;
        const id = visibleId(visible, offset);
        const body = bodiesById.get(id);
        if (body !== undefined) {
          body.applyTransform(visible, offset);
          continue;
        }
        // An unregistered body has no node to sync; that is what unregistered means.
        areas.get(id)?.applyTransform(visible, offset);
      }

      events = growEvents(events, bodies.size + areas.size);
      const maximumEventValues = Math.max(
        64,
        (bodies.size + areas.size) ** 2 * PHYSICS_COLLISION_EVENT_STRIDE,
      );
      let eventCount: number;
      for (;;) {
        try {
          eventCount = simulation.drainCollisionEvents(events);
          break;
        } catch (error) {
          if (!isSmallBufferError(error) || events.length >= maximumEventValues) throw error;
          events = new Uint32Array(Math.min(maximumEventValues, events.length * 2));
        }
      }
      for (let index = 0; index < eventCount; index += 1) {
        const offset = index * PHYSICS_COLLISION_EVENT_STRIDE;
        const left = events[offset];
        const right = events[offset + 1];
        const started = events[offset + 2] === 1;
        if (left === undefined || right === undefined)
          throw new Error("IPhysicsSimulation returned a malformed collision event.");
        const leftArea = areas.get(left);
        const rightArea = areas.get(right);
        const leftBody = bodiesById.get(left);
        const rightBody = bodiesById.get(right);
        const contactKey = left < right ? `${left}:${right}` : `${right}:${left}`;
        if (started) activeContacts.set(contactKey, left < right ? [left, right] : [right, left]);
        else activeContacts.delete(contactKey);
        if (leftArea !== undefined && rightBody !== undefined)
          leftArea.handleCollision(rightBody, started);
        if (rightArea !== undefined && leftBody !== undefined)
          rightArea.handleCollision(leftBody, started);
      }
      if (simulation.areaIntersections !== undefined) {
        for (const area of areas.values()) {
          const buffers = areaMembershipBuffers.get(area.body.id);
          if (buffers === undefined)
            throw new Error("Physics area membership buffers lost a registered area.");
          const current = buffers.current;
          current.clear();
          for (const bodyId of simulation.areaIntersections(area.body.id)) {
            const body = bodiesById.get(bodyId);
            if (body !== undefined) current.set(bodyId, body);
          }
          area.reconcileIntersections(current);
          buffers.current = buffers.previous;
          buffers.previous = current;
        }
      }
      kinematicMotions.clear();
    },
    // Disposing the bodies is not enough to make a restarted scene reproducible. The solver,
    // island manager and broad phase carry state from everything that has already happened, so
    // replaying an identical authored layout in a reused world settles differently -- measured
    // in a sandbox build as settle hashes a2f87bad vs 658eb6f8 at 240 vs 266 ticks, diverging
    // before any input. A scene therefore gets a pristine simulation, which makes restart
    // deterministic without a game having to discover an API for it.
    sceneExit: (ctx: ICtx<Record<string, unknown>, IPhysicsContext>) => {
      for (const buoyancy of [...buoyancies]) buoyancy.dispose();
      for (const area of [...areas.values()]) area.dispose();
      for (const body of [...bodies]) body.dispose();
      areaMembershipBuffers.clear();
      buoyancies.clear();
      kinematicMotions.clear();
      activeContacts.clear();
      debugSeries = [];
      if (options.deterministicRestart !== true) return;
      areas.clear();
      bodies.clear();
      bodiesById.clear();
      simulation?.dispose();
      const replacement = backend.createSimulation(options);
      simulation = replacement;
      context = buildContext(replacement);
      ctx.physics = context;
    },
    dispose: () => {
      unregisterObservations?.();
      unregisterObservations = undefined;
      for (const buoyancy of [...buoyancies]) buoyancy.dispose();
      for (const area of [...areas.values()]) area.dispose();
      for (const body of [...bodies]) body.dispose();
      areaMembershipBuffers.clear();
      buoyancies.clear();
      simulation?.dispose();
      simulation = undefined;
      context = undefined;
      areas.clear();
      bodies.clear();
      bodiesById.clear();
      kinematicMotions.clear();
      activeContacts.clear();
      debugSeries = [];
    },
  };

  function physicsObservations(
    ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
    runtime: NonNullable<Parameters<NonNullable<PhysicsPlugin["setup"]>>[1]>,
    request: IGameObservationSampleRequest,
  ): Record<string, unknown> {
    if (simulation === undefined) throw new Error("Physics observations sampled before setup.");
    if (request.include?.includes("physicsDebugSeries") !== true)
      return { physicsSteps: completedSteps };
    if (request.label !== undefined) {
      if (debugSeries.some(({ label }) => label === request.label)) {
        throw new Error(
          `TN_PHYSICS_DEBUG_LABEL_DUPLICATE: '${request.label}' was already sampled.`,
        );
      }
      if (debugSeries.length >= PHYSICS_DEBUG_SAMPLE_LIMIT) {
        throw new Error(
          `TN_PHYSICS_DEBUG_SAMPLE_LIMIT: at most ${PHYSICS_DEBUG_SAMPLE_LIMIT} labelled samples are retained.`,
        );
      }
      debugSeries.push({
        label: request.label,
        snapshot: physicsDebugSnapshot(ctx),
        tick: runtime.tick(),
      });
    }
    return {
      physicsDebugSeries: debugSeries.map((sample) => ({ ...sample })),
      physicsSteps: completedSteps,
    };
  }

  function physicsDebugSnapshot(
    ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  ): Record<string, unknown> {
    if (simulation === undefined) throw new Error("Physics observations sampled before setup.");
    const ordered = [...bodies].sort((left, right) => left.body.id - right.body.id);
    const retained = ordered.slice(0, PHYSICS_DEBUG_BODY_LIMIT);
    const retainedIds = new Set(retained.map(({ body }) => body.id));
    const entityById = new Map(
      retained.map((body) => [body.body.id, physicsEntityId(ctx, body)] as const),
    );
    sleepStates = growSleepStates(sleepStates, bodies.size + areas.size);
    const sleepCount = simulation.readBodySleepStates(sleepStates);
    const sleepingById = new Map<number, boolean>();
    for (let index = 0; index < sleepCount; index += 1) {
      const offset = index * PHYSICS_SLEEP_STATE_STRIDE;
      const id = sleepStates[offset];
      const sleeping = sleepStates[offset + 1];
      if (id === undefined || !Number.isInteger(id) || (sleeping !== 0 && sleeping !== 1)) {
        throw new Error("IPhysicsSimulation returned a malformed sleep-state record.");
      }
      sleepingById.set(id, sleeping === 1);
    }
    const positionById = new Map<number, readonly [number, number, number]>();
    for (let index = 0; index < visibleCount; index += 1) {
      const offset = index * PHYSICS_TRANSFORM_STRIDE;
      const id = visibleId(visible, offset);
      const position = [visible[offset + 1], visible[offset + 2], visible[offset + 3]];
      if (position.some((value) => value === undefined || !Number.isFinite(value))) {
        throw new Error("IPhysicsSimulation returned a malformed debug position.");
      }
      positionById.set(id, position as [number, number, number]);
    }
    const primitives: Array<Record<string, unknown>> = [];
    for (const body of retained) {
      const entity = entityById.get(body.body.id);
      if (entity === undefined) throw new Error("A retained physics body lost its entity id.");
      const sleeping = sleepingById.get(body.body.id) ?? false;
      primitives.push({
        category: "sleep",
        entity,
        id: `sleep:${entity}`,
        value: sleeping ? 1 : 0,
      });
      const position = positionById.get(body.body.id);
      if (position !== undefined) {
        primitives.push({ category: "center-of-mass", entity, position });
      }
    }
    for (const [left, right] of activeContacts.values()) {
      if (!retainedIds.has(left) || !retainedIds.has(right)) continue;
      primitives.push({
        category: "contact",
        id: `${entityById.get(left)}:${entityById.get(right)}`,
      });
    }
    return {
      artifact: {
        overflow: {
          bodyLimit: PHYSICS_DEBUG_BODY_LIMIT,
          omittedBodies: Math.max(0, ordered.length - retained.length),
          totalBodies: ordered.length,
        },
        primitives,
      },
    };
  }

  function removeContactsFor(bodyId: number): void {
    for (const [key, pair] of activeContacts) {
      if (pair.includes(bodyId)) activeContacts.delete(key);
    }
  }
}

function growSleepStates(
  buffer: Float32Array<ArrayBufferLike>,
  bodyCount: number,
): Float32Array<ArrayBufferLike> {
  const required = bodyCount * PHYSICS_SLEEP_STATE_STRIDE;
  if (buffer.length >= required) return buffer;
  return new Float32Array(Math.max(required, buffer.length * 2));
}

function physicsEntityId(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  body: PhysicsBody3D,
): string {
  const object = body.object;
  const stableId = body.body.entity ?? `physics.body.${body.body.id}`;
  for (const id of Object.keys(ctx.entities.snapshot())) {
    const entity = ctx.entities.get(id);
    if (entity === body || (object !== undefined && entity === object)) return id;
    if (
      entity !== undefined &&
      Object.values(entity).some(
        (value) => value === body || (object !== undefined && value === object),
      )
    ) {
      return id;
    }
  }
  return stableId;
}
