import * as THREE from "three/webgpu";
import { depth, float, mrt, normalView, output, pass, vec4, velocity as defaultVelocity } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

const TEMPORAL_SETTLED_FRAME = 8;
const FRAME_ZERO_BACKGROUND = 0x0b1020;
const TEMPORAL_MOVING_BACKGROUND = 0x5b1828;

export function startRealismEffectsScene(canvas, dimensions, effect, build, options = {}) {
  const sceneOptions =
    globalThis.__TN_CONFORMANCE_TARGET__ === "native"
      ? { ...options, deferInitialRender: true }
      : options;
  return startVisualScene(canvas, dimensions, `realism-effects:${effect}`, ({ renderer, scene, camera }) => {
    scene.background = new THREE.Color(FRAME_ZERO_BACKGROUND);
    scene.add(
      new THREE.HemisphereLight(0x9fc5ff, 0x1d2740, 1.8),
      new THREE.DirectionalLight(0xffd6a5, 3.2),
    );
    const subject = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.66, 0.2, 96, 20),
      new THREE.MeshStandardMaterial({ color: 0x54d2ff, metalness: 0.35, roughness: 0.22 }),
    );
    subject.position.x = -0.55;
    const companion = new THREE.Mesh(
      new THREE.SphereGeometry(0.52, 32, 20),
      new THREE.MeshStandardMaterial({ color: 0xff9d5c, metalness: 0.1, roughness: 0.35 }),
    );
    companion.position.set(0.72, -0.08, 0.18);
    scene.add(subject, companion);

    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, normal: normalView, ...(options.velocityNode === undefined ? { velocity: defaultVelocity, depth } : {}) }));
    const colorNode = scenePass.getTextureNode("output");
    const depthNode = scenePass.getTextureNode("depth");
    const normalNode = scenePass.getTextureNode("normal");
    const velocityNode = options.velocityNode ?? scenePass.getTextureNode("velocity");
    const buildResult = build({
      camera,
      color: colorNode,
      depth: depthNode,
      normal: normalNode,
      scene,
      scenePass,
      velocity: velocityNode,
    });
    const node = buildResult?.node ?? buildResult;
    const outputNode = buildResult?.outputNode ?? node;
    if (node?.isNode !== true || outputNode?.isNode !== true) {
      throw new Error(`Realism-effects conformance scene did not build ${effect} as a TSL node.`);
    }
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = outputNode;
    let frame = 0;
    const temporal = options.temporal === true;
    const render = () => {
      if (temporal) {
        const moving = frame > 0 && frame <= TEMPORAL_SETTLED_FRAME;
        subject.rotation.y = moving ? frame * 0.008 : 0;
        scene.background.set(moving ? TEMPORAL_MOVING_BACKGROUND : FRAME_ZERO_BACKGROUND);
        if (frame === 0) console.info(`TN_CONFORMANCE_TEMPORAL_FRAME:${effect}:frame-zero`);
        if (frame === TEMPORAL_SETTLED_FRAME) console.info(`TN_CONFORMANCE_TEMPORAL_FRAME:${effect}:settled`);
        if (frame === TEMPORAL_SETTLED_FRAME + 1) console.info(`TN_CONFORMANCE_TEMPORAL_FRAME:${effect}:next`);
      }
      pipeline.render();
      frame += 1;
      if (temporal && frame >= TEMPORAL_SETTLED_FRAME) {
        globalThis.__TN_CONFORMANCE_TEMPORAL = {
          effect,
          frame,
          frameZeroRendered: true,
          settledFrameRendered: true,
          nextFrameRendered: frame > TEMPORAL_SETTLED_FRAME,
          restoredFrameRendered: frame > TEMPORAL_SETTLED_FRAME,
          restoredToFrameZero: frame > TEMPORAL_SETTLED_FRAME && subject.rotation.y === 0,
        };
      }
    };
    return {
      detail: {
        effect,
        pipeline: "RenderPipeline",
        temporal: temporal
          ? {
              comparesFrameZero: true,
              historyProbe: "background-toggle-and-scene-restore",
              restoresFrameZero: true,
              settledFrame: TEMPORAL_SETTLED_FRAME,
            }
          : null,
      },
      render,
    };
  }, sceneOptions);
}

export function colorizeVelocity(velocityNode) {
  return vec4(velocityNode.xy, float(0), float(1));
}
