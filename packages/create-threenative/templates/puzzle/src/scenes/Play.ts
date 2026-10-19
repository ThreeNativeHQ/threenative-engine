import {
  type ICtx,
  type IRandom,
  Scene,
  type SceneFrame,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  BufferAttribute,
  type Group,
  type Material,
  Mesh,
  NearestFilter,
  type PerspectiveCamera,
  type Quaternion,
  Vector3,
} from "three";
import { Crate, type CrateKind, WORLD_LAYER } from "../entities/Crate.js";
import { Seal } from "../entities/Seal.js";
import { WARDEN_SPAWN, Warden } from "../entities/Warden.js";
import { createVaultCamera } from "../render/camera.js";
import { CRATE_SIZE } from "../render/crateShape.js";
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import {
  crateBraceMaterial,
  crateMaterials,
  createBannerMaterial,
  phaseCoreMaterial,
  phaseMaterial,
} from "../render/materials.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import { SEAL, VAULT, createVaultRoom } from "../render/vault.js";
import type { GameState } from "../state.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

/** Below this linear speed a body counts as at rest. */
const REST_SPEED = 0.06;
/** Consecutive at-rest ticks before the opening drop is declared over. */
const REST_TICKS = 24;
/** How far a crate must move after the drop before it counts as shoved. */
const PUSH_THRESHOLD = 0.25;

/** The deterministic check: this many fixed steps, twice, on the script below. */
const REPLAY_TICKS = 70;
/**
 * How far the two passes may disagree on any one position or rotation component and still count
 * as the same run. Reported as `replayDrift` either way, so the number is never hidden behind the
 * verdict: a tolerance nobody can see is a tolerance that can be widened until anything passes.
 */
const REPLAY_TOLERANCE = 1e-4;
/** Steps each pass is given, before it is timed, to place the warden in an otherwise empty room. */
const REPLAY_ARM_TICKS = 8;

/**
 * The three bodies the determinism check actually runs on, and why it is three and not forty-four.
 *
 * A dynamic `RigidBody3D` cannot be repositioned. There is no `teleport` (the character body has
 * one), no position setter, and `syncToPhysics()` does not write a dynamic body's transform back
 * to the backend — measured: after a pose reset and ninety settling steps the pile was still
 * 0.80 m from the pose it had been handed. So "put the world back and run it again" can only be
 * done by destroying the bodies and building new ones — and *that* changes the order the backend
 * hands out handles, which changes the simulation. Rebuilding forty-four crates has two stable
 * outcomes that alternate: the two passes disagreed by 0.2818 m on 220 of 308 recorded components,
 * to the same sixteen digits on every run, and swapped places when a throwaway rebuild was moved
 * from one side to the other.
 *
 * So the check runs on a rig small enough to be built identically twice, in a vault emptied for
 * the duration: the warden shoves one crate into a stack of two. It is a real character push
 * against real contacts under the same fixed step — and it is three bodies, which is why
 * `replayBodies` is published beside the verdict rather than left for a reader to assume.
 */
const REPLAY_RIG: readonly { readonly x: number; readonly y: number; readonly z: number }[] = [
  { x: 0.3, y: 0.5, z: 2.1 },
  { x: 2.0, y: 0.5, z: 2.1 },
  { x: 2.0, y: 1.45, z: 2.1 },
];
const REPLAY_START = { x: -1.1, y: 0.62, z: 2.1 } as const;

/** The scripted input both replay passes are driven by. A pure function of the tick index. */
function replayInput(tick: number): { readonly x: number; readonly z: number } {
  return tick < 8 ? { x: 0, z: 0 } : { x: 1, z: 0 };
}

/** The one crate allowed in the lane: the one the warden starts against. */
const PUSH_CRATE_INDEX = 22;

interface ICrateAuthoring {
  /** Which of the three crate tints this body wears. */
  readonly colour: number;
  readonly kind: CrateKind;
  readonly rotationY: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface IPose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

export class Play extends Scene<GameState, IPhysicsContext> {
  #banner: Mesh | undefined;
  #statics: RigidBody3D[] = [];

  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #materialEnvironment(ctx: GameCtx) {
    return {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
  }
  static override readonly initialState: GameState = {
    blockedTicks: 0,
    crates: 0,
    odometer: 0,
    passThroughs: 0,
    wardenFall: 0,
    wardenGrounded: false,
    paused: false,
    phaseCrates: 0,
    playerX: WARDEN_SPAWN.x,
    playerZ: WARDEN_SPAWN.z,
    pushDistance: 0,
    pushedCrates: 0,
    replayBodies: 0,
    replayDrift: 0,
    replayMatch: false,
    replayPhase: "idle",
    replayTicks: REPLAY_TICKS,
    seed: 6132,
    sealContacts: 0,
    sealedBy: "none",
    settled: false,
    settledCrates: 0,
    status: "playing",
    uiReady: false,
  };

  override async load(ctx: GameCtx): Promise<void> {
    // The packaged proof pair still loads, and still prints the marker the desktop asset gate
    // greps for. In this game the triangle earns its place as the pennant on the east wall
    // rather than as a debug object parked over the level.
    const [texture, model] = await Promise.all([
      ctx.assets.texture("native-proof.png"),
      ctx.assets.model<{ scene: Group }>("native-proof.glb"),
    ]);
    // A 16-pixel check filtered smoothly is a grey smear at banner size; nearest keeps it square.
    texture.magFilter = NearestFilter;
    let banner: Mesh | undefined;
    model.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (banner !== undefined) throw new Error("Proof glTF must contain exactly one mesh.");
      object.material = createBannerMaterial(texture);
      // The packaged proof carries positions and indices only. Without UVs the sampler reads one
      // corner texel for every fragment and it renders flat white — a loaded texture that proves
      // nothing you can see. Plane-project the triangle, measuring each axis from the array so a
      // quantized (KHR_mesh_quantization) build projects identically.
      const position = object.geometry.getAttribute("position");
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < position.count; index += 1) {
        minX = Math.min(minX, position.getX(index));
        maxX = Math.max(maxX, position.getX(index));
        minY = Math.min(minY, position.getY(index));
        maxY = Math.max(maxY, position.getY(index));
      }
      const spanX = Math.max(maxX - minX, Number.EPSILON);
      const spanY = Math.max(maxY - minY, Number.EPSILON);
      const uv = new Float32Array(position.count * 2);
      for (let index = 0; index < position.count; index += 1) {
        uv[index * 2] = (position.getX(index) - minX) / spanX;
        uv[index * 2 + 1] = (position.getY(index) - minY) / spanY;
      }
      object.geometry.setAttribute("uv", new BufferAttribute(uv, 2));
      // A clone, because `ctx.add` REPARENTS what it is handed. Adding the loaded mesh itself
      // empties `model.scene`, the asset loader hands the same cached object back on the next
      // load, and the scene `R` rebuilds throws "did not contain a mesh" — leaving the game dead
      // on a keypress the HUD advertises. The clone shares geometry and material, so nothing is
      // duplicated but the node.
      banner = object.clone();
    });
    if (banner === undefined) throw new Error("Proof glTF did not contain a mesh.");
    this.#banner = banner;
    console.info("TN_NATIVE_STARTER_ASSETS_LOADED:texture,glb");
    setupSky(ctx.scene);
    this.#environmentSample = await sampleEnvironment(
      ctx.renderer.raw,
      ctx.scene,
      this.#materialEnvironment(ctx),
    );
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    const bannerMesh = this.#banner;
    if (bannerMesh === undefined) throw new Error("Vault scene did not finish loading.");

    // --- room ------------------------------------------------------------------------------
    setupSky(ctx.scene);
    const sun = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    // isMobile() arrives as an argument because src/render/ imports no framework package: the
    // platform decision is made here, in portable game code.
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      godraysLight: sun,
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
      onTierChanged: (tier) =>
        this.#materialLighting?.setEnabled(
          materialLightingEnabled(tier, this.#materialEnvironment(ctx)),
        ),
    });
    const loading = createLoadingScreen(ctx);
    const room = createVaultRoom();
    ctx.add(room.object);
    ctx.entities.add("seal", room.seal);
    // The room's solid boxes become fixed bodies here, in the scene, so `src/render/` never has
    // to import a framework package to describe what is walkable.
    this.#statics = room.solids.map(
      (solid) =>
        new RigidBody3D({
          collisionLayer: WORLD_LAYER,
          physics: ctx.physics,
          position: { x: solid.x, y: solid.y, z: solid.z },
          shape: CollisionShape3D.box(solid.width, solid.height, solid.depth),
          type: "fixed",
        }),
    );

    bannerMesh.scale.setScalar(0.24);
    bannerMesh.position.set(VAULT.halfX - 0.1, 1.38, 2.6);
    bannerMesh.rotation.set(0, -Math.PI / 2, 0);
    ctx.add(bannerMesh);

    const camera = createVaultCamera(ctx.camera as PerspectiveCamera);
    camera.snap();
    ctx.add(ctx.camera);
    // The vault is a room the player walks around in, so a phone needs the same stick the
    // keyboard has. `isMobile() && isTouchscreenAvailable()` is the one place that decision is
    // made, and it is made here, in portable game code.
    const touchControls =
      isMobile() && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(ctx.camera as PerspectiveCamera))
        : undefined;

    // --- bodies ----------------------------------------------------------------------------
    const authored = authorCrates(ctx.random);
    let crates: Crate[] = [];
    // The seal reports every body that overlaps it, and the floor slab is one of them: its top
    // face is exactly the plane the seal plate sits on, so an area authored from y = 0 upward is
    // *already* intersecting a fixed body on the first step and the run is won before the warden
    // moves. Keeping the live crate bodies in a set is what makes "was that a crate" answerable
    // without guessing from a body id.
    const crateBodies = new Set<unknown>();
    const clearCrates = (): void => {
      for (const crate of crates) crate.dispose();
      crates = [];
      crateBodies.clear();
    };
    const buildCrates = (poses?: readonly IPose[]): void => {
      clearCrates();
      crates = authored.map((plan, index) => {
        const pose = poses?.[index];
        return new Crate(ctx, crateFinishes(plan), {
          entity: `crate.${index}`,
          kind: plan.kind,
          quaternion: pose?.quaternion,
          rotationY: plan.rotationY,
          x: pose?.position.x ?? plan.x,
          y: pose?.position.y ?? plan.y,
          z: pose?.position.z ?? plan.z,
        });
      });
      for (const crate of crates) crateBodies.add(crate.body);
    };
    // The vault opens when the runtime is ready — but only on the run that is still booting.
    //
    // The runner takes its first observation after `startup.whenReady()` resolves, which here was
    // 3.0 s in — by which time crates built in `enter()` have already fallen, collided and gone to
    // sleep. Every assertion about the opening drop was reported
    // `TN_PLAYTEST_ASSERTION_TRIVIAL: already satisfied before the scenario ran`, because it was.
    // Dropping the pile on the first observed frame makes the settle provable, and it is a better
    // opening for a player too: the room assembles itself instead of already being over.
    //
    // Startup readiness is a boot milestone, not a per-scene one. On the rebuild that `R` causes
    // it has already happened and never happens again, so a scene that waits for it a second time
    // waits forever: pressing R left an empty vault with `crates: 0` and a warden alone in a lit
    // room. The scenario found that; nothing else would have.
    if (ctx.startup.progress >= 1) buildCrates();
    else void ctx.startup.whenReady().then(() => buildCrates());
    const solidCount = authored.filter((plan) => plan.kind === "solid").length;
    if (solidCount < 30 || authored.length - solidCount < 1)
      throw new Error(
        `The vault needs at least 30 solid bodies and one the warden walks through; this layout has ${solidCount} and ${authored.length - solidCount}.`,
      );

    const warden = ctx.entities.add("player", new Warden(ctx));
    const seal = ctx.entities.add("seal.area", new Seal(ctx, room.seal));

    // --- the run's own bookkeeping ----------------------------------------------------------
    let status: GameState["status"] = "playing";
    let sealedBy: GameState["sealedBy"] = "none";
    let passThroughs = 0;
    let insidePhaseWall = false;
    let settled = false;
    let restTicks = 0;
    let replayPhase: GameState["replayPhase"] = "idle";
    let replayMatch = false;
    let replayTick = 0;
    let replayDigest: readonly number[] = [];
    let replayDrift = 0;
    let armTicks = 0;
    /**
     * Both passes start from the poses the opening drop left, not from the authored heights.
     *
     * Re-dropping forty-four crates is a chaotic opening: a difference of one ULP in the order the
     * backend resolves two contacts becomes centimetres by the time the pile settles, and the
     * check then measures the backend's allocator rather than the game's determinism. Starting
     * both passes from the same *settled* pile keeps the thing under test — the warden's scripted
     * shove — and drops the amplifier.
     */
    let snapshot: readonly IPose[] = [];
    let wardenSnapshot = new Vector3(WARDEN_SPAWN.x, WARDEN_SPAWN.y, WARDEN_SPAWN.z);
    /** V pressed before the opening drop finished: honoured as soon as it has. */
    let replayRequested = false;

    seal.watch({
      isCrate: (body) => crateBodies.has(body),
      onContact: (by) => {
        // The seal is switched off for the duration of the replay, so anything that reaches it
        // here reached it in the run the player is actually playing.
        if (status === "won") return;
        status = "won";
        sealedBy = by;
        room.setSealLit(true);
        ctx.state.set({ sealedBy: by, status: "won" });
        ctx.state.flush();
      },
      warden: warden.body,
    });

    const phaseWall = phaseWallBounds();
    /** Seven numbers per rig body — position then rotation — plus the warden's, in build order. */
    const digest = (): readonly number[] => {
      const values: number[] = [];
      const p = warden.mesh.position;
      values.push(p.x, p.y, p.z);
      for (const crate of rig) {
        const p = crate.mesh.position;
        const q = crate.mesh.quaternion;
        values.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w);
      }
      return values;
    };
    /** The largest single component the two passes disagree on. Zero is bit-identical. */
    const drift = (a: readonly number[], b: readonly number[]): number => {
      if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
      let worst = 0;
      for (let index = 0; index < a.length; index += 1)
        worst = Math.max(worst, Math.abs((a[index] as number) - (b[index] as number)));
      return worst;
    };
    const capture = (): readonly IPose[] =>
      crates.map((crate) => ({
        position: crate.mesh.position.clone(),
        quaternion: crate.mesh.quaternion.clone(),
      }));

    /**
     * Clear the vault, put the warden back, and give the solver a few steps to place it before a
     * single crate exists.
     *
     * `teleport` is queued for the bulk step like every other motion, so a pass that begins on the
     * same frame as the teleport begins with the warden still at its *previous* position for one
     * step. Pass one's previous position was the spawn it was already standing on; pass two's was
     * wherever pass one ended. Arming both passes the same way is what makes them comparable.
     */
    let rig: Crate[] = [];
    const clearRig = (): void => {
      for (const crate of rig) crate.dispose();
      rig = [];
    };
    const buildRig = (): void => {
      clearRig();
      rig = REPLAY_RIG.map(
        (pose, index) =>
          new Crate(ctx, crateFinishes({ colour: 2, kind: "solid" }), {
            entity: `rig.${index}`,
            kind: "solid",
            rotationY: 0,
            x: pose.x,
            y: pose.y,
            z: pose.z,
          }),
      );
    };
    const startReplayPass = (phase: "first" | "second"): void => {
      buildRig();
      warden.teleport(REPLAY_START);
      replayPhase = phase;
      replayTick = 0;
      armTicks = REPLAY_ARM_TICKS;
    };

    ctx.state.set({ ...Play.initialState, replayTicks: REPLAY_TICKS, status });

    const frameState: Partial<GameState> = {};

    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, sun, {
        ...this.#materialEnvironment(ctx),
        enabled: materialLightingEnabled(this.#post.tier, this.#materialEnvironment(ctx)),
      }),
    );
    if (this.#environmentSample !== undefined) {
      const { measurement, source, intensity } = this.#environmentSample;
      this.#materialLighting.setEnvironmentMeasurement(
        measurement,
        source,
        intensity,
        this.#environmentSample,
      );
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the frame is the vault's whole
    // per-tick bookkeeping — the two replay passes, the settle test, the push tally and the state
    // flush — and splitting it would move the wiring between three closures that all share it.
    return (frame, dt) => {
      loading.update();
      if (frame.input.justPressed("restart")) {
        frame.state.set(Play.initialState);
        frame.state.flush();
        void frame.goto("play");
        return;
      }

      // --- the deterministic double run -----------------------------------------------------
      if (replayPhase === "first" || replayPhase === "second") {
        if (armTicks > 0) {
          armTicks -= 1;
          warden.update(dt, { x: 0, z: 0 });
          camera.follow(warden.mesh.position, dt);
          return;
        }
        // The pass ends at the TOP of a frame, before anything is queued for the solver.
        //
        // Ending it at the bottom made the two passes different shapes: pass one began on a frame
        // that ran no character step, and pass two began on a frame that had already queued one
        // from the end of pass one. That single extra queued step, resolved against the freshly
        // rebuilt pile, was 0.28 m of divergence in a check whose entire job is to report zero.
        if (replayTick >= REPLAY_TICKS) {
          if (replayPhase === "first") {
            replayDigest = digest();
            // One extra build-and-discard, so pass two's three bodies are an EVEN number of
            // allocate/free cycles after pass one's. Consecutive rebuilds alternate.
            buildRig();
            startReplayPass("second");
          } else {
            const second = digest();
            replayDrift = drift(second, replayDigest);
            // The marker carries the shape of the comparison, not just its verdict: how many
            // numbers were compared and how many of them disagreed at all.
            let differing = 0;
            for (let index = 0; index < second.length; index += 1)
              if (Math.abs((second[index] as number) - (replayDigest[index] ?? 0)) > 1e-9)
                differing += 1;
            console.info(
              `WV_REPLAY bodies=${rig.length} components=${second.length} differing=${differing} drift=${replayDrift}`,
            );
            // A tolerance, not equality. Reported beside the verdict so a reader can see whether
            // the two passes agreed to the last bit or merely to a millimetre.
            replayMatch = replayDrift <= REPLAY_TOLERANCE;
            replayPhase = "done";
            // Put the vault back exactly as the player left it, then let the seal watch again.
            clearRig();
            buildCrates(snapshot);
            warden.teleport(wardenSnapshot);
            seal.area.monitoring = true;
            frame.state.set({ replayBodies: rig.length, replayDrift, replayMatch, replayPhase });
            frame.state.flush();
          }
          camera.follow(warden.mesh.position, dt);
          return;
        }
        warden.update(dt, replayInput(replayTick));
        replayTick += 1;
        camera.follow(warden.mesh.position, dt);
        return;
      }

      if (frame.input.justPressed("verify")) replayRequested = true;
      if (replayRequested && replayPhase === "idle" && settled) {
        replayRequested = false;
        snapshot = capture();

        wardenSnapshot = warden.mesh.position.clone();
        // Nothing that happens during the two passes may end the run.
        seal.area.monitoring = false;
        // Empty the vault, then build and discard one rig, so that BOTH passes allocate their
        // three bodies from a free list of exactly three rather than pass one from a free list of
        // forty-four. Two consecutive rebuilds do not otherwise get the same handles.
        clearCrates();
        buildRig();
        startReplayPass("first");
        frame.state.set({ replayPhase: "first" });
        frame.state.flush();
        return;
      }

      // --- ordinary play --------------------------------------------------------------------
      const touch = touchControls?.update(frame.input.raw.pointers, frame.viewport.size);
      const move = touch?.move ?? frame.input.vector("move");
      // `input.vector("move").y` is +up on the screen, which is -Z in the world. The thumbstick
      // reports the same convention, so the one conversion covers both.
      warden.update(dt, { x: move.x, z: -move.y });
      camera.follow(warden.mesh.position, dt);

      let atRest = 0;
      let pushed = 0;
      let pushDistance = 0;
      let solid = 0;
      let phase = 0;
      for (const crate of crates) {
        if (crate.kind === "phase") phase += 1;
        else solid += 1;
        if (crate.speed < REST_SPEED) atRest += 1;
        if (settled && crate.kind === "solid") {
          const moved = crate.displacement();
          if (moved > PUSH_THRESHOLD) pushed += 1;
          pushDistance = Math.max(pushDistance, moved);
        }
      }
      if (!settled && crates.length > 0) {
        restTicks = atRest === crates.length ? restTicks + 1 : 0;
        if (restTicks >= REST_TICKS) {
          settled = true;
          for (const crate of crates) crate.markRest();
        }
      }

      // Pass-through is counted as an event, not a frame: the warden's capsule centre entering
      // the glowing wall's volume once is one pass, however long it stands inside it.
      const inside =
        warden.mesh.position.x > phaseWall.minX &&
        warden.mesh.position.x < phaseWall.maxX &&
        warden.mesh.position.z > phaseWall.minZ &&
        warden.mesh.position.z < phaseWall.maxZ;
      if (inside && !insidePhaseWall) passThroughs += 1;
      insidePhaseWall = inside;

      // Counted from the live array rather than published once from the authoring plan: the
      // vault does not contain 38 crates until it has dropped them, and a number that is right
      // before the thing it describes exists is a number no scenario can prove anything with.
      frameState.crates = solid;
      frameState.phaseCrates = phase;
      frameState.blockedTicks = warden.blockedTicks;
      frameState.odometer = warden.odometer;
      frameState.wardenFall = warden.fallSpeed;
      frameState.wardenGrounded = warden.grounded;
      frameState.passThroughs = passThroughs;
      frameState.playerX = warden.mesh.position.x;
      frameState.playerZ = warden.mesh.position.z;
      frameState.pushDistance = pushDistance;
      frameState.pushedCrates = pushed;
      frameState.sealContacts = seal.contacts;
      frameState.sealedBy = sealedBy;
      frameState.settled = settled;
      frameState.settledCrates = atRest;
      frameState.status = status;
      frame.state.set(frameState);
    };
  }

  override exit(ctx: GameCtx): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;

    for (const body of this.#statics) body.dispose();
    this.#statics = [];
    super.exit(ctx);
  }
}

/**
 * The two finishes a crate is built from: its own face, and the battens nailed across it.
 *
 * A solid crate wears one of the three tints cycled across the pile — forty bodies in one colour
 * are forty of the same thing — while a phase crate swaps the pair outright: it is the one body a
 * capsule does not collide with, and its glass shell is the only thing that says so before the
 * player tries.
 */
function crateFinishes(plan: Pick<ICrateAuthoring, "colour" | "kind">): readonly Material[] {
  if (plan.kind === "phase") return [phaseMaterial, phaseCoreMaterial];
  const tint = crateMaterials[plan.colour % crateMaterials.length];
  if (tint === undefined) throw new Error("Crate colour index fell outside the palette.");
  return [tint, crateBraceMaterial];
}

/** The glowing ward's footprint, used to count the warden walking through it. */
function phaseWallBounds(): {
  readonly maxX: number;
  readonly maxZ: number;
  readonly minX: number;
  readonly minZ: number;
} {
  return { maxX: 5.5, maxZ: 0.85 + CRATE_SIZE / 2, minX: 2.69, minZ: 0.85 - CRATE_SIZE / 2 };
}

/**
 * Where every body starts, drawn from the seeded source so two loads of seed 6132 build the same
 * vault. Nothing is authored at its resting height: the whole field is dropped a few centimetres
 * so the opening seconds are a real settle, and three of them are authored off-balance so
 * something visibly topples while it happens.
 *
 * Two lanes are deliberately empty. The warden's spawn row (z about 3.0) is clear all the way
 * east, and the approach to the seal carries nothing solid — the only thing standing in it is the
 * glowing ward, which is the one wall the warden can walk through.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the layout is one table of authored
// positions, and each of its four groups is a loop that pushes a plan; the invariants below are what
// read it, so the table stays in one place.
function authorCrates(random: IRandom): readonly ICrateAuthoring[] {
  const plans: ICrateAuthoring[] = [];
  // A seeded rotation through the three tints rather than three independent draws. Random draws
  // clumped: one load came up amber-heavy on the whole east half of the pile, which reads as a
  // palette with two colours in it rather than three.
  const start = Math.floor(random.range(0, 2.999));
  let drawn = 0;
  const colour = (): number => (start + drawn++) % 3;
  const jitter = (amount: number): number => random.range(-amount, amount);

  // The pile: four columns, two deep, three high, in the middle of the room.
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 2; row += 1) {
      for (let level = 0; level < 3; level += 1) {
        // Two gaps knocked out of the top course. A four-by-three block with every cell filled
        // reads as a wall, and the silhouette is most of what makes a pile look like a pile.
        if (level === 2 && ((column === 3 && row === 0) || (column === 0 && row === 1))) continue;
        plans.push({
          colour: colour(),
          kind: "solid",
          rotationY: jitter(0.05),
          x: -2.55 + column * 0.95 + jitter(0.03),
          y: 0.5 + level * 0.95,
          z: -1.45 + row * 0.95 + jitter(0.03),
        });
      }
    }
  }

  // The crate the warden is already leaning on when the vault opens. It is directly in the lane,
  // so the first press of ArrowRight shoves it — which is the mechanic, not decoration.
  // Half a crate off the warden's centre line, which is the whole difference between shoving a
  // crate aside and carrying it the length of the room. Head-on, the character controller pushed
  // it the entire crossing and covered 6.8 m of a 9.5 m lane in the time a proof allows; offset,
  // the first contact deflects it north and the warden walks on. It is still the first thing the
  // player touches, and it is still what the reference picture shows.
  plans.push({
    colour: colour(),
    kind: "solid",
    rotationY: jitter(0.1),
    x: -2.9,
    y: 0.5,
    z: WARDEN_SPAWN.z - 0.44,
  });

  // Singles around the room, clear of the seal's footprint.
  // The warden's lane runs the length of the room at z = 2.0, and the three crates nearest it are
  // held to a sixth of a radian: a crate yawed half a radian has a 0.62 m footprint half-extent
  // rather than 0.46, and three of those turned the crossing into a bulldoze that stalled the
  // warden five metres short of the seal.
  // The four crates nearest the aisle are held to a sixth of a radian: a crate yawed half a
  // radian has a 0.62 m footprint half-extent rather than 0.46, and the lane check has to leave
  // room for the worst case of every crate in the room.
  // The four crates nearest the aisle are held to a sixth of a radian: a crate yawed half a
  // radian has a 0.62 m footprint half-extent rather than 0.46, and the lane check has to leave
  // room for the worst case of every crate in the room.
  const laneAdjacent = new Set([9, 10, 11, 13]);
  const singles: readonly (readonly [number, number])[] = [
    [-4.5, -2.6],
    [-3.5, -0.4],
    [-0.9, 0.6],
    [-4.3, 0.9],
    [1.4, -2.7],
    [-0.3, -3.1],
    [1.25, -3.4],
    [-5.0, -1.6],
    [1.9, 0.45],
    [-4.6, 1.1],
    [-1.3, 1.15],
    [1.3, 1.1],
    [-2.6, -3.3],
    [0.4, 1.1],
    [3.0, -0.3],
  ];
  for (const [index, [x, z]] of singles.entries())
    plans.push({
      colour: colour(),
      kind: "solid",
      rotationY: laneAdjacent.has(index) ? random.range(-0.16, 0.16) : random.range(-0.5, 0.5),
      x: x + jitter(0.05),
      y: 0.52,
      z: z + jitter(0.05),
    });

  // Three off-balance crates: authored above and beside a neighbour so the drop tips them over.
  const topplers: readonly (readonly [number, number, number])[] = [
    [-2.0, 1.55, 0.55],
    [0.5, 1.5, -2.9],
    [0.55, 2.45, -1.3],
  ];
  for (const [x, y, z] of topplers)
    plans.push({ colour: colour(), kind: "solid", rotationY: random.range(0.3, 0.45), x, y, z });

  // The ward: three wide, two high, standing across the seal's approach. Every route from the
  // warden's lane to the seal goes through it, and none of it stops the warden.
  for (let column = 0; column < 3; column += 1)
    plans.push({
      colour: 0,
      kind: "phase",
      rotationY: 0,
      x: 3.15 + column * 0.94,
      y: 0.5,
      z: 0.85,
    });
  plans.push({ colour: 0, kind: "phase", rotationY: 0, x: 4.09, y: 1.44, z: 0.85 });

  assertClearOfSeal(plans);
  assertLaneClear(plans);
  assertClearOfWard(plans);
  return plans;
}

/** The ward's footprint, so nothing solid is authored inside a body it cannot collide with. */
const WARD = { centreX: 4.09, centreZ: 0.85, halfX: 1.41, halfZ: 0.46 } as const;

/**
 * Refuses a layout with a solid crate standing inside the ward.
 *
 * The ward is transparent to every movable body, which is what stops a shoved crate wedging
 * against it and dead-ending the level. The cost is that a crate authored on top of it simply
 * interpenetrates, and on the first screen that does not read as a ghost — it reads as two boxes
 * clipping through each other. A crate *pushed* into it is fine and is the point; a crate that
 * starts there is a mistake.
 */
function assertClearOfWard(plans: readonly ICrateAuthoring[]): void {
  for (const [index, plan] of plans.entries()) {
    if (plan.kind === "phase") continue;
    const reach = footprint(plan.rotationY);
    if (
      Math.abs(plan.x - WARD.centreX) < WARD.halfX + reach &&
      Math.abs(plan.z - WARD.centreZ) < WARD.halfZ + reach
    )
      throw new Error(
        `Crate ${index} is authored inside the ward at (${plan.x.toFixed(2)}, ${plan.z.toFixed(2)}). The ward collides with nothing movable, so it would clip through it on the first frame.`,
      );
  }
}

/** The strip the warden crosses. Nothing but the crate it starts against may stand in it. */
/**
 * The aisle along the front of the vault, and why it is where it is.
 *
 * The near wall is 1.9 m of stone between the camera and the front of the room, and at this
 * elevation it hides everything within about 1.3 m of it: the warden spawned at z 3.15 and only
 * the top of its head cleared the rail. Anything the player has to see stands at z 2.4 or less.
 */
export const LANE = { halfWidth: 0.5, z: WARDEN_SPAWN.z } as const;

/**
 * Refuses a layout that blocks the crossing.
 *
 * The route from the spawn to the seal is the only route the game guarantees, and it turned out to
 * be a hostage to the seeded jitter: adding two decorative crates changed how many numbers the
 * authoring drew from `ctx.random`, every later rotation shifted, and two crates that had been
 * clear of the lane by centimetres moved into it. The warden then bulldozed instead of walking and
 * stopped six metres short of the seal — a level that had been finishable for six runs became
 * unfinishable because of two crates placed nowhere near the lane.
 *
 * So the lane is an invariant with a check, not an intention with a comment.
 */
function assertLaneClear(plans: readonly ICrateAuthoring[]): void {
  for (const [index, plan] of plans.entries()) {
    if (index === PUSH_CRATE_INDEX) continue;
    const reach = footprint(plan.rotationY);
    if (Math.abs(plan.z - LANE.z) < LANE.halfWidth + reach)
      throw new Error(
        `Crate ${index} stands in the warden's lane: z ${plan.z.toFixed(2)} with a ${reach.toFixed(2)} m footprint is inside ${(LANE.z - LANE.halfWidth).toFixed(2)}..${(LANE.z + LANE.halfWidth).toFixed(2)}. The crossing to the seal is the only route this level guarantees.`,
      );
  }
}

/** Half-extent of a crate's footprint along either axis once it is yawed. */
function footprint(rotationY: number): number {
  return (CRATE_SIZE / 2) * (Math.abs(Math.cos(rotationY)) + Math.abs(Math.sin(rotationY)));
}

/**
 * Refuses a layout in which any authored crate already overlaps the seal.
 *
 * This is not defensive tidiness — it is the third time this exact bug shipped. A crate authored
 * with up to half a radian of yaw has a footprint half-extent of 0.46 * (|cos| + |sin|), which is
 * 0.62 m, not 0.46 m; three separate singles cleared the seal on paper and clipped it by a
 * centimetre or two in the world, and the run reported `won` on the opening drop with the warden
 * still standing at its spawn. Reading the number off the screenshot took a build each time.
 * Fail closed at authoring instead, and name the crate.
 */
function assertClearOfSeal(plans: readonly ICrateAuthoring[]): void {
  for (const [index, plan] of plans.entries()) {
    const reach = footprint(plan.rotationY);
    const overlapsX = Math.abs(plan.x - SEAL.x) < SEAL.half + reach;
    const overlapsZ = Math.abs(plan.z - SEAL.z) < SEAL.half + reach;
    if (overlapsX && overlapsZ)
      throw new Error(
        `Crate ${index} is authored inside the seal: (${plan.x.toFixed(2)}, ${plan.z.toFixed(2)}) with a ${reach.toFixed(2)} m footprint reaches the seal at (${SEAL.x}, ${SEAL.z}) half ${SEAL.half}. The run would report won before the warden moves.`,
      );
  }
}
