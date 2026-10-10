import {
  type ICtx,
  type IFrameBudgetWindow,
  type ISpanWindow,
  SPANS,
  SPANS_MARKER,
  Scene,
  SkeletalMesh3D,
  beginSpan,
  endSpan,
  lodPixelScale,
} from "@threenative/core";
import {
  AnimationClip,
  AnimationMixer,
  Bone,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  NumberKeyframeTrack,
  Object3D,
  type PerspectiveCamera,
  PlaneGeometry,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import { crowdLook } from "../render/look.js";

const SIDE = 8;
const SPACING = 1.4;
const BONES = 12;
const HEIGHT = 2;
const SWAY_SECONDS = 2;

const query = new URLSearchParams(globalThis.location?.search ?? "");
const requestedCount = query.get("crowdCount");
const count = requestedCount === null ? SIDE * SIDE : Number(requestedCount);
const arm = query.get("crowdArm") ?? "animated";
if (requestedCount !== null && ![32, 128, 256].includes(count))
  throw new Error("crowdCount must be 32, 128 or 256.");
if (!["animated", "held", "static"].includes(arm))
  throw new Error("crowdArm must be animated, held or static.");
const measuring = requestedCount !== null;

export const crowdRate: Record<string, unknown> = { count, arm, measuring, ready: false };

export function crowdBudget(window: IFrameBudgetWindow): void {
  if (!measuring) return;
  crowdRate.gpuMainMs = window.gpuMain;
  crowdRate.gpuShadowMs = window.gpuShadow;
  crowdRate.gpuShadowSamples = window.gpuShadowRendered?.samples;
  crowdRate.gpuSamples = window.gpu?.samples;
  crowdRate.window = window.window;
  crowdRate.mainDraws = window.passes?.main?.draws.mean;
  crowdRate.shadowDraws = window.passes?.shadow?.draws.mean;
  crowdRate.mainTriangles = window.passes?.main?.triangles.mean;
  crowdRate.shadowTriangles = window.passes?.shadow?.triangles.mean;
  crowdRate.surface = window.surface;
}

export function crowdSpans(line: string): void {
  console.info(line);
  if (!measuring || !line.startsWith(`${SPANS_MARKER}:`)) return;
  const window = JSON.parse(line.slice(SPANS_MARKER.length + 1)) as ISpanWindow;
  const animation = window.spans.animationUpdate;
  const palette = window.spans.skinnedWrite;
  crowdRate.animationUpdateMs = animation?.mean;
  crowdRate.skinnedWriteMs = palette?.mean;
  crowdRate.animationCalls = animation?.perFrame ?? 0;
  crowdRate.paletteWrites = palette?.perFrame ?? 0;
  crowdRate.ready =
    window.overflowed === 0 &&
    window.window === crowdRate.window &&
    (arm === "animated" ? animation?.perFrame === count : animation === undefined) &&
    (arm === "static" ? palette === undefined : palette?.perFrame === count) &&
    Number.isFinite(crowdRate.gpuMainMs) &&
    Number.isFinite(crowdRate.gpuShadowMs) &&
    Number(crowdRate.mainDraws) > 0 &&
    Number(crowdRate.shadowDraws) > 0 &&
    Number(crowdRate.gpuShadowSamples) > 0;
  console.info(`TN_CROWD_RATE:${JSON.stringify(crowdRate)}`);
}

/** Bake the held pose once; shared geometry keeps both controls at one draw per pass. */
function staticPose(source: SkinnedMesh): CylinderGeometry {
  source.updateMatrixWorld(true);
  source.skeleton.update();
  const boneMatrices = source.skeleton.boneMatrices;
  if (boneMatrices === null) throw new Error("Crowd held pose has no bone palette.");
  const geometry = source.geometry.clone() as CylinderGeometry;
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const indices = geometry.getAttribute("skinIndex");
  const weights = geometry.getAttribute("skinWeight");
  const point = new Vector3();
  const normal = new Vector3();
  const transformed = new Vector3();
  const sum = new Vector3();
  const matrix = new Matrix4();
  const linear = new Matrix3();
  for (let vertex = 0; vertex < positions.count; vertex += 1) {
    source.getVertexPosition(vertex, point);
    positions.setXYZ(vertex, point.x, point.y, point.z);
    normal.fromBufferAttribute(normals, vertex);
    sum.set(0, 0, 0);
    for (let influence = 0; influence < 4; influence += 1) {
      matrix.fromArray(boneMatrices, indices.getComponent(vertex, influence) * 16);
      matrix.premultiply(source.bindMatrixInverse).multiply(source.bindMatrix);
      linear.setFromMatrix4(matrix);
      transformed.copy(normal).applyMatrix3(linear);
      sum.addScaledVector(transformed, weights.getComponent(vertex, influence));
    }
    sum.normalize();
    normals.setXYZ(vertex, sum.x, sum.y, sum.z);
  }
  geometry.deleteAttribute("skinIndex");
  geometry.deleteAttribute("skinWeight");
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A tube bound to a chain of bones, so a bend of the chain bends the tube. */
function tube(): CylinderGeometry {
  const geometry = new CylinderGeometry(0.22, 0.3, HEIGHT, 12, 22);
  const position = geometry.getAttribute("position");
  const indices: number[] = [];
  const weights: number[] = [];
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const along = ((position.getY(vertex) + HEIGHT / 2) / HEIGHT) * (BONES - 1);
    const bone = Math.min(Math.floor(along), BONES - 2);
    const blend = along - bone;
    indices.push(bone, bone + 1, 0, 0);
    weights.push(1 - blend, blend, 0, 0);
  }
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(indices, 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
  return geometry;
}

/** One sway cycle: every bone bends the same way, so the whole chain curls and returns. */
function swayClip(): AnimationClip {
  const tracks: NumberKeyframeTrack[] = [];
  for (let bone = 1; bone < BONES; bone += 1) {
    tracks.push(
      new NumberKeyframeTrack(
        `bone${bone}.rotation[z]`,
        [0, SWAY_SECONDS / 2, SWAY_SECONDS],
        [-0.09, 0.09, -0.09],
      ),
    );
  }
  return new AnimationClip("sway", SWAY_SECONDS, tracks);
}

function rig(geometry: CylinderGeometry, material: SkinnedMesh["material"]): SkinnedMesh {
  const bones: Bone[] = [];
  for (let index = 0; index < BONES; index += 1) {
    const bone = new Bone();
    bone.name = `bone${index}`;
    bone.position.y = index === 0 ? -HEIGHT / 2 : HEIGHT / (BONES - 1);
    bones[index - 1]?.add(bone);
    bones.push(bone);
  }
  const mesh = new SkinnedMesh(geometry, material);
  mesh.add(bones[0] as Bone);
  mesh.bind(new Skeleton(bones));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export class Crowd extends Scene {
  override enter(ctx: ICtx) {
    const extent = measuring ? 125 : (SIDE * SPACING) / 2 + 1;
    const camera = ctx.camera as PerspectiveCamera;
    camera.position.set(0, 7, 11);
    camera.lookAt(0, 0, 0);
    if (measuring) {
      camera.position.set(0, 3, 0);
      camera.lookAt(0, 0, -40);
      camera.far = 250;
      camera.updateProjectionMatrix();
    }
    ctx.add(camera);
    const look = crowdLook(ctx.scene, ctx.renderer.raw as never, extent);

    const ground = new Mesh(new PlaneGeometry(extent * 2, extent * 2), look.ground);
    ground.name = "ground";
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -HEIGHT / 2;
    ground.receiveShadow = true;
    ctx.add(ground);

    const geometry = tube();
    const clip = swayClip();
    if (measuring) {
      const source = rig(geometry, look.skin);
      const heldMixer = new AnimationMixer(source);
      heldMixer.clipAction(clip).play();
      heldMixer.setTime(0);
      source.updateMatrixWorld(true);
      source.computeBoundingBox();
      const posedHeight = source.boundingBox?.getSize(new Vector3()).y;
      if (posedHeight === undefined || !Number.isFinite(posedHeight) || posedHeight <= 0)
        throw new Error("Crowd held pose has no finite positive height.");
      const baked = arm === "static" ? staticPose(source) : undefined;
      const staticCrowd =
        baked === undefined ? undefined : new InstancedMesh(baked, look.skin, count);
      if (staticCrowd !== undefined) {
        staticCrowd.name = "static-crowd";
        staticCrowd.castShadow = true;
        staticCrowd.receiveShadow = true;
        staticCrowd.frustumCulled = false;
        ctx.add(staticCrowd);
      }
      const shadows = ctx.scene.children
        .filter((node): node is DirectionalLight => node instanceof DirectionalLight)
        .map((light) => light.shadow);
      const players: SkeletalMesh3D[] = [];
      const projectedHeights: number[] = [];
      camera.updateMatrixWorld(true);
      const cameraPoint = new Vector3();
      for (let index = 0; index < count; index += 1) {
        const player =
          arm === "static"
            ? undefined
            : new SkeletalMesh3D({
                source,
                clips: [clip],
                requiredClips: ["sway"],
                strideSync: false,
              });
        const mesh = player?.root ?? new Object3D();
        mesh.name = `walker-${index}`;
        const band = index % 3;
        const row = Math.floor(index / 24);
        const depth = band === 0 ? 10 + row : band === 1 ? 40 + row : 120 - row;
        mesh.position.set(((Math.floor(index / 3) % 8) - 3.5) * SPACING, 0, -depth);
        mesh.rotation.y = index * 0.37;
        if (staticCrowd !== undefined) {
          mesh.updateMatrix();
          staticCrowd.setMatrixAt(index, mesh.matrix);
        } else ctx.add(mesh);
        cameraPoint.copy(mesh.position).applyMatrix4(camera.matrixWorldInverse);
        projectedHeights.push(
          posedHeight * lodPixelScale(camera, ctx.viewport.size.height, -cameraPoint.z),
        );
        if (player !== undefined) {
          player.play("sway");
          player.update(0);
          players.push(player);
        }
      }
      if (staticCrowd !== undefined) staticCrowd.instanceMatrix.needsUpdate = true;
      crowdRate.projectedHeldHeights = projectedHeights;
      crowdRate.projectedRigs = projectedHeights.length;
      crowdRate.bonesPerRig = BONES;
      crowdRate.verticesPerRig = geometry.getAttribute("position").count;
      crowdRate.heldPoseSeconds = 0;
      crowdRate.nearDepth = 10;
      crowdRate.midDepth = 40;
      crowdRate.farDepth = 120;
      ctx.beforeRender(() => {
        // Both frozen controls redraw shadows, so a cached shadow is never priced as skinning saved.
        for (const shadow of shadows) shadow.needsUpdate = true;
        if (arm === "animated")
          for (const player of players) {
            beginSpan(SPANS.animationUpdate);
            try {
              player.update(1 / 60);
            } finally {
              endSpan(SPANS.animationUpdate);
            }
          }
        ctx.state.set({ crowdRate: { ...crowdRate } });
      });
      return;
    }
    const mixers: { mixer: AnimationMixer; phase: number }[] = [];
    for (let index = 0; index < SIDE * SIDE; index += 1) {
      const mesh = rig(geometry, look.skin);
      mesh.name = `walker-${index}`;
      mesh.position.set(
        ((index % SIDE) - (SIDE - 1) / 2) * SPACING,
        0,
        (Math.floor(index / SIDE) - (SIDE - 1) / 2) * SPACING,
      );
      mesh.rotation.y = index * 0.37;
      ctx.add(mesh);
      const mixer = new AnimationMixer(mesh);
      mixer.clipAction(clip).play();
      mixers.push({ mixer, phase: (index * 0.29) % SWAY_SECONDS });
    }

    // Posed by rendered frame rather than wall time, so every platform's capture of frame N shows
    // the same crowd and a cross-platform pixel comparison compares like with like.
    let frames = 0;
    ctx.beforeRender(() => {
      frames += 1;
      for (const { mixer, phase } of mixers) mixer.setTime(phase + frames / 60);
    });
  }
}
