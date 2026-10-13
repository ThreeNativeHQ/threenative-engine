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
import { positionWorld, vec4 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { terrainMaterial } from "../render/terrain.js";
import { TERRAIN_SEED, terrainHeight } from "../world/terrainSampler.js";

const TILE_SIZE = 64;
const TILE_RESOLUTION = 65;
const PLAYER_SPEED = 150;
// 128 RGBA32F texels are 2,048 bytes a row, so the readback needs no row padding.
const GPU_SURFACE_SIZE = 128;
const GPU_SURFACE_OBSERVATIONS = 8;

interface IGpuRenderer {
  getClearAlpha(): number;
  getClearColor(target: THREE.Color): THREE.Color;
  getRenderTarget(): THREE.RenderTarget | null;
  readRenderTargetPixelsAsync(
    target: THREE.RenderTarget,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<Float32Array>;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  setRenderTarget(target: THREE.RenderTarget | null): void;
}

const initialState = {
  chunks: 0,
  playerX: 0,
};

interface ITerrainBlendFrame {
  readonly frame: number;
  readonly startedAt: number;
  readonly blendingTiles: number;
  frameMs?: number;
}

export function retainTerrainBlendFrame(
  entries: ITerrainBlendFrame[],
  startedAt: number,
  blendingTiles: number,
): void {
  const previous = entries.at(-1);
  // The interval ends at the next draw; it belongs to the draw that just completed.
  if (previous !== undefined) previous.frameMs = startedAt - previous.startedAt;
  entries.push({ frame: (previous?.frame ?? -1) + 1, startedAt, blendingTiles });
  if (entries.length > 1_024) entries.shift();
}

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
  #blendFrames: ITerrainBlendFrame[] = [];
  #lodEligibilityTrace: Record<string, unknown>[] = [];
  #lodEligibilityOverflow = 0;
  #sceneUpdateTick = 0;
  #gpuSurfaceMaterial: MeshBasicNodeMaterial | undefined;
  #gpuSurfaceStarted = 0;
  #gpuSurfaceFrames = 0;
  #gpuSurfaceSamples = 0;
  #gpuSurfaceMaxError = 0;
  #gpuSurfaceFailure: Error | undefined;
  #gpuSurfaceEpoch = 0;

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
      retainTerrainBlendFrame(this.#blendFrames, performance.now(), this.#frameBlendingTiles);
      const view = this.#view(ctx);
      process(renderer, camera, covered, view);
      reference.process(renderer, camera, covered, view);
      this.#checkParity();
    };
    ctx.beforeRender(() => {
      const failure = this.#gpuSurfaceFailure;
      this.#gpuSurfaceFailure = undefined;
      if (failure !== undefined) throw failure;
      this.#observeGpuSurface(ctx);
      if (this.#lodEligibilityTrace.length >= 1_024) {
        this.#lodEligibilityOverflow++;
      } else {
        const snapshot = tiles.debug();
        const fields = [
          "lodPolicy",
          "residentKeys",
          "pendingConstruction",
          "ringEpoch",
          "lodTransitions",
          "terrainTiles",
          "lodDecisions",
        ];
        this.#lodEligibilityTrace.push({
          renderSample: this.#lodEligibilityTrace.length,
          sceneUpdateTick: this.#sceneUpdateTick,
          parityFrame: this.#parityFrames,
          playerPosition: this.#player?.mesh.position.toArray() ?? null,
          lodPolicy: snapshot.lodPolicy ?? null,
          residentKeys: snapshot.residentKeys ?? null,
          pendingConstruction: snapshot.pendingConstruction ?? null,
          ringEpoch: snapshot.ringEpoch ?? null,
          lodTransitions: snapshot.lodTransitions ?? null,
          terrainTiles: snapshot.terrainTiles ?? null,
          lodDecisions: snapshot.lodDecisions ?? null,
          missingFields: fields.filter((field) => snapshot[field] === undefined),
        });
      }
    });
    ctx.entities.add("terrain", {
      debug: () => ({
        ...(this.#tiles?.debug() ?? {}),
        lodCamera: {
          type: ctx.camera.type,
          projectionMatrix: ctx.camera.projectionMatrix.toArray(),
          matrixWorld: ctx.camera.matrixWorld.toArray(),
          rasterWidth: ctx.renderer.domElement.width,
          rasterHeight: ctx.renderer.domElement.height,
        },
        maxBlendingTiles: this.#maxBlendingTiles,
        // The newest draw has no ending timestamp yet; expose only completed intervals.
        blendFrames: this.#blendFrames.slice(0, -1).map((entry) => ({ ...entry })),
        lodEligibilityTrace: {
          sampling: "beforeRender; sceneUpdateTick is a scene-local update ordinal",
          overflow: this.#lodEligibilityOverflow,
          // The bridge rejects snapshots over 1 MB; each entry is ~3 KB, so expose the newest 64.
          retained: this.#lodEligibilityTrace.length,
          samples: this.#lodEligibilityTrace.slice(-64),
        },
        cpuFallbackIterations: this.#capabilities?.cpuFallbackIterations ?? 0,
        generation: this.#capabilities?.generation ?? "unsupported",
        gpu: this.#capabilities?.gpu ?? false,
        seed: TERRAIN_SEED,
        parityFrames: this.#parityFrames,
        parityVertices: this.#parityVertices,
        activeMorphFrames: this.#activeMorphFrames,
        maxPositionError: this.#maxPositionError,
        maxNormalError: this.#maxNormalError,
        gpuSurfaceFrames: this.#gpuSurfaceFrames,
        gpuSurfaceSamples: this.#gpuSurfaceSamples,
        gpuSurfaceMaxError: this.#gpuSurfaceMaxError,
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
    this.#sceneUpdateTick++;
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
    this.#lodEligibilityTrace = [];
    this.#lodEligibilityOverflow = 0;
    this.#sceneUpdateTick = 0;
    this.#gpuSurfaceEpoch++;
    this.#gpuSurfaceMaterial?.dispose();
    this.#gpuSurfaceMaterial = undefined;
    this.#gpuSurfaceStarted = 0;
    this.#gpuSurfaceFrames = 0;
    this.#gpuSurfaceSamples = 0;
    this.#gpuSurfaceMaxError = 0;
    this.#gpuSurfaceFailure = undefined;
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

  // AC-1: draws a blending tile's morphed source mesh as world positions into a float target,
  // then checks the readback against a ray cast on a same-frame copy of the CPU reference.
  #observeGpuSurface(ctx: TerrainCtx): void {
    const gpu = this.#tiles;
    const cpu = this.#reference;
    if (ctx.renderer.kind !== "webgpu" || gpu === undefined || cpu === undefined) return;
    if (this.#gpuSurfaceStarted >= GPU_SURFACE_OBSERVATIONS) return;
    for (const key of gpu.residentKeys) {
      const tile = gpu.getTile(key);
      const index = tile?.lod.levels.findIndex(({ object }) => object.visible) ?? -1;
      const mesh = tile?.lod.levels[index]?.object;
      const oracle = cpu.getTile(key)?.lod.levels[index]?.object;
      if (!(mesh instanceof THREE.Mesh) || !(oracle instanceof THREE.Mesh)) continue;
      if (!(mesh.morphTargetInfluences ?? []).some((weight) => weight > 0 && weight < 1)) continue;
      this.#gpuSurfaceStarted++;
      const epoch = this.#gpuSurfaceEpoch;
      void this.#observeSurface(ctx.renderer.raw as IGpuRenderer, mesh, oracle).then(
        ({ maxError, samples }) => {
          if (epoch !== this.#gpuSurfaceEpoch) return;
          this.#gpuSurfaceFrames++;
          this.#gpuSurfaceSamples += samples;
          this.#gpuSurfaceMaxError = Math.max(this.#gpuSurfaceMaxError, maxError);
        },
        (error: unknown) => {
          if (epoch === this.#gpuSurfaceEpoch)
            this.#gpuSurfaceFailure = error instanceof Error ? error : new Error(String(error));
        },
      );
      return;
    }
  }

  async #observeSurface(
    raw: IGpuRenderer,
    mesh: THREE.Mesh,
    oracle: THREE.Mesh,
  ): Promise<{ maxError: number; samples: number }> {
    // Copy everything now: the next blend frame rewrites the reference positions.
    const positions = oracle.geometry.getAttribute("position");
    const reference = new THREE.Mesh(
      new THREE.BufferGeometry()
        .setAttribute("position", new THREE.BufferAttribute(Float32Array.from(positions.array), 3))
        .setIndex(oracle.geometry.index),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    const target = new THREE.RenderTarget(GPU_SURFACE_SIZE, GPU_SURFACE_SIZE, {
      depthBuffer: true,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });
    try {
      mesh.updateWorldMatrix(true, false);
      reference.matrixAutoUpdate = false;
      reference.matrix.copy(mesh.matrixWorld);
      reference.updateMatrixWorld(true);
      // fragmentNode, not colorNode: colorNode output clamps to >= 0, zeroing negative y and z.
      this.#gpuSurfaceMaterial ??= new MeshBasicNodeMaterial({
        fragmentNode: vec4(positionWorld, 1),
        fog: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      // The same geometry shares the tile's morph texture; the copied weights are the drawn blend.
      const probe = new THREE.Mesh(mesh.geometry, this.#gpuSurfaceMaterial);
      probe.matrixAutoUpdate = false;
      probe.matrix.copy(mesh.matrixWorld);
      probe.frustumCulled = false;
      probe.morphTargetInfluences = [...(mesh.morphTargetInfluences ?? [])];
      const scene = new THREE.Scene();
      scene.add(probe);
      scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromBufferAttribute(positions as THREE.BufferAttribute);
      const center = bounds.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      const half = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 0.55;
      const camera = new THREE.OrthographicCamera(-half, half, half, -half, 1, 8192);
      camera.up.set(0, 0, -1);
      camera.position.set(center.x, 4096, center.z);
      camera.lookAt(center.x, 0, center.z);
      camera.updateMatrixWorld(true);
      const previousTarget = raw.getRenderTarget();
      const previousColor = raw.getClearColor(new THREE.Color());
      const previousAlpha = raw.getClearAlpha();
      try {
        raw.setRenderTarget(target);
        raw.setClearColor(0x000000, 0);
        raw.render(scene, camera);
      } finally {
        // Restore before awaiting: the main frame must not draw into the probe target.
        raw.setRenderTarget(previousTarget);
        raw.setClearColor(previousColor, previousAlpha);
      }
      const pixels = await raw.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        GPU_SURFACE_SIZE,
        GPU_SURFACE_SIZE,
      );
      const raycaster = new THREE.Raycaster();
      const origin = new THREE.Vector3();
      const down = new THREE.Vector3(0, -1, 0);
      let maxError = 0;
      let samples = 0;
      // Interior texels only: the frame is 10% wider than the footprint, so every one is covered.
      for (let row = 16; row < GPU_SURFACE_SIZE - 16; row += 8) {
        for (let column = 16; column < GPU_SURFACE_SIZE - 16; column += 8) {
          const offset = (row * GPU_SURFACE_SIZE + column) * 4;
          const x = pixels[offset] ?? Number.NaN;
          const y = pixels[offset + 1] ?? Number.NaN;
          const z = pixels[offset + 2] ?? Number.NaN;
          if (!((pixels[offset + 3] ?? 0) > 0.5))
            throw new Error(`GPU surface texel (${column}, ${row}) is not covered.`);
          raycaster.set(origin.set(x, 4096, z), down);
          const hit = raycaster.intersectObject(reference)[0];
          if (hit === undefined)
            throw new Error(`CPU reference has no surface under GPU texel (${x}, ${z}).`);
          const error = Math.abs(y - hit.point.y);
          if (!Number.isFinite(error) || error > 0.001)
            throw new Error(
              `GPU surface is ${error} m from the CPU blend at (${x}, ${z}): texel=${column},${row} rgba=${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]} hit=${hit.point.toArray()} center=${center.toArray()} half=${half} boundsMin=${bounds.min.toArray()} boundsMax=${bounds.max.toArray()} world=${mesh.matrixWorld.elements.join(",")}`,
            );
          maxError = Math.max(maxError, error);
          samples++;
        }
      }
      return { maxError, samples };
    } finally {
      reference.geometry.dispose();
      (reference.material as THREE.Material).dispose();
      target.dispose();
    }
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
    const y = player?.y ?? 0;
    ctx.camera.position.set(x, y + 180, z + 180);
    ctx.camera.lookAt(x, y, z);
  }
}
