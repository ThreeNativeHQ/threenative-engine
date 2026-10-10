import {
  DISCRETE_LOD_DEFAULT_ERROR_PIXELS,
  DISCRETE_LOD_DEFAULT_HYSTERESIS,
  type ICtx,
  Scene,
} from "@threenative/core";
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
  #reference: TerrainTiles | undefined;
  #parityFrames = 0;
  #parityVertices = 0;
  #activeMorphFrames = 0;
  #maxPositionError = 0;
  #maxNormalError = 0;
  #capabilities: IWorldCapabilities | undefined;
  #maxBlendingTiles = 0;
  #frameBlendingTiles = 0;
  #blendFrames: number[] = [];

  override enter(ctx: TerrainCtx): void {
    this.#player = new TerrainPlayer(ctx);
    this.#camera(ctx);
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
    const tileOptions = {
      surface: terrainMaterial(),
      residentByteBudget: 20_000_000,
      residentTileBudget: 9,
      sampleHeight: terrainHeight,
      streamRadius: 1,
      tileResolution: TILE_RESOLUTION,
      tileSize: TILE_SIZE,
      lodDistances: [48, 96],
      topologyObservation: {
        columns: 1025,
        depth: 1024,
        origin: { x: 0, z: 0 },
        rows: 1025,
        width: 1024,
      },
      ...(worldPasses === undefined ? {} : { worldPasses }),
    };
    const tiles = new TerrainTiles({
      ...tileOptions,
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
      validate: false,
    });
    // Populate the initial resident set before registration so compute warm-up sees every
    // field's kernels, including fields created during the first follow operation.
    tiles.follow({ x: 0, z: 0 }, undefined, this.#view(ctx));
    const reference = new TerrainTiles({
      ...tileOptions,
      validate: true,
      residentTileBudget: tiles.residentTileCount,
    });
    reference.follow({ x: 0, z: 0 }, undefined, this.#view(ctx));
    this.#reference = reference;
    this.#tiles = ctx.add(tiles);
    const process = tiles.process.bind(tiles);
    tiles.process = (renderer, camera, covered) => {
      // Observe before process removes completed transitions, including their final blend frame.
      this.#frameBlendingTiles = tiles.blendingTiles;
      this.#maxBlendingTiles = Math.max(this.#maxBlendingTiles, this.#frameBlendingTiles);
      const view = this.#view(ctx);
      process(renderer, camera, covered, view);
      reference.process(renderer, camera, covered, view);
      this.#checkParity();
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
        parityFrames: this.#parityFrames,
        parityVertices: this.#parityVertices,
        activeMorphFrames: this.#activeMorphFrames,
        maxPositionError: this.#maxPositionError,
        maxNormalError: this.#maxNormalError,
      }),
      dispose: () => this.#tiles?.dispose(),
      object: this.#tiles,
    });
    ctx.entities.add("terrainCpuReference", {
      debug: () => reference.debug(),
      dispose: () => reference.dispose(),
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
    this.#camera(ctx);
    const view = this.#view(ctx);
    tiles.follow(player.mesh.position, undefined, view);
    this.#reference?.follow(player.mesh.position, undefined, view);
    this.#publish(ctx);
  }

  override exit(): void {
    this.#reference?.dispose();
    this.#reference = undefined;
    this.#tiles = undefined;
    this.#parityFrames = 0;
    this.#parityVertices = 0;
    this.#activeMorphFrames = 0;
    this.#maxPositionError = 0;
    this.#maxNormalError = 0;
    this.#player = undefined;
    this.#capabilities = undefined;
    this.#maxBlendingTiles = 0;
    this.#frameBlendingTiles = 0;
    this.#blendFrames = [];
  }

  #view(ctx: TerrainCtx) {
    return {
      camera: ctx.camera,
      viewportHeight: ctx.renderer.domElement.height,
      maxPixelError: DISCRETE_LOD_DEFAULT_ERROR_PIXELS,
      hysteresis: DISCRETE_LOD_DEFAULT_HYSTERESIS,
    };
  }

  #checkParity(): void {
    const gpu = this.#tiles;
    const cpu = this.#reference;
    if (gpu === undefined || cpu === undefined) throw new Error("Terrain parity needs both paths.");
    const frame = this.#parityFrames;
    if (
      gpu.residentKeys.join() !== cpu.residentKeys.join() ||
      gpu.lodTransitions !== cpu.lodTransitions ||
      gpu.maxLodTransitionFrames !== cpu.maxLodTransitionFrames
    )
      throw new Error(
        `Terrain parity residency/transitions diverged at frame ${frame}: GPU ${gpu.residentKeys}, CPU ${cpu.residentKeys}.`,
      );
    const actual = new THREE.Vector3();
    const expected = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const delta = new THREE.Vector3();
    let active = false;
    for (const key of gpu.residentKeys) {
      const tile: ReturnType<TerrainTiles["getTile"]> = gpu.getTile(key);
      const reference = cpu.getTile(key);
      if (tile === undefined || reference === undefined || tile.lodLevel !== reference.lodLevel)
        throw new Error(`Terrain LOD parity diverged at frame ${frame}, tile ${key}.`);
      const index = tile.lod.levels.findIndex(({ object }) => object.visible);
      // Settled merged tiles have no visible source mesh; their blends always draw individually.
      if (index < 0) continue;
      const mesh = tile.lod.levels[index]?.object;
      const oracle = reference.lod.levels[index]?.object;
      if (!(mesh instanceof THREE.Mesh) || !(oracle instanceof THREE.Mesh))
        throw new Error(`Terrain parity needs matching meshes at frame ${frame}, tile ${key}.`);
      const positions = oracle.geometry.getAttribute("position");
      const normals = oracle.geometry.getAttribute("normal");
      if (positions.count !== mesh.geometry.getAttribute("position").count)
        throw new Error(`Terrain parity vertex count diverged at frame ${frame}, tile ${key}.`);
      const weights = mesh.morphTargetInfluences ?? [];
      active ||= weights.some((weight) => weight > 0 && weight < 1);
      for (let vertex = 0; vertex < positions.count; vertex++) {
        mesh.getVertexPosition(vertex, actual);
        const positionError = actual.distanceTo(expected.fromBufferAttribute(positions, vertex));
        normal.fromBufferAttribute(mesh.geometry.getAttribute("normal"), vertex);
        for (const [target, weight] of weights.entries()) {
          const attribute = mesh.geometry.morphAttributes.normal?.[target];
          if (attribute !== undefined)
            normal.addScaledVector(delta.fromBufferAttribute(attribute, vertex), weight);
        }
        const normalError = normal
          .normalize()
          .distanceTo(expected.fromBufferAttribute(normals, vertex).normalize());
        if (
          !Number.isFinite(positionError + normalError) ||
          positionError > 0.001 ||
          normalError > 0.001
        )
          throw new Error(
            `Terrain morph parity failed at frame ${frame}, tile ${key}, vertex ${vertex}: position=${positionError}, normal=${normalError}.`,
          );
        this.#maxPositionError = Math.max(this.#maxPositionError, positionError);
        this.#maxNormalError = Math.max(this.#maxNormalError, normalError);
        this.#parityVertices++;
      }
    }
    if (active) this.#activeMorphFrames++;
    this.#parityFrames++;
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
