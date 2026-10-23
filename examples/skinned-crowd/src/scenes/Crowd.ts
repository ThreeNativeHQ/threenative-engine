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
  spansRequested,
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
const requestedCount = query.get("crowdCount") ?? (spansRequested() ? "128" : null);
const count = requestedCount === null ? SIDE * SIDE : Number(requestedCount);
const arm = query.get("crowdArm") ?? "animated";
const requestedRate = query.get("crowdRate") ?? "auto";
const focusDepth = query.get("crowdFocus");
const freezeFrameText = query.get("crowdFreezeFrame");
const visualFreezeFrame = freezeFrameText === null ? undefined : Number(freezeFrameText);
const updateRate = requestedRate === "1" ? 1 : requestedRate === "auto" ? "auto" : undefined;
if (requestedCount !== null && ![32, 128, 256].includes(count))
  throw new Error("crowdCount must be 32, 128 or 256.");
if (!["animated", "held", "static"].includes(arm))
  throw new Error("crowdArm must be animated, held or static.");
if (updateRate === undefined) throw new Error("crowdRate must be auto or 1.");
if (focusDepth !== null && !["10", "40", "120"].includes(focusDepth))
  throw new Error("crowdFocus must be 10, 40 or 120.");
if (
  visualFreezeFrame !== undefined &&
  (!Number.isSafeInteger(visualFreezeFrame) || visualFreezeFrame < 1)
)
  throw new Error("crowdFreezeFrame must be a positive safe integer.");
const measuring = requestedCount !== null;

export const crowdRate: Record<string, unknown> = {
  count,
  arm,
  updateRate,
  measuring,
  window: 0,
  ready: false,
  measured: null,
};
if (visualFreezeFrame !== undefined) {
  crowdRate.visualFreezeFrame = visualFreezeFrame;
  crowdRate.visualFrozen = false;
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function crowdBudget(window: IFrameBudgetWindow): void {
  if (!measuring) return;
  crowdRate.gpuMainMs = window.gpuMain ?? null;
  crowdRate.gpuMainSamples = window.gpuMainSamples ?? null;
  crowdRate.gpuShadowMs = window.gpuShadow ?? null;
  crowdRate.gpuShadowSamples = window.gpuShadowRendered?.samples ?? null;
  crowdRate.gpuSamples = window.gpu?.samples ?? null;
  crowdRate.window = window.window;
  crowdRate.renderFrames = window.frames;
  crowdRate.simulatedSeconds = window.simulatedSeconds ?? null;
  crowdRate.mainDraws = window.passes?.main?.draws.mean ?? null;
  crowdRate.shadowDraws = window.passes?.shadow?.draws.mean ?? null;
  crowdRate.mainTriangles = window.passes?.main?.triangles.mean ?? null;
  crowdRate.shadowTriangles = window.passes?.shadow?.triangles.mean ?? null;
  crowdRate.surface = window.surface ?? null;
}

export function crowdSpans(line: string): void {
  console.info(line);
  if (!measuring || !line.startsWith(`${SPANS_MARKER}:`)) return;
  const window = JSON.parse(line.slice(SPANS_MARKER.length + 1)) as ISpanWindow;
  const animation = window.spans.animationUpdate;
  const palette = window.spans.skinnedWrite;
  crowdRate.animationUpdateMs = animation?.mean ?? null;
  crowdRate.skinnedWriteMs = palette?.mean ?? null;
  crowdRate.animationFrames = animation?.frames ?? null;
  crowdRate.paletteFrames = palette?.frames ?? null;
  crowdRate.animationCalls = animation?.perFrame ?? 0;
  crowdRate.paletteCalls = palette?.perFrame ?? 0;
  crowdRate.ready =
    window.overflowed === 0 &&
    window.window === crowdRate.window &&
    Number.isSafeInteger(window.frames) &&
    window.frames > 0 &&
    window.frames === crowdRate.renderFrames &&
    // reportEvery is 120 simulation ticks at the fixture's default 60 Hz, not 120 renders.
    Number.isFinite(crowdRate.simulatedSeconds) &&
    Number(crowdRate.simulatedSeconds) >= 120 / 60 &&
    (arm !== "held" || updateRate === 1 || Number(crowdRate.rawRigs) > 0) &&
    (arm !== "static"
      ? animation?.perFrame === count &&
        animation.frames === window.frames &&
        Number.isFinite(animation.mean)
      : animation === undefined) &&
    (arm === "static"
      ? palette === undefined
      : palette !== undefined &&
        palette.frames === window.frames &&
        palette.perFrame === count &&
        Number.isFinite(palette.mean)) &&
    Number.isFinite(crowdRate.gpuMainMs) &&
    Number.isFinite(crowdRate.gpuShadowMs) &&
    Number(crowdRate.mainDraws) > 0 &&
    Number(crowdRate.shadowDraws) > 0 &&
    [crowdRate.gpuSamples, crowdRate.gpuShadowSamples, crowdRate.gpuMainSamples].every(
      (samples) => Number.isSafeInteger(samples) && Number(samples) > 0,
    );
  if (crowdRate.measured === null && crowdRate.ready === true && window.window >= 2) {
    const surface = crowdRate.surface as IFrameBudgetWindow["surface"] | null;
    crowdRate.measured = Object.freeze({
      window: finiteOrNull(window.window),
      ready: true,
      renderFrames: finiteOrNull(crowdRate.renderFrames),
      simulatedSeconds: finiteOrNull(crowdRate.simulatedSeconds),
      animationFrames: finiteOrNull(crowdRate.animationFrames),
      paletteFrames: finiteOrNull(crowdRate.paletteFrames),
      animationUpdateMs: finiteOrNull(crowdRate.animationUpdateMs),
      skinnedWriteMs: finiteOrNull(crowdRate.skinnedWriteMs),
      rawRigs: finiteOrNull(crowdRate.rawRigs),
      animationCalls: finiteOrNull(crowdRate.animationCalls),
      paletteCalls: finiteOrNull(crowdRate.paletteCalls),
      gpuSamples: finiteOrNull(crowdRate.gpuSamples),
      gpuMainSamples: finiteOrNull(crowdRate.gpuMainSamples),
      gpuShadowSamples: finiteOrNull(crowdRate.gpuShadowSamples),
      gpuMainMs: finiteOrNull(crowdRate.gpuMainMs),
      gpuShadowMs: finiteOrNull(crowdRate.gpuShadowMs),
      mainDraws: finiteOrNull(crowdRate.mainDraws),
      shadowDraws: finiteOrNull(crowdRate.shadowDraws),
      mainTriangles: finiteOrNull(crowdRate.mainTriangles),
      shadowTriangles: finiteOrNull(crowdRate.shadowTriangles),
      surface:
        surface == null
          ? null
          : Object.freeze({
              resolutionScale: finiteOrNull(surface.resolutionScale),
              sampleCount: finiteOrNull(surface.sampleCount),
              drawingBufferWidth: finiteOrNull(surface.drawingBufferWidth),
              drawingBufferHeight: finiteOrNull(surface.drawingBufferHeight),
              scaleSource: surface.scaleSource ?? null,
              atFloor: surface.atFloor ?? null,
              compiling: surface.compiling ?? null,
            }),
      count,
      arm,
      measuring,
      projectedRigs: finiteOrNull(crowdRate.projectedRigs),
      bonesPerRig: finiteOrNull(crowdRate.bonesPerRig),
      verticesPerRig: finiteOrNull(crowdRate.verticesPerRig),
      heldPoseSeconds: finiteOrNull(crowdRate.heldPoseSeconds),
      nearDepth: finiteOrNull(crowdRate.nearDepth),
      midDepth: finiteOrNull(crowdRate.midDepth),
      farDepth: finiteOrNull(crowdRate.farDepth),
      projectedHeldHeights: Array.isArray(crowdRate.projectedHeldHeights)
        ? Object.freeze(crowdRate.projectedHeldHeights.map(finiteOrNull))
        : null,
    });
  }
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
      camera.lookAt(0, 0, -Number(focusDepth ?? "40"));
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
                updateRate,
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
      let visualRenderFrame = 0;
      let visualFrozen = false;
      ctx.beforeRender(() => {
        if (!visualFrozen) {
          visualRenderFrame += 1;
          // Both frozen controls redraw shadows, so a cached shadow is never priced as skinning
          // saved.
          for (const shadow of shadows) shadow.needsUpdate = true;
          if (arm !== "static")
            for (const player of players) {
              beginSpan(SPANS.animationUpdate);
              try {
                player.update(arm === "held" ? 0 : 1 / 60);
              } finally {
                endSpan(SPANS.animationUpdate);
              }
            }
          if (arm === "held") {
            crowdRate.rawRigs = players.filter((player) => {
              const report = player.updateRateReport;
              return report.boneRate > report.rate;
            }).length;
          }
          if (visualFreezeFrame !== undefined) {
            const rates = players.map((player) => player.updateRateReport.rate);
            crowdRate.visualRenderFrame = visualRenderFrame;
            crowdRate.visualLogicalSeconds = visualRenderFrame / 60;
            crowdRate.visualEvaluationTimes = players.map((player) => player.mixer.time);
            crowdRate.visualRates = rates;
            crowdRate.visualEvaluated = players.map((player) => player.updateRateReport.evaluated);
            crowdRate.visualThrottledRigs = rates.filter((rate) => rate > 1).length;
            visualFrozen = visualRenderFrame >= visualFreezeFrame;
            crowdRate.visualFrozen = visualFrozen;
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
