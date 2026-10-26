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
  type Camera,
  DoubleSide,
  Mesh,
  OrthographicCamera,
  type PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from "three";
import { cameraFar, cameraNear, clamp, float, positionGeometry, uv, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { MeshBasicNodeMaterial, PassNode } from "three/webgpu";
import type { QualityName, Weather } from "../state.js";
import { type ICloudPass, createCloudPass } from "./clouds.js";
import { setupLighting } from "./lighting.js";
import { setupMaterials } from "./materials.js";
import { studyTier } from "./quality.js";
import { setupSky } from "./sky.js";
import {
  baseTable,
  heightTable,
  setBase,
  setHeight,
  tempestWorld,
  uAspect,
  uBaseGrid,
  uCam,
  uFlash,
  uFog,
  uForward,
  uHeightGrid,
  uHeightMargin,
  uRain,
  uReflect,
  uRight,
  uStrike,
  uTan,
  uTime,
  uUp,
  uWet,
} from "./world-shader.js";

// terrain() is the march's costliest call and it never changes, so it is cached every frame in two
// small passes the coast samples instead (see `hillHeight` and `cellBase` in tempest-world.frag).
// The grids follow the camera and reach as far as the march does (1850 m).
/** Texels per side of the cached heightmap, and the metres it spans: 3.6 m between samples. */
const HEIGHT_TEXELS = 1024;
const HEIGHT_SPAN = 3700;
/**
 * Metres added to a cached height so it bounds terrain() from above. Between its texels the cache
 * reads at most 2.61 m below the true height (18,000,000 random points at 3.6 m, half-float storage,
 * the road cut and the coast step included), so 4 m keeps every hit on the exact surface.
 */
const HEIGHT_MARGIN = 4;
/** Tree cells per side of the base table: 360 cells of 10.5 m, 1890 m each way. */
const BASE_CELLS = 360;
/** The tree grid of `treeCell` in tempest-world.frag: 10.5 m cells offset by (2, 1) m. */
const CELL_SIZE = 10.5;

/** A pass whose target keeps one size, whatever the drawing buffer is: a table, not a picture. */
class TablePass extends PassNode {
  side = 1;
  override setSize(): void {
    super.setSize(this.side ?? 1, this.side ?? 1);
  }
}

function tablePass(fragment: Node, side: number): { pass: TablePass; dispose(): void } {
  const scene = new Scene();
  const camera: Camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new PlaneGeometry(2, 2);
  const material = new MeshBasicNodeMaterial();
  material.side = DoubleSide;
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.fragmentNode = fragment;
  const quad = new Mesh(geometry, material);
  quad.frustumCulled = false;
  scene.add(quad);
  const pass = new TablePass(PassNode.COLOR, scene, camera, { depthBuffer: false, samples: 0 });
  pass.side = side;
  return {
    pass,
    dispose(): void {
      pass.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}

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

  // Bound before the coast's graph is built, the same order as the cloud pass and for the same reason.
  const heights = tablePass(heightTable(uv()), HEIGHT_TEXELS);
  setHeight(heights.pass.getTextureNode());
  const bases = tablePass(baseTable(uv()), BASE_CELLS);
  setBase(bases.pass.getTextureNode());
  uHeightMargin.value = HEIGHT_MARGIN;

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
      heights.dispose();
      bases.dispose();
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
      // Both caches centre on the camera, snapped to their own grid so a cached value stays put.
      const step = HEIGHT_SPAN / HEIGHT_TEXELS;
      uHeightGrid.value.set(
        Math.floor(camera.position.x / step) * step - HEIGHT_SPAN / 2,
        Math.floor(camera.position.z / step) * step - HEIGHT_SPAN / 2,
        HEIGHT_SPAN,
        HEIGHT_SPAN,
      );
      uBaseGrid.value.set(
        Math.floor((camera.position.x + 2) / CELL_SIZE) - BASE_CELLS / 2,
        Math.floor((camera.position.z + 1) / CELL_SIZE) - BASE_CELLS / 2,
        BASE_CELLS,
      );

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
