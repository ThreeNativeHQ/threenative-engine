// Generated for you. Ordinary Three.js, and the falling rain lives in this file.
//
// The reference study drew every drop in one vertex stage: six vertices per drop, the drop's own
// seed hashed from its index, its position wrapped inside a 66 x 30 x 66 metre cell that follows the
// camera in 12 metre steps, and its two endpoints projected by hand so each quad comes out stretched
// along the drop's own fall. That maths is transcribed below, constant for constant, and it is the
// rain: no sprite sheet, no texture, no particle simulation on the CPU.
//
// The engine owns the frame loop, the scene and the renderer, so this file owns three things — the
// uniforms, the geometry, and its own lifetime — and draws nothing itself. No render loop, no raw
// GL, no engine package import, so the same file runs wherever the game runs.
import {
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  type PerspectiveCamera,
  type Scene,
  Vector3,
} from "three";
import {
  abs,
  cameraFar,
  cameraNear,
  clamp,
  dot,
  float,
  floor,
  fract,
  frameGroup,
  instanceIndex,
  max,
  mix,
  mod,
  normalize,
  positionGeometry,
  pow,
  screenSize,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { Node } from "three/webgpu";
import type { QualityName, Weather } from "../state.js";
import { studyTier } from "./quality.js";

/**
 * The six corners of one drop's quad, exactly as the study's `rainGeometry` wrote them: `x` runs
 * across the streak from -1 to 1 and `y` runs along it from the drop's head to its tail. Stored as
 * three-component positions because Three's own bounds pass reads a `position` attribute, and the
 * quad is projected by the shader rather than by a camera matrix, so `z` is never read.
 */
const DROP_CORNERS = new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, -1, 1, 0, 1, 0, 0, 1, 1, 0]);

/** The cell wraps at this many metres on each horizontal axis, and this many in height. */
const CELL_XZ = 66;
const CELL_Y = 30;
/** The cell follows the camera in steps of this many metres. */
const CELL_STEP = 12;
/** The most drops any tier may ask for. */
const MAX_DROPS = 16_000;

/** The study's own hash: one sine, one fract, and every drop's fate in it. */
function rnd(n: Node<"float">) {
  return fract(sin(n.mul(127.1)).mul(43758.5453123));
}

/**
 * How many drops this budget and this weather actually draw, rounded to a whole drop.
 *
 * The number returned is what `geometry.instanceCount` is set to, so what the renderer issues and
 * what this reports are the same figure — there is no second count anywhere that could disagree with
 * the draw.
 */
export function rainInstanceCount(budget: number, rain: number): number {
  if (!Number.isInteger(budget) || budget <= 0 || budget > MAX_DROPS) {
    throw new Error(
      `rain budget must be a whole number of drops in 1..${MAX_DROPS}, got ${budget}.`,
    );
  }
  if (!Number.isFinite(rain) || rain < 0 || rain > 1) {
    throw new Error(`weather.rain must be 0..1, got ${rain}.`);
  }
  return Math.round(budget * rain);
}

export interface IRainOptions {
  /** Absolute seconds, so the fall does not depend on how the frame was scheduled. */
  readonly elapsed: number;
  /** Current flash envelope. The caller has already gated it on the photosensitivity switch. */
  readonly flash: number;
  readonly weather: Weather;
  /** Which tier's drop budget to draw. An unknown name throws rather than falling back. */
  readonly quality: QualityName;
}

export interface IStormRain {
  /** The real mesh, for the engine's culling pass and for a scene walk that counts what is drawn. */
  readonly mesh: Mesh;
  /** The drops the renderer is being asked to draw right now: `geometry.instanceCount`. */
  readonly instanceCount: number;
  update(options: IRainOptions): void;
  dispose(): void;
}

/**
 * The rain pass: one instanced draw of six-vertex quads, added to `scene`.
 *
 * The engine's `GPUParticles3D` was the thing to reach for and it cannot carry this
 * shader: it extends `Sprite`, it overwrites the material's `positionNode` with a storage buffer, and
 * it derives every particle's position from a compute node — there is nowhere to hand it an authored
 * vertex stage that hashes its own drop index, wraps its own cell and projects its own two endpoints
 * by hand. This fills that gap with the smallest thing that holds the maths: an
 * `InstancedBufferGeometry`, so the draw count is the geometry's own `instanceCount` and
 * `instanceIndex` is the study's `floor(gl_VertexID / 6)`.
 */
export function createStormRain(scene: Scene, camera: PerspectiveCamera): IStormRain {
  // The uniform block the study passed to every pass. Assigned each frame below, from the same
  // camera basis and the same weather the coast is drawn with.
  const uTime = uniform(0, "float").setGroup(frameGroup);
  const uRain = uniform(0, "float").setGroup(frameGroup);
  const uWind = uniform(0, "float").setGroup(frameGroup);
  const uFlash = uniform(0, "float").setGroup(frameGroup);
  const uAspect = uniform(0, "float").setGroup(frameGroup);
  const uTan = uniform(0, "float").setGroup(frameGroup);
  const uCam = uniform(new Vector3(), "vec3").setGroup(frameGroup);
  const uForward = uniform(new Vector3(), "vec3").setGroup(frameGroup);
  const uRight = uniform(new Vector3(), "vec3").setGroup(frameGroup);
  const uUp = uniform(new Vector3(), "vec3").setGroup(frameGroup);

  /**
   * The study's `proj`. Its x and y are the ordinary perspective divide for this camera's field of
   * view, and its z becomes the depth the coast's own quad already wrote with these same near and far
   * planes — so a drop behind the headland is hidden by it, which is the one comparison that pass
   * existed for.
   */
  function proj(p: Node<"vec3">) {
    const v = p.sub(uCam);
    const d = dot(v, uForward);
    const depth = clamp(
      cameraNear
        .add(cameraFar)
        .sub(cameraNear.mul(cameraFar).mul(2).div(d))
        .div(cameraFar.sub(cameraNear))
        .add(1)
        .mul(0.5),
      0,
      1,
    );
    return vec4(dot(v, uRight).div(uAspect.mul(uTan)), dot(v, uUp).div(uTan), depth.mul(d), d);
  }

  // --- the vertex stage, transcribed from the study's RAIN_VERTEX --------------------------

  // The study read each drop's own index out of `gl_VertexID / 6`. Instanced, that division is the
  // instance itself: one instance is one drop's six vertices. Written as one composition rather
  // than a run of `assign`s on a `toVar` variable: `assign` only exists inside a generated `Fn`
  // body, and the whole stage is a single expression anyway, so plain composition is both the
  // legal spelling and the smaller one.
  const id = float(instanceIndex);
  const seed = rnd(id.add(1));
  const seedPos = vec3(
    rnd(id.mul(3.1).add(2))
      .mul(CELL_XZ)
      .sub(CELL_XZ / 2),
    rnd(id.mul(7.3).add(5)).mul(CELL_Y),
    rnd(id.mul(5.7).add(8))
      .mul(CELL_XZ)
      .sub(CELL_XZ / 2),
  );
  const anchor = vec3(
    floor(uCam.x.div(CELL_STEP)).mul(CELL_STEP),
    float(0),
    floor(uCam.z.div(CELL_STEP)).mul(CELL_STEP),
  );
  const speed = float(14).add(seed.mul(8));
  const tm = uTime.add(seed.mul(10));

  // The fall. Each axis wraps inside the cell, so a drop reappears at the far edge instead of
  // running out; the cell then jumps with the camera, which is what keeps the volume around the
  // viewer rather than around the origin.
  const falling = vec3(
    mod(seedPos.x.add(tm.mul(uWind).mul(20)).add(CELL_XZ / 2), float(CELL_XZ)).sub(CELL_XZ / 2),
    mod(seedPos.y.sub(tm.mul(speed)), float(CELL_Y)).sub(0.45),
    mod(seedPos.z.add(tm.mul(uWind).mul(2)).add(CELL_XZ / 2), float(CELL_XZ)).sub(CELL_XZ / 2),
  ).add(anchor);
  // The cell sits at the viewer's feet: however high the camera flies, the drops start five metres
  // below it and fall through the same 30 metres of air.
  const p = vec3(falling.x, falling.y.add(max(uCam.y.sub(5), float(0))), falling.z);

  // The streak is the drop's own velocity over a thirteenth of a second, so the quad comes out
  // stretched along the fall instead of a square hung at the drop.
  const velocity = vec3(uWind.mul(20), speed.negate(), uWind.mul(2));
  const end = p.sub(velocity.mul(float(0.013).add(seed.mul(0.011))));
  const a = proj(p);
  const b = proj(end);

  const corner = positionGeometry.xy;
  const dir = normalize(
    b.xy
      .div(max(b.w, float(0.1)))
      .sub(a.xy.div(max(a.w, float(0.1))))
      .mul(screenSize)
      .add(0.0001),
  );
  const side = vec2(dir.y.negate(), dir.x);
  // The width is in pixels and the quad is in clip space, so the offset carries the vertex's own
  // `w`: the study's `... / uRes * c.w * 2`.
  const along = mix(a, b, corner.y);
  const across = side
    .mul(corner.x)
    .mul(mix(float(0.42), float(0.85), seed))
    .div(screenSize)
    .mul(along.w)
    .mul(2);
  const stretched = along.add(vec4(across.x, across.y, float(0), float(0)));
  // An endpoint behind the camera has no direction to stretch along; the study threw the quad off
  // screen rather than letting it collapse to a dot on the near plane.
  const clip = select(a.w.lessThan(0.4).or(b.w.lessThan(0.4)), vec4(2, 2, 2, 1), stretched);

  // Near drops fade up and far ones fade out, so the volume has no visible wall.
  const opacity = float(0.07)
    .add(seed.mul(0.14))
    .mul(uRain)
    .mul(smoothstep(0.3, 1.8, a.w))
    .mul(float(1).sub(smoothstep(12, 43, a.w)));

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(DROP_CORNERS, 3));
  geometry.instanceCount = 0;

  const material = new MeshBasicNodeMaterial();
  // The quads are wound by the projection, not by the vertex order, so either face can end up front
  // facing; the study's pass drew both.
  material.side = DoubleSide;
  material.transparent = true;
  // Drops are light over a coast that has already written depth: they test it and leave it alone,
  // so streaks never occlude each other or the lightning behind them.
  material.depthWrite = false;
  material.vertexNode = clip;

  const vAcross = varying(corner.x, "vAcross");
  const vAlong = varying(corner.y, "vAlong");
  const vOpacity = varying(opacity, "vOpacity");
  material.fragmentNode = vec4(
    vec3(0.41, 0.56, 0.68).add(uFlash.mul(vec3(0.35, 0.48, 0.65))),
    pow(max(float(0), float(1).sub(abs(vAcross))), 1.6)
      .mul(sin(vAlong.mul(Math.PI)))
      .mul(vOpacity),
  );

  const mesh = new Mesh(geometry, material);
  // The geometry holds one quad's worth of corners at the origin while the drops are projected by
  // the shader, so its own bounds say nothing about where any of them land.
  mesh.frustumCulled = false;
  scene.add(mesh);

  const forward = new Vector3();
  const right = new Vector3();
  const up = new Vector3();

  return {
    mesh,
    get instanceCount(): number {
      return geometry.instanceCount;
    },
    update({ elapsed, flash, weather, quality }): void {
      geometry.instanceCount = rainInstanceCount(studyTier(quality).rainBudget, weather.rain);

      // The same basis and the same field of view the coast is drawn with, so a drop and the
      // headland behind it agree on where the horizon is.
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
      uWind.value = weather.wind;
      uFlash.value = flash;
    },
    dispose(): void {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
