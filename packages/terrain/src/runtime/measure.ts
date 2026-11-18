import { VirtualShadowNode } from "@threenative/core";
import type { IRaycastOptions } from "@threenative/core";
import type { CharacterBody3D, IPhysicsContext } from "@threenative/physics";
import { CollisionShape3D } from "@threenative/physics";
import type { Box3 } from "three";
import {
  Frustum,
  InstancedMesh,
  type Intersection,
  Matrix4,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  Vector3,
} from "three";

/**
 * What one scene measures about the player, the ground and the props, step by step.
 *
 * The scene builds the world and calls `step()` from its physics hook; the counters and the probes
 * live here. Each probe fails closed by the same rule the scene had: a contact the run cannot
 * observe throws rather than publishing a healthy-looking zero.
 */
export interface IMeasureOptions {
  readonly world: string;
  readonly physics: IPhysicsContext;
  readonly raycast: (options: IRaycastOptions) => Intersection | undefined;
  readonly actor: Mesh;
  readonly player: CharacterBody3D;
  /** The baked world's own size, in metres: the square the player can walk off. */
  readonly size: number;
  readonly mesh: Mesh | undefined;
  /** The drawn triangles of the staged world's ground, when the run draws a staged world. */
  readonly stage: IStagedWorld | undefined;
  /** The invisible asymmetric fixture the bilinear-difference probe walks. */
  readonly fixture: { heightAt: (x: number, z: number) => number };
  readonly probeMesh: Mesh;
  /** True while the figure plays a swim clip: the playtest reads swimming that way. */
  readonly swimmingClip: () => boolean;
  /** True once the scene holds prop colliders to probe. */
  readonly hasPropColliders: () => boolean;
  readonly eye: () => Vector3;
  readonly camera: () => PerspectiveCamera;
  readonly ocean: IOceanSample | undefined;
  readonly spawnReady: () => boolean;
  readonly terrainTargets: () => Object3D | readonly Object3D[] | undefined;
  readonly view: () => string;
}

interface IStagedWorld {
  readonly world: {
    stats: () => unknown;
    traverseVisible: (callback: (object: Object3D) => void) => void;
  };
  readonly ground: { readonly body: { readonly id: number | string } };
}

interface IOceanSample {
  readonly steps: number;
  readonly sampleHeight: (x: number, z: number) => { readonly height: number } | undefined;
}

/** The measurements a scene publishes each time `publish` runs. */
export interface IMeasureFacts {
  readonly travel: number;
  readonly straightTravel: number;
  readonly edgeOvershoot: number;
  readonly grounded: boolean;
  readonly propOverlapFrames: number;
  readonly swimming: boolean;
  readonly immersionDepth: number;
  readonly swimSamples: number;
  readonly swimFloatSamples: number;
  readonly swimExits: number;
  readonly swimDrift: number;
  readonly contactSamples: number;
  readonly maxContactError: number;
  readonly bilinearDifference: number;
  readonly oceanSteps: number;
  readonly waveSamples: number;
  readonly waveRange: number;
  readonly sampleSlopeRange: number;
  readonly propCounts: {
    readonly draws: number;
    readonly instances: number;
    readonly triangles: number;
  };
  readonly coverNearEye: number;
  readonly coverFar: number;
  readonly farForestInView: number;
}

export interface IMeasure {
  /** One fixed physics step: travel, contact, the edge, the swim and the water's own samples. */
  readonly step: () => void;
  /** The drawn prop counts and the cover in front of the eye, every thirtieth step. */
  readonly countProps: (meshes: InstancedMesh[], farWorld: Object3D | undefined) => void;
  readonly facts: () => IMeasureFacts;
}

/**
 * The asymmetric fixture: eight seeded points where a bilinear height and the drawn triangle disagree,
 * walked by both paths — the picker's triangles and the solver's own ray. It throws when either path
 * answers nothing, because a run that cannot see the ground must not publish a healthy zero.
 */
export interface IContactProbeOptions {
  readonly mesh: { updateMatrixWorld: (force?: boolean) => unknown } | undefined;
  readonly probeMesh: { updateMatrixWorld: (force?: boolean) => unknown };
  readonly raycast: (options: IRaycastOptions) => Intersection | undefined;
  readonly physics: IPhysicsContext;
  readonly fixture: { heightAt: (x: number, z: number) => number };
}

export interface IContactWitness {
  readonly bilinearDifference: number;
  readonly contactSamples: number;
  readonly maxContactError: number;
}

export function witnessAsymmetricContact(options: IContactProbeOptions): IContactWitness {
  options.probeMesh.updateMatrixWorld(true);
  options.mesh?.updateMatrixWorld(true);
  let maxContactError = 0;
  let bilinearDifference = 0;
  let contactSamples = 0;
  const points = [
    [-7.75, -7.75],
    [-7.25, -7.25],
    [-7.75, -7.25],
    [-7.25, -7.75],
    [-8, -8],
    [-7, -8],
    [0, 0],
    [7.5, 7.5],
  ];
  for (const [x, z] of points) {
    const wx = 600 + (x as number);
    const visual = options.raycast({
      origin: new Vector3(wx, 200, z),
      direction: new Vector3(0, -1, 0),
      targets: options.probeMesh as Object3D,
    });
    const physical = options.physics.directSpaceState.intersectRay({
      from: { x: wx, y: 200, z: z as number },
      to: { x: wx, y: -100, z: z as number },
      collisionMask: 2,
    });
    if (!visual || !physical) throw new Error("Missing asymmetric terrain contact");
    maxContactError = Math.max(maxContactError, Math.abs(visual.point.y - physical.position.y));
    bilinearDifference = Math.max(
      bilinearDifference,
      Math.abs(visual.point.y - options.fixture.heightAt(x as number, z as number)),
    );
    contactSamples++;
  }
  return { bilinearDifference, contactSamples, maxContactError };
}

/**
 * The per-world measurement: contacts, travel, edge overshoot, water and the frame facts a run
 * reports.
 *
 * @requires npm i -D @threenative/terrain @threenative/physics
 * @situation measure one played starter world every fixed step
 * @constraint the game supplies the actor, the player body and the probe fixture; it owns no look
 * @example const measure = createMeasure({ world, physics: ctx.physics, raycast, actor, player, ...options });
 */
export function createMeasure(options: IMeasureOptions): IMeasure {
  const { actor, physics, player } = options;
  const previous = actor.position.clone();
  const origin = actor.position.clone();
  // The owner's report, measured the same with or without prop collision: frames in which the
  // player's capsule, less a 5 cm skin, crosses into a rock or trunk body.
  const propProbe = CollisionShape3D.capsule(0.5, 0.3);
  const farFrustum = new Frustum();
  const farMatrix = new Matrix4();
  const farPoint = new Vector3();
  let travel = 0;
  let straightTravel = 0;
  let propOverlapFrames = 0;
  // Metres past the playable square's edge the player reached: onto the surroundings' hills.
  let edgeOvershoot = Number.NEGATIVE_INFINITY;
  // Swimming as the playtest reads it: samples swimming with a swim clip on, those of them off
  // the bed, and how many times the player climbed back out.
  let swimSamples = 0;
  let swimFloatSamples = 0;
  let swimExits = 0;
  let swimDrift = 0;
  let wasSwimming = false;
  let contactSamples = 0;
  let maxContactError = 0;
  let bilinearDifference = 0;
  let waveSamples = 0;
  let minWave = Number.POSITIVE_INFINITY;
  let maxWave = Number.NEGATIVE_INFINITY;
  let minSlope = Number.POSITIVE_INFINITY;
  let maxSlope = Number.NEGATIVE_INFINITY;
  let propCounts = { draws: 0, instances: 0, triangles: 0 };
  let coverNearEye = 0;
  let coverFar = 0;
  let farForestInView = 0;
  let frames = 0;

  const step = (): void => {
    const dx = actor.position.x - previous.x;
    const dz = actor.position.z - previous.z;
    travel += Math.hypot(dx, dz);
    previous.copy(actor.position);
    straightTravel = Math.max(
      straightTravel,
      Math.hypot(actor.position.x - origin.x, actor.position.z - origin.z),
    );
    // What the water moved, not what the keys moved: the share of this step's travel along the
    // current, counted only while swimming with no input of the player's own. 0 with
    // `?current=off`, which is its before arm.
    if (player.swimming && player.velocity.x === 0 && player.velocity.z === 0) {
      const { x: cx, z: cz } = player.currentVelocity;
      const speed = Math.hypot(cx, cz);
      if (speed > 0) swimDrift += (dx * cx + dz * cz) / speed;
    }
    if (
      options.hasPropColliders() &&
      physics.directSpaceState.intersectShape({
        shape: propProbe,
        position: actor.position,
        collisionMask: 16,
        maxResults: 1,
      }).length > 0
    )
      propOverlapFrames++;
    // Query actual triangles, not bilinear interpolation, after the shared solver step.
    if (frames === 0) {
      const witness = witnessAsymmetricContact({
        mesh: options.mesh,
        probeMesh: options.probeMesh,
        raycast: options.raycast,
        physics,
        fixture: options.fixture,
      });
      contactSamples = witness.contactSamples;
      maxContactError = Math.max(maxContactError, witness.maxContactError);
      bilinearDifference = Math.max(bilinearDifference, witness.bilinearDifference);
    }
    // A staged world admits no terrain tile before its first update, which the loop's settle
    // steps precede, so its contact is observed once its spawn region is ready.
    // A staged world streams around the camera, so a benchmark view far from the player has no
    // ground under it; the player is held there (see the scene) and its contact is not asked for.
    // Past the square the player stands on the surroundings, whose collider is their drawn
    // triangles (see the walls the scene builds): physics alone answers there, and no picking tree
    // is built.
    const onSurroundings =
      options.stage === undefined &&
      Math.max(Math.abs(actor.position.x), Math.abs(actor.position.z)) > options.size / 2 - 1;
    edgeOvershoot = Math.max(
      edgeOvershoot,
      Math.max(Math.abs(actor.position.x), Math.abs(actor.position.z)) - options.size / 2,
    );
    if (player.swimming && options.swimmingClip()) swimSamples++;
    if (player.swimming && !player.grounded) swimFloatSamples++;
    if (wasSwimming && !player.swimming) swimExits++;
    wasSwimming = player.swimming;
    if (options.stage === undefined || (options.spawnReady() && options.view() === "player")) {
      const terrainTargets = options.terrainTargets();
      const visual =
        !onSurroundings &&
        terrainTargets &&
        options.raycast({
          origin: new Vector3(actor.position.x, 300, actor.position.z),
          direction: new Vector3(1, -400, 1).normalize(),
          targets: terrainTargets,
        });
      // The same line as the visual ray, started a metre above the feet: from 300 m, a stage
      // tree the player stands against is the first body under it, not the ground.
      const start = options.stage || onSurroundings ? actor.position.y + 1 : 300;
      const lead = (300 - start) / 400;
      const physical = physics.directSpaceState.intersectRay({
        from: { x: actor.position.x + lead, y: start, z: actor.position.z + lead },
        to: { x: actor.position.x + 1, y: -100, z: actor.position.z + 1 },
        // The kit's ground keeps the default layer; here the ground alone, not a rock beside it.
        collisionMask: options.stage ? 1 : 8,
      });
      if (
        (!visual && !onSurroundings) ||
        !physical ||
        (options.stage && physical.body.id !== options.stage.ground.body.id)
      )
        throw new Error(
          `Missing playable terrain contact: world=${options.world}, frame=${frames}, player=${actor.position.toArray()}, visual=${!!visual}, physical=${!!physical}, body=${physical?.body.id}:${physical?.body.entity}, expectedGround=${options.stage?.ground.body.id}, terrain=${options.mesh?.position.toArray() ?? "stage"}`,
        );
      if (visual) {
        maxContactError = Math.max(maxContactError, Math.abs(visual.point.y - physical.position.y));
        contactSamples++;
      }
    }
    const wave = options.ocean?.sampleHeight(130, 140);
    const east = options.ocean?.sampleHeight(131, 140);
    if (wave && east) {
      waveSamples++;
      minWave = Math.min(minWave, wave.height);
      maxWave = Math.max(maxWave, wave.height);
      // Stale CPU sample slopes are a proxy; they do not qualify rendered normals.
      const slope = east.height - wave.height;
      minSlope = Math.min(minSlope, slope);
      maxSlope = Math.max(maxSlope, slope);
    }
    frames++;
  };

  const countProps = (meshes: InstancedMesh[], farWorld: Object3D | undefined): void => {
    propCounts = {
      draws: meshes.length,
      instances: meshes.reduce((sum, draw) => sum + draw.count, 0),
      triangles: meshes.reduce(
        (sum, draw) => sum + (draw.count * (draw.geometry.index?.count ?? 0)) / 3,
        0,
      ),
    };
    // What the vista's meadow puts in front of the eye; skipped in the player view.
    coverNearEye = 0;
    coverFar = 0;
    if (options.view() !== "player") {
      const eye = options.eye();
      for (const draw of meshes) {
        const grass = /^(grass|meadow):/.test(draw.name);
        const local = draw.instanceMatrix.array;
        const world = draw.matrixWorld.elements;
        for (let i = 0; i < draw.count; i++) {
          const x = local[i * 16 + 12] as number;
          const y = local[i * 16 + 13] as number;
          const z = local[i * 16 + 14] as number;
          const dx =
            (world[0] as number) * x +
            (world[4] as number) * y +
            (world[8] as number) * z +
            (world[12] as number) -
            eye.x;
          const dz =
            (world[2] as number) * x +
            (world[6] as number) * y +
            (world[10] as number) * z +
            (world[14] as number) -
            eye.z;
          const square = dx * dx + dz * dz;
          if (square < 1600) coverNearEye++;
          if (grass && square >= 10000 && square < 40000) coverFar++;
        }
      }
    }
    // The far forest's drawn instances whose root is inside the camera's frustum.
    farForestInView = 0;
    if (farWorld && options.view() !== "player") {
      const camera = options.camera();
      camera.updateMatrixWorld(true);
      farFrustum.setFromProjectionMatrix(
        farMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        camera.coordinateSystem,
      );
      farWorld.traverse((node) => {
        if (!(node instanceof InstancedMesh) || !node.visible || !node.layers.isEnabled(0)) return;
        const local = node.instanceMatrix.array;
        for (let i = 0; i < node.count; i++) {
          farPoint
            .set(
              local[i * 16 + 12] as number,
              local[i * 16 + 13] as number,
              local[i * 16 + 14] as number,
            )
            .applyMatrix4(node.matrixWorld);
          if (farFrustum.containsPoint(farPoint)) farForestInView++;
        }
      });
    }
  };

  return {
    step,
    countProps,
    facts: () => ({
      travel,
      straightTravel,
      edgeOvershoot,
      grounded: player.grounded,
      propOverlapFrames,
      swimming: player.swimming,
      immersionDepth: player.immersionDepth,
      swimSamples,
      swimFloatSamples,
      swimExits,
      swimDrift,
      contactSamples,
      maxContactError,
      bilinearDifference,
      oceanSteps: options.ocean?.steps ?? 0,
      waveSamples,
      waveRange: waveSamples ? maxWave - minWave : 0,
      sampleSlopeRange: waveSamples ? maxSlope - minSlope : 0,
      propCounts,
      coverNearEye,
      coverFar,
      farForestInView,
    }),
  };
}

/**
 * What the reveal cost, measured from the frame it completes: batches published in view, shadows
 * invalidated, impostors still pending, and every pipeline the device created since.
 *
 * One source counts the pipelines, picked at the reveal: three's census on its backend, else the
 * owned engine's own compile count. The owned engine builds pipelines inside Wasm, where the census
 * sees none and stays incomplete.
 */
export interface IRevealProbeOptions {
  readonly camera: () => PerspectiveCamera;
  readonly pipelineCensus: () =>
    | { readonly complete: boolean; readonly counts: { readonly deviceCreations?: number } }
    | undefined;
  readonly engineCompiles: () => number | undefined;
  /** True while a loading overlay covers the world: the reveal has not happened yet. */
  readonly covered: () => boolean;
  readonly phase: () => string;
  readonly shadowNode: () => unknown;
  /** Impostors still pending across every streamed world. */
  readonly pendingImpostors: () => number;
  readonly released: () => boolean;
  readonly afterPhysics: (callback: () => void) => unknown;
  readonly revealed: () => void;
}

export interface IRevealProbe {
  /** The loading screen reported its reveal: take the baseline this probe measures against. */
  readonly initialize: () => void;
  /** A props batch was published; count it when the reveal frustum holds it. */
  readonly publishedBatch: (bounds: Box3) => void;
  /** The measured numbers as plain data: the run report's `props.reveal` readout. */
  readonly readout: () => Readonly<Record<string, number | string | boolean>>;
}

/**
 * What the loading reveal showed once the curtain lifts: drawn batches, pipelines and impostor
 * readiness, measured against the reveal's own baseline.
 *
 * @requires npm i -D @threenative/terrain
 * @situation measure whether the spawn drew before the curtain released it
 * @example const reveal = createRevealProbe({ camera, covered, phase, released, ...options });
 */
export function createRevealProbe(options: IRevealProbeOptions): IRevealProbe {
  const reveal = {
    startedMs: -1,
    elapsedMs: 0,
    complete: false,
    samples: 0,
    publishedBatchesInView: -1,
    shadowInvalidated: -1,
    impostorPendingPeak: -1,
    pipelinesCreated: -1,
    pipelineCensusAvailable: false,
    pipelineSource: "none",
    // Device pipeline creations from the reveal to now, for the whole session: a walk and a
    // camera turn must build none either (`playtests/loop.playtest.json`). -1: not measured.
    pipelinesSinceReveal: -1,
  };
  let shadowAtReveal = -1;
  let pipelinesAtReveal: number | undefined;
  let pipelineSource: "census" | "engine" | undefined;
  const frustum = new Frustum();
  const matrix = new Matrix4();
  const idle = (): boolean =>
    options.released() || reveal.complete || reveal.startedMs < 0 || options.covered();
  const shadows = (): { readonly stats: { readonly byInvalidation: number } } => {
    const node = options.shadowNode();
    if (!(node instanceof VirtualShadowNode))
      throw new Error("Reveal probe requires virtual shadows");
    return node;
  };
  const pipelineCount = (source: typeof pipelineSource): number | undefined => {
    if (source === "census") {
      const census = options.pipelineCensus();
      return census?.complete === true ? census.counts.deviceCreations : undefined;
    }
    return source === "engine" ? options.engineCompiles() : undefined;
  };
  const initialize = (): void => {
    if (options.released() || reveal.complete || reveal.startedMs >= 0) return;
    if (options.covered() || options.phase() !== "ready")
      throw new Error("Reveal probe requires ready props and an uncovered world");
    const node = shadows();
    pipelineSource = pipelineCount("census") !== undefined ? "census" : "engine";
    reveal.startedMs = performance.now();
    reveal.publishedBatchesInView = 0;
    shadowAtReveal = node.stats.byInvalidation;
    pipelinesAtReveal = pipelineCount(pipelineSource);
    if (pipelinesAtReveal !== undefined) reveal.pipelineSource = pipelineSource;
    const camera = options.camera();
    camera.updateMatrixWorld(true);
    frustum.setFromProjectionMatrix(
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
    );
  };
  options.afterPhysics(() => {
    if (idle() || options.phase() !== "ready") return;
    const node = shadows();
    const creations = pipelineCount(pipelineSource);
    reveal.samples++;
    reveal.elapsedMs = performance.now() - reveal.startedMs;
    reveal.shadowInvalidated = node.stats.byInvalidation - shadowAtReveal;
    reveal.impostorPendingPeak = Math.max(reveal.impostorPendingPeak, options.pendingImpostors());
    reveal.pipelineCensusAvailable = creations !== undefined && pipelinesAtReveal !== undefined;
    if (creations !== undefined && pipelinesAtReveal !== undefined)
      reveal.pipelinesCreated = creations - pipelinesAtReveal;
    reveal.complete = reveal.elapsedMs >= 3000;
    if (reveal.complete) options.revealed();
  });
  options.afterPhysics(() => {
    if (options.released() || pipelinesAtReveal === undefined) return;
    const creations = pipelineCount(pipelineSource);
    reveal.pipelinesSinceReveal = creations === undefined ? -1 : creations - pipelinesAtReveal;
  });
  return {
    initialize,
    readout: () => ({ ...reveal }),
    publishedBatch: (bounds) => {
      if (reveal.startedMs < 0 || reveal.complete) return;
      if (frustum.intersectsBox(bounds)) reveal.publishedBatchesInView++;
    },
  };
}
