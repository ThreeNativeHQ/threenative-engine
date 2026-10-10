import { type ICtx, Scene } from "@threenative/core";
import {
  type IWorldCapabilities,
  type IWorldTileColliderInput,
  TerrainTiles,
  getWorldCapabilities,
} from "@threenative/core/world";
import {
  CharacterBody3D,
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
} from "@threenative/physics";
import * as THREE from "three";
import { terrainMaterial } from "../render/terrain.js";
import { TERRAIN_SEED, terrainHeight } from "../world/terrainSampler.js";

const TILE_SIZE = 64;
const TILE_RESOLUTION = 65;
const PLAYER_SPEED = 150;

const initialState = {
  chunks: 0,
  playerX: 0,
};

export type TerrainState = typeof initialState;
type TerrainCtx = ICtx<TerrainState, IPhysicsContext>;

function rendererLimits(ctx: TerrainCtx): Record<string, number> | undefined {
  const raw = ctx.renderer.raw as {
    backend?: { device?: { limits?: Record<string, number> } };
  };
  return raw.backend?.device?.limits;
}

class TerrainPlayer {
  readonly mesh: THREE.Mesh;
  readonly #body: CharacterBody3D;
  readonly #geometry: THREE.BoxGeometry;
  readonly #material: THREE.MeshBasicMaterial;

  constructor(ctx: TerrainCtx) {
    this.#geometry = new THREE.BoxGeometry(8, 8, 8);
    this.#material = new THREE.MeshBasicMaterial({ color: 0xffd27a });
    this.mesh = new THREE.Mesh(this.#geometry, this.#material);
    this.mesh.position.set(0, 30, 0);
    ctx.add(this.mesh);
    this.#body = new CharacterBody3D({
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(2, 2),
      snapToGround: 0.5,
    });
  }

  move(velocity: { x: number; z: number }, dt: number): void {
    this.#body.velocity.x = velocity.x;
    this.#body.velocity.z = velocity.z;
    this.#body.moveAndSlide(dt);
  }

  dispose(): void {
    this.#body.dispose();
    this.mesh.removeFromParent();
    this.#geometry.dispose();
    this.#material.dispose();
  }
}

export class TerrainProbe extends Scene<TerrainState, IPhysicsContext> {
  static override readonly initialState = initialState;

  #player: TerrainPlayer | undefined;
  #tiles: TerrainTiles | undefined;
  #capabilities: IWorldCapabilities | undefined;
  #maxBlendingTiles = 0;
  #frameBlendingTiles = 0;
  #blendFrames: number[] = [];

  override enter(ctx: TerrainCtx): void {
    this.#player = new TerrainPlayer(ctx);
    this.#capabilities = getWorldCapabilities({
      cpuFallbackIterations: 4,
      gpuAvailable: ctx.renderer.kind === "webgpu",
      limits: rendererLimits(ctx),
    });
    const worldPasses =
      this.#capabilities.generation === "unsupported"
        ? undefined
        : {
            dispatchBudget: 4,
            erosion: {
              depositionRate: 0.35,
              erosionRate: 0.22,
              evaporation: 0.04,
              iterations:
                this.#capabilities.generation === "cpu-fallback"
                  ? this.#capabilities.cpuFallbackIterations
                  : 8,
              rainfall: 0.08,
              sedimentCapacity: 0.7,
              timeStep: 0.05,
            },
            gpu: this.#capabilities.generation === "gpu",
          };
    const tiles = new TerrainTiles({
      createCollider: ({ field, key, object, tileX, tileZ }: IWorldTileColliderInput) =>
        new RigidBody3D({
          object,
          physics: ctx.physics,
          shape: CollisionShape3D.heightfield(
            field.rows,
            field.columns,
            field.toColliderHeights(),
            { x: TILE_SIZE, y: 1, z: TILE_SIZE },
          ),
          type: "fixed",
          entity: `terrain.${key}.${String(tileX)}.${String(tileZ)}`,
        }),
      surface: terrainMaterial(),
      residentByteBudget: 20_000_000,
      residentTileBudget: 9,
      sampleHeight: terrainHeight,
      streamRadius: 1,
      tileResolution: TILE_RESOLUTION,
      tileSize: TILE_SIZE,
      lodDistances: [48, 96],
      // This scene exists to measure the streamed field, and seam gap, visual seam and LOD pop are
      // the measurements: without this they read `undefined` and the scenario's assertions have
      // nothing to hold.
      validate: true,
      topologyObservation: {
        columns: 1025,
        depth: 1024,
        origin: { x: 0, z: 0 },
        rows: 1025,
        width: 1024,
      },
      ...(worldPasses === undefined ? {} : { worldPasses }),
    });
    // Populate the initial resident set before registration so compute warm-up sees every
    // field's kernels, including fields created during the first follow operation.
    tiles.follow({ x: 0, z: 0 });
    this.#tiles = ctx.add(tiles);
    const process = tiles.process.bind(tiles);
    tiles.process = (renderer) => {
      // Observe before process removes completed transitions, including their final blend frame.
      this.#frameBlendingTiles = tiles.blendingTiles;
      this.#maxBlendingTiles = Math.max(this.#maxBlendingTiles, this.#frameBlendingTiles);
      process(renderer);
    };
    ctx.beforeRender(() => {
      // One entry per world draw; join the steady tail to runtime.performance's 1,024-frame tail.
      this.#blendFrames.push(this.#frameBlendingTiles);
      if (this.#blendFrames.length > 1_024) this.#blendFrames.shift();
    });
    ctx.entities.add("terrain", {
      debug: () => ({
        ...(this.#tiles?.debug() ?? {}),
        maxBlendingTiles: this.#maxBlendingTiles,
        blendFrames: [...this.#blendFrames],
        cpuFallbackIterations: this.#capabilities?.cpuFallbackIterations ?? 0,
        generation: this.#capabilities?.generation ?? "unsupported",
        gpu: this.#capabilities?.gpu ?? false,
        seed: TERRAIN_SEED,
      }),
      dispose: () => this.#tiles?.dispose(),
      object: this.#tiles,
    });
    ctx.entities.add("player", {
      debug: () => ({ position: this.#player?.mesh.position.toArray() ?? [] }),
      dispose: () => this.#player?.dispose(),
      mesh: this.#player.mesh,
    });
    this.#publish(ctx);
    this.#camera(ctx);
  }

  override update(ctx: TerrainCtx, dt: number): void {
    const player = this.#player;
    const tiles = this.#tiles;
    if (player === undefined || tiles === undefined) return;
    const move = ctx.input.vector("move");
    player.move({ x: move.x * PLAYER_SPEED, z: move.y * PLAYER_SPEED }, dt);
    tiles.follow(player.mesh.position);
    this.#publish(ctx);
    this.#camera(ctx);
  }

  override exit(): void {
    this.#tiles = undefined;
    this.#player = undefined;
    this.#capabilities = undefined;
    this.#maxBlendingTiles = 0;
    this.#frameBlendingTiles = 0;
    this.#blendFrames = [];
  }

  #publish(ctx: TerrainCtx): void {
    const tiles = this.#tiles;
    ctx.state.set({
      chunks: tiles?.residentTileCount ?? 0,
      playerX: this.#player?.mesh.position.x ?? 0,
    });
  }

  #camera(ctx: TerrainCtx): void {
    const player = this.#player?.mesh.position;
    const x = player?.x ?? 0;
    const z = player?.z ?? 0;
    ctx.camera.position.set(x, 180, z + 180);
    ctx.camera.lookAt(x, 0, z);
  }
}
