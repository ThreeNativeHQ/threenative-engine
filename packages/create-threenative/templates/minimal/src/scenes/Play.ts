import {
  type ICtx,
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import {
  Area3D,
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  buildStaticColliders,
} from "@threenative/physics";
import {
  CylinderGeometry,
  Group,
  Mesh,
  type PerspectiveCamera,
  PlaneGeometry,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { type IPlayerModel, Player } from "../entities/Player.js";
import { followCamera, setupCamera } from "../render/camera.js";
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import {
  floorMaterial,
  propMaterial,
  structureMaterial,
  worldGridUVs,
} from "../render/materials.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import type { GameState } from "../state.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    playerX: -2,
    score: 0,
  };

  #model: IPlayerModel | undefined;
  #sky: Texture | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    [this.#model, this.#sky] = await Promise.all([
      ctx.assets.model<IPlayerModel>("mannequin.glb"),
      ctx.assets.texture("sky.jpg"),
    ]);
    setupSky(ctx.scene, this.#sky);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    if (this.#model === undefined || this.#sky === undefined)
      throw new Error("Play.enter ran before load() loaded mannequin.glb and sky.jpg.");
    const showTouchControls = isMobile() && isTouchscreenAvailable();
    setupSky(ctx.scene, this.#sky);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    // isMobile() arrives as an argument because src/render/ imports no framework package: the
    // platform decision is made here, in portable game code, exactly like createRandom.
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      godraysLight: lighting.key,
      onTierChanged: (tier) =>
        this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment)),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    setupCamera(ctx.camera as PerspectiveCamera);
    const loading = createLoadingScreen(ctx);
    ctx.add(ctx.camera);
    const touchControls = showTouchControls
      ? ctx.entities.add("touch-controls", new TouchControls(ctx.camera as PerspectiveCamera))
      : undefined;
    // The prototype arena every engine opens a new project on: a light grid floor, dark grid walls
    // and blocks, one tall cylinder, and blue crates — the saturated colour marks what you can
    // touch. Everything added to `level` becomes a fixed trimesh body below, so the player collides
    // with exactly the triangles it sees — the ramp is a slope, not its bounding box.
    const level = new Group();
    const solid = (mesh: Mesh): Mesh => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      level.add(mesh);
      return mesh;
    };
    // Bevelled, not sharp: a 3 cm rounded edge catches a line of sun and a line of sky, which is
    // what makes a block read as a made object instead of a placeholder. UVs are world metres, so
    // one grid tile is one metre on every face (`worldGridUVs`). Each block sinks by its bevel
    // radius: resting the rounded bottom edge on the floor leaves a lit sliver under it, and the
    // block's shadow reads as detached from the block.
    const BEVEL = 0.03;
    const block = (
      size: readonly [number, number, number],
      at: readonly [number, number, number],
      material = structureMaterial,
    ): Mesh => {
      const geometry = new RoundedBoxGeometry(size[0], size[1], size[2], 2, BEVEL);
      geometry.translate(at[0], at[1] + size[1] / 2 - BEVEL, at[2]);
      return solid(new Mesh(worldGridUVs(geometry), material));
    };
    // The floor runs out past the walls to the haze line, so the sky over a wall meets ground, not
    // a void. Its collider is the arena's footprint.
    const groundSize = 12_000;
    const groundGeometry = new PlaneGeometry(groundSize, groundSize).rotateX(-Math.PI / 2);
    const ground = new Mesh(worldGridUVs(groundGeometry), floorMaterial);
    ground.receiveShadow = true;
    ctx.add(ground);
    new RigidBody3D({
      physics: ctx.physics,
      position: { x: 0, y: -0.5, z: 0 },
      shape: CollisionShape3D.box(200, 1, 200),
      type: "fixed",
    });
    const half = 16;
    for (const [size, at] of [
      [
        [half * 2 + 1, 4, 1],
        [0, 0, -half],
      ],
      [
        [half * 2 + 1, 4, 1],
        [0, 0, half],
      ],
      [
        [1, 4, half * 2 - 1],
        [-half, 0, 0],
      ],
      [
        [1, 4, half * 2 - 1],
        [half, 0, 0],
      ],
    ] as const)
      block(size, at);
    // A raised deck with a ramp up to it, and a step block beside it.
    block([8, 1.5, 6], [-9, 0, -9]);
    block([4, 0.75, 3], [-3.5, 0, -12.5]);
    const ramp = new RoundedBoxGeometry(6.2, 0.4, 4, 2, BEVEL);
    ramp.rotateZ(-Math.atan2(1.5, 6));
    ramp.translate(-2, 0.55, -8);
    solid(new Mesh(worldGridUVs(ramp), structureMaterial));
    const pillar = new CylinderGeometry(2.4, 2.4, 6, 48);
    pillar.translate(8, 3, -8);
    solid(new Mesh(worldGridUVs(pillar), structureMaterial));
    for (const [x, y, z, edge, turn] of [
      [3, 0, -4, 1, 0.3],
      [4.2, 0, -4.5, 1, -0.15],
      [3.6, 1, -4.2, 1, 0.9],
      [-6, 0, 4, 1.5, -0.25],
      [10, 0, 5, 1.2, 0.6],
    ] as const) {
      const crate = new Mesh(new RoundedBoxGeometry(edge, edge, edge, 2, BEVEL), propMaterial);
      crate.position.set(x, y + edge / 2 - BEVEL, z);
      crate.rotation.y = turn;
      solid(crate);
    }
    ctx.add(level);
    buildStaticColliders(ctx, level);
    const player = new Player(ctx, this.#model);
    const camera = ctx.camera as PerspectiveCamera;
    afterPhysics(ctx, (dt) => followCamera(camera, player.mesh.position, dt));
    ctx.entities.add("player", player);
    const pickup = new Area3D({
      physics: ctx.physics,
      position: { x: 1.5, y: 0.5, z: 0 },
      shape: CollisionShape3D.box(1, 1, 1),
    });
    pickup.on("bodyEntered", (body) => {
      if (body === player.body) ctx.state.set((state) => ({ score: state.score + 1 }));
    });

    // Loaded character and all arena meshes are attached before the single material traversal.
    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, lighting.key, {
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
    const statePatch: Partial<GameState> = {};
    return (frameCtx, dt) => {
      loading.update();
      player.update(
        frameCtx,
        dt,
        touchControls?.update(frameCtx.input.raw.pointers, frameCtx.viewport.size),
      );
      statePatch.playerX = player.mesh.position.x;
      frameCtx.state.set(statePatch);
    };
  }
  override exit(): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#environmentSample = undefined;
  }
}
