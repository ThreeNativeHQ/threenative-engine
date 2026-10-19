// Generated for you. Ordinary Three.js, and the whole coastal look lives in this file.
//
// The coast is not a set of meshes. It is one raymarched distance field — terrain, the road down
// it, the double yellow line, the sea, the island, the forest, the six lamps, the rail, the cabin
// with its lit window and its antenna, the wet reflections and the rain ripples — evaluated in the
// fragment shader, which is why the whole thing is a single screen-sized quad. Its maths lives in
// `world-shader.ts`, which `tools/generate-shaders.mjs` transpiles from GLSL; this file
// owns the camera basis, the weather uniforms and the sky it reflects, and nothing else.
//
// Conventions: one world unit is one metre, +x is out to sea, -z runs down the coast.
import {
  DoubleSide,
  Mesh,
  type PerspectiveCamera,
  PlaneGeometry,
  type Scene,
  Vector3,
} from "three";
import { cameraFar, cameraNear, clamp, float, positionGeometry, uv, vec4 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { QualityName, Weather } from "../state.js";
import { type ICloudPass, createCloudPass } from "./clouds.js";
import { setupLighting } from "./lighting.js";
import { setupMaterials } from "./materials.js";
import { studyTier } from "./quality.js";
import { setupSky } from "./sky.js";
import {
  tempestWorld,
  uAspect,
  uCam,
  uFlash,
  uFog,
  uForward,
  uRain,
  uReflect,
  uRight,
  uStrike,
  uTan,
  uTime,
  uUp,
  uWet,
} from "./world-shader.js";

export interface IWeatherWorldOptions {
  /** Absolute seconds, so the weather phase does not depend on how the frame was scheduled. */
  readonly elapsed: number;
  /** Current flash envelope, already gated on the photosensitivity switch by the caller. */
  readonly flash: number;
  readonly weather: Weather;
  /** Where the last strike landed, in metres. Only visible while `flash` is above zero. */
  readonly strike: Vector3;
  /** The player's tier: `quality.ts` decides whether it runs the 36-step reflection march. */
  readonly quality: QualityName;
}

export interface IWeatherWorld {
  /** The screen quad, for the engine's culling pass: see the engine's `alwaysRender`. */
  readonly quad: Mesh;
  /** What the cloud pass really drew last frame: its target size and its march steps. */
  readonly clouds: ICloudPass["measured"];
  dispose(): void;
  update(options: IWeatherWorldOptions): void;
}

/**
 * The cloud pass is built first because it is what the world samples: `createCloudPass` binds the
 * pass's texture node to the world's `uSky`, and the world shader's own functions read that binding
 * when this call below builds their graph. The order of these two lines is the whole dependency.
 */
export function createWeatherWorld(scene: Scene, camera: PerspectiveCamera): IWeatherWorld {
  const clouds: ICloudPass = createCloudPass({ camera });
  // The look the two passes read: sky and haze colours, the sun and the flash light, and the lamp
  // and sea colours. Set once; nothing here changes per frame.
  setupSky(scene);
  setupLighting();
  setupMaterials();

  const world = tempestWorld(uv());
  // The shader's own depth is a curve fitted to the source's camera; the closed form is reversible,
  // so the engine's near/far decide the real clip depth and anything drawn after this quad — rain,
  // then lightning — is occluded by the coast rather than floating through it.
  const viewDistance = float(0.150009).div(float(1.00006).sub(world.w));
  const material = new MeshBasicNodeMaterial();
  // The source driver drew its coast quad with both faces, so the vertex stage is written to flip
  // the corner order; a single-face material would cull whichever way that lands.
  material.side = DoubleSide;
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.fragmentNode = world.xyz;
  material.depthNode = clamp(
    cameraNear
      .add(cameraFar)
      .sub(cameraNear.mul(cameraFar).mul(2).div(viewDistance))
      .div(cameraFar.sub(cameraNear))
      .add(1)
      .mul(0.5),
    0,
    1,
  );

  const geometry = new PlaneGeometry(2, 2);
  const quad = new Mesh(geometry, material);
  // The quad's own bounds are two metres wide and sit at the origin, so both frustum tests would
  // throw it away the moment the camera looks along the coast.
  quad.frustumCulled = false;
  scene.add(quad);

  const forward = new Vector3();
  const right = new Vector3();
  const up = new Vector3();

  return {
    quad,
    clouds: clouds.measured,
    dispose(): void {
      scene.remove(quad);
      geometry.dispose();
      material.dispose();
      clouds.dispose();
    },
    update({ elapsed, flash, quality, strike, weather }): void {
      // The camera basis the shader raymarches from: the same three axes the renderer draws with,
      // and the same field of view, so the coast lines up with anything the engine adds later.
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

      uRain.value = weather.rain;
      uFog.value = weather.fog;
      uWet.value = weather.wet;
      uFlash.value = flash;
      uStrike.value.copy(strike);
      uReflect.value = studyTier(quality).reflections ? 1 : 0;

      // The sky the shader draws and reflects is the cloud target, so the same weather that steers
      // the rain also lights the ceiling, and a flash reaches both from one value.
      clouds.update({ elapsed, flash, quality, strike, weather });
    },
  };
}
