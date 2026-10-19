import * as THREE from "three/webgpu";
import { mrt, pass, texture, uniform, vec2 } from "three/tsl";
import { RenderChain } from "../../../../core/src/render/chain.ts";
import {
  VelocityTracker,
  readVelocityPreviousBoneMatrices,
  readVelocityPreviousMatrices,
  readVelocityPreviousWorldMatrix,
} from "../../../../core/src/render/velocity.ts";
import { createExperimentalTemporalResolve } from "../../../../create-threenative/templates/starter/src/render/temporalResolve.ts";
import { createTemporalAA } from "../../../../create-threenative/templates/starter/src/render/temporalAA.ts";
import { ownsCurrentInput } from "../../../../create-threenative/templates/starter/src/render/temporalCurrentSelection.ts";
import { assertCondition } from "./scene-support.js";
import { createTemporalResolveProbe } from "./temporal-resolve-probe.ts";
import { createTemporalVelocityProbe } from "./temporal-velocity-probe.ts";

// The one scaled arm: the scene pass renders below the display raster and the resolve reconstructs
// at the display raster. Two thirds is a deliberate fraction — it is neither an integer divisor of
// any conformance viewport nor a round pixel count, so an off-by-one raster cannot pass for it.
const SCALED_RESOLUTION_SCALE = 2 / 3;

// One bounded lifecycle route on the shared fixture, on top of the height-only transition every
// scaled arm already makes. Each step is keyed to the real frame, so the browser and native hosts
// reach it at the same point, and the pose keeps moving through all of them, so the skinned limb and
// the instances are still moving when each history decision is taken.
const LIFECYCLE_CUT_FRAME = 24;
const LIFECYCLE_PROJECTION_FRAME = 28;
const LIFECYCLE_SCALE_FRAME = 32;
// Fixture-only measurement thresholds, not product tolerances: a measured vector this small belongs
// to a stationary point, and the misregistration bound is the sub-pixel jitter lattice this route
// reprojects through. A vector that is simply wrong misses it by the point's whole per-frame motion.
export const MOVING_PIXELS = 0.5;
export const REPROJECTION_PIXELS = 0.05;

// The unchecked-history control replaces the resolve's whole fragment, so the fragment never evaluates
// the shared history-validity predicate the rejection counter samples. The counter keeps running and
// keeps counting that predicate, so its share would describe a decision this control did not make. It
// is therefore unavailable here, with this reason, rather than published as a number for a kernel the
// pixels did not come from. The production and default temporal arms are unaffected: their fragment is
// the instrumented one, so their counter still measures the real per-pixel decision.
const FRAGMENT_OVERRIDDEN = "unchecked-history";
export const REJECTION_UNAVAILABLE = "fragment-overridden control bypasses the instrumented rejection predicate";

/** This arm's own rejection measurement, or the reason it has none. Never a fabricated share. */
function rejectionReport(report, fragmentOverridden) {
  if (report === undefined) return null;
  if (!fragmentOverridden) return report;
  // The provider's report keeps its source frame, history validity and both rasters; only the
  // measurement its own predicate could not reach is dropped, in favour of the stated reason.
  const { rejection, ...rest } = report;
  return { ...rest, rejectionUnavailable: REJECTION_UNAVAILABLE };
}

// Shared browser/native content. The caller owns the renderer and sole frame loop.
/**
 * Quality-only authored content: deterministic alpha-tested leaf cards. A cut-out alpha edge is
 * neither a solid surface nor a fence bar, so it is the coverage the pinned corpus requires and the
 * route the pre-existing arms deliberately do not carry. The mask is a DataTexture because the
 * native host has no canvas, and nearest filtering keeps every texel a hard decision.
 */
function addQualityFoliage(scene) {
  const data = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const offset = (y * 16 + x) * 4;
      data[offset] = 74; data[offset + 1] = 210; data[offset + 2] = 128;
      data[offset + 3] = Math.hypot((x - 7.5) / 8, (y - 7.5) / 8) < 0.72 ? 255 : 0;
    }
  const map = new THREE.DataTexture(data, 16, 16);
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  map.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide });
  const group = new THREE.Group();
  for (let index = 0; index < 6; index++) {
    const card = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), material);
    card.position.set(-1.35 + index * 0.54, -0.15 + (index % 2) * 0.18, -0.2 + (index % 3) * 0.2);
    card.rotation.y = index * 1.3;
    group.add(card);
  }
  scene.add(group);
  return { group, map, cards: group.children.length, alphaTest: material.alphaTest, textureSize: 16 };
}
/**
 * `settle` holds the authored pose at that frame. A conformance capture compares two hosts at their
 * own capture frames, so a pose that keeps moving cannot be compared frame-for-frame; every temporal
 * frame still renders, and the raster transition stays keyed to the real frame so both hosts reach
 * it at the same point.
 */
export function createTemporalAAFixture(renderer, scene, camera, variant = "temporal", measurement = false, settle = null, options = {}) {
  // The quality family reuses the existing control roles, so its prefix is stripped here: a
  // "quality-unchecked-history" arm must install the same negative control as "unchecked-history",
  // or it silently measures the installed policy twice.
  const policy = variant.replace(/-open$/u, "").replace(/^quality-/u, "");
  // One arm replaces the resolve fragment outright, so its own pixels carry no instrumented
  // predicate for the counter to sample and its rejection share is unavailable, not zero.
  const fragmentOverridden = policy === FRAGMENT_OVERRIDDEN;
  // One bounded quality family: the same scene, poses, occluder and frame schedule as every other
  // arm, with the physical display raster pinned and only the authored input raster moving. It adds
  // deterministic alpha-tested foliage, which is why it scores against its own supersampled
  // reference. `qualityRole` stays null for every pre-existing arm, so their behaviour is untouched.
  const qualityRole = variant.startsWith("quality-") ? variant.slice(8).replace(/-open$/u, "") : null;
  // The roles that must genuinely request nothing: no reconstruction stage, no velocity MRT. The
  // spatial role still renders its low input and presents it through the ordinary texture upsample.
  const off = variant === "reference" || qualityRole === "reference" || qualityRole === "spatial";
  scene.background = new THREE.Color(0x0d1630);
  camera.position.set(0, 0.3, 6);
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.position.set(2, 5, 3);
  scene.add(new THREE.HemisphereLight(0xb4d4ff, 0x303848, 1.5), sun);
  const white = new THREE.MeshStandardMaterial({ color: 0xe1eafa });
  const fence = new THREE.InstancedMesh(new THREE.BoxGeometry(0.012, 2.6, 0.02), white, 40);
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < fence.count; index++) {
    fence.setMatrixAt(index, matrix.makeTranslation((index - 20) * 0.125, 0, -0.6));
  }
  scene.add(fence);
  const diagonal = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.02, 0.03), white);
  diagonal.rotation.z = 0.27;
  scene.add(diagonal);
  const rigid = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.9, 0.3), new THREE.MeshStandardMaterial({ color: 0xf0924e }));
  rigid.position.set(-1.5, 0.6, 0.4);
  scene.add(rigid);
  const instances = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 12, 8), new THREE.MeshStandardMaterial({ color: 0x60ead6 }), 3);
  // Diagnostic only: clone inherits usage. This isolates previous-buffer upload policy while
  // current geometry and its authored per-frame needsUpdate remain identical.
  if (variant === "dynamic-instances") instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(instances);
  const geometry = new THREE.BoxGeometry(0.28, 1.4, 0.25, 1, 8, 1);
  const skinIndices = [];
  const skinWeights = [];
  for (let index = 0; index < geometry.attributes.position.count; index++) {
    const weight = THREE.MathUtils.clamp(geometry.attributes.position.getY(index) + 0.5, 0, 1);
    skinIndices.push(0, 1, 0, 0);
    skinWeights.push(1 - weight, weight, 0, 0);
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
  const character = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0xdd72df }));
  const root = new THREE.Bone();
  const limb = new THREE.Bone();
  root.add(limb); character.add(root);
  character.bind(new THREE.Skeleton([root, limb]));
  character.position.set(1.4, 0.25, 0.5);
  scene.add(character);
  // Saturated foreground is a measurable history marker. Removing it reveals the actual scene,
  // including thin geometry; no reset is requested because this is ordinary disocclusion.
  const occluder = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  occluder.position.set(0.25, 0.45, 1.3);
  if (measurement) scene.add(occluder);
  const foliage = qualityRole === null ? null : addQualityFoliage(scene);
  const scenePass = pass(scene, camera);
  // Three sizes a pass from the drawing buffer every frame, so a lower input raster is the pass's
  // own resolution scale rather than a one-shot resize that the next frame undoes.
  if (variant.startsWith("scaled")) scenePass.setResolutionScale(SCALED_RESOLUTION_SCALE);
  // The quality family leaves the physical display raster exactly where it is and lowers only the
  // input raster, so its resolve, its history and the whole-display oracle stay comparable.
  if (qualityRole !== null && qualityRole !== "reference") scenePass.setResolutionScale(SCALED_RESOLUTION_SCALE);
  const pipeline = new THREE.RenderPipeline(renderer);
  const tracker = new VelocityTracker();
  let temporal;
  let setupCount = 0;
  let setupDuringJitter = 0;
  const chain = new RenderChain({
    renderer: { kind: "webgpu", raw: renderer, setOutputNode: (node) => { pipeline.outputNode = node; }, clearOutputNode: () => {} },
    input: scenePass.getTextureNode("output"), worldPass: scenePass,
    request: {
      stages: off ? [] : ["traa"],
      // The raw fixture builds the chain itself, so it supplies the same compatibility callback the
      // generated world environment does: the provider's own completed measurement, once per frame.
      // The fragment-overridden control hands over nothing, because the counter it would carry counted
      // a predicate its resolve never evaluated.
      velocity: {
        pass: scenePass,
        rejectionMeasurement: () =>
          fragmentOverridden ? undefined : temporal?.rejectionMeasurement(),
      },
    },
    stages: [{
      name: "traa",
      build: (input, context) => {
        temporal = options.raw4
          ? createTemporalAA(input, scenePass.getTextureNode("depth"), context.velocityNode, camera, scenePass)
          : createTemporalAA(input, scenePass.getTextureNode("depth"), context.velocityNode, camera);
        if (
          options.raw4 &&
          !ownsCurrentInput(input, scenePass.getTextureNode("depth"), context.velocityNode, camera, scenePass)
        )
          throw new Error("raw4 requested but the raw lane did not engage");
        // Diagnostic: normalized depth range is at most 1, so only the upstream edge bypass
        // is disabled. Its disocclusion threshold and history blend remain identical.
        if (policy === "strict-rejection" || policy.startsWith("resolve-cubic-strict")) temporal.node.edgeDepthDiff = 1;
        // Causal probe only: suppress bilinear diffusion of repeatedly reprojected history.
        // Nearest sampling can introduce motion snapping; it is not a proposed quality policy.
        if (policy === "nearest-history") {
          temporal.node._historyRenderTarget.texture.minFilter = THREE.NearestFilter;
          temporal.node._historyRenderTarget.texture.magFilter = THREE.NearestFilter;
        }
        const setup = temporal.node.setup.bind(temporal.node);
        temporal.node.setup = (builder) => {
          setupCount++;
          if (camera.view?.enabled) setupDuringJitter++;
          // Fixture-only control: hand the kernel a constant-valid history, so a reset frame blends
          // whatever the history buffer holds instead of publishing current colour. This is what
          // proves the reset gate is what keeps a cold frame clean; it is not a product mode. The
          // provider builds its kernel from whichever uniform is installed when the graph is built,
          // so the replacement has to precede that build to reach the shader at all.
          if (policy.endsWith("unchecked-reset")) temporal.node._historyValidUniform = uniform(1);
          const result = setup(builder);
          if (policy.startsWith("resolve-")) {
            temporal.node._resolveMaterial.colorNode = createExperimentalTemporalResolve(
              temporal.node, builder.renderer, temporal.jitterOffset, policy === "resolve-linear" ? "linear" : "catmull-rom",
              // The linear equivalence control follows the production blend; weighted cubic
              // arms retain their explicit diagnostic policy.
              policy === "resolve-linear" || policy.startsWith("resolve-cubic-strict-ordinary") ? "ordinary" : "luminance",
            );
          }
          if (policy === "unchecked-history") {
          // Fixture-only negative control: actually render an unchecked 95% history blend.
          // This bypasses depth rejection AND neighbourhood clipping; it is not a product mode
          // and does not isolate either mechanism's individual contribution.
            temporal.node._resolveMaterial.colorNode = temporal.node.beautyNode.mul(0.05).add(texture(temporal.node._historyRenderTarget.texture).mul(0.95));
          }
          return result;
        };
        return temporal.node;
      },
      dispose: () => temporal?.dispose(),
    }],
  });
  if (variant === "zero-velocity" || variant === "scaled-lifecycle-zero" || variant === "resolve-cubic-strict-zero" || variant === "resolve-cubic-strict-ordinary-zero" || qualityRole === "zero-velocity") scenePass.setMRT(scenePass.getMRT().merge(mrt({ velocity: vec2(0) })));
  if (variant === "reference" || qualityRole === "reference") pipeline.outputNode = scenePass;
  // The spatial arm installs no reconstruction stage at all: it presents its low-resolution colour
  // input through the pipeline's ordinary texture upsample, at the display raster.
  if (qualityRole === "spatial") pipeline.outputNode = scenePass.getTextureNode("output");
  const resolveProbe =
    variant.startsWith("scaled")
      ? createTemporalResolveProbe(renderer, scene, camera, scenePass, temporal.node, () => temporal.report().resetReason !== null)
      : null;
  const probeMatrix = new THREE.Matrix4();
  const drawingBuffer = new THREE.Vector2();
  const frontTriangle = geometry.groups[4].start + 18;
  const velocityProbe = measurement && !off ? createTemporalVelocityProbe(renderer, scene, camera, scenePass, () => {
    const skinned = new THREE.Vector3();
    for (let corner = 0; corner < 3; corner++) skinned.add(character.getVertexPosition(geometry.index.getX(frontTriangle + corner), new THREE.Vector3()));
    skinned.multiplyScalar(1 / 3).applyMatrix4(character.matrixWorld);
    instances.getMatrixAt(0, probeMatrix);
    return {
      rigid: new THREE.Vector3(0, 0, 0.15).applyMatrix4(rigid.matrixWorld),
      instance: new THREE.Vector3(0, 0, 0.16).applyMatrix4(probeMatrix).applyMatrix4(instances.matrixWorld),
      skinned,
    };
  }) : null;
  let frame = 0;
  let instanceDraw = null;
  let instanceUploads = [];
  let readbackAttributes = [];
  const attributeIds = new WeakMap();
  let nextAttributeId = 0;
  const attributeId = (attribute) => {
    if (!attributeIds.has(attribute)) attributeIds.set(attribute, ++nextAttributeId);
    return attributeIds.get(attribute);
  };
  const originalCreateAttribute = renderer.backend.createAttribute;
  const originalUpdateAttribute = renderer.backend.updateAttribute;
  const recordUpload = (method, attribute) => {
    const data = attribute.isInterleavedBufferAttribute ? attribute.data : attribute;
    if (frame >= 21 && frame <= 23 && data.array.length === instances.count * 16) {
      instanceUploads.push({
        method, wrapperId: attributeId(attribute), callId: renderer.info.render.calls,
        bufferExists: renderer.backend.get(data).buffer !== undefined,
        bufferUuid: data.uuid ?? null, version: data.version,
        isCurrent: data.array === instances.instanceMatrix.array, values: Array.from(data.array),
      });
    }
  };
  const observedCreateAttribute = function (attribute, ...args) {
    recordUpload("create", attribute);
    return originalCreateAttribute.call(this, attribute, ...args);
  };
  const observedUpdateAttribute = function (attribute, ...args) {
    recordUpload("update", attribute);
    return originalUpdateAttribute.call(this, attribute, ...args);
  };
  // Fixture-only observation of the actual compiled draw. Unlike getShaderAsync(), this never
  // compiles an extra pass or advances previous-frame bookkeeping while inspecting the shader.
  const originalDraw = renderer.backend.draw;
  const observedDraw = function (renderObject, ...args) {
    if (renderObject.object === instances && frame >= 21 && frame <= 23) {
      const state = renderObject.getNodeBuilderState();
      const matrixAttributes = state.nodeAttributes.filter(({ node }) => node?.attribute?.data?.stride === 16);
      const unique = new Set();
      readbackAttributes = matrixAttributes.map(({ node }) => node.attribute).filter((attribute) => {
        if (unique.has(attribute.data)) return false;
        unique.add(attribute.data);
        return true;
      });
      instanceDraw = {
        frame: frame + 1, callId: renderer.info.render.calls,
        objectUuid: instances.uuid,
        matrixId: instances.instanceMatrix.id,
        vertexShader: state.vertexShader,
        beforeEvents: state.updateBeforeNodes.map((node) => node.eventType ?? node.constructor.name),
        attributes: matrixAttributes.map(({ name, node }) => ({
          name, wrapperId: attributeId(node.attribute),
          attributeCall: renderer._geometries.attributeCall.get(node.attribute) ?? null,
          bufferCall: renderer._geometries.attributeCall.get(node.attribute.data) ?? null,
          bufferUuid: node.attribute.data.uuid, version: node.attribute.data.version,
          isCurrent: node.attribute.data.array === instances.instanceMatrix.array,
          values: Array.from(node.attribute.data.array),
        })),
      };
    }
    return originalDraw.call(this, renderObject, ...args);
  };
  if (variant === "recompile") {
    renderer.backend.draw = observedDraw;
    renderer.backend.createAttribute = observedCreateAttribute;
    renderer.backend.updateAttribute = observedUpdateAttribute;
  }
  let resets = 0;
  let lastReset = null;
  // Fixture-only history witness: where the measured MRT vector reprojects each tracked point to,
  // against where that point independently projected last frame.
  const emptyWitness = () => ({
    samples: 0,
    movingFrames: 0,
    maxMisregistration: 0,
    maxMisregistrationFrame: -1,
    maxMeasuredPixels: 0,
    maxExpectedPixels: 0,
  });
  const historyWitness = { rigid: emptyWitness(), instance: emptyWitness(), skinned: emptyWitness() };
  const lifecycle = variant === "scaled-lifecycle" || variant === "scaled-lifecycle-zero";
  // One rejected-pixel count per reset frame, taken after its copy lands. A reset frame is the only
  // frame whose expected rejection share is a whole raster, so it is where the count is checkable.
  const rejectionCold = [];
  const rejectionFrames = [];
  // The rasters the fixture actually rendered, read from the pass target and the drawing buffer
  // rather than from the scale that was asked for: an off-by-one input raster cannot pass as one.
  const raster = () => {
    renderer.getDrawingBufferSize(drawingBuffer);
    return {
      displayWidth: drawingBuffer.x, displayHeight: drawingBuffer.y,
      inputWidth: scenePass.renderTarget?.width ?? null, inputHeight: scenePass.renderTarget?.height ?? null,
    };
  };
  const observation = () => ({
    frame, resets, lastReset, aa: rejectionReport(temporal?.report(), fragmentOverridden),
    instanceDraw, instanceUploads,
    measurement, variant, setupCount, setupDuringJitter, occluderVisible: measurement && occluder.visible,
    raster: raster(),
    quality: foliage === null ? null : {
      role: qualityRole, foliageCards: foliage.cards, alphaTest: foliage.alphaTest, leafTextureSize: foliage.textureSize,
    },
    rejectionCold, rejectionFrames,
    resolveProbe: resolveProbe?.observation() ?? null,
    pose: { cameraX: camera.position.x, rigidX: rigid.position.x, limbZ: limb.rotation.z },
    historyWitness,
    held: frozen === null ? null : { frame: frozen.frame, resolve: frozen.resolve },
    velocityProbe: velocityProbe?.observation() ?? null,
    historyValues: measurement ? {
      instances: Array.from(instances.instanceMatrix.array),
      previousInstances: Array.from(readVelocityPreviousMatrices(instances) ?? []),
      bones: Array.from(character.skeleton.boneMatrices),
      previousBones: Array.from(readVelocityPreviousBoneMatrices(character) ?? []),
    } : null,
    stages: chain.applied.stages, velocity: chain.applied.velocity,
    rigidHistory: readVelocityPreviousWorldMatrix(rigid) !== undefined,
    skinnedHistory: readVelocityPreviousBoneMatrices(character) !== undefined,
    instancedHistory: readVelocityPreviousMatrices(instances) !== undefined,
  });
  // Fixture-only capture hold. The host keeps calling render() after a route's diagnostic loop ends,
  // and every one of those frames advances the temporal chain's own jitter and history, so two hosts
  // that stop at different frames publish different pixels from one measurement. After the last
  // diagnostic frame this holds the resolve target that frame actually produced and presents that
  // same texture on every later frame: a real draw each time, with no scene pass, no velocity, no
  // reconstruction and no history write, so presenting invents no frame and no measurement.
  let frozen = null;
  const freeze = () => {
    assertCondition(frozen === null, "The temporal fixture capture is already frozen.");
    const resolve = temporal?.node._resolveRenderTarget;
    assertCondition(
      resolve !== undefined && resolve.texture !== undefined,
      "Freezing a capture needs a reconstruction frame, and none rendered one.",
    );
    renderer.getDrawingBufferSize(drawingBuffer);
    assertCondition(
      resolve.width === drawingBuffer.x && resolve.height === drawingBuffer.y,
      `A held capture must hold the display raster; the resolve is ${resolve.width}x${resolve.height} against ${drawingBuffer.x}x${drawingBuffer.y}.`,
    );
    frozen = { frame, node: texture(resolve.texture), resolve: `${resolve.width}x${resolve.height}` };
    pipeline.outputNode = frozen.node;
    // The pipeline's own "the output node changed" flag, so the held texture replaces the whole
    // reconstruction graph rather than only taking over the frames that need no rebuild.
    pipeline.needsUpdate = true;
  };
  const render = () => {
    if (frozen !== null) {
      // Presenting a held resolve is still a draw on the host surface every frame. It is not a
      // rendered frame, so the fixture's own frame must not advance and must not measure again.
      assertCondition(frame === frozen.frame, "A held temporal capture advanced the fixture frame.");
      pipeline.render();
      return;
    }
    instanceDraw = null;
    instanceUploads = [];
    readbackAttributes = [];
    if (variant === "recompile" && frame === 22) renderer.contextNode.needsUpdate = true;
    if (measurement) occluder.visible = frame < 28 && !variant.endsWith("-open");
    const pose = settle === null ? frame : Math.min(frame, settle);
    rigid.position.x = -1.5 + Math.sin(pose / 18) * 0.65;
    limb.rotation.z = Math.sin(pose / 13) * 0.7;
    for (let index = 0; index < instances.count; index++) {
      instances.setMatrixAt(index, matrix.makeTranslation(-0.5 + index * 0.6, -0.9 + Math.sin(pose / 11 + index) * 0.22, 0.3));
    }
    instances.instanceMatrix.needsUpdate = true;
    // The quality foliage rides the same authored pose schedule as every other object, so it is
    // sub-pixel moving coverage rather than a static texture pasted into the frame.
    if (foliage) foliage.group.position.x = Math.sin(pose / 17) * 0.25;
    // One authored camera jump per route, applied from its frame onward. Holding it keeps the pose
    // from announcing an unrequested reverse cut on the very next frame, which no reset names.
    const cut =
      (variant === "cut" && frame >= 20) || (lifecycle && frame >= LIFECYCLE_CUT_FRAME)
        ? 1.2
        : 0;
    camera.position.x = Math.sin(pose / 50) * 0.15 + cut;
    if (frame === 20 && variant === "cut") temporal?.resetHistory("camera-cut");
    if (frame === 20 && variant === "projection") { camera.fov = 65; camera.updateProjectionMatrix(); }
    if (frame === 20 && variant === "resize") { renderer.setSize(960, 540, false); camera.aspect = 960 / 540; camera.updateProjectionMatrix(); }
    // The scaled arm moves the display height only. The input raster keeps its width, so a guard
    // that watched width alone would keep a wrong-height depth history across the transition.
    if (frame === 20 && variant.startsWith("scaled")) {
      renderer.getDrawingBufferSize(drawingBuffer);
      const scaledHeight = Math.round(drawingBuffer.y * SCALED_RESOLUTION_SCALE);
      renderer.setSize(drawingBuffer.x, scaledHeight, false);
      camera.aspect = drawingBuffer.x / scaledHeight;
      camera.updateProjectionMatrix();
    }
    if (lifecycle) {
      // The teleport the pose above holds from this frame on. The camera jumps a whole unit, so no
      // history can still name the same samples, and the reset is the caller's own explicit request.
      if (frame === LIFECYCLE_CUT_FRAME) temporal?.resetHistory("camera-cut");
      // An authored projection change with no reset requested anywhere: the provider has to notice
      // the discontinuity itself, and the raster never moves.
      if (frame === LIFECYCLE_PROJECTION_FRAME) {
        camera.fov = 52;
        camera.updateProjectionMatrix();
      }
      // An input-raster change only. The physical display raster is left exactly where it is, so the
      // display-sized resolve, its history and the whole-display oracle all stay comparable.
      if (frame === LIFECYCLE_SCALE_FRAME) scenePass.setResolutionScale(1 / 2);
    }
    tracker.update(scene);
    velocityProbe?.before();
    pipeline.render();
    tracker.commit(scene);
    const result = temporal?.report();
    if (result?.resetReason) { resets += 1; lastReset = result; }
    frame += 1;
  };
  return {
    render, observation, freeze,
    sampleVelocity: async () => {
      await velocityProbe?.read();
      await resolveProbe?.read();
      // Only a frame that reused history reprojects a previous image at all: a reset frame has no
      // history to land on, and it is checked against the whole-display oracle below instead.
      const frameReport = temporal?.report();
      if (frameReport?.historyValid) {
        // The tracked points' history coordinates, folded into one running witness per point, so a
        // moving skinned limb and a moving instance are both measured rather than asserted.
        for (const sample of velocityProbe?.observation()?.samples ?? []) {
          const witness = historyWitness[sample.name];
          if (witness === undefined) continue;
          witness.samples += 1;
          if (sample.measuredPixels >= MOVING_PIXELS) witness.movingFrames += 1;
          if (sample.misregistrationPixels > witness.maxMisregistration) {
            witness.maxMisregistration = sample.misregistrationPixels;
            witness.maxMisregistrationFrame = frameReport.frame;
          }
          witness.maxMeasuredPixels = Math.max(witness.maxMeasuredPixels, sample.measuredPixels);
          // The motion the point actually had, so a control whose measured vector reads zero cannot
          // pass by claiming the point never moved.
          witness.maxExpectedPixels = Math.max(witness.maxExpectedPixels, sample.expectedPixels);
        }
      }
      // A rejection measurement only exists once its GPU copy lands, so a diagnostic frame awaits it
      // here rather than reading whatever the previous frame happened to leave in the report.
      await temporal?.settledRejection();
      const report = temporal?.report();
      if (report !== undefined && !fragmentOverridden) {
        const measured = report.rejection;
        // The frame's own measurement, with the count the GPU visited beside the share it rejected.
        rejectionFrames.push({
          frame: report.frame,
          historyValid: report.historyValid,
          resetReason: report.resetReason,
          // The raster this frame counted, so a visited count is checked against the display that
          // was actually current rather than against an index the caller has to line up.
          displayWidth: report.outputWidth,
          displayHeight: report.outputHeight,
          fraction: measured?.fraction ?? null,
          visited: measured?.visited ?? null,
          staleFrames: measured?.staleFrames ?? null,
        });
        if (report.resetReason !== null) rejectionCold.push(rejectionFrames.at(-1));
      }
      if (instanceDraw !== null) {
        instanceDraw.gpuValues = [];
        for (const attribute of readbackAttributes) {
          const bytes = await renderer.getArrayBufferAsync(attribute);
          instanceDraw.gpuValues.push({
            wrapperId: attributeId(attribute), bufferUuid: attribute.data.uuid,
            isCurrent: attribute.data.array === instances.instanceMatrix.array,
            values: Array.from(new Float32Array(bytes)),
          });
        }
      }
      // The chain is observed here because only the fixture's own loop drives this RenderChain, and a
      // measurement that is never observed is never published.
      chain.observeFrame();
    },
    dispose: () => {
      if (renderer.backend.draw === observedDraw) renderer.backend.draw = originalDraw;
      if (renderer.backend.createAttribute === observedCreateAttribute) renderer.backend.createAttribute = originalCreateAttribute;
      if (renderer.backend.updateAttribute === observedUpdateAttribute) renderer.backend.updateAttribute = originalUpdateAttribute;
      velocityProbe?.dispose();
      resolveProbe?.dispose();
      chain.dispose(); tracker.clear(); scenePass.dispose(); pipeline.dispose();
      const geometries = new Set();
      const materials = new Set();
      scene.traverse((object) => { if (object.geometry) geometries.add(object.geometry); if (object.material) materials.add(object.material); });
      for (const item of geometries) item.dispose();
      for (const item of materials) item.dispose();
      character.skeleton.dispose();
      foliage?.map.dispose();
      if (!measurement) { occluder.geometry.dispose(); occluder.material.dispose(); }
    },
  };
}
