import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Camera,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Texture,
  Vector2,
  Vector3,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../core/src/entities.js";
import { createRandom } from "../../core/src/random.js";
import { rapier } from "../../physics/src/index.js";
import type { IPhysicsContext } from "../../physics/src/plugin.js";
import type { Player } from "../templates/starter/src/entities/Player.js";
import { templatedRig } from "./templated-rig.js";

/** The clips the packaged `mannequin.glb` ships, by the name `Player.ts` plays them under. */
const MANNEQUIN_CLIPS = [
  "Idle_Loop",
  "Jog_Fwd_Loop",
  "Walk_Loop",
  "Jump_Start",
  "Jump_Loop",
  "Jump_Land",
] as const;

/**
 * Every clip `assets/mannequin-combat.glb` ships that the action RPG plays, read off the packaged
 * glTF's own animation list. `SkeletalMesh3D` fails the load by name when one is missing, so this
 * list is the contract between the template's clip tables and the file the scaffolder copies.
 */
const COMBAT_CLIPS = [
  "Death01",
  "Hit_Chest",
  "Idle_Loop",
  "Jog_Fwd_Loop",
  "PickUp_Table",
  "Punch_Jab",
  "Roll",
  "Spell_Simple_Shoot",
  "Sword_Attack",
  "Sword_Idle",
  "Walk_Loop",
] as const;

const probeState = vi.hoisted(() => ({
  colliderReads: 0,
  vector2Allocations: 0,
  vector3Allocations: 0,
  vector3Clones: 0,
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class CountingVector2 extends actual.Vector2 {
    constructor(x?: number, y?: number) {
      super(x, y);
      probeState.vector2Allocations += 1;
    }
  }
  class CountingVector3 extends actual.Vector3 {
    constructor(x?: number, y?: number, z?: number) {
      super(x, y, z);
      probeState.vector3Allocations += 1;
    }
  }
  const clone = actual.Vector3.prototype.clone;
  actual.Vector3.prototype.clone = function () {
    probeState.vector3Clones += 1;
    return clone.call(this);
  };
  return { ...actual, Vector2: CountingVector2, Vector3: CountingVector3 };
});

vi.mock("@threenative/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/src/index.js")>();
  // The headless probe has no AudioContext; starter Play registers the bus and plays a
  // pickup buffer, so the fixture doubles exactly that surface — allocation is the target.
  class FixtureAudioBus {
    play(_buffer: unknown): void {}
    dispose(): void {}
  }
  return { ...actual, AudioBus: FixtureAudioBus };
});
vi.mock("@threenative/physics", () => import("../../physics/src/index.js"));
// Every read of a town collider's bounds, so a navigation query's scan of the whole town shows.
vi.mock("../templates/shooter/src/render/town.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../templates/shooter/src/render/town.js")>();
  const counted = <T extends object>(value: T): T =>
    new Proxy(value, {
      get(target, key, receiver) {
        if (key === "min" || key === "max") probeState.colliderReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
  return {
    ...actual,
    buildTown: (...args: Parameters<typeof actual.buildTown>) => {
      const town = actual.buildTown(...args);
      return { ...town, colliders: town.colliders.map(counted) };
    },
  };
});

const WARMUP_FRAMES = 30;
/** The `Object3D` calls that walk a node's ancestors, which on the engine are each a crossing. */
const WORLD_WALKS = [
  "getWorldDirection",
  "getWorldPosition",
  "getWorldQuaternion",
  "getWorldScale",
  "localToWorld",
  "updateMatrixWorld",
  "updateWorldMatrix",
  "worldToLocal",
] as const;
const MEASURED_FRAMES = 600;
const DT = 1 / 60;

/**
 * Every other template's car here is kinematic, so the zero-gravity default below costs it
 * nothing. Racing's is a real `VehicleBody3D`: its suspension is a spring pre-loaded against the
 * car's own weight, and with no gravity to load it, the strut fully extends and launches the
 * chassis — wheels losing contact one at a time — within a few frames of spawning. `-24` matches
 * `src/game.ts`'s own plugin gravity, the value the suspension's `SAG` and `stiffness` are tuned
 * against.
 */
const RACING_GRAVITY = { x: 0, y: -24, z: 0 };

interface IPhysicsFixture {
  readonly physics: IPhysicsContext;
  dispose(): void;
  step(dt: number): void;
}

function resetAllocationSentinel(): void {
  probeState.vector2Allocations = 0;
  probeState.vector3Allocations = 0;
  probeState.vector3Clones = 0;
}

function measureVectorAllocations(step: () => void): { clones: number; constructors: number } {
  for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) step();
  resetAllocationSentinel();
  for (let frame = 0; frame < MEASURED_FRAMES; frame += 1) step();
  return { clones: probeState.vector3Clones, constructors: probeState.vector3Allocations };
}

function measureVector2Allocations(step: () => void): number {
  for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) step();
  resetAllocationSentinel();
  for (let frame = 0; frame < MEASURED_FRAMES; frame += 1) step();
  return probeState.vector2Allocations;
}

async function physicsFixture(
  gravity: { readonly x: number; readonly y: number; readonly z: number } = { x: 0, y: 0, z: 0 },
): Promise<IPhysicsFixture> {
  const owner = { add: () => undefined } as never;
  const plugin = rapier({ gravity });
  await plugin.setup?.(owner);
  const physics = (owner as { physics?: IPhysicsFixture["physics"] }).physics;
  if (physics === undefined) throw new Error("Allocation fixture did not install physics.");
  return {
    physics,
    dispose: () => plugin.dispose?.(owner),
    // The engine loop calls the plugin's update hook every frame, which steps the world
    // and drains collision events; a scene that steps physics per frame without it grows
    // the Rapier event queue until the WASM heap dies. Scenes that never step may omit it.
    step: (dt: number) => plugin.update?.(owner as never, dt),
  };
}

function gameContext(
  physics: IPhysicsFixture["physics"],
  options: {
    readonly justPressed?: (action: string) => boolean;
    readonly move?: Vector2;
  } = {},
) {
  const move = options.move ?? new Vector2(0.35, -0.2);
  return {
    add: () => undefined,
    input: {
      justPressed: (action: string) => options.justPressed?.(action) ?? false,
      justReleased: () => false,
      pressed: () => false,
      vector: () => move,
    },
    physics,
  };
}

function sceneContext(
  physics: IPhysicsFixture["physics"],
  initialState: Record<string, unknown>,
  options: { readonly look?: Vector2; readonly move?: Vector2 } = {},
) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 16 / 9);
  const layerScene = new Scene();
  const layerCamera = new OrthographicCamera(-800, 800, 450, -450, 0, 10);
  const entities = new Map<string, unknown>();
  const patchIdentities = new Set<object>();
  const state = { ...initialState };
  const inputVector = options.move ?? new Vector2();
  const lookVector = options.look ?? new Vector2();
  // One mesh with a position attribute, so a scene's load() can project UVs the way the
  // real packaged proof carries them; scene.load() must be awaited before enter().
  const proofScene = new Group();
  proofScene.add(
    new Mesh(
      new BufferGeometry().setAttribute(
        "position",
        new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
      ),
      new MeshBasicMaterial(),
    ),
  );
  const assets = {
    audio: (name: string) => Promise.resolve({ name }),
    // PRD-470: `starter` and `minimal` both load the packaged mannequin, and `Player` refuses a rig
    // missing one of its five named clips, so the stub hands back a rig for that name and the
    // proof scene for everything else.
    model: async <T>(name: string): Promise<T> =>
      (name === "mannequin.glb" ? templatedRig(MANNEQUIN_CLIPS) : { scene: proofScene }) as T,
    texture: async () => new Texture(),
  };
  return {
    add: (object: { readonly isObject3D?: boolean }) => {
      scene.add(object as never);
      return object;
    },
    after: () => ({ cancel: () => undefined }),
    afterPhysics: () => () => undefined,
    every: () => ({ cancel: () => undefined }),
    assets,
    camera,
    canvasLayer: { camera: layerCamera, opaque: false, scene: layerScene },
    entities: {
      add: <T>(id: string, entity: T): T => {
        entities.set(id, entity);
        return entity;
      },
      get: (id: string) => entities.get(id),
      remove: (id: string) => {
        entities.delete(id);
      },
    },
    goto: async () => undefined,
    input: {
      axis: () => 0,
      justPressed: () => false,
      justReleased: () => false,
      pressed: () => false,
      raw: { keys: new Set<string>(), pointer: { position: new Vector2() }, pointers: new Map() },
      vector: (name: string) => (name === "look" ? lookVector : inputVector),
    },
    physics,
    random: createRandom(193),
    renderer: {
      compileAsync: async () => undefined,
      kind: "webgl",
      raw: { shadowMap: { enabled: false, type: 0 } },
      // The real chain returns what it installed; a template reads that report back to print
      // TN_WORLD_ENVIRONMENT, so the double has to honour the contract rather than return void.
      createRenderChain: () => ({
        applied: { dropped: [], stages: ["bloom"] },
        dispose: () => undefined,
      }),
      setOutputNode: () => undefined,
    },
    scene,
    startup: { progress: 1, whenReady: async () => undefined },
    state: {
      flush: () => undefined,
      getState: () => state,
      set: (patch: unknown) => {
        const next =
          typeof patch === "function"
            ? (patch as (current: Record<string, unknown>) => Record<string, unknown>)(state)
            : patch;
        if (typeof next !== "object" || next === null) {
          throw new Error("Allocation fixture received a malformed state patch.");
        }
        patchIdentities.add(next);
        Object.assign(state, next);
      },
    },
    tween: () => Promise.resolve(),
    viewport: {
      resize: () => undefined,
      safeArea: { height: 900, width: 1600, x: 0, y: 0 },
    },
    raycast: () => undefined,
    patchIdentities,
  };
}

function runSceneFrames(frame: unknown, context: unknown, beforeMeasure?: () => void): void {
  if (typeof frame !== "function") throw new Error("Allocation fixture returned no scene frame.");
  const update = frame as (ctx: unknown, dt: number) => void;
  for (let index = 0; index < WARMUP_FRAMES; index += 1) update(context, DT);
  beforeMeasure?.();
  for (let index = 0; index < MEASURED_FRAMES; index += 1) update(context, DT);
}

describe("generated template ordinary-frame runtime cost", () => {
  it("releases the shooter-owned decal texture after its borrowers on repeated scene teardown", async () => {
    const { Play } = await import("../templates/shooter/src/scenes/Play.js");
    const { ENEMY_CLIPS } = await import("../templates/shooter/src/entities/Enemy.js");
    const maps = new Set<Texture>();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const physics = await physicsFixture();
      const entities = new Registry();
      const context = { ...sceneContext(physics.physics, Play.initialState), entities };
      const sky = new Texture();
      const skyDisposed = vi.fn();
      sky.addEventListener("dispose", skyDisposed);
      const play = new Play();
      try {
        await play.load({
          ...context,
          assets: {
            ...context.assets,
            model: async <T>(): Promise<T> => templatedRig(ENEMY_CLIPS) as T,
            texture: async () => sky,
          },
        } as never);
        play.enter(context as never);
        const slots = context.scene.children.filter(
          (child): child is Mesh<PlaneGeometry, MeshBasicMaterial> =>
            child instanceof Mesh &&
            child.geometry instanceof PlaneGeometry &&
            child.renderOrder === 23,
        );
        expect(slots).toHaveLength(224);
        const map = slots[0]?.material.map;
        if (map === undefined || map === null) throw new Error("Shooter decal texture missing.");
        expect(new Set(slots.map((slot) => slot.material.map))).toEqual(new Set([map]));
        expect(maps.has(map)).toBe(false);
        maps.add(map);
        let releasedMaterials = 0;
        for (const slot of slots) {
          slot.material.addEventListener("dispose", () => {
            releasedMaterials += 1;
          });
        }
        const mapDisposed = vi.fn(() => expect(releasedMaterials).toBe(slots.length));
        map.addEventListener("dispose", mapDisposed);

        play.exit();
        entities.clear();
        expect(mapDisposed).toHaveBeenCalledTimes(1);
        play.exit();
        entities.clear();
        expect(mapDisposed).toHaveBeenCalledTimes(1);
        expect(skyDisposed).not.toHaveBeenCalled();
      } finally {
        play.exit();
        entities.clear();
        physics.dispose();
        sky.dispose();
      }
    }
  });

  it("executes 600 steady frames per template without fresh vector work", async () => {
    const minimal = await import("../templates/minimal/src/render/camera.js");
    const starter = await import("../templates/starter/src/entities/Player.js");
    const platformer = await import("../templates/platformer/src/entities/Fox.js");
    const racing = await import("../templates/racing/src/track/Ranking.js");
    const racingLap = await import("../templates/racing/src/track/Lap.js");
    const racingSector = await import("../templates/racing/src/track/TrackSector.js");
    const actionRpg = await import("../templates/action-rpg/src/entities/Enemy.js");
    const defense = await import("../templates/tower-defense/src/enemies/Enemy.js");
    const core = await import("../../core/src/index.js");

    for (const [name, value] of Object.entries({
      "minimal followCamera": minimal.followCamera,
      "starter Player": starter.Player,
      "platformer Fox": platformer.Fox,
      "racing rankRacers": racing.rankRacers,
      "racing TrackSector": racingSector.TrackSector,
      "action-RPG Enemy": actionRpg.Enemy,
      "tower-defense Enemy": defense.Enemy,
      "core PathFollow3D": core.PathFollow3D,
    })) {
      if (value === undefined) throw new Error(`Malformed ${name} fixture: export is missing.`);
    }

    const physics = await physicsFixture();
    try {
      const camera = new PerspectiveCamera(60, 16 / 9);
      const target = new Vector3(-2, 0.9, 0);
      // Both arms: a clear way eases the lens, a wall at 1 m pulls it in and climbs.
      for (const probe of [() => undefined, () => 1]) {
        for (let frame = 0; frame < WARMUP_FRAMES; frame += 1)
          minimal.followCamera(camera, target, DT, probe);
        expect(
          measureVectorAllocations(() => minimal.followCamera(camera, target, DT, probe)),
          "minimal followCamera vector allocation sentinel",
        ).toEqual({ clones: 0, constructors: 0 });
      }

      const ctx = gameContext(physics.physics);
      const player = new starter.Player(
        ctx as never,
        templatedRig(MANNEQUIN_CLIPS),
        new Vector3(-2, 0.9, 0),
      );
      expect(
        measureVectorAllocations(() => player.update(ctx as never, DT)),
        "starter Player.update vector allocation sentinel",
      ).toEqual({ clones: 0, constructors: 0 });
      player.dispose();

      const fox = new platformer.Fox(ctx as never, new Vector3(0, 0.75, 0));
      expect(
        measureVectorAllocations(() => fox.update(ctx as never, DT)),
        "platformer Fox.update vector allocation sentinel",
      ).toEqual({ clones: 0, constructors: 0 });
      fox.dispose();

      const dashCtx = gameContext(physics.physics, {
        justPressed: (action) => action === "dash",
        move: new Vector2(),
      });
      const dashingFox = new platformer.Fox(dashCtx as never, new Vector3(0, 0.75, 0));
      expect(
        measureVectorAllocations(() => dashingFox.update(dashCtx as never, DT)),
        "platformer dash fallback vector allocation sentinel",
      ).toEqual({ clones: 0, constructors: 0 });
      dashingFox.dispose();

      const touchModule = await import("../templates/platformer/src/render/touch-controls.js");
      const touch = new touchModule.TouchControls(camera);
      const touchSize = { aspect: 16 / 9, height: 900, width: 1600 };
      const touchPointers = new Map();
      const firstTouch = touch.update(touchPointers, touchSize);
      const touchVector2Allocations = measureVector2Allocations(() => {
        if (touch.update(touchPointers, touchSize) !== firstTouch)
          throw new Error("TouchControls returned a new input object during steady state.");
      });
      expect(touchVector2Allocations, "platformer touch-controls Vector2 allocation sentinel").toBe(
        0,
      );
      touch.dispose();

      const route = new core.PathFollow3D({
        loop: true,
        points: [
          new Vector3(10, 0, -10),
          new Vector3(10, 0, 10),
          new Vector3(-10, 0, 10),
          new Vector3(-10, 0, -10),
        ],
      });
      const racePosition = new Vector3(9, 0, -10);
      const raceHeading = new Vector3(1, 0, 0);
      const racers = [
        { id: "player", lap: 0, position: racePosition },
        { id: "rival", lap: 0, position: new Vector3(8, 0, -10) },
      ];
      const rankingBuffer: Array<{
        id: string;
        lap: number;
        position: Vector3;
        place: number;
        routeProgress: number;
      }> = [];
      const projectionTarget = {
        curvature: 0,
        distance: 0,
        lateral: 0,
        point: new Vector3(),
        tangent: new Vector3(),
      };
      const sampleTarget = { point: new Vector3(), progress: 0, tangent: new Vector3() };
      const lap = new racingLap.Lap({ body: { id: 42 } as never, forward: new Vector3(1, 0, 0) }, [
        {
          area: { on: () => () => undefined },
          at: new Vector3(0, 0, 0),
          forward: new Vector3(1, 0, 0),
        },
      ] as never);
      const lapPrevious = new Vector3(0, 0, 1);
      const lapCurrent = new Vector3(0, 0, 1);
      const sector = new racingSector.TrackSector({
        intersectRay: () => ({ distance: 1 }),
        route: route as never,
      });
      const mapSpy = vi.spyOn(Array.prototype, "map");
      const entriesSpy = vi.spyOn(Array.prototype, "entries");
      const sortSpy = vi.spyOn(Array.prototype, "sort");
      const raceStep = (): void => {
        expect(route.advance(DT, sampleTarget)).toBe(sampleTarget);
        racing.rankRacers(route as never, racers, projectionTarget, rankingBuffer);
        lap.observe(lapPrevious, lapCurrent);
        sector.update(racePosition, raceHeading, DT);
      };
      const racingAllocations = measureVectorAllocations(raceStep);
      const racingMapCalls = mapSpy.mock.calls.length;
      const racingEntriesCalls = entriesSpy.mock.calls.length;
      const racingSortComparators = new Set(sortSpy.mock.calls.map((call) => call[0]));
      const racingSortCalls = sortSpy.mock.calls.length;
      mapSpy.mockRestore();
      entriesSpy.mockRestore();
      sortSpy.mockRestore();
      expect(rankingBuffer.length, "racing ranking high-water buffer").toBe(racers.length);
      expect(racingMapCalls, "racing ranking pipeline allocation sentinel").toBe(0);
      expect(racingEntriesCalls, "racing ranking/lap iterator allocation sentinel").toBe(0);
      expect(racingSortCalls, "racing ranking sort sentinel").toBeGreaterThan(0);
      expect(
        racingSortComparators.size,
        "racing comparator retention sentinel",
      ).toBeLessThanOrEqual(1);
      expect(racingAllocations, "racing PathFollow result allocation sentinel").toEqual({
        clones: 0,
        constructors: 0,
      });
      const tiedRanked = racing.rankRacers(
        route as never,
        [
          { id: "zulu", lap: 0, position: racePosition },
          { id: "alpha", lap: 0, position: racePosition },
        ],
        projectionTarget,
        rankingBuffer,
      );
      expect(tiedRanked[0]?.id, "racing deterministic tie order").toBe("alpha");
      expect(tiedRanked[1]?.id, "racing deterministic tie order").toBe("zulu");

      const enemy = new actionRpg.Enemy(
        ctx as never,
        templatedRig(COMBAT_CLIPS),
        new Vector3(0, 0.78, 0),
        { id: 777 } as never,
        { onAttack: () => undefined, onDeath: () => undefined },
      );
      const enemyQueryPhysics = {
        ...physics.physics,
        directSpaceState: {
          intersectRay: () => ({ body: { id: 777 } }),
          intersectShape: () => [{ body: { id: 777 } }],
        },
      };
      const enemyCtx = { ...ctx, physics: enemyQueryPhysics } as never;
      const enemyTarget = new Vector3(4, 0.78, 0);
      expect(
        measureVectorAllocations(() => enemy.update(enemyCtx, DT, enemyTarget)),
        "action-RPG Enemy.update vector allocation sentinel",
      ).toEqual({ clones: 0, constructors: 0 });
      enemy.dispose();

      const walker = new defense.Enemy({
        id: "enemy.skitter.0",
        kind: "skitter",
        onDefeated: () => undefined,
        onLeak: () => undefined,
        physics: physics.physics as never,
        points: [new Vector3(0, 0, 0), new Vector3(100, 0, 0), new Vector3(200, 0, 100)],
      });
      walker.reset("enemy.skitter.0.w1", 58);
      expect(
        measureVectorAllocations(() => walker.update(DT)),
        "tower-defense Enemy.update vector allocation sentinel",
      ).toEqual({ clones: 0, constructors: 0 });
      walker.dispose();
    } finally {
      physics.dispose();
    }
  });

  it("executes scene-owned collection and formatted-state paths for 600 frames", async () => {
    const minimal = await import("../templates/minimal/src/scenes/Play.js");
    const starter = await import("../templates/starter/src/scenes/Play.js");
    const platformer = await import("../templates/platformer/src/scenes/Play.js");
    const racing = await import("../templates/racing/src/scenes/Race.js");
    const actionRpg = await import("../templates/action-rpg/src/scenes/Play.js");
    const defense = await import("../templates/tower-defense/src/scenes/Battle.js");
    // The mocked specifier, not the original module: templates resolve solarPosition
    // through the mock factory's namespace copy, so the spy has to target that copy.
    const core = await import("@threenative/core");

    for (const [name, value] of Object.entries({
      "minimal Play": minimal.Play,
      "starter Play": starter.Play,
      "platformer Play": platformer.Play,
      "racing Race": racing.Race,
      "action-RPG Play": actionRpg.Play,
      "tower-defense Battle": defense.Battle,
    })) {
      if (value === undefined) throw new Error(`Malformed ${name} fixture: export is missing.`);
    }

    const minimalPhysics = await physicsFixture();
    try {
      const context = sceneContext(minimalPhysics.physics, minimal.Play.initialState);
      const rig = templatedRig([
        "Idle_Loop",
        "Jog_Fwd_Loop",
        "Jump_Start",
        "Jump_Loop",
        "Jump_Land",
      ]);
      const play = new minimal.Play();
      await play.load({
        ...context,
        assets: { ...context.assets, model: async <T>(): Promise<T> => rig as T },
      } as never);
      const frame = play.enter(context as never);
      runSceneFrames(frame, context);
      expect(context.patchIdentities.size, "minimal Play state-patch high-water sentinel").toBe(1);
    } finally {
      minimalPhysics.dispose();
    }

    const starterPhysics = await physicsFixture();
    class IdleWorker {
      onerror: unknown = null;
      onmessage: unknown = null;
      postMessage(): void {}
      terminate(): void {}
    }
    vi.stubGlobal("Worker", IdleWorker);
    try {
      const context = sceneContext(starterPhysics.physics, starter.Play.initialState);
      expect(context.state.getState().progress).toBe(0);
      const play = new starter.Play();
      await play.load(context as never);
      const update = play.enter(context as never) as (ctx: unknown, dt: number) => void;
      if (typeof update !== "function")
        throw new Error("Allocation fixture returned no starter scene frame.");
      // Starter steps real physics per frame, so the loop mirrors the engine: plugin
      // update (step + event drain) before the scene frame, warmup then measured.
      for (let index = 0; index < WARMUP_FRAMES; index += 1) {
        starterPhysics.step(DT);
        update(context, DT);
      }
      const patchWarmHighWater = context.patchIdentities.size;
      for (let index = 0; index < MEASURED_FRAMES; index += 1) {
        starterPhysics.step(DT);
        update(context, DT);
      }
      expect(context.patchIdentities.size, "starter Play state-patch high-water sentinel").toBe(
        patchWarmHighWater,
      );
      const player = context.entities.get("player") as Player;
      for (const [x, progress] of [
        [-4, 0],
        [-2, 0],
        [0, (100 * 2) / 8.4],
        [2, (100 * 4) / 8.4],
        [6.4, 100],
        [8, 100],
      ] as const) {
        player.body.teleport({ x, y: 0.9, z: 0 });
        update(context, DT);
        expect(context.state.getState().progress, `progress at x=${x}`).toBeCloseTo(progress);
      }
    } finally {
      vi.unstubAllGlobals();
      starterPhysics.dispose();
    }

    const platformerPhysics = await physicsFixture();
    try {
      const context = sceneContext(platformerPhysics.physics, platformer.Play.initialState);
      const play = new platformer.Play();
      // The fox run loads the sky photograph in `load()`, exactly like every other template that
      // ships one, so the scene under measurement is the one a player sees.
      await play.load(context as never);
      const frame = play.enter(context as never);
      let patchHighWater = 0;
      runSceneFrames(frame, context, () => {
        patchHighWater = context.patchIdentities.size;
      });
      expect(patchHighWater, "platformer Play state-patch warm high-water sentinel").toBe(1);
      expect(context.patchIdentities.size, "platformer Play state-patch high-water sentinel").toBe(
        patchHighWater,
      );
    } finally {
      platformerPhysics.dispose();
    }

    // The shooter ships no scene-owned collection hot path any more: its town's solids are
    // merged per material at construction and its frame is a firefight, not a per-frame scan.
    // `enemy-stops-without-snapping` and `performance` are what prove its steady frame.

    const actionRpgPhysics = await physicsFixture();
    try {
      const context = sceneContext(actionRpgPhysics.physics, actionRpg.Play.initialState);
      const play = new actionRpg.Play();
      await play.load({
        ...context,
        assets: {
          ...context.assets,
          model: async <T>(): Promise<T> => templatedRig(COMBAT_CLIPS) as T,
        },
      } as never);
      const frame = play.enter(context as never);
      const toFixedSpy = vi.spyOn(Number.prototype, "toFixed");
      let patchHighWater = 0;
      runSceneFrames(frame, context, () => {
        patchHighWater = context.patchIdentities.size;
        toFixedSpy.mockClear();
      });
      const toFixedCalls = toFixedSpy.mock.calls.length;
      toFixedSpy.mockRestore();
      expect(toFixedCalls, "action-RPG formatted-state allocation sentinel").toBe(0);
      expect(context.patchIdentities.size, "action-RPG state-patch high-water sentinel").toBe(
        patchHighWater,
      );
    } finally {
      actionRpgPhysics.dispose();
    }

    const defensePhysics = await physicsFixture();
    try {
      const context = sceneContext(defensePhysics.physics, defense.Battle.initialState);
      const scene = new defense.Battle();
      await scene.load(context as never);
      const frame = scene.enter(context as never);
      const reduceSpy = vi.spyOn(Array.prototype, "reduce");
      let patchHighWater = 0;
      runSceneFrames(frame, context, () => {
        patchHighWater = context.patchIdentities.size;
        reduceSpy.mockClear();
      });
      const reduceCalls = reduceSpy.mock.calls.length;
      reduceSpy.mockRestore();
      expect(reduceCalls, "tower-defense scene spread/reduce allocation sentinel").toBe(0);
      expect(context.patchIdentities.size, "tower-defense state-patch high-water sentinel").toBe(
        patchHighWater,
      );
    } finally {
      defensePhysics.dispose();
    }
  });

  it("runs the shooter's firefight frame without engine walks for constants", async () => {
    const { Play } = await import("../templates/shooter/src/scenes/Play.js");
    const { ENEMY_CLIPS } = await import("../templates/shooter/src/entities/Enemy.js");
    const physics = await physicsFixture();
    const entities = new Registry();
    const base = sceneContext(physics.physics, Play.initialState);
    const viewport = { ...base.viewport, size: { height: 900, width: 1600 } };
    const context = { ...base, entities, viewport };
    const play = new Play();
    try {
      await play.load({
        ...context,
        assets: {
          ...context.assets,
          model: async <T>(): Promise<T> => templatedRig(ENEMY_CLIPS) as T,
        },
      } as never);
      const frame = play.enter(context as never);
      // On the engine each of these is a call into Wasm that walks the node's ancestors. Count the
      // ones the kit's own code starts, by the kit line that starts them.
      const walks = new Map<string, number>();
      const restore: Array<() => void> = [];
      // `Camera` overrides two of them, so its own copies are counted too.
      for (const owner of [Object3D.prototype, Camera.prototype] as Record<string, unknown>[]) {
        for (const name of WORLD_WALKS) {
          if (!Object.hasOwn(owner, name)) continue;
          const original = owner[name] as (...args: unknown[]) => unknown;
          owner[name] = function (this: unknown, ...args: unknown[]) {
            const caller = new Error().stack?.split("\n")[2] ?? "";
            const site = /at (\S+) .*templates\/shooter\/src\/(.+?):(\d+)/.exec(caller);
            if (site !== null) {
              const key = `${name} ${site[1]} ${site[2]}:${site[3]}`;
              walks.set(key, (walks.get(key) ?? 0) + 1);
            }
            return original.apply(this, args);
          };
          restore.push(() => {
            owner[name] = original;
          });
        }
      }
      try {
        runSceneFrames(frame, context, () => {
          walks.clear();
          probeState.colliderReads = 0;
        });
      } finally {
        for (const undo of restore) undo();
      }
      console.log("PROBE", probeState.colliderReads / MEASURED_FRAMES, [...walks].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${(v / MEASURED_FRAMES).toFixed(2)} ${k}`));
    } finally {
      play.exit();
      entities.clear();
      physics.dispose();
    }
  });

  it("forwards a cached-sky sample to the controller entered while sampling was pending", async () => {
    const sampling = await import("../templates/racing/src/render/environmentSampling.js");
    const { captureEnvironmentSnapshot } = await import(
      "../templates/racing/src/render/environmentSnapshot.js"
    );
    const { Race } = await import("../templates/racing/src/scenes/Race.js");
    const physics = await physicsFixture(RACING_GRAVITY);
    const context = sceneContext(physics.physics, Race.initialState);
    let complete: (() => void) | undefined;
    const sampleSpy = vi
      .spyOn(sampling, "sampleEnvironment")
      .mockImplementation((_renderer, scene) => {
        const snapshot = captureEnvironmentSnapshot(scene);
        return new Promise((resolve) => {
          complete = () =>
            resolve({
              ...snapshot,
              measurement: {
                status: "measured",
                meanRadiance: 0.25,
                meanRGB: [0.25, 0.25, 0.25],
                reason: "CPU timing fixture",
              },
            });
        });
      });
    const race = new Race();
    try {
      // The sky is applied before enter(), while the bounded sample is still pending.
      await race.load(context as never);
      expect(sampleSpy).toHaveBeenCalledTimes(1);
      expect(complete).toBeTypeOf("function");
      race.enter(context as never);
      const controller = context.entities.get("material-lighting") as {
        debug(): { status: string; meanRadiance: number | null };
      };
      expect(controller.debug().status).toBe("unknown");
      complete?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.debug()).toMatchObject({ status: "measured", meanRadiance: 0.25 });
    } finally {
      race.exit(context as never);
      sampleSpy.mockRestore();
      physics.dispose();
    }
  });

  it("executes the racing scene player scan for 600 measured frames", async () => {
    const { Race } = await import("../templates/racing/src/scenes/Race.js");
    const racingPhysics = await physicsFixture(RACING_GRAVITY);
    try {
      const context = sceneContext(racingPhysics.physics, Race.initialState);
      // `Race.load()` fetches the sky photograph the first frame is lit by, and `enter` refuses to
      // run without it: a scene that quietly fell back to a flat sky would render a plausible frame
      // and prove nothing about the look this template ships.
      const race = new Race();
      await race.load(context as never);
      const frame = race.enter(context as never);
      const update = frame as (ctx: unknown, dt: number) => void;
      if (typeof update !== "function")
        throw new Error("Allocation fixture returned no race frame.");
      for (let index = 0; index < WARMUP_FRAMES; index += 1) {
        racingPhysics.step(DT);
        update(context, DT);
      }
      const patchWarmHighWater = context.patchIdentities.size;
      // The engine loop drains collision events every frame (plugin update); the fixture
      // mirrors that, because a scene that steps real physics without the drain grows the
      // Rapier event queue instead of holding a steady state.
      const sortSpy = vi.spyOn(Array.prototype, "sort");
      let patchHighWater = patchWarmHighWater;
      try {
        for (let index = 0; index < MEASURED_FRAMES; index += 1) {
          racingPhysics.step(DT);
          update(context, DT);
          patchHighWater = context.patchIdentities.size;
        }
      } finally {
        sortSpy.mockRestore();
      }
      const comparators = new Set(sortSpy.mock.calls.map((call) => call[0]));
      expect(comparators.size, "racing Race comparator retention sentinel").toBeLessThanOrEqual(1);
      expect(context.patchIdentities.size, "racing Race state-patch high-water sentinel").toBe(
        patchHighWater,
      );
      expect(context.state.getState().position, "racing Race player ranking state").toBe("P2");
    } finally {
      racingPhysics.dispose();
    }
  });
  it("publishes a JSON-safe component snapshot for the racing scene, as `survives` requires", async () => {
    const { Race } = await import("../templates/racing/src/scenes/Race.js");
    const { snapshotEntities } = await import("../../core/src/entity-snapshot.js");
    const racingPhysics = await physicsFixture(RACING_GRAVITY);
    try {
      const context = sceneContext(racingPhysics.physics, Race.initialState);
      const race = new Race();
      await race.load(context as never);
      const frame = race.enter(context as never) as (ctx: unknown, dt: number) => void;
      // The capability query lands between `enter()` and the first update, so the snapshot has to
      // be honest before anything has moved.
      const probe = (): Record<string, Record<string, unknown>> => {
        const registry = context.entities;
        const named = new Map<string, object>();
        for (const id of ["camera.main", "player", "rival"]) {
          const entity = registry.get(id) as object | undefined;
          if (entity !== undefined) named.set(id, entity);
        }
        return snapshotEntities(named as ReadonlyMap<string, object>);
      };
      const atEnter = probe();
      for (const [id, fields] of Object.entries(atEnter)) {
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value === "number")
            expect(Number.isFinite(value), `racing ${id}.${key} finite at enter`).toBe(true);
        }
      }
      racingPhysics.step(DT);
      frame(context, DT);
      // The `runtime.components` capability is offered only when at least one named entity
      // publishes a JSON-safe field, and `survives` fails closed without it. A car that owns only
      // nested objects and no scalar of its own silently withdraws the whole capability.
      const snapshot = probe();
      const observed = Object.entries(snapshot).filter(
        ([, fields]) => Object.keys(fields).length > 0,
      );
      expect(observed.length, "racing entities publishing component fields").toBeGreaterThan(0);
      for (const [id, fields] of observed) {
        expect(() => JSON.stringify(fields), `racing component fields for ${id}`).not.toThrow();
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value === "number") {
            expect(Number.isFinite(value), `racing component ${id}.${key} is finite`).toBe(true);
          }
        }
      }
    } finally {
      racingPhysics.dispose();
    }
  });
  it("executes the racing scene player scan without an iterator", async () => {
    const { Race } = await import("../templates/racing/src/scenes/Race.js");
    const racingPhysics = await physicsFixture(RACING_GRAVITY);
    try {
      const context = sceneContext(racingPhysics.physics, Race.initialState);
      // `Race.load()` fetches the sky photograph the first frame is lit by, and `enter` refuses to
      // run without it: a scene that quietly fell back to a flat sky would render a plausible frame
      // and prove nothing about the look this template ships.
      const race = new Race();
      await race.load(context as never);
      const frame = race.enter(context as never);
      if (typeof frame !== "function")
        throw new Error("Allocation fixture returned no race frame.");
      const originalIterator = Array.prototype[Symbol.iterator];
      const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
      if (originalDescriptor === undefined)
        throw new Error("Allocation fixture could not inspect Array iterator.");
      let iteratorCalls = 0;
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        ...originalDescriptor,
        value(this: unknown[]) {
          iteratorCalls += 1;
          return originalIterator.call(this);
        },
      });
      try {
        (frame as (ctx: unknown, dt: number) => void)(context, DT);
      } finally {
        Object.defineProperty(Array.prototype, Symbol.iterator, originalDescriptor);
      }
      expect(iteratorCalls, "racing Race player scan iterator sentinel").toBe(0);
      expect(context.patchIdentities.size, "racing Race frame execution sentinel").toBe(1);
      expect(context.state.getState().position, "racing Race player ranking state").toBe("P2");
    } finally {
      racingPhysics.dispose();
    }
  });
});
