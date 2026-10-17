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
  OrthographicCamera,
  type PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector2,
  Vector3,
} from "three";
import {
  abs,
  cameraFar,
  cameraNear,
  clamp,
  exp,
  float,
  floor,
  frameGroup,
  max,
  positionGeometry,
  select,
  uniform,
  uv,
  vec2,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial, PassNode } from "three/webgpu";
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

/** How far a neighbouring texel's view distance may differ, as a share of the nearest texel's, before the upscale drops it. */
const EDGE_TOLERANCE = 0.08;

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

  // The coast is the frame's whole cost, and it is smooth: no pixel of it needs its own march. It is
  // drawn into a target at `worldScale` of the frame, with its colour in rgb and the view distance
  // in alpha, and the frame's own quad below upscales it. The pass is a `PassNode` over a scene of
  // one quad, like the clouds, so the engine owns the target and its size.
  const world = tempestWorld(uv());
  // The shader's own depth is a curve fitted to the source's camera; the closed form is reversible,
  // so the engine's near/far decide the real clip depth and anything drawn after the coast — rain,
  // then lightning — is occluded by it rather than floating through it.
  const viewDistance = float(0.150009).div(float(1.00006).sub(world.w));
  // The source driver drew its coast quad with both faces, so the vertex stage is written to flip
  // the corner order; a single-face material would cull whichever way that lands.
  const marchMaterial = new MeshBasicNodeMaterial();
  marchMaterial.side = DoubleSide;
  marchMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1);
  marchMaterial.fragmentNode = vec4(world.xyz, viewDistance);
  const marchGeometry = new PlaneGeometry(2, 2);
  const marchQuad = new Mesh(marchGeometry, marchMaterial);
  marchQuad.frustumCulled = false;
  const marchScene = new Scene();
  marchScene.add(marchQuad);
  const marchPass = new PassNode(
    PassNode.COLOR,
    marchScene,
    new OrthographicCamera(-1, 1, 1, -1, 0, 1),
  );
  const marched = marchPass.getTextureNode();

  // Upscale: the four low-resolution texels around a pixel are blended bilinearly, but a texel whose
  // view distance differs from the nearest texel's is another surface (a lamp against the sea, the
  // headland against the sky), so its weight falls away and it cannot halo across the edge.
  const uLow = uniform(new Vector2(1, 1), "vec2").setGroup(frameGroup);
  const at = vec2(uv().x, uv().y.oneMinus());
  const grid = at.mul(uLow).sub(0.5);
  const corner = floor(grid);
  const frac = grid.sub(corner);
  const tap = (dx: number, dy: number) =>
    marched.sample(corner.add(vec2(dx, dy)).add(0.5).div(uLow));
  const t00 = tap(0, 0);
  const t10 = tap(1, 0);
  const t01 = tap(0, 1);
  const t11 = tap(1, 1);
  const nearest = select(
    frac.y.greaterThan(0.5),
    select(frac.x.greaterThan(0.5), t11.w, t01.w),
    select(frac.x.greaterThan(0.5), t10.w, t00.w),
  );
  const fx = frac.x;
  const fy = frac.y;
  const edge = (t: typeof t00) =>
    exp(abs(t.w.sub(nearest)).div(max(nearest, 1)).div(EDGE_TOLERANCE).negate());
  const w00 = fx.oneMinus().mul(fy.oneMinus()).mul(edge(t00));
  const w10 = fx.mul(fy.oneMinus()).mul(edge(t10));
  const w01 = fx.oneMinus().mul(fy).mul(edge(t01));
  const w11 = fx.mul(fy).mul(edge(t11));
  const total = w00.add(w10).add(w01).add(w11);
  const color = t00.xyz
    .mul(w00)
    .add(t10.xyz.mul(w10))
    .add(t01.xyz.mul(w01))
    .add(t11.xyz.mul(w11))
    .div(total);

  const material = new MeshBasicNodeMaterial();
  material.side = DoubleSide;
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.fragmentNode = color;
  material.depthNode = clamp(
    cameraNear
      .add(cameraFar)
      .sub(cameraNear.mul(cameraFar).mul(2).div(nearest))
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
      marchPass.dispose();
      marchGeometry.dispose();
      marchMaterial.dispose();
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

      // The march target's size is the renderer's to decide, so the upscale reads it back.
      const worldScale = studyTier(quality).worldScale;
      if (worldScale !== marchPass.getResolutionScale()) marchPass.setResolutionScale(worldScale);
      uLow.value.set(marchPass.renderTarget.width, marchPass.renderTarget.height);
    },
  };
}
