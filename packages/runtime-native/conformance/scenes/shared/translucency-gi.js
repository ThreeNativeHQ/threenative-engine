import * as THREE from "three/webgpu";
import { color, normalWorld, positionWorld } from "three/tsl";
import { ProbeVolume } from "../../../../core/src/render/probe-volume.ts";
import { assertCondition, startVisualScene } from "./scene-support.js";

const VOLUME_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-1, -1, -0.8),
  new THREE.Vector3(1, 1, 0.8),
);
const BAKE_FRAME_LIMIT = 180;
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function waitForSubmittedWork(renderer) {
  const wait = renderer.backend?.device?.queue?.onSubmittedWorkDone;
  if (typeof wait === "function") await wait.call(renderer.backend.device.queue);
}

// A translucent pixel has no side that faces the light: it reads the volume's one-fetch mean
// (sampleNonDirectional), the same in every direction, next to an opaque panel that reads the
// directional sampleNode of the same volume.
export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "translucency-gi",
    async ({ camera, renderer, scene }) => {
      const volume = new ProbeVolume({
        bounds: VOLUME_BOUNDS,
        // This row judges the frame, not the bake cost: a work item that a busy host delays past 16.5 ms would end the scene.
        bakeBudgetMs: 250,
        cubemapSize: 8,
        density: 0.5,
        maxWorkItemsPerFrame: 1,
      });
      scene.add(volume);
      const host = { kind: "webgpu", raw: renderer };
      volume.attachRenderer(host);

      const backdropMaterial = new THREE.MeshBasicNodeMaterial({ color: 0x2a3140 });
      const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.45), backdropMaterial);
      backdrop.name = "backdrop";
      backdrop.position.set(0, 0, -0.5);

      const panelMaterial = new THREE.MeshBasicNodeMaterial();
      panelMaterial.colorNode = volume.sampleNode(positionWorld, normalWorld).mul(8);
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.2), panelMaterial);
      panel.name = "opaque-panel";
      panel.position.set(0.62, 0, -0.35);

      const paneMaterial = new THREE.MeshBasicNodeMaterial();
      paneMaterial.colorNode = volume.sampleNonDirectional(positionWorld).mul(8);
      paneMaterial.transparent = true;
      paneMaterial.opacity = 0.6;
      paneMaterial.depthWrite = false;
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.2), paneMaterial);
      pane.name = "translucent-pane";
      pane.position.set(-0.62, 0, -0.1);

      // The saturated emitter is outside the camera frustum. The bake sees it, and both
      // surfaces receive it through the volume.
      const emitterMaterial = new THREE.MeshBasicNodeMaterial();
      emitterMaterial.colorNode = color(0xff0030).mul(12);
      const offscreenEmitter = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 1.45, 0.8),
        emitterMaterial,
      );
      offscreenEmitter.name = "off-screen-emitter";
      offscreenEmitter.position.set(4.2, 0, 1.8);
      scene.add(backdrop, panel, pane, offscreenEmitter);
      assertCondition(offscreenEmitter.position.x > 2, "emitter must be outside the camera frustum");
      assertCondition(
        volume.sampleNonDirectional(positionWorld)?.isNode === true,
        "translucent sample node must be installed",
      );

      const bake = volume.requestBake(scene);
      let bakeFrames = 0;
      while (volume.observation.status === "baking") {
        volume.process(host);
        renderer.render(scene, camera);
        await waitForSubmittedWork(renderer);
        bakeFrames += 1;
        if (bakeFrames > BAKE_FRAME_LIMIT) {
          throw new Error(`probe volume bake exceeded ${BAKE_FRAME_LIMIT} frames`);
        }
        await nextFrame();
      }
      await bake;
      assertCondition(volume.observation.status === "ready", "probe volume bake must complete");

      // The bake runs on the GPU and leaves no CPU copy of the atlas: both surfaces are judged by the frame the
      // desktop host draws against the browser's.
      assertCondition(paneMaterial.transparent === true, "pane must be translucent");

      return {
        detail: {
          atlasBytes: volume.atlasBytes,
          bakeFrames,
          emitter: "off-screen",
          sample: "sampleNonDirectional(positionWorld)",
          status: volume.observation.status,
        },
        render: () => renderer.render(scene, camera),
        volume,
      };
    },
    {
      background: 0x090b14,
      camera: (size) => {
        const view = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 100);
        view.position.set(0, 0.05, 3.8);
        view.lookAt(0, 0, -0.35);
        return view;
      },
    },
  );
}
