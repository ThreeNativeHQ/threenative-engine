import { type GPUSceneBVH, type ICtx, Scene, type SceneFrame, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  Bone,
  BoxGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LOD,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Points,
  PointsMaterial,
  Skeleton,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import { createGpuSceneBvhDemo, loadGpuSceneBvhModel } from "./render/gpu-scene-bvh.js";

/**
 * PRD-152's semantic stress subject.
 *
 * The optimizer's claim is that a developer writing ordinary Three.js never has to know it exists:
 * no flag, no annotation, no base class, no `userData` convention. This game is what tests that
 * claim against a real renderer rather than a stub — it writes the kind of scene the framework
 * promises to leave alone, then checks, from inside the running game, that it was left alone.
 *
 * Nothing here opts in or out of anything. Every subject below is ordinary Three.js a game might
 * write for its own reasons, and the assertions are the ones a developer would make if they had
 * never heard of the optimizer: my objects are where I put them, my raycast returns my mesh, the
 * thing I hid is hidden, and the thing I moved on frame 600 moved.
 */

const PROP_COUNT = 250;
/** Long past any startup window, so nothing here can pass by being measured during one. */
const MUTATE_AT = 600;
const ASSERT_AT = 1_200;
const BVH_REBUILD_AT = 140;

interface IStressState extends Record<string, unknown> {
  meshCount: number;
  pickedTarget: number;
  /** The unannotated mesh a raycast returned — picking must not require `userData`. */
  pickedUnannotated: number;
  /** The authored graph is byte-identical to its fingerprint, bar the game's own mutations. */
  graphIntact: number;
  /** Every advanced subject still has the semantics its class carries. */
  semanticsIntact: number;
  /** A mesh hidden before anything settled is still hidden and still in the scene. */
  hiddenIntact: number;
  /** A prop that first moves on frame 600 is where the game put it. */
  lateMutationApplied: number;
  /** A camera-parented overlay still rides the camera. */
  overlayRides: number;
  framesRun: number;
  bvhObjects: number;
  bvhTriangles: number;
  bvhRebuilds: number;
  bvhBuildMs: number;
  bvhEffectLive: number;
}

/** Identity, parentage, name and sibling order for every object the game authored. */
function fingerprint(root: Object3D): string {
  const rows: string[] = [];
  root.traverse((object) => {
    rows.push(
      [
        object.uuid,
        object.name,
        object.type,
        object.parent?.uuid ?? "root",
        object.parent?.children.indexOf(object) ?? -1,
      ].join("|"),
    );
  });
  return rows.join("\n");
}

class SemanticStressScene extends Scene<IStressState> {
  static override readonly initialState: IStressState = {
    meshCount: 0,
    pickedTarget: 0,
    pickedUnannotated: 0,
    graphIntact: 0,
    semanticsIntact: 0,
    hiddenIntact: 0,
    lateMutationApplied: 0,
    overlayRides: 0,
    framesRun: 0,
    bvhObjects: 0,
    bvhTriangles: 0,
    bvhRebuilds: 0,
    bvhBuildMs: 0,
    bvhEffectLive: 0,
  };

  #loadedTraceScene: Group | undefined;

  override async load(): Promise<void> {
    this.#loadedTraceScene = await loadGpuSceneBvhModel();
  }

  override enter(ctx: ICtx<IStressState>): SceneFrame<IStressState> {
    ctx.camera.position.set(0, 5, 10);
    ctx.camera.lookAt(0, 0, -0.3);

    // ── Ordinary props. The bulk of the scene, and what the optimizer is for.
    //
    // One shared geometry and one shared material, which is what an ordinary level looks like and
    // what lets these collapse to a single draw. Giving each prop its own material would be a
    // scene that cannot batch by construction, and would quietly test nothing.
    const propGeometry = new BoxGeometry(1, 1, 1);
    const propMaterial = new MeshBasicMaterial({ color: 0x00aaff });
    const props: Mesh[] = [];
    for (let index = 0; index < PROP_COUNT; index += 1) {
      const mesh = new Mesh(propGeometry, propMaterial);
      if (index === 0) mesh.userData.target = 1;
      else mesh.position.set(20 + (index % 20) * 2, 2 * Math.floor(index / 20), 0);
      ctx.add(mesh);
      props.push(mesh);
    }
    // An unannotated mesh on its own axis, so a ray can reach it with nothing in the way. Picking
    // it is what proves an annotation is not the price of staying pickable.
    const unannotated = new Mesh(propGeometry, propMaterial);
    unannotated.position.set(-6, 0, 0);
    ctx.add(unannotated);

    // ── A mesh the game hides before anything has settled. Kept off both pick axes, so it is
    // testing visibility rather than accidentally testing which object a ray reaches first.
    const hidden = new Mesh(propGeometry, propMaterial);
    hidden.position.set(0, -8, 0);
    // engine-override: hiding a pick target permanently; not a transient effect surface
    hidden.visible = false;
    ctx.add(hidden);

    // ── A grouped subtree, so hierarchy and inherited transforms are exercised.
    const group = new Group();
    group.name = "grouped";
    group.position.set(-8, 0, 0);
    for (let index = 0; index < 12; index += 1) {
      const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0xffaa22 }));
      mesh.position.set(index, 0, 0);
      group.add(mesh);
    }
    ctx.add(group);

    // ── Advanced semantics a batched draw cannot carry, beside the props rather than instead.
    const instanced = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 3);
    for (let index = 0; index < 3; index += 1) {
      instanced.setMatrixAt(index, new Matrix4().makeTranslation(index * 2 - 12, 4, 0));
    }
    instanced.instanceMatrix.needsUpdate = true;
    ctx.add(instanced);

    const bone = new Bone();
    const skinGeometry = new BoxGeometry(1, 1, 1);
    // A `SkinnedMesh` needs `skinIndex` and `skinWeight`; three.js reads them when it raycasts or
    // computes bounds, and a geometry without them throws inside `applyBoneTransform`. Every vertex
    // here is bound wholly to bone 0, which is the simplest rig that is actually a rig.
    const skinVertices = skinGeometry.getAttribute("position").count;
    skinGeometry.setAttribute(
      "skinIndex",
      new Uint16BufferAttribute(new Uint16Array(skinVertices * 4), 4),
    );
    const skinWeights = new Float32Array(skinVertices * 4);
    for (let index = 0; index < skinVertices; index += 1) skinWeights[index * 4] = 1;
    skinGeometry.setAttribute("skinWeight", new Float32BufferAttribute(skinWeights, 4));
    const skinned = new SkinnedMesh(skinGeometry, new MeshBasicMaterial());
    skinned.add(bone);
    skinned.bind(new Skeleton([bone]));
    skinned.position.set(-4, 4, 0);
    ctx.add(skinned);

    const morphGeometry = new BoxGeometry(1, 1, 1);
    morphGeometry.morphAttributes.position = [
      new Float32BufferAttribute(
        new Float32Array(morphGeometry.getAttribute("position").count * 3),
        3,
      ),
    ];
    const morphed = new Mesh(morphGeometry, new MeshBasicMaterial());
    morphed.morphTargetInfluences = [0];
    morphed.position.set(-2, 4, 0);
    ctx.add(morphed);

    const glass = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({ transparent: true, opacity: 0.5 }),
    );
    glass.position.set(2, 4, 0);
    ctx.add(glass);

    const lod = new LOD();
    lod.addLevel(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()), 0);
    lod.addLevel(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()), 40);
    lod.position.set(6, 4, 0);
    ctx.add(lod);

    const sprite = new Sprite(new SpriteMaterial());
    sprite.position.set(10, 8, 0);
    ctx.add(sprite);
    const points = new Points(new BoxGeometry(1, 1, 1), new PointsMaterial());
    points.position.set(12, 8, 0);
    ctx.add(points);

    // ── A small loaded-scene-shaped trace set. It has transformed meshes, an instanced mesh,
    // indexed geometry, and two material groups—the cases the GPU packing path must keep honest.
    const loadedTraceScene = this.#loadedTraceScene;
    if (loadedTraceScene === undefined) throw new Error("GPUSceneBVH proof scene was not loaded.");
    const { blockers, bvh } = createGpuSceneBvhDemo(ctx.scene, ctx.add, loadedTraceScene);

    // ── A camera-parented overlay, which is where a HUD lives.
    const reticle = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial());
    reticle.position.set(0, 0, -2);
    ctx.camera.add(reticle);

    // The late mover holds perfectly still until frame 600, which is what makes it the case a
    // startup observation window cannot possibly get right.
    const sleeper = props[7] as Mesh;
    const sleeperHome = sleeper.position.clone();
    const movedBlocker = blockers[1];
    if (movedBlocker === undefined)
      throw new Error("GPUSceneBVH proof scene lost its moved blocker.");

    let authored: string | undefined;
    let sampled = false;
    let frames = 0;
    let bvhRebuilds = 0;

    return (frameCtx) => {
      frames += 1;
      if (ctx.startup.phase !== "ready") return;
      // Taken once the framework has finished whatever it does at startup. Anything the optimizer
      // changes about the game's graph after this point shows up as a mismatch.
      if (authored === undefined) authored = fingerprint(ctx.scene);
      const authoredFingerprint = authored;
      applyStressMutation(frames, sleeper, sleeperHome, morphed);
      bvhRebuilds = rebuildBvhAtFrame(frames, frameCtx, bvh, movedBlocker, bvhRebuilds);
      if (frames < ASSERT_AT || sampled) return;

      frameCtx.state.set({
        meshCount: PROP_COUNT,
        ...readStressAssertions(
          frameCtx,
          authoredFingerprint,
          hidden,
          unannotated,
          sleeper,
          sleeperHome,
          reticle,
          instanced,
          skinned,
          morphed,
          glass,
          lod,
          group,
        ),
        framesRun: frames,
      });
      publishBvhState(frameCtx, bvh, bvhRebuilds);
      sampled = true;
    };
  }
}

function publishBvhState(ctx: ICtx<IStressState>, bvh: GPUSceneBVH, rebuilds: number): void {
  ctx.state.set({
    bvhObjects: bvh.objectCount,
    bvhTriangles: bvh.triangleCount,
    bvhRebuilds: rebuilds,
    bvhBuildMs: bvh.buildMs,
    bvhEffectLive: bvh.triangleCount > 0 ? 1 : 0,
  });
  ctx.state.flush();
}

function applyStressMutation(
  frame: number,
  sleeper: Mesh,
  sleeperHome: Vector3,
  morphed: Mesh,
): void {
  if (frame !== MUTATE_AT) return;
  sleeper.position.set(sleeperHome.x, sleeperHome.y + 5, sleeperHome.z);
  (morphed.morphTargetInfluences as number[])[0] = 0.5;
}

function rebuildBvhAtFrame(
  frame: number,
  ctx: ICtx<IStressState>,
  bvh: GPUSceneBVH,
  movedBlocker: Object3D,
  rebuilds: number,
): number {
  if (frame !== BVH_REBUILD_AT) return rebuilds;
  movedBlocker.position.x = 6;
  bvh.rebuild();
  const nextRebuilds = rebuilds + 1;
  publishBvhState(ctx, bvh, nextRebuilds);
  return nextRebuilds;
}

function readStressAssertions(
  ctx: ICtx<IStressState>,
  authored: string,
  hidden: Mesh,
  unannotated: Mesh,
  sleeper: Mesh,
  sleeperHome: Vector3,
  reticle: Mesh,
  instanced: InstancedMesh,
  skinned: SkinnedMesh,
  morphed: Mesh,
  glass: Mesh,
  lod: LOD,
  group: Group,
): Pick<
  IStressState,
  | "pickedTarget"
  | "pickedUnannotated"
  | "graphIntact"
  | "semanticsIntact"
  | "hiddenIntact"
  | "lateMutationApplied"
  | "overlayRides"
> {
  const annotated = ctx.raycast({
    origin: new Vector3(0, 0, 40),
    direction: new Vector3(0, 0, -1),
  });
  const plain = ctx.raycast({
    origin: new Vector3(-6, 0, 40),
    direction: new Vector3(0, 0, -1),
  });
  const semanticsIntact =
    instanced.count === 3 &&
    instanced.parent === ctx.scene &&
    skinned.skeleton.bones.length === 1 &&
    skinned.parent === ctx.scene &&
    morphed.morphTargetInfluences?.[0] === 0.5 &&
    (glass.material as MeshBasicMaterial).transparent &&
    lod.levels.length === 2 &&
    group.children.length === 12 &&
    (group.children[0] as Mesh).parent === group;
  return {
    pickedTarget: annotated?.object.userData.target === 1 ? 1 : 0,
    pickedUnannotated: plain?.object === unannotated ? 1 : 0,
    graphIntact: fingerprint(ctx.scene) === authored ? 1 : 0,
    semanticsIntact: semanticsIntact ? 1 : 0,
    hiddenIntact: !hidden.visible && hidden.parent === ctx.scene ? 1 : 0,
    lateMutationApplied: sleeper.position.y === sleeperHome.y + 5 ? 1 : 0,
    overlayRides: reticle.parent === ctx.camera ? 1 : 0,
  };
}

const game = defineGame<IStressState>({
  camera: { projection: "perspective", fov: 60 },
  plugins: [playtest()],
  renderer: { preferWebGPU: true },
  scenes: { picking: SemanticStressScene },
  start: "picking",
});

export default game;
