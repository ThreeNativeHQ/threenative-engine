import {
  AudioBus,
  type ICtx,
  Scene,
  type SceneFrame,
  createRandom,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
  resolveTargetFps,
} from "@threenative/core";
import { Area3D, CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  BufferAttribute,
  Group,
  Mesh,
  NearestFilter,
  type PerspectiveCamera,
  type Texture,
} from "three";
import config from "../../threenative.config.js";
import { Crate } from "../entities/Crate.js";
import { Goal, ISLAND } from "../entities/Goal.js";
import { type IPlayerModel, PLAYER_STAND_Y, Player } from "../entities/Player.js";
import { createArena, platform } from "../render/arena.js";
import { createSpringArm } from "../render/camera.js";
import { pickupRiseEase } from "../render/easing.js";
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { createPennantMaterial, propMaterial } from "../render/materials.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { ball, block, spike, tube } from "../render/shapes.js";
import { setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import { STARTER_MIST, createVolumetricFog } from "../render/volumetricFog.js";
import type { GameState } from "../state.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

const KILL_PLANE = -4;
const STARTING_LIVES = 3;
const FLOOR_SURFACE_Y = 0;
const FLOOR_BOUNDS = { maxX: 5, minX: -5, maxZ: 2, minZ: -2 } as const;
/** The near platform's own footprint, which the support surface below answers for. */
const FLOOR_SIZE = { depth: 4.2, width: 10 } as const;

export class Play extends Scene<GameState, IPhysicsContext> {
  #assetProof: Mesh | undefined;
  #playerModel: IPlayerModel | undefined;
  #sky: Texture | undefined;
  #environmentSample: IEnvironmentSample | undefined;

  static override readonly initialState: GameState = {
    coyoteJumps: 0,
    entityCount: 0,
    flagDisplacement: 0,
    flagGusts: 0,
    flagReadbacks: 0,
    flagSteps: 0,
    jumps: 0,
    levelX: -99,
    lives: STARTING_LIVES,
    odometer: 0,
    paused: false,
    peakRise: 0,
    playerX: -2,
    respawns: 0,
    score: 0,
    status: "playing",
    uiReady: false,
  };

  override async load(ctx: GameCtx): Promise<void> {
    const [texture, model, playerModel, sky] = await Promise.all([
      ctx.assets.texture("native-proof.png"),
      ctx.assets.model<{ scene: Group }>("native-proof.glb"),
      ctx.assets.model<IPlayerModel>("mannequin.glb"),
      ctx.assets.texture("sky.jpg"),
    ]);
    this.#playerModel = playerModel;
    this.#sky = sky;
    setupSky(ctx.scene, sky, ctx.renderer.softwareAdapter !== undefined);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
    // A 16-pixel check filtered smoothly is a grey smear at flag size; nearest keeps the
    // squares square, which is the whole reason the finish flag is legible from the ledge.
    texture.magFilter = NearestFilter;
    let pennant: Mesh | undefined;
    model.scene.traverse((object) => {
      if (object instanceof Mesh) {
        if (pennant !== undefined) throw new Error("Starter proof glTF must contain one mesh.");
        object.material = createPennantMaterial(texture);
        // The packaged proof carries positions and indices only. Without UVs the sampler
        // reads one corner texel for every fragment and the flag renders as flat white —
        // a loaded texture that proves nothing you can see. Plane-project the triangle.
        // Compiled models may be quantized (KHR_mesh_quantization): the attribute then holds
        // normalized integers, so measure each axis range from the array itself instead of
        // assuming float32 metres — the affine projection is identical either way.
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
        pennant = object;
      }
    });
    if (pennant === undefined) throw new Error("Starter proof glTF did not contain a mesh.");
    model.scene.name = "native-proof-assets";
    this.#assetProof = pennant;
    console.info("TN_NATIVE_STARTER_ASSETS_LOADED:texture,glb");
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    if (
      this.#assetProof === undefined ||
      this.#playerModel === undefined ||
      this.#sky === undefined
    )
      throw new Error("Starter scene did not finish loading.");
    const state = ctx.state.getState();
    const player = ctx.entities.add(
      "player",
      new Player(ctx, this.#playerModel, {
        x: Number.isFinite(state.playerX) ? state.playerX : Play.initialState.playerX,
        y: PLAYER_STAND_Y,
        z: 0,
      }),
    );
    const audio = ctx.entities.add("audio", new AudioBus({ camera: ctx.camera }));
    const pickupAudio = ctx.assets.audio("pickup.wav");
    void pickupAudio.catch(() => undefined);
    setupSky(ctx.scene, this.#sky, ctx.renderer.softwareAdapter !== undefined);
    // isMobile() arrives as an argument because src/render/ imports no framework package:
    // the platform decision is made here, in portable game code, exactly like createRandom.
    const { key } = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    this.#post = ctx.entities.add(
      "quality",
      setupPost(ctx.renderer, ctx.scene, ctx.camera, {
        godraysLight: key,
        onTierChanged: (tier) =>
          this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment)),
        mobile: isMobile(),
        software: ctx.renderer.softwareAdapter !== undefined,
        gpuClass: ctx.renderer.gpuClass?.class,
        // One rule for the frame budget, from the engine: the display refresh capped at 120,
        // 60 on mobile. A game that names `display.maxFps` overrides it here too.
        targetFps: resolveTargetFps(config, getPlatform()).targetFps,
        ready: () => ctx.startup.phase === "ready",
        // Rebuilt per graph, so a tier change that replaces the chain cannot compose one medium
        // twice. The look and the flag are `STARTER_MIST`'s, in `volumetricFog.ts`; only the
        // backend is wired here, and with `enabled` false nothing is allocated at all.
        fog: () =>
          createVolumetricFog(ctx.scene, ctx.camera as PerspectiveCamera, {
            ...STARTER_MIST,
            renderer: ctx.renderer.kind,
          }),
      }),
    );
    const loading = createLoadingScreen(ctx);
    ctx.add(ctx.camera);
    const showTouchControls = isMobile() && isTouchscreenAvailable();
    const touchControls = showTouchControls
      ? ctx.entities.add("touch-controls", new TouchControls(ctx.camera as PerspectiveCamera))
      : undefined;
    // Offset, lead and damping all live in render/camera.ts — framing is a look decision.
    const springArm = createSpringArm(ctx.camera as PerspectiveCamera);

    // The prototype test arena every engine opens a new project on, dressed as a course: a light
    // metre-grid ground running out to the haze line, dark-grid walls and a pillar as backdrop,
    // and the near platform between them. Every solid gets a fixed body built from the triangles
    // the player actually sees. Two sentinels, both read by an out-of-range assertion rather than
    // as a transition: state.levelX starts at -99, so a level that never builds stays out of
    // range, and seededLevelX becomes 2 if this draw did not advance ctx.random — which is what
    // happens if someone swaps it for Math.random. Neither depends on WHEN the runner samples.
    const randomStateBeforeLevel = ctx.random.state;
    const levelX = ctx.random.range(-1, 1);
    const seededLevelX = ctx.random.state === randomStateBeforeLevel ? 2 : levelX;
    const pickupX = 1.2 + createRandom(Math.round((levelX + 1) * 1000))() * 0.8;
    const fixed = (mesh: Mesh): Mesh => {
      new RigidBody3D({
        object: mesh,
        physics: ctx.physics,
        shape: CollisionShape3D.fromMesh(mesh, "trimesh"),
        type: "fixed",
      });
      return mesh;
    };
    const arena = createArena();
    ctx.add(arena.group);
    for (const solid of arena.solids) fixed(solid);
    const { base: floorBase, plate: floorMesh } = platform(
      FLOOR_SIZE.width,
      FLOOR_SIZE.depth,
      FLOOR_SURFACE_Y,
      0,
      0,
    );
    ctx.add(fixed(floorMesh));
    ctx.add(fixed(floorBase));
    new Crate(ctx, levelX, 4, -1.5, propMaterial);
    const pickupBase = block(0.42, 0.14, 0.42, propMaterial);
    const pickupStem = tube(0.08, 0.08, 0.3, propMaterial);
    const pickupOrb = ball(0.16, propMaterial);
    const pickupTip = spike(0.14, 0.26, propMaterial);
    pickupBase.position.y = -0.16;
    pickupStem.position.y = 0.06;
    pickupOrb.position.y = 0.32;
    pickupTip.position.y = 0.53;
    const pickupVisual = new Group();
    pickupVisual.add(pickupBase, pickupStem, pickupOrb, pickupTip);
    pickupVisual.position.set(pickupX, 0.5, 0);
    pickupVisual.castShadow = true;
    ctx.add(pickupVisual);
    ctx.entities.add("pickup", pickupVisual);
    void ctx.tween(pickupVisual.position, { y: 0.65 }, 0.4, { ease: pickupRiseEase });
    springArm.snap(player.mesh.position);
    // The packaged proof asset earns its place here: it is the pennant on the finish flag,
    // not a debug object parked over the level. The texture and the glTF still load in
    // `load()` above, which is what the native asset gate greps for.
    const goal = ctx.entities.add("goal", new Goal(ctx, this.#assetProof));
    // All borrowed materials, including the cloned skinned mannequin and arena, now exist.
    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, key, {
        ...materialEnvironment,
        enabled: materialLightingEnabled(this.#post.tier, materialEnvironment),
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
    const supportSurfaceY = (position: { readonly x: number; readonly z: number }):
      | number
      | undefined => {
      if (
        position.x >= FLOOR_BOUNDS.minX &&
        position.x <= FLOOR_BOUNDS.maxX &&
        position.z >= FLOOR_BOUNDS.minZ &&
        position.z <= FLOOR_BOUNDS.maxZ
      )
        return FLOOR_SURFACE_Y;
      if (
        position.x >= ISLAND.x - ISLAND.width / 2 &&
        position.x <= ISLAND.x + ISLAND.width / 2 &&
        position.z >= ISLAND.z - ISLAND.depth / 2 &&
        position.z <= ISLAND.z + ISLAND.depth / 2
      )
        return ISLAND.top;
      return undefined;
    };
    // The area says the character is over the island; the run is only won once it is also
    // standing on it. Ending on the overlap alone freezes the character in mid-air at the
    // lip of the island, half a metre short of a landing, which is what it looks like.
    let overGoal = false;
    goal.area.on("bodyEntered", (body) => {
      if (body === player.body) overGoal = true;
    });
    let entityCount = 4;
    ctx.state.set({ entityCount });
    const pickup = new Area3D({
      physics: ctx.physics,
      position: { x: pickupX, y: 0.5, z: 0 },
      shape: CollisionShape3D.box(1, 1, 1),
    });
    pickup.on("bodyEntered", (body) => {
      if (body !== player.body) return;
      ctx.state.set((state) => ({ score: state.score + 1 }));
      ctx.entities.remove("pickup");
      entityCount -= 1;
      ctx.state.set({ entityCount });
      pickup.monitoring = false;
      pickupVisual.visible = false;
      ctx.after(3, () => {
        ctx.entities.add("pickup", pickupVisual);
        entityCount += 1;
        ctx.state.set({ entityCount });
        pickupVisual.visible = true;
        pickup.monitoring = true;
      });
      void pickupAudio.then((buffer) => audio.play(buffer)).catch(() => undefined);
    });
    if (state.score > 0) {
      ctx.entities.remove("pickup");
      entityCount -= 1;
      ctx.state.set({ entityCount });
      pickup.monitoring = false;
      pickupVisual.visible = false;
    }

    // Set with the level, not 0.25 s later. The delay existed so the playtest could observe the
    // -99 -> seeded transition, which made the assertion a race against boot time: it was sampled
    // at tick 6 on a workstation and tick 47 in CI, and only the slow sample missed the change.
    ctx.state.set({ levelX: seededLevelX });
    const frameState: Partial<GameState> = {};
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: starter frame coordinates existing gameplay state transitions.
    return (frameCtx, dt) => {
      loading.update();
      // Restart resets the store before clearing entities and scheduled callbacks.
      if (frameCtx.input.justPressed("restart")) {
        frameCtx.state.set(Play.initialState);
        frameCtx.state.flush();
        void frameCtx.goto("play");
        return;
      }
      const previous = frameCtx.state.getState();
      // A finished run stops simulating the character and keeps drawing the world behind
      // the banner. R, or the restart button, rebuilds the scene from `initialState`.
      if (previous.status !== "playing") return;
      if (frameCtx.input.justPressed("flagGust")) {
        goal.pennant.wind.set(0, 0.4, 4.5);
        frameCtx.state.set((state) => ({ flagGusts: state.flagGusts + 1 }));
      }
      const touch = touchControls?.update(frameCtx.input.raw.pointers, frameCtx.viewport.size);
      player.update(frameCtx, dt, supportSurfaceY, touch);
      let respawned = false;
      let lives = previous.lives;
      if (player.mesh.position.y < KILL_PLANE) {
        lives -= 1;
        player.respawn();
        springArm.snap(player.mesh.position);
        respawned = true;
      }
      springArm.dolly(frameCtx.input.axis("zoom"), dt);
      springArm.follow(player.mesh.position, dt);
      // `status` is written only on the frame that ends the run, and never in the bulk
      // write below, which would stamp this frame's stale copy back over it.
      if (lives <= 0) frameCtx.state.set({ status: "lost" });
      else if (overGoal && player.grounded) {
        frameCtx.state.set({ status: "won" });
        frameCtx.state.flush();
      }
      frameState.coyoteJumps = player.coyoteJumps;
      frameState.flagDisplacement = Math.max(previous.flagDisplacement, goal.flagDisplacement());
      frameState.flagReadbacks = goal.readbackLands();
      frameState.flagSteps = goal.pennant.steps;
      frameState.jumps = player.jumps;
      frameState.lives = lives;
      frameState.odometer = player.odometer;
      // The rise above the standing body, not above the world origin: measured from the origin a
      // 1.8 m figure would report its own height as a jump.
      frameState.peakRise = Math.max(previous.peakRise, player.mesh.position.y - PLAYER_STAND_Y);
      frameState.playerX = player.mesh.position.x;
      frameState.respawns = previous.respawns + (respawned ? 1 : 0);
      const current = frameCtx.state.getState();
      const changed =
        frameState.coyoteJumps !== current.coyoteJumps ||
        frameState.flagDisplacement !== current.flagDisplacement ||
        frameState.flagReadbacks !== current.flagReadbacks ||
        frameState.flagSteps !== current.flagSteps ||
        frameState.jumps !== current.jumps ||
        frameState.lives !== current.lives ||
        frameState.odometer !== current.odometer ||
        frameState.peakRise !== current.peakRise ||
        frameState.playerX !== current.playerX ||
        frameState.respawns !== current.respawns;
      if (changed) frameCtx.state.set(frameState);
      if (respawned) frameCtx.state.flush();
    };
  }

  #post: ReturnType<typeof setupPost> | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override exit(ctx: GameCtx): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    // Also releases the medium `setupPost` built, with the graph it composed into.
    this.#post?.dispose();
    this.#post = undefined;
    super.exit(ctx);
  }
}
