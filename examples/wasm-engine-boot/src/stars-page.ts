/**
 * PRD-871: a game's star field, drawn with `THREE.Points` and `PointsMaterial` on the default engine.
 *
 * Under `engine: "threenative"` these imports are the engine's classes, so this page is the game a
 * developer writes: a `bufferGeometry` of positions and colours and one `PointsMaterial`. Nothing here
 * knows the engine refuses nothing, and 100 000 stars is the count the frame budget is measured at.
 */
import { type ICtx, Scene, type SceneFrame, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  type PerspectiveCamera,
  Points,
  PointsMaterial,
  Vector3,
} from "three";
import config from "../threenative.config.js";

const STAR_COUNT = 100_000;
/** A shell 30 to 60 m around the camera, so every point is in the frustum and one is one pixel. */
const NEAR_SHELL = 30;
const FAR_SHELL = 60;

export interface IStarState extends Record<string, unknown> {
  frames: number;
  stars: number;
}

class StarField extends Scene<IStarState> {
  static override readonly initialState: IStarState = { frames: 0, stars: STAR_COUNT };
  #stars: Points | undefined;

  override enter(ctx: ICtx<IStarState>): SceneFrame<IStarState> {
    const camera = ctx.camera as PerspectiveCamera;
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.far = 2 * FAR_SHELL;
    camera.updateProjectionMatrix();

    // A fixed linear congruential sequence: the same sky every run, so a frame diff is the rotation's.
    let seed = 871;
    const random = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);
    const tint = new Color();
    const star = new Vector3();
    for (let index = 0; index < STAR_COUNT; index += 1) {
      // A uniform direction on the sphere, at a distance in the shell.
      const height = random() * 2 - 1;
      const turn = random() * Math.PI * 2;
      const radius = NEAR_SHELL + random() * (FAR_SHELL - NEAR_SHELL);
      const ring = Math.sqrt(1 - height * height);
      star.set(Math.cos(turn) * ring, height, Math.sin(turn) * ring).multiplyScalar(radius);
      positions[index * 3] = star.x;
      positions[index * 3 + 1] = star.y;
      positions[index * 3 + 2] = star.z;
      // Three-quarters of the stars are white-hot, the rest blue or amber, as a night sky reads.
      tint.setHSL(random() < 0.75 ? 0.58 : random() < 0.5 ? 0.08 : 0.62, 0.35, 0.72 + random() * 0.28);
      colors[index * 3] = tint.r;
      colors[index * 3 + 1] = tint.g;
      colors[index * 3 + 2] = tint.b;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));

    // A game writes a size and turns attenuation off for a sky: WebGPU draws a one-pixel point either
    // way (PRD-871), and the engine keeps both values without moving a pixel, as upstream does.
    this.#stars = new Points(
      geometry,
      new PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false }),
    );
    this.#stars.name = "starField";
    ctx.scene.add(this.#stars);
    return (frameCtx, dt) => {
      if (this.#stars !== undefined) this.#stars.rotation.y += dt * 0.35;
      frameCtx.state.set((state) => ({ frames: state.frames + 1 }));
    };
  }
}

const game = defineGame<IStarState>({
  plugins: [playtest()],
  display: config.display,
  renderer: config.renderer,
  scenes: { sky: StarField },
  start: "sky",
});

export default game;
