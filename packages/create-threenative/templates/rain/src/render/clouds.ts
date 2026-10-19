// Generated for you. Ordinary Three.js, and the whole storm ceiling lives in this file.
//
// The clouds are not part of the coast's raymarch: the source rendered them into a screen-sized
// target first and handed that target to the world shader as its sky and its wet reflections, which
// is what makes the reflections carry the same cloud shapes the sky does. This is that pass. The
// shader itself is `clouds-shader.ts`, transpiled from `tools/tempest-clouds.frag`; the maths of the
// volume is there and the only decision here is where the march happens.
//
// The pass is a `PassNode` over a scene holding one screen quad, so the engine's own renderer owns
// the render target, its size and its per-frame update — there is no second render loop here, and
// nothing about the target is copied out by hand.
import {
  DoubleSide,
  Mesh,
  OrthographicCamera,
  type PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from "three";
import { positionGeometry, texture3D, uv, vec4 } from "three/tsl";
import { MeshBasicNodeMaterial, PassNode } from "three/webgpu";
import type { QualityName, Weather } from "../state.js";
import {
  setNoise,
  tempestClouds,
  uAspect,
  uCam,
  uCloud,
  uFlash,
  uForward,
  uRight,
  uSteps,
  uStrike,
  uTan,
  uTime,
  uUp,
  uWind,
} from "./clouds-shader.js";
import { createNoiseVolume } from "./noise-volume.js";
import { studyTier } from "./quality.js";
import { setSky } from "./world-shader.js";

export interface ICloudPassOptions {
  readonly camera: PerspectiveCamera;
}

export interface ICloudPass {
  /** The node the world shader samples for its sky and its reflections. */
  readonly sky: ReturnType<PassNode["getTextureNode"]>;
  /** The cloud target as the renderer last sized it, and the march steps it ran: read, not asked. */
  measured(): { readonly height: number; readonly steps: number; readonly width: number };
  dispose(): void;
  update(options: {
    readonly elapsed: number;
    readonly flash: number;
    readonly quality: QualityName;
    readonly strike: Vector3;
    readonly weather: Weather;
  }): void;
}

export function createCloudPass({ camera }: ICloudPassOptions): ICloudPass {
  const volume = createNoiseVolume();
  setNoise(texture3D(volume.texture));

  // The source's cloud quad filled the frame from clip-space corners, so the camera on this pass is
  // a formality: the vertex stage writes the corners and nothing reads the projection.
  const cloudScene = new Scene();
  const cloudCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new PlaneGeometry(2, 2);
  const material = new MeshBasicNodeMaterial();
  material.side = DoubleSide;
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.fragmentNode = tempestClouds(uv());
  const quad = new Mesh(geometry, material);
  // Same as the coast quad: its own bounds are two metres wide at the origin, and the projection it
  // is drawn with has no use for them.
  quad.frustumCulled = false;
  cloudScene.add(quad);

  const pass = new PassNode(PassNode.COLOR, cloudScene, cloudCamera);
  // The world's shader has to reach the pass through the node graph, not through a copied texture:
  // a pass that is not in the graph the renderer walks is never asked for a frame.
  const sky = pass.getTextureNode();
  setSky(sky);

  const forward = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  let steps = 0;
  let scale = 0;

  return {
    sky,
    measured: () => ({
      height: pass.renderTarget.height,
      steps: uSteps.value,
      width: pass.renderTarget.width,
    }),
    dispose(): void {
      pass.dispose();
      geometry.dispose();
      material.dispose();
      volume.texture.dispose();
    },
    update({ elapsed, flash, quality, strike, weather }): void {
      // The same basis the world marches from, and the same field of view, so the clouds and the
      // coast agree on where the horizon is.
      camera.getWorldDirection(forward);
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      uCam.value.copy(camera.position);
      uForward.value.copy(forward);
      uRight.value.copy(right);
      uUp.value.copy(up);
      uAspect.value = camera.aspect;
      uTan.value = Math.tan((camera.fov * Math.PI) / 360);

      uTime.value = elapsed;
      uCloud.value = weather.cloud;
      uWind.value = weather.wind;
      uFlash.value = flash;
      uStrike.value.copy(strike);

      const tier = studyTier(quality);
      const next = tier.cloudSteps;
      if (next !== steps) {
        steps = next;
        uSteps.value = next;
      }

      // The pass renders at this share of the frame's resolution: the cloud march is smooth and
      // low-frequency next to the coast it backs, so a lower tier costs it little and buys a lot.
      const nextScale = tier.cloudScale;
      if (nextScale !== scale) {
        scale = nextScale;
        pass.setResolutionScale(nextScale);
      }
    },
  };
}
