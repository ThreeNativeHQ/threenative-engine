import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { pass } from "three/tsl";
// The portable half of the PRD-117 ThreeNative arm: it builds the scene, steps it from a frame
// index, and renders. It touches no browser global other than the canvas handed to it, so the
// device arms of Phase 4 can drive the same file.
import {
  ACESFilmicToneMapping,
  Box3,
  BoxGeometry,
  type BufferGeometry,
  DirectionalLight,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  Object3D,
  type OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RenderPipeline,
  RenderTarget,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
// Type-only, and that is the point: `plain-three-webgpu` drives this same harness for the same
// scene, and a runtime import here would put the framework in the control arm's served graph. The
// arm that owns the optimizer passes the factory in; an arm that has none has no L3 to measure.
import type { MatrixWorldPass } from "../../../packages/core/src/matrix-world.js";
import type { RenderCameraCull } from "../../../packages/core/src/render-camera-cull.js";
import type {
  IRenderProjectionOptions,
  IRenderProjectionReport,
  SceneRenderProjection,
} from "../../../packages/core/src/renderProjection.js";
import {
  type IFoxMeasurement,
  type IFrameStats,
  type ILadderCounts,
  LADDER_BLOOM_RADIUS,
  LADDER_BLOOM_STRENGTH,
  LADDER_BLOOM_THRESHOLD,
  LADDER_HEADLINE_HEIGHT,
  LADDER_HEADLINE_WIDTH,
  LADDER_HEIGHT,
  LADDER_POINT_LIGHTS,
  LADDER_SHADOW_MAP_SIZE,
  LADDER_TONEMAPPING,
  LADDER_WIDTH,
  type RealisticRung,
  characterPlacement,
  frameStats,
  pointLightPosition,
  resolutionOf,
  rungAtLeast,
} from "./ladder.js";
import { type IPhaseRecorder, PHASE } from "./phases.js";
import {
  DEFAULT_AXES,
  type ICubePlacement,
  type IWorkloadAxes,
  type RenderMode,
  assertRungAxesSupported,
  cameraPose,
  canonicalPlacementBytes,
  createPlacements,
  cubeBobY,
  cubeRotationX,
  cubeRotationY,
  culledOffsetX,
  isAuthoredRung,
  isMutated,
  isProjectedRung,
  isRealisticRung,
  latticeExtent,
  positionHash,
  uniqueMaterialColor,
} from "./workload.js";

export const VIEWPORT_WIDTH = 1280;
export const VIEWPORT_HEIGHT = 720;

/** How an arm that owns a render projection builds one over a scene. */
export type CollapseFactory = (
  scene: Scene,
  options?: IRenderProjectionOptions,
) => SceneRenderProjection;

/**
 * The two passes `defineGame` installs around the draw that no render argument can carry: the
 * engine's visible-only world-matrix walk and the projected-size cull. The arm that owns the
 * framework builds them at their shipped defaults and hands them in, because this module may only
 * ever import the framework's *types* — a runtime import would put the engine in the control arm's
 * served graph, and the whole comparison rests on that arm having none.
 */
export interface ILoadTestEnginePasses {
  readonly cameraCull: RenderCameraCull;
  readonly matrixWorld: MatrixWorldPass;
}

/**
 * Wraps the world-matrix pass so its time is its own phase wherever it is called from: the render projection
 * calls it inside `reconcile` too, and the exclusive phases then move that time out of `projection`.
 */
function timeMatrixWorld(pass: MatrixWorldPass, phases: IPhaseRecorder): void {
  const apply = pass.apply.bind(pass);
  pass.apply = (root, force) => {
    phases.begin(PHASE.matrixWorld);
    try {
      return apply(root, force);
    } finally {
      phases.end();
    }
  };
}

export interface ILoadTestRung {
  mode: RenderMode;
  objectCount: number;
}

/**
 * PRD-464's R3 characters. The arm that owns the framework builds them with the engine's own
 * `SkeletalMesh3D` and hands them in, for the same reason it hands in the projection: this module
 * may only import the framework's types, or the control arm would inherit it. An arm with no
 * factory asking for R3 fails closed at `setRung` rather than quietly measuring R1.
 */
export interface ICharacterCrowd {
  /**
   * The one factor every character's root is scaled by, measured off the imported bind pose. The
   * Khronos Fox is authored in centimetres, so an unscaled import is a 79 m statue; both engines
   * apply this so R3 measures skinning rather than a camera full of overdraw.
   */
  readonly scale: number;
  /** How many skinned meshes the crowd actually built, which is what the rung asserts. */
  readonly skinnedMeshes: number;
  dispose(): void;
  /** The roots to attach, one per character. */
  objects(): Object3D[];
  /** Poses every character at a pure function of the frame index. */
  step(frameIndex: number): void;
}

export interface ILoadTestFrameStats {
  drawCalls: number;
  triangles: number;
  visibleObjects: number;
}

export interface ILoadTestHarness {
  adapterLabel: string;
  /** Initial positions read from the built meshes or instance buffer, before the timed loop. */
  placementBytes: Uint8Array;
  beginCollapse(): void;
  collapseMovingParts(): number;
  collapseMs: number;
  collapseStatus(): string;
  dispose(): void;
  /** The rung's asserted counts, or undefined outside the realistic-scene ladder. */
  ladderCounts(): ILadderCounts | undefined;
  /**
   * PRD-464: what one of R3's characters measures in the world and on screen, or undefined on a rung
   * with no characters. The parser gates on it, so a ladder whose foxes are not the specified size
   * fails instead of comparing two differently-sized scenes.
   */
  foxMeasurement(): IFoxMeasurement | undefined;
  /** Render and compute pipelines this renderer has created so far; the driver reads the window's delta. */
  pipelineCompiles(): number;
  positionHash: string;
  /**
   * PRD-464: render the rung's current frame into a readable target and report what the pixels say.
   * It draws the same scene the timed loop draws, once, after warmup — the read-back is a GPU stall
   * and must never land inside a measured window.
   */
  probeFrame(
    save?: (pixels: ArrayLike<number>, width: number, height: number) => void,
  ): Promise<IFrameStats>;
  render(): Promise<void>;
  renderer: WebGPURenderer;
  setRung(rung: ILoadTestRung): void;
  stats(): ILoadTestFrameStats;
  step(frameIndex: number): void;
  stepMs: number;
}

interface IRungState {
  collapse: SceneRenderProjection | undefined;
  cubes: Mesh[];
  geometries: BufferGeometry[];
  groups: Group[];
  instanced: InstancedMesh | undefined;
  materials: Material[];
  placements: ICubePlacement[];
  rung: ILoadTestRung;
}

// A hierarchy-depth chain hangs the whole rung under nested groups; depth 0 keeps the cubes direct
// scene children, which is the PRD-117 scene.
function attachHierarchy(scene: Scene, depth: number): { groups: Group[]; parent: Object3D } {
  let parent: Object3D = scene;
  const groups: Group[] = [];
  for (let level = 0; level < depth; level += 1) {
    const group = new Group();
    parent.add(group);
    groups.push(group);
    parent = group;
  }
  return { groups, parent };
}

// The shadow camera has to cover the lattice, whose extent is a function of the rung.
function configureShadowCamera(light: DirectionalLight, objectCount: number): void {
  const extent = latticeExtent(objectCount);
  const shadowCamera = light.shadow.camera as OrthographicCamera;
  shadowCamera.left = -extent;
  shadowCamera.right = extent;
  shadowCamera.top = extent;
  shadowCamera.bottom = -extent;
  shadowCamera.near = 0.1;
  shadowCamera.far = extent * 4 + 200;
  shadowCamera.updateProjectionMatrix();
  // One map, the same size on both engines: a shadow map that differs between the arms would
  // make R1 a comparison of two resolutions rather than of two renderers.
  light.shadow.mapSize.set(LADDER_SHADOW_MAP_SIZE, LADDER_SHADOW_MAP_SIZE);
}

interface IAuthoredCubes {
  cubes: Mesh[];
  geometries: BufferGeometry[];
  materials: Material[];
}

// The authored L1/L3/L4 rung: shared geometry and material by default, per-object clones when
// either uniqueness axis is on, one extra material per cube under L4, and culled objects pushed
// past the far plane.
function buildAuthoredCubes(
  placements: readonly ICubePlacement[],
  parent: Object3D,
  axes: IWorkloadAxes,
  mode: RenderMode,
  cubeGeometry: BoxGeometry,
  material: MeshStandardMaterial,
  shadowCasterCount: number,
): IAuthoredCubes {
  const cubes: Mesh[] = [];
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const uniqueGeometry = axes.geometry === "unique";
  // L4 is the per-cube-material rung whatever the axes say: its whole claim is that nothing can be
  // batched, which a shared material would let the projection batch away.
  const perCubeColor = mode === "L4";
  const uniqueMaterial = axes.material === "unique" || perCubeColor;
  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index] as ICubePlacement;
    const geometry = uniqueGeometry ? cubeGeometry.clone() : cubeGeometry;
    const owned = uniqueMaterial ? material.clone() : undefined;
    // On the clone, so the ground plane and every other rung keep the shared authored colour.
    if (perCubeColor) owned?.color.setHex(uniqueMaterialColor(index));
    const meshMaterial: Material = owned ?? material;
    if (uniqueGeometry) geometries.push(geometry);
    if (uniqueMaterial) materials.push(meshMaterial);
    const cube = new Mesh(geometry, meshMaterial);
    cube.position.set(
      placement.x + culledOffsetX(index, axes.visibleFraction),
      placement.y,
      placement.z,
    );
    if (index < shadowCasterCount) cube.castShadow = true;
    // Where the projection batches the cubes, three culls the batch as one object while the engine's host
    // batching culls each member against the view, which is 21k fewer triangles in the R5 frame. One cull
    // unit on both arms, as L2's batch and the characters already are, so both submit the same work.
    if (mode === "L3" || isRealisticRung(mode)) cube.frustumCulled = false;
    parent.add(cube);
    cubes.push(cube);
  }
  return { cubes, geometries, materials };
}

function writeAuthoredTransforms(
  cubes: readonly Mesh[],
  placements: readonly ICubePlacement[],
  frameIndex: number,
  axes: IWorkloadAxes,
): void {
  for (let index = 0; index < cubes.length; index += 1) {
    if (!isMutated(index, axes.mutationRate)) continue;
    const cube = cubes[index] as Mesh;
    const placement = placements[index] as ICubePlacement;
    cube.position.y = cubeBobY(index, frameIndex, placement.y);
    cube.rotation.x = cubeRotationX(index, frameIndex);
    cube.rotation.y = cubeRotationY(index, frameIndex);
  }
}

// One instance's transform: the lattice pose with the cull offset, bobbed and rotated only when the
// instance is dirty this frame. `mutated` false is the base pose baked into the buffer at `setRung`.
function writeInstanceMatrix(
  target: Matrix4,
  index: number,
  placement: ICubePlacement,
  frameIndex: number,
  mutated: boolean,
  axes: IWorkloadAxes,
  dummy: Object3D,
): void {
  dummy.position.set(
    placement.x + culledOffsetX(index, axes.visibleFraction),
    mutated ? cubeBobY(index, frameIndex, placement.y) : placement.y,
    placement.z,
  );
  dummy.rotation.set(
    mutated ? cubeRotationX(index, frameIndex) : 0,
    mutated ? cubeRotationY(index, frameIndex) : 0,
    0,
  );
  dummy.updateMatrix();
  target.copy(dummy.matrix);
}

// The base pose every instance starts from, written once per rung before the measured window. A
// mutation rate of 0 still draws the lattice because of this; without it the batch would sit at the
// origin. The upload is requested once here, never per frame.
export function initInstanceMatrices(
  instanced: InstancedMesh,
  placements: readonly ICubePlacement[],
  axes: IWorkloadAxes,
  dummy: Object3D,
  instanceMatrix: Matrix4,
): void {
  for (let index = 0; index < placements.length; index += 1) {
    writeInstanceMatrix(
      instanceMatrix,
      index,
      placements[index] as ICubePlacement,
      0,
      false,
      axes,
      dummy,
    );
    instanced.setMatrixAt(index, instanceMatrix);
  }
  instanced.instanceMatrix.needsUpdate = true;
}

// Only the instances the mutation rate selects are rewritten; the return is whether anything moved,
// which gates the GPU upload. At the default 1 every instance is dirty, preserving the old all-dirty
// frame; at 0 the buffer is never touched after `initInstanceMatrices`.
export function writeInstanceMatrices(
  instanced: InstancedMesh,
  placements: readonly ICubePlacement[],
  frameIndex: number,
  axes: IWorkloadAxes,
  dummy: Object3D,
  instanceMatrix: Matrix4,
): boolean {
  let changed = false;
  for (let index = 0; index < placements.length; index += 1) {
    if (!isMutated(index, axes.mutationRate)) continue;
    writeInstanceMatrix(
      instanceMatrix,
      index,
      placements[index] as ICubePlacement,
      frameIndex,
      true,
      axes,
      dummy,
    );
    instanced.setMatrixAt(index, instanceMatrix);
    changed = true;
  }
  return changed;
}

/**
 * Counts every pipeline three asks its backend to create. `Pipelines` calls these two methods only on
 * a cache miss, so the count is the number of compiles. A backend without them (a moved seam) throws:
 * the scoreboard refuses a missing counter, and a silent zero would pass it.
 */
export function countPipelineCreates(renderer: WebGPURenderer): () => number {
  const backend = (renderer as unknown as { backend?: Record<string, unknown> }).backend;
  // The native engine has no three backend to hook: its facade reads the player's own pipeline cache.
  if (typeof backend?.pipelineCompiles === "function")
    return backend.pipelineCompiles as () => number;
  let count = 0;
  for (const method of ["createRenderPipeline", "createComputePipeline"]) {
    const original = backend?.[method];
    if (backend === undefined || typeof original !== "function")
      throw new Error(`TN_BENCH_NO_PIPELINE_COUNTER:${method}`);
    backend[method] = function (this: unknown, ...args: unknown[]) {
      count += 1;
      return original.apply(this, args);
    };
  }
  return () => count;
}

export async function createLoadTestHarness(
  canvas: HTMLCanvasElement,
  adapterLabel = "unknown",
  animateObjects = true,
  axes: IWorkloadAxes = DEFAULT_AXES,
  createCollapse?: CollapseFactory,
  enginePasses?: ILoadTestEnginePasses,
  characters?: ICharacterCrowd,
  readFrame?: () => Promise<Uint8Array>,
  phases?: IPhaseRecorder,
): Promise<ILoadTestHarness> {
  if (phases !== undefined && enginePasses !== undefined)
    timeMatrixWorld(enginePasses.matrixWorld, phases);
  const renderer = new WebGPURenderer({ antialias: false, canvas });
  renderer.setPixelRatio(1);
  renderer.setSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, false);
  await renderer.init();
  const pipelineCompiles = countPipelineCreates(renderer);
  // three's own rAF clears the per-frame counters even when no animation loop is set, so a
  // harness that reads them after yielding reads zero. This harness owns the reset.
  renderer.info.autoReset = false;

  const scene = new Scene();
  const camera = new PerspectiveCamera(60, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 0.1, 4000);
  // One shared lit material for ground and cubes, one directional light: two shaders would be two
  // experiments (PRD-117 §3.1). Shadows are off at the default axes and enabled only by the
  // shadow-caster-share axis.
  const material = new MeshStandardMaterial({ color: 0xb8c4cc, metalness: 0, roughness: 0.75 });
  const cubeGeometry = new BoxGeometry(1, 1, 1);
  const ground = new Mesh(new PlaneGeometry(200, 200), material);
  ground.rotation.x = -Math.PI / 2;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  scene.add(ground);
  const light = new DirectionalLight(0xffffff, 2.4);
  light.position.set(40, 80, 25);
  scene.add(light);
  if (axes.shadowCasterShare > 0) {
    renderer.shadowMap.enabled = true;
    light.castShadow = true;
    ground.receiveShadow = true;
  }

  const dummy = new Object3D();
  const instanceMatrix = new Matrix4();
  const drawingBufferSize = new Vector2();
  const projectedScratch = new Vector3();
  let state: IRungState | undefined;

  // PRD-464's ladder bits. They sit on the harness rather than in a rung's teardown list because
  // each one is a *setting* of something the scene already owns — the sun, the renderer's post
  // chain, the drawing buffer — so the next rung has to put every one of them back as it found it.
  let ladder: RealisticRung | undefined;
  // R4's chain, in the shape every generated `src/render/` template ships: a `RenderPipeline` whose
  // output node is the scene pass plus a bloom of it. It is null in every other rung, which is how
  // `renderFrame` knows to draw straight to the target instead of through the chain.
  let postPipeline: RenderPipeline | undefined;
  let postScenePass: ReturnType<typeof pass> | undefined;
  let ladderPost = false;
  const pointLights: PointLight[] = [];
  let characterRoots: Object3D[] = [];

  const clearLadder = (): void => {
    for (const point of pointLights) point.removeFromParent();
    pointLights.length = 0;
    for (const root of characterRoots) root.removeFromParent();
    characterRoots = [];
    postPipeline?.dispose();
    postPipeline = undefined;
    postScenePass = undefined;
    renderer.toneMapping = NoToneMapping;
    ladder = undefined;
    ladderPost = false;
    renderer.shadowMap.enabled = axes.shadowCasterShare > 0;
    light.castShadow = axes.shadowCasterShare > 0;
    ground.receiveShadow = axes.shadowCasterShare > 0;
    if (renderer.domElement.width !== VIEWPORT_WIDTH) {
      renderer.setSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, false);
      camera.aspect = VIEWPORT_WIDTH / VIEWPORT_HEIGHT;
      camera.updateProjectionMatrix();
    }
  };

  /** R1's sun, R2's local lights, R3's characters, R4's post chain and R5's resolution, each one
   *  added only when the rung above it is the one being built. */
  const buildLadder = (rung: RealisticRung, objectCount: number, parent: Object3D): void => {
    const rank = rung === "R1" ? 0 : Number(rung.slice(1)) - 1;
    ladder = rung;
    renderer.shadowMap.enabled = true;
    light.castShadow = true;
    ground.receiveShadow = true;
    configureShadowCamera(light, objectCount);
    if (rungAtLeast(rank, "R2")) {
      for (let index = 0; index < LADDER_POINT_LIGHTS; index += 1) {
        const point = new PointLight(0xffffff, 1.2, 0, 2);
        point.position.set(0, 6, 0);
        parent.add(point);
        pointLights.push(point);
      }
    }
    if (rungAtLeast(rank, "R3")) {
      if (characters === undefined) throw new Error("TN_BENCH_NO_CHARACTER_FACTORY");
      const roots = characters.objects();
      if (characters.skinnedMeshes !== roots.length)
        throw new Error(`TN_BENCH_CHARACTER_COUNT:${characters.skinnedMeshes}/${roots.length}`);
      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index] as Object3D;
        const placement = characterPlacement(index);
        root.position.set(placement.x, placement.y, placement.z);
        // Uniform, and before the placement is read back: the glTF is authored in centimetres, so an
        // unscaled character is a 79 m statue. `ladder-characters.ts` measured the factor off the
        // imported bind pose and the parser reads the resulting height back off the scene.
        root.scale.setScalar(characters.scale);
        root.traverse((object) => {
          object.castShadow = true;
          object.frustumCulled = false;
        });
        parent.add(root);
        characterRoots.push(root);
      }
    }
    if (rungAtLeast(rank, "R4")) {
      // `LADDER_TONEMAPPING` in `ladder.ts` is the name of this pair, read by the Godot arm's
      // `_apply_post` so neither engine picks its own operator.
      renderer.toneMapping = ACESFilmicToneMapping;
      const size = resolutionOf(rung);
      const scenePass = pass(scene, camera);
      postScenePass = scenePass;
      const colour = scenePass.getTextureNode();
      postPipeline = new RenderPipeline(renderer);
      postPipeline.outputNode = colour.add(
        bloom(colour, LADDER_BLOOM_STRENGTH, LADDER_BLOOM_RADIUS, LADDER_BLOOM_THRESHOLD),
      );
      ladderPost = true;
      renderer.setSize(size.width, size.height, false);
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
      return;
    }
    if (rung === "R5") {
      // R5 is R4 at 1080p, so it never reaches here; a new rung below R4 that changed resolution
      // would, and a silent 720p row published as R5 is exactly the lie this guard refuses.
      throw new Error(`TN_BENCH_LADDER_RUNG_UNBUILT:${rung}`);
    }
  };

  /** The scene cost the rung claims it added, read off the built scene rather than off the spec. */
  const readLadderCounts = (): ILadderCounts | undefined => {
    if (ladder === undefined || state === undefined) return undefined;
    const size = renderer.getDrawingBufferSize(drawingBufferSize);
    let shadowCasters = 0;
    let skinnedMeshes = 0;
    scene.traverse((object) => {
      // `castShadow` is an `Object3D` field in three, so a fox's 24 joint nodes would each count
      // as a caster. A caster is a mesh that casts: the same definition the Godot census uses on
      // `MeshInstance3D`, and the only one both arms can agree on.
      if ((object as Mesh).isMesh === true && object.castShadow === true) shadowCasters += 1;
      if ((object as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true)
        skinnedMeshes += 1;
    });
    return {
      pointLights: pointLights.length,
      postPasses: ladderPost ? 1 : 0,
      resolution: `${size.x}x${size.y}`,
      shadowCasters,
      skinnedMeshes,
      tonemapping: renderer.toneMapping === ACESFilmicToneMapping ? 1 : 0,
    };
  };

  /**
   * What the first character of R3 measures: its world bounding-box height, and that box's height on
   * screen. Both are read off the built scene at the camera's live pose, so a camera that stopped
   * looking at the crowd shows up as a zero rather than as a plausible number. The first character
   * stands at the middle of the block's x row, so it is on screen from every orbit angle.
   */
  const readFoxMeasurement = (): IFoxMeasurement | undefined => {
    const first = characterRoots[0];
    if (first === undefined) return undefined;
    // Bind-pose geometry box, not the skinned one: Godot's `get_aabb()` is the bind-pose box, and a
    // posed box reads a running fox ~10% shorter than it stands, which the engines would disagree on.
    const bounds = new Box3().setFromObject(first, false); // engine-override: the cross-engine Fox check needs the bind-pose mesh box Godot's get_aabb() reports; normaliseToMetres measures a crown bone
    if (bounds.isEmpty()) return { heightM: 0, screenFraction: 0 };
    // The box's top and bottom at its own centre x, projected through the live camera. NDC y spans
    // -1..1, so half the difference is the fraction of the viewport height the fox covers.
    const centreX = (bounds.min.x + bounds.max.x) / 2;
    const centreZ = (bounds.min.z + bounds.max.z) / 2;
    const ndcTop = projectedScratch.set(centreX, bounds.max.y, centreZ).project(camera).y;
    const ndcBottom = projectedScratch.set(centreX, bounds.min.y, centreZ).project(camera).y;
    return {
      heightM: bounds.max.y - bounds.min.y,
      screenFraction: Math.abs(ndcTop - ndcBottom) / 2,
    };
  };

  // The shipped default's per-frame passes, and only for the rung that installed the projection.
  // L1 and L2 hand the authored scene straight to three with no engine walk behind it, and that is
  // exactly what the independent rung is for: it must keep measuring the scene with the framework's
  // own pipeline out of the frame, or it stops being the diagnostic L3 is compared against.
  const shippedDefaultPasses = (): ILoadTestEnginePasses | undefined =>
    state?.collapse === undefined ? undefined : enginePasses;

  const clearRung = (): void => {
    if (state === undefined) return;
    // The engine owns the world-matrix walk while a rung is projecting, so the authored scene is
    // marked once here. Restored on the way out because L1 and L2 reuse this same scene with
    // nothing behind it but three: left marked, it would never be refreshed at all.
    scene.matrixWorldAutoUpdate = true;
    // Released before the cubes are removed. The projection holds instanced draws built from this
    // rung's geometry; leaving them alive across a rung change would draw the previous rung's
    // objects on top of the next one's.
    state.collapse?.dispose();
    clearLadder();
    for (const cube of state.cubes) cube.removeFromParent();
    if (state.instanced !== undefined) {
      state.instanced.removeFromParent();
      state.instanced.dispose();
    }
    // The unique-geometry/material axis clones per rung, so the clones are this rung's to release.
    for (const group of state.groups) group.removeFromParent();
    for (const geometry of state.geometries) geometry.dispose();
    for (const owned of state.materials) owned.dispose();
    state = undefined;
  };

  const setRung = (rung: ILoadTestRung): void => {
    // Fail before anything is torn down: an unsupported L2 cell is a configuration error, not a
    // scene to measure.
    assertRungAxesSupported(rung.mode, axes);
    clearRung();
    // Cleared per rung, not per collapse: a stale report made an L2 rung inherit the previous L3
    // rung's `movingParts`, which is the one number the frozen-scene guard reads.
    collapseReport = undefined;
    const placements = createPlacements(rung.objectCount);
    const { groups, parent } = attachHierarchy(scene, axes.hierarchyDepth);
    const cubes: Mesh[] = [];
    const geometries: BufferGeometry[] = [];
    const materials: Material[] = [];
    let instanced: InstancedMesh | undefined;
    const shadowCasterCount = isRealisticRung(rung.mode)
      ? rung.objectCount
      : Math.ceil(rung.objectCount * axes.shadowCasterShare);
    if (isAuthoredRung(rung.mode)) {
      const authored = buildAuthoredCubes(
        placements,
        parent,
        axes,
        rung.mode,
        cubeGeometry,
        material,
        shadowCasterCount,
      );
      cubes.push(...authored.cubes);
      geometries.push(...authored.geometries);
      materials.push(...authored.materials);
    } else if (rung.objectCount > 0) {
      instanced = new InstancedMesh(cubeGeometry, material, rung.objectCount);
      // The batch is one cull unit on both engines; leaving it in makes the cull depend on a
      // bounding volume each engine derives differently, which is not what L2 is measuring.
      instanced.frustumCulled = false;
      if (shadowCasterCount > 0) instanced.castShadow = true;
      parent.add(instanced);
      // Base poses baked once, not every frame: the per-frame writer then touches only the dirty
      // subset, so a mutation rate of 0 leaves the batch static and never re-uploads it.
      initInstanceMatrices(instanced, placements, axes, dummy, instanceMatrix);
    }
    if (isRealisticRung(rung.mode)) buildLadder(rung.mode, rung.objectCount, parent);
    else if (axes.shadowCasterShare > 0) {
      configureShadowCamera(light, rung.objectCount);
    }
    state = {
      collapse: undefined,
      cubes,
      geometries,
      groups,
      instanced,
      materials,
      placements,
      rung,
    };
  };

  // Driven by the ladder before the measured window opens: the pass watches, bakes across frames,
  // and only then starts refreshing moving parts. A rung that begins measuring mid-bake would time
  // the bake, not the collapsed scene.
  let collapseReport: IRenderProjectionReport | undefined;

  const beginCollapse = (): void => {
    if (state === undefined || !isProjectedRung(state.rung.mode)) return;
    if (createCollapse === undefined) throw new Error("TN_BENCH_NO_COLLAPSE_PROVIDER");
    collapseReport = undefined;
    // No tuning: `defineGame` constructs `new SceneRenderProjection(scene)` with defaults and
    // reconciles it every frame, so L3 must use the same defaults or it measures a hand-tuned
    // optimizer rather than what a ThreeNative game actually gets. The world-matrix pass is the
    // one option it is handed, because the renderer is given the mirror and three's own walk would
    // never reach the authored scene it projects from.
    const passes = enginePasses;
    state.collapse = createCollapse(scene, {
      ...(passes === undefined ? {} : { matrixWorld: passes.matrixWorld }),
      onReport: (value) => {
        collapseReport = value;
      },
    });
    if (passes !== undefined) scene.matrixWorldAutoUpdate = false;
  };

  const collapseStatus = (): string =>
    collapseReport === undefined ? "pending" : collapseReport.reasonCode;

  // Integrity check, not a statistic: a collapse that baked every cube as static would render a
  // frozen scene while the animation loop still burned its whole cost, and the rung would publish a
  // fast number for a picture that is not the one L1 drew.
  const collapseMovingParts = (): number => state?.collapse?.report.projectedObjects ?? -1;

  // The game-side half of a frame, timed separately from the renderer's half: without the split
  // an L1 regression cannot be told apart from a scene-graph one. `collapseMs` splits it once more,
  // into the game's own animation and the framework's refresh — only the second is the framework's
  // to fix, and guessing which dominates is how the wrong thing gets optimised.
  let stepMs = 0;
  let collapseMs = 0;

  const step = (frameIndex: number): void => {
    if (state === undefined) throw new Error("TN_BENCH_NO_RUNG");
    const startedAt = performance.now();
    phases?.begin(PHASE.game);
    const pose = cameraPose(frameIndex, state.rung.objectCount);
    camera.position.set(pose.x, pose.y, pose.z);
    camera.lookAt(pose.targetX, pose.targetY, pose.targetZ);
    // R2's lights and R3's characters move before the cube transforms, and both are a pure
    // function of the frame index so the two engines frame the same scene at frame 317.
    if (ladder !== undefined) {
      const extent = latticeExtent(state.rung.objectCount);
      for (let index = 0; index < pointLights.length; index += 1) {
        const at = pointLightPosition(index, frameIndex, extent);
        (pointLights[index] as PointLight).position.set(at.x, at.y, at.z);
      }
      phases?.begin(PHASE.animation);
      characters?.step(frameIndex);
      phases?.end();
    }
    // The mutation-rate axis decides which objects are dirty this frame; at the default 1 every
    // transform moves, which is the honest worst case a game with moving actors pays.
    if (isAuthoredRung(state.rung.mode)) {
      // Diagnostic only: with the animation off, `stepMs` is the framework's refresh alone, which
      // is what separates "the engine is slow" from "the game's own gameplay loop is slow". A
      // framework fix can only ever address the first.
      if (animateObjects) {
        writeAuthoredTransforms(state.cubes, state.placements, frameIndex, axes);
      }
      // L3 and L4 pay this on the game side every frame: the collapse pass reads the same moved
      // meshes and pushes their transforms into the baked draw. It is part of the frame, not a
      // setup cost. L4's per-cube materials are why there is usually nothing to push them into.
      const collapseStartedAt = performance.now();
      // The walk counts the nodes this frame visits, so its count opens before the reconcile that
      // walks the authored scene, as `defineGame` does.
      phases?.begin(PHASE.projection);
      shippedDefaultPasses()?.matrixWorld.beginFrame();
      state.collapse?.reconcile();
      phases?.end();
      collapseMs = performance.now() - collapseStartedAt;
      stepMs = performance.now() - startedAt;
      phases?.end();
      return;
    }
    const instanced = state.instanced;
    if (instanced === undefined) {
      stepMs = performance.now() - startedAt;
      phases?.end();
      return;
    }
    if (
      writeInstanceMatrices(instanced, state.placements, frameIndex, axes, dummy, instanceMatrix)
    ) {
      // Only a frame that actually moved an instance asks for the upload.
      instanced.instanceMatrix.needsUpdate = true;
    }
    stepMs = performance.now() - startedAt;
    phases?.end();
  };

  /** One frame of the rung, into whatever target the renderer currently holds. */
  const renderFrame = async (): Promise<void> => {
    // `info.reset()` is only automatic inside three's own animation loop; this harness drives
    // its own rAF, so the per-frame counters are ours to clear.
    renderer.info.reset();
    // The projection's own render input when L3 has one, the authored scene otherwise. Same
    // resolution `defineGame` performs, so this rung draws what a shipped game draws. The
    // pass-count axis re-renders the same input; the default is one pass.
    const root = state?.collapse?.root ?? scene;
    // The shipped default's frame around that draw, in its order: the projected-size cull writes
    // `object.visible` and leaves it alone until the draw is submitted, the engine's walk
    // refreshes the world matrices three is no longer asked to walk, and both are undone
    // afterwards so the authored scene is exactly as the game left it. Without these L3 measured
    // a projection on top of three's default frame, which is not the pipeline a ThreeNative game
    // draws with. A rung without a projection keeps the plain frame: it is the independent cell.
    const passes = shippedDefaultPasses();
    if (passes !== undefined) {
      phases?.begin(PHASE.projection);
      passes.cameraCull.apply(root, camera, renderer.getDrawingBufferSize(drawingBufferSize).y);
      phases?.end();
      root.matrixWorldAutoUpdate = false;
      passes.matrixWorld.apply(root);
    }
    // The post chain draws through the pipeline rather than through the renderer, and the pipeline
    // is the one that renders the scene pass, so the two paths never both run for one frame.
    for (let pass = 0; pass < axes.passCount; pass += 1) {
      phases?.begin(PHASE.render);
      if (postPipeline === undefined) await renderer.render(root, camera);
      else {
        // The pass was built on the authored scene; every other rung draws the projection's root, so
        // aim the pass at the same input or R4 measures an unbatched scene the other rungs never draw.
        if (postScenePass !== undefined) postScenePass.scene = root;
        postPipeline.render();
      }
      phases?.end();
    }
    phases?.begin(PHASE.projection);
    if (passes !== undefined) passes.cameraCull.restore();
    // The velocity snapshot the colour and velocity passes consume. A no-op unless the render
    // chain allocates per-object velocity, which this arm has none of — a shipped game with no
    // post chain resolves the same way, so L3 pays the same commit a shipped game does.
    state?.collapse?.commit();
    phases?.end();
  };

  return {
    adapterLabel,
    get placementBytes() {
      if (state === undefined) throw new Error("TN_BENCH_NO_RUNG");
      const current = state;
      return canonicalPlacementBytes(current.rung.objectCount, (index) => {
        if (current.instanced !== undefined) {
          current.instanced.getMatrixAt(index, instanceMatrix);
          return {
            x: instanceMatrix.elements[12] ?? Number.NaN,
            y: instanceMatrix.elements[13] ?? Number.NaN,
            z: instanceMatrix.elements[14] ?? Number.NaN,
          };
        }
        const cube = current.cubes[index];
        if (cube === undefined) throw new Error(`TN_BENCH_PLACEMENT_MISSING:${index}`);
        return cube.position;
      });
    },
    dispose: () => {
      clearRung();
      characters?.dispose();
      enginePasses?.cameraCull.dispose();
      enginePasses?.matrixWorld.dispose();
      renderer.dispose();
    },
    pipelineCompiles,
    get positionHash() {
      return positionHash(state?.placements ?? []);
    },
    foxMeasurement: readFoxMeasurement,
    render: renderFrame,
    /**
     * The read-back `examples/engine-load-test/src/skinned-crowd.ts` already uses for its own
     * capture: draw the rung's current frame into a render target, then read it. The same
     * `render()` the timed loop calls draws it, so the pixels are the rung's pixels and not a
     * re-authored scene — a probe that rendered something else would pass a ladder rung that
     * measured a blank screen.
     */
    probeFrame: async (save) => {
      if (state === undefined) throw new Error("TN_BENCH_NO_RUNG");
      const size = renderer.getDrawingBufferSize(drawingBufferSize);
      // A host whose post pass does not draw into a render target reads the frame it last drew
      // instead (the engine player). It is the frame a player sees, post chain included.
      if (readFrame !== undefined) {
        const pixels = await readFrame();
        if (pixels.length !== size.x * size.y * 4)
          throw new Error(`TN_BENCH_PROBE_SIZE:${pixels.length}!=${size.x}x${size.y}`);
        save?.(pixels, size.x, size.y);
        return frameStats(pixels, size.x, size.y);
      }
      const target = new RenderTarget(size.x, size.y);
      try {
        renderer.setRenderTarget(target);
        await renderFrame();
        renderer.setRenderTarget(null);
        const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size.x, size.y);
        save?.(pixels as ArrayLike<number>, size.x, size.y);
        return frameStats(pixels as ArrayLike<number>, size.x, size.y);
      } finally {
        renderer.setRenderTarget(null);
        target.dispose();
      }
    },
    beginCollapse,
    collapseStatus,
    ladderCounts: readLadderCounts,
    renderer,
    setRung,
    collapseMovingParts,
    get collapseMs() {
      return collapseMs;
    },
    get stepMs() {
      return stepMs;
    },
    stats: () => {
      const drawCalls = renderer.info.render.drawCalls;
      const triangles = renderer.info.render.triangles;
      // `drawCalls` totals every render pass, so the per-object count divides the pass count. L1
      // and L4 have no baked batch to inflate it, so the visible count is read off the draw count;
      // L3's draw count is the finding: if the collapse applied, it is small; if it declined, this
      // is L1 with extra steps and the report must show that rather than hide it.
      const mode = state?.rung.mode;
      return {
        drawCalls,
        triangles,
        visibleObjects:
          mode === "L1" || mode === "L4"
            ? Math.max(0, drawCalls / axes.passCount - 1)
            : (state?.rung.objectCount ?? 0),
      };
    },
    step,
  };
}
