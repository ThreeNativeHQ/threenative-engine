import * as THREE from "three/webgpu";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { mrt, output, pass, velocity } from "three/tsl";
import { assertCondition, startVisualScene } from "./scene-support.js";

const INPUT_SCALE = 0.72;
const COMPLETION_MARKER = "TN_CONFORMANCE_UPSAMPLE_300_FRAMES";

export function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "temporal-aa-upsampled",
    ({ renderer, scene, camera }) => {
      const knot = new THREE.Mesh(
        new THREE.TorusKnotGeometry(0.55, 0.13, 128, 12),
        new THREE.MeshBasicMaterial({ color: 0x54d2ff }),
      );
      knot.position.set(-0.65, 0.12, 0);
      scene.add(knot);
      const barGeometry = new THREE.BoxGeometry(0.008, 1.5, 0.02);
      const barMaterial = new THREE.MeshBasicMaterial({ color: 0xff9d5c });
      for (let index = 0; index < 24; index += 1) {
        const bar = new THREE.Mesh(barGeometry, barMaterial);
        bar.position.set(0.25 + index * 0.045, 0.14, 0);
        bar.rotation.z = 0.23;
        scene.add(bar);
      }
      const owned = renderer.info.engine !== undefined;
      const scenePass = pass(scene, camera);
      // Owned depth is the scene attachment and TRAA owns velocity; upstream requests its velocity MRT.
      if (!owned) scenePass.setMRT(mrt({ output, velocity }));
      const pipeline = new THREE.RenderPipeline(renderer);
      pipeline.outputNode = traa(
        scenePass.getTextureNode("output"),
        scenePass.getTextureNode("depth"),
        scenePass.getTextureNode("velocity"),
        camera,
      );
      if (owned) {
        assertCondition(
          typeof renderer.setRenderScale === "function",
          "Owned temporal upsampling is unavailable.",
        );
        renderer.setRenderScale(INPUT_SCALE);
      }
      let frame = 0,
        complete = false;
      return {
        detail: {
          inputScale: owned ? INPUT_SCALE : 1,
          scene: "unlit-knot-and-thin-diagonal-fence",
        },
        render() {
          knot.rotation.y = frame > 0 && frame <= 8 ? frame * 0.008 : 0;
          pipeline.render();
          frame += 1;
          const temporal = owned ? renderer.info.engine.temporal : null;
          // Native render metadata arrives after the queued scene reaches the host's first frame.
          if (owned && !(temporal.frame > 0)) return;
          if (owned) {
            assertCondition(temporal.active === true, "The owned TRAA resolve did not run.");
            assertCondition(
              temporal.inputWidth === Math.round(dimensions.width * INPUT_SCALE) &&
                temporal.inputHeight === Math.round(dimensions.height * INPUT_SCALE),
              "The scene did not draw at the requested input size.",
            );
            assertCondition(
              temporal.outputWidth === dimensions.width &&
                temporal.outputHeight === dimensions.height,
              "The temporal resolve did not write the display size.",
            );
            assertCondition(
              temporal.jitterLength >=
                (((8 * dimensions.width) / temporal.inputWidth) * dimensions.height) /
                  temporal.inputHeight,
              "Temporal jitter density fell below the display-pixel requirement.",
            );
          }
          const observedFrames = owned ? temporal.frame : frame;
          if (!complete && observedFrames >= 300) {
            complete = true;
            globalThis.__TN_CONFORMANCE_COMPLETION__ = COMPLETION_MARKER;
            console.info(
              `${COMPLETION_MARKER} frames=${observedFrames} input=${owned ? temporal.inputWidth : dimensions.width}x${owned ? temporal.inputHeight : dimensions.height} output=${dimensions.width}x${dimensions.height} jitter=${owned ? temporal.jitterLength : "upstream"}`,
            );
          }
        },
      };
    },
    { deferInitialRender: globalThis.__TN_CONFORMANCE_TARGET__ === "native" },
  );
}
