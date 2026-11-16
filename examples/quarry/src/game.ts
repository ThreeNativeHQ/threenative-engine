// The quarry: a first-person walk through geometry far denser than the screen can resolve, built
// as the instrument PRD-280 asks for. It is graded as a measurement, not as a game — but it is
// walkable, because popping and cracks are found by eye at eye height long before a test finds
// them, and `?mode=free` is the cheapest crack detector this batch will ever have.
import {
  ClusteredBatch,
  ClusteredMesh,
  type ICtx,
  InstancedBatch,
  Scene,
  type SceneFrame,
  defineGame,
} from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type Group, type Mesh, Vector3 } from "three";
import {
  type QuarryArm,
  type QuarryMode,
  armFromLocation,
  bodiesModelPath,
  modeFromLocation,
  poseFrameFromLocation,
  viewCullFromLocation,
} from "./quarry/arm.js";
import { BOULDER_SUBDIVISIONS, boulderPlacements } from "./quarry/bodies.js";
import { EYE_HEIGHT, ROUTE_FRAMES, ROUTE_MARKS, routePose } from "./quarry/route.js";
import { floorHeight } from "./quarry/terrain.js";
import { createQuarryLook } from "./render/look.js";

const FLOOR_MODEL = "assets/quarry-floor.glb";
/** Metres per second in `free` mode. Route mode ignores this entirely. */
const WALK_SPEED = 7;
/**
 * Whether the route draws only what the view holds. `?viewCull=off` is PRD-600's measurement arm and
 * is the only difference between the two runs it compares.
 */
const VIEW_CULL = viewCullFromLocation();
/** The route frame `?mode=pose` stands on; the same pose in every run, so a pair is comparable. */
const POSE_FRAME = poseFrameFromLocation();
const LOOK_SPEED = 0.0022;

export interface IQuarryState extends Record<string, unknown> {
  arm: string;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  drawCalls: number;
  frame: number;
  mark: string;
  /** The pose at the last named route frame, held until the next one. */
  markX: number;
  markY: number;
  markZ: number;
  mode: string;
  routeComplete: boolean;
  triangles: number;
}

interface IQuarryOptions {
  readonly arm: QuarryArm;
  readonly mode: QuarryMode;
}

/**
 * Straight down over the middle of the pit, where nothing but the control surface is in frame.
 *
 * AC5's whole claim is that the floor's pixels do not move between arms, and the only way to say
 * that is to look at a frame that holds nothing else.
 */
const CONTROL_EYE = [0, 3.5, 0] as const;
/**
 * Tilted off vertical rather than straight down. Straight down over flat rubble is a frame of one
 * luminance, which the harness's blank-capture guard rejects — correctly, since it cannot tell a
 * deliberately flat frame from a failed one. The tilt still keeps every body outside the frame:
 * the top of a 60-degree view pitched 58 degrees down meets the ground 6.6 m out, and nothing is
 * placed within twelve.
 */
const CONTROL_TARGET = [0, 0, 2.2] as const;

interface IRendererInfo {
  // `calls` is renders since the app started and `frameCalls` is renders this frame; `drawCalls`
  // is the one that answers "how many draws did this frame submit". Reading `calls` reports a
  // number that climbs forever and looks like a per-frame regression.
  render?: { drawCalls?: number; triangles?: number };
}

function meshNamed(root: Group, name: string): Mesh {
  let found: Mesh | undefined;
  root.traverse((child) => {
    if (found === undefined && (child as Mesh).isMesh === true && child.name === name)
      found = child as Mesh;
  });
  // Fails closed. A missing body would otherwise draw a quarry with a hole in it and report a
  // frame time for a scene that is not the one being compared.
  if (found === undefined)
    throw new Error(`TN_QUARRY_BODY_MISSING: no mesh named '${name}' in the loaded model.`);
  return found;
}

function createQuarryScene(options: IQuarryOptions): new () => Scene<IQuarryState> {
  return class QuarryScene extends Scene<IQuarryState> {
    static override readonly initialState: IQuarryState = {
      arm: options.arm,
      cameraX: 0,
      cameraY: 0,
      cameraZ: 0,
      drawCalls: 0,
      frame: 0,
      mark: "start",
      markX: 0,
      markY: 0,
      markZ: 0,
      mode: options.mode,
      routeComplete: false,
      triangles: 0,
    };

    #floorModel: Group | undefined;
    #bodiesModel: Group | undefined;
    #drawCalls = 0;
    #triangles = 0;

    // Loading belongs here rather than in `enter`, which is synchronous by contract: a scene that
    // returned a promise from `enter` would have its frame callback ignored.
    override async load(ctx: ICtx<IQuarryState>): Promise<void> {
      const [floorModel, bodiesModel] = await Promise.all([
        ctx.assets.model<{ scene: Group }>(FLOOR_MODEL),
        ctx.assets.model<{ scene: Group }>(bodiesModelPath(options.arm)),
      ]);
      this.#floorModel = floorModel.scene;
      this.#bodiesModel = bodiesModel.scene;
    }

    override enter(ctx: ICtx<IQuarryState>): SceneFrame<IQuarryState> {
      const look = createQuarryLook(ctx.scene, ctx.camera);
      const floorModel = this.#floorModel;
      const bodiesModel = this.#bodiesModel;
      if (floorModel === undefined || bodiesModel === undefined)
        throw new Error("TN_QUARRY_NOT_LOADED: enter ran before load resolved.");

      // The control surface. One set of bytes, one material, in every arm — AC5 is only provable
      // if the floor is literally the same file.
      const floor = meshNamed(floorModel, "floor");
      floor.material = look.floor;
      ctx.add(floor);

      const cliff = meshNamed(bodiesModel, "cliff");
      cliff.material = look.cliff;
      ctx.add(cliff);

      const gantry = meshNamed(bodiesModel, "gantry");
      gantry.material = look.gantry;
      ctx.add(gantry);

      const grating = meshNamed(bodiesModel, "grating");
      grating.material = look.grating;
      ctx.add(grating);

      if (!VIEW_CULL)
        for (const body of [cliff, gantry, grating])
          if (body instanceof ClusteredMesh) body.viewCull = false;

      // Six sources, ~400 instances: many copies of few bodies, which is the case that tests
      // per-instance and per-cluster rejection together.
      const placements = boulderPlacements();
      for (let source = 0; source < BOULDER_SUBDIVISIONS.length; source += 1) {
        const template = meshNamed(bodiesModel, `boulder-${source}`);
        // In the `virtual` arm the loader handed back a `ClusteredMesh`, so the copies go through
        // `ClusteredBatch` and each distance group draws its own cut — and nothing in this file
        // calls the cut, because the engine does. In every other arm they are one `InstancedBatch`
        // drawing the same triangles at every distance, which is what a game does today and what
        // this arm has to beat.
        const clustered = template instanceof ClusteredMesh ? template : undefined;
        const batch =
          clustered === undefined
            ? new InstancedBatch({ geometry: template.geometry, material: look.boulder })
            : new ClusteredBatch({
                geometry: clustered.geometry,
                material: look.boulder,
                table: clustered.table,
                viewCull: VIEW_CULL,
              });
        for (const placement of placements) {
          if (placement.source !== source) continue;
          batch.place({
            position: [placement.x, placement.y, placement.z],
            rotation: [0, placement.rotationY, 0],
            scale: placement.scale,
          });
        }
        batch.build({ name: `boulders-${source}`, parent: ctx.scene });
        // The template itself is never added to the scene; the batch draws every copy. A clustered
        // template left in the graph would draw a boulder at the origin as well.
        if (clustered !== undefined) clustered.removeFromParent();
      }

      const eye = new Vector3();
      const gaze = new Vector3();
      /** The re-cut each clustered mesh had last reported, so one cut is counted once. */
      const recutSeen = new Map<ClusteredMesh, number>();
      // The route starts on a press, not on the first frame. Loading a 12.5 MB body takes hundreds
      // of frames longer than loading a 1.2 MB one, and a walk that began during the load would
      // have each arm measured on a different stretch of the same route.
      let started = options.mode === "free" || options.mode === "pose";
      let frame = 0;
      let yaw = Math.PI;
      let pitch = 0;
      const free = new Vector3(0, floorHeight(0, 20) + EYE_HEIGHT, 20);

      return (frameCtx, dt) => {
        if (!started && frameCtx.input.justPressed("start")) started = true;
        if (options.mode === "control") {
          frameCtx.camera.position.set(
            CONTROL_EYE[0],
            floorHeight(CONTROL_EYE[0], CONTROL_EYE[2]) + CONTROL_EYE[1],
            CONTROL_EYE[2],
          );
          frameCtx.camera.lookAt(
            CONTROL_TARGET[0],
            floorHeight(CONTROL_TARGET[0], CONTROL_TARGET[2]),
            CONTROL_TARGET[2],
          );
        } else if (options.mode === "pose") {
          const pose = routePose(Math.min(POSE_FRAME, ROUTE_FRAMES));
          eye.set(pose.position[0], pose.position[1], pose.position[2]);
          gaze.set(pose.target[0], pose.target[1], pose.target[2]);
          frameCtx.camera.position.copy(eye);
          frameCtx.camera.lookAt(gaze);
        } else if (options.mode === "route") {
          const pose = routePose(Math.min(frame, ROUTE_FRAMES));
          eye.set(pose.position[0], pose.position[1], pose.position[2]);
          gaze.set(pose.target[0], pose.target[1], pose.target[2]);
          frameCtx.camera.position.copy(eye);
          frameCtx.camera.lookAt(gaze);
        } else {
          const relative = frameCtx.input.raw.pointer.relative;
          yaw -= relative.x * LOOK_SPEED;
          pitch = Math.max(-1.4, Math.min(1.4, pitch - relative.y * LOOK_SPEED));
          const move = frameCtx.input.vector("move");
          free.x += (Math.sin(yaw) * move.y + Math.cos(yaw) * move.x) * WALK_SPEED * dt;
          free.z += (Math.cos(yaw) * move.y - Math.sin(yaw) * move.x) * WALK_SPEED * dt;
          // The ten lines of grounding PRD-280 §2 budgets for, against the same height field the
          // floor's triangles came from.
          free.y = floorHeight(free.x, free.z) + EYE_HEIGHT;
          frameCtx.camera.position.copy(free);
          frameCtx.camera.lookAt(
            free.x + Math.sin(yaw) * Math.cos(pitch),
            free.y + Math.sin(pitch),
            free.z + Math.cos(yaw) * Math.cos(pitch),
          );
        }

        // Every two seconds of route, what the renderer is holding. The virtual arm's first runs
        // exhausted an 8 GB card and this marker is how that was found: `indexAttributes` climbing
        // by 74 every 120 frames, which is three never freeing an index buffer that was replaced.
        if (frame > 0 && frame % 120 === 0) {
          let geometries = 0;
          let indexBytes = 0;
          let attributeBytes = 0;
          const seen = new Set<unknown>();
          frameCtx.scene.traverse((object) => {
            const geometry = (object as { geometry?: import("three").BufferGeometry }).geometry;
            if (geometry === undefined || seen.has(geometry)) return;
            seen.add(geometry);
            geometries += 1;
            indexBytes += geometry.getIndex()?.array.byteLength ?? 0;
            for (const attribute of Object.values(geometry.attributes))
              attributeBytes += (attribute as { array: { byteLength: number } }).array.byteLength;
          });
          console.log(
            `TN_QUARRY_MEM:${JSON.stringify({ attributeBytes, frame, geometries, indexBytes, info: (frameCtx.renderer as unknown as { info?: { memory?: unknown } }).info?.memory })}`,
          );
        }

        // What the view does not hold, read off the standing cut. PRD-600's gate is the share of the
        // submitted triangles that lie wholly outside the camera's frustum, so it is printed on the
        // same 30-frame cadence as the frame budget's windows and `measure` takes the median over the
        // same steady ones. Nothing is culled by this: it only says how much there is to cull.
        if (frame > 0 && frame % 30 === 0) {
          let triangles = 0;
          let outsideTriangles = 0;
          let clusters = 0;
          let outsideClusters = 0;
          let copies = 0;
          let outsideCopies = 0;
          let recutSamples = 0;
          let recutMs = 0;
          let recutBytes = 0;
          frameCtx.scene.traverse((object) => {
            if (object instanceof ClusteredMesh) {
              triangles += object.drawnTriangles;
              outsideTriangles += object.drawnTrianglesOutsideView;
              clusters += object.drawnClusters;
              outsideClusters += object.drawnClustersOutsideView;
              const seen = recutSeen.get(object) ?? 0;
              if (object.recutCount > seen) {
                recutSeen.set(object, object.recutCount);
                recutSamples += 1;
                recutMs += object.recutMs;
                recutBytes += object.recutBytes;
              }
              return;
            }
            const batch = (object as { batch?: ClusteredBatch }).batch;
            if (!(batch instanceof ClusteredBatch)) return;
            triangles += batch.drawnTriangles;
            outsideTriangles += batch.drawnTrianglesOutsideView;
            copies += batch.count;
            outsideCopies += batch.drawnCopiesOutsideView;
          });
          console.log(
            `TN_CLUSTER_VIEW:${JSON.stringify({
              copies,
              frame,
              outsideClusters,
              outsideCopies,
              outsideTriangles,
              recutBytes,
              recutMs,
              recutSamples,
              triangles,
            })}`,
          );
        }

        const mark =
          options.mode === "pose"
            ? { frame, label: "pose" }
            : ROUTE_MARKS.find((candidate) => candidate.frame === frame);
        frameCtx.state.set({
          cameraX: round(frameCtx.camera.position.x),
          cameraY: round(frameCtx.camera.position.y),
          cameraZ: round(frameCtx.camera.position.z),
          drawCalls: this.#drawCalls,
          frame,
          ...(mark === undefined
            ? {}
            : {
                mark: mark.label,
                markX: round(frameCtx.camera.position.x),
                markY: round(frameCtx.camera.position.y),
                markZ: round(frameCtx.camera.position.z),
              }),
          routeComplete: frame >= ROUTE_FRAMES,
          triangles: this.#triangles,
        });
        // Flushed on the named frames so a scenario can assert the pose at a frame rather than
        // whenever the store next happened to publish.
        if (mark !== undefined || frame === ROUTE_FRAMES) frameCtx.state.flush();
        if (started) frame += 1;
      };
    }

    /**
     * Read here rather than in the frame callback because `Scene.render` runs immediately after
     * `renderer.render()`, which is the only moment the per-frame counters hold this frame's
     * numbers. Read a step earlier and a scene reports whatever the previous render left behind.
     */
    override render(ctx: ICtx<IQuarryState>): void {
      const info = ctx.renderer.info as IRendererInfo;
      this.#drawCalls = info.render?.drawCalls ?? 0;
      this.#triangles = info.render?.triangles ?? 0;
    }
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function createQuarryGame(options: IQuarryOptions) {
  return defineGame<IQuarryState>({
    step: 1 / 60,
    // The default 300-presented-frame window is thirty seconds of a scene that runs at ten frames
    // a second, which is one window for a whole route and no steady window at all — and on the
    // desktop lane, where the bridge steps several simulation ticks per presented frame, even
    // sixty left one window and nothing steady to report. Thirty still averages a hitch away.
    frameBudget: { reportEvery: 30 },
    input: {
      start: { keys: ["Space"] },
      move: {
        down: ["KeyS", "ArrowDown"],
        left: ["KeyA", "ArrowLeft"],
        pointerRelative: true,
        right: ["KeyD", "ArrowRight"],
        up: ["KeyW", "ArrowUp"],
      },
    },
    plugins: [playtest()],
    renderer: { preferWebGPU: true },
    scenes: { quarry: createQuarryScene(options) },
    start: "quarry",
  });
}

const game = createQuarryGame({ arm: armFromLocation(), mode: modeFromLocation() });

export default game;
