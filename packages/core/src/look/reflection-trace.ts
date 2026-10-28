// Generated for you: ordinary Three.js; ThreeNative does not read this file.
//
// Traced reflections: what a smooth surface shows of the scene, from the scene's triangles and not from
// the screen. The `ssr` stage finds a hit among the pixels the camera drew, so a ray that leaves the frame,
// or reaches the far side of an object, meets the camera-facing pixel near the silhouette (lit, wrong side).
// This stage walks `TracedReflections` (the engine mechanism) for the exact surface, then lights
// that surface here. How a hit is lit is a look, so it lives in this file and not in the package.
//
// Unreal traces dedicated reflection rays for roughness up to 0.4 and lights each hit from its surface cache
// (Engine/Source/Runtime/Renderer/Private/Lumen/LumenReflectionTracing.cpp). Without a surface cache the hit
// takes the sun with one shadow ray, the world-space radiance cache for the bounce, and its own emission.

import type { DirectionalLight, PerspectiveCamera, PointLight, SpotLight } from "three";
import { HalfFloatType } from "three";
import {
  Fn,
  If,
  clamp,
  dot,
  float,
  length,
  max,
  mix,
  normalize,
  pow,
  reflect,
  rtt,
  saturate,
  select,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";
import type { TracedReflections } from "../render/traced-reflections.js";
import { giCache } from "./gi-registry.js";

/** The traced scene the reference scene registers, read by the `ssr` stage when it builds. */
export const reflectionTrace: {
  current?: TracedReflections;
  /** The scene's point and spot lamps: each lights a hit like the sun (the scene registers them with the trace). */
  lamps?: readonly (PointLight | SpotLight)[];
} = {};

export interface ITracedReflectionStage {
  readonly trace: TracedReflections;
  /** The scene camera the pass draws with: a post quad has its own, so the stage reads this one every render. */
  readonly camera: PerspectiveCamera;
  /** The sun, for the hit's direct light. Unset: a hit takes only the cache and its own emission. */
  readonly sun?: DirectionalLight;
  /**
   * The point and spot lamps, for the hit's direct light: each lights a hit through one shadow ray, as the sun does. Unreal's
   * surface cache takes the direct light of every light in the scene, not only the sun
   * (Engine/Source/Runtime/Renderer/Private/Lumen/LumenSceneDirectLighting.cpp).
   */
  readonly lamps?: readonly (PointLight | SpotLight)[];
  /** The lit frame, the scene pass's depth, view-space normal, metalness (r) and roughness (g). */
  readonly base: TextureNode;
  readonly depth: TextureNode;
  readonly normal: TextureNode;
  readonly metalness: TextureNode;
  readonly roughness: TextureNode;
  /** The surface's own colour (the scene pass's `diffuseColor`), which tints a metal's reflection. */
  readonly albedo?: TextureNode;
  /** The frame's exposure multiplier: scene light times this is what the chain holds. */
  readonly gain: Node<"float">;
  /** Metres a ray travels before it counts as a miss. Unset: the whole scene, and no fade. */
  readonly maxDistance?: number;
  readonly resolutionScale?: number;
}

/** With a `maxDistance`, a hit's reflection fades out over the last half of the reach, so a far surface does not pop. */
const FADE_FROM = 0.5;
/** Depth buffers lose precision with distance, so the ray starts off the surface by more the farther it is. */
const START_OFFSET = 0.01;
const START_OFFSET_PER_METRE = 0.004;
/** The shadow ray starts this far off the hit, along its normal. */
const SHADOW_OFFSET = 0.02;
const SHADOW_FAR = 2000;
const NO_CACHE_RADIANCE = 0;
/** Share of a metal's colour, per unit of roughness, that a hit takes as diffuse: calibrated on the rough metal sphere. */
const METAL_DIFFUSE = 0.12;

/**
 * The delta to add to the lit frame (zero where nothing is traced or the ray finds nothing): for a metal the
 * traced hit replaces the frame's own environment reflection, for a dielectric it adds the Fresnel-weighted
 * reflection. Multiply by `trace.weight(roughness)` before adding. The same shape `ssr` returns.
 */
export function tracedReflections(stage: ITracedReflectionStage): Node<"vec4"> {
  const { camera, trace } = stage;
  const live = (read: () => number): Node<"float"> =>
    uniform(read()).onRenderUpdate(read) as Node<"float">;
  const projection = (index: number) => live(() => camera.projectionMatrix.elements[index] ?? 0);
  const [p00, p11, p02, p12, p22, p32] = [0, 5, 8, 9, 10, 14].map(projection) as [
    Node<"float">,
    Node<"float">,
    Node<"float">,
    Node<"float">,
    Node<"float">,
    Node<"float">,
  ];
  const world = (index: number) => live(() => camera.matrixWorld.elements[index] ?? 0);
  const column = (first: number) => vec3(world(first), world(first + 1), world(first + 2));
  const [right, up, back, at] = [column(0), column(4), column(8), column(12)];
  const direction = (v: Node<"vec3">): Node<"vec3"> =>
    right.mul(v.x).add(up.mul(v.y)).add(back.mul(v.z));

  const sun = stage.sun;
  const sunDirection = vec3(
    live(() => sunVector(sun)[0]),
    live(() => sunVector(sun)[1]),
    live(() => sunVector(sun)[2]),
  );
  const sunRadiance = vec3(
    live(() => (sun === undefined ? 0 : (sun.color.r * sun.intensity) / Math.PI)),
    live(() => (sun === undefined ? 0 : (sun.color.g * sun.intensity) / Math.PI)),
    live(() => (sun === undefined ? 0 : (sun.color.b * sun.intensity) / Math.PI)),
  );

  const lamps = stage.lamps ?? [];
  const lampDirect = (
    lamp: PointLight | SpotLight,
    hit: ReturnType<typeof trace.trace>,
  ): Node<"vec3"> => {
    const lampAt = vec3(
      live(() => lamp.position.x),
      live(() => lamp.position.y),
      live(() => lamp.position.z),
    );
    // three's lamp: colour times candela over the squared distance, windowed to its cut-off distance, then the BRDF's 1/PI.
    const radiance = vec3(
      live(() => (lamp.color.r * lamp.intensity) / Math.PI),
      live(() => (lamp.color.g * lamp.intensity) / Math.PI),
      live(() => (lamp.color.b * lamp.intensity) / Math.PI),
    );
    const cutoff = live(() => lamp.distance);
    const toLamp = lampAt.sub(hit.position);
    const distance = max(length(toLamp), 0.01);
    const direction = toLamp.div(distance);
    const facing = max(dot(hit.normal, direction), 0);
    const window = select(
      cutoff.greaterThan(0),
      pow(saturate(float(1).sub(pow(distance.div(cutoff), 4))), 2),
      float(1),
    );
    let cone: Node<"float"> = float(1);
    if ("angle" in lamp) {
      const axis = vec3(
        live(() => lamp.target.position.x - lamp.position.x),
        live(() => lamp.target.position.y - lamp.position.y),
        live(() => lamp.target.position.z - lamp.position.z),
      );
      const outerCos = live(() => Math.cos(lamp.angle));
      const innerCos = live(() => Math.cos(lamp.angle * (1 - lamp.penumbra)));
      cone = smoothstep(outerCos, innerCos, dot(direction.negate(), normalize(axis)));
    }
    const blocked = float(0).toVar();
    If(facing.greaterThan(0), () => {
      const shadow = trace.trace({
        origin: hit.position.add(hit.normal.mul(SHADOW_OFFSET)),
        direction,
        far: distance.sub(SHADOW_OFFSET),
        anyHit: true,
      });
      blocked.assign(shadow.hit);
    });
    return radiance
      .mul(facing.mul(window).mul(cone).div(distance.mul(distance)))
      .mul(float(1).sub(blocked));
  };

  const graph = Fn(() => {
    const coordinate = uv();
    const result = vec4(0, 0, 0, 0).toVar();
    const depth = stage.depth.r;
    const roughness = stage.roughness.g;
    const gate = depth.lessThan(1).and(roughness.lessThan(trace.maxRoughnessToTrace));
    If(gate, () => {
      // View-space position from depth: depth is (A z + B) / -z, so z = -B / (depth + A).
      const z = p32.negate().div(depth.add(p22));
      const position = vec3(
        z.negate().mul(coordinate.x.mul(2).sub(1).add(p02)).div(p00),
        z.negate().mul(float(1).sub(coordinate.y).mul(2).sub(1).add(p12)).div(p11),
        z,
      );
      const normalView = normalize(stage.normal.xyz);
      const incidentView = normalize(position);
      const normalWorld = direction(normalView);
      const reflected = normalize(reflect(direction(incidentView), normalWorld));
      const start = max(float(START_OFFSET), z.negate().mul(START_OFFSET_PER_METRE));
      const origin = direction(position).add(at).add(normalWorld.mul(start));
      const hit = trace.trace({
        origin,
        direction: reflected,
        ...(stage.maxDistance === undefined ? {} : { far: stage.maxDistance }),
      });
      If(hit.hit.greaterThan(0), () => {
        // The hit's light, in scene units: the sun through one shadow ray, the cache for everything else.
        const facing = max(dot(hit.normal, sunDirection), 0);
        const blocked = float(0).toVar();
        If(facing.greaterThan(0), () => {
          const shadow = trace.trace({
            origin: hit.position.add(hit.normal.mul(SHADOW_OFFSET)),
            direction: sunDirection,
            far: SHADOW_FAR,
            anyHit: true,
          });
          blocked.assign(shadow.hit);
        });
        const sunDirect = sunRadiance.mul(facing).mul(float(1).sub(blocked));
        const direct = lamps.reduce((sum, lamp) => sum.add(lampDirect(lamp, hit)), sunDirect);
        const indirect = giCache.irradiance?.(hit.position, hit.normal) ?? vec3(NO_CACHE_RADIANCE);
        // A metal has almost no diffuse colour: the sun and the bounce light it only a little, more the rougher it is
        // (Unreal's reflection hit shows a rough metal as a dark shape, not black and not a lit diffuse one).
        const metalShare = hit.roughness.mul(METAL_DIFFUSE);
        const diffuse = hit.albedo.mul(float(1).sub(hit.metalness.mul(float(1).sub(metalShare))));
        const radiance = diffuse.mul(direct.add(indirect)).add(hit.emissive).mul(stage.gain);

        const facingView = clamp(dot(normalView, incidentView.negate()), 0, 1);
        const schlick = float(1).sub(facingView).pow(5);
        const metalness = clamp(stage.metalness.r, 0, 1);
        const tint = stage.albedo === undefined ? vec3(1) : stage.albedo.rgb;
        const f0 = mix(vec3(0.04), tint, metalness);
        const fresnel = f0.add(vec3(1).sub(f0).mul(schlick));
        const frame = stage.base.rgb;
        const delta = mix(radiance.mul(fresnel), radiance.mul(fresnel).sub(frame), metalness);
        const reach =
          stage.maxDistance === undefined
            ? float(1)
            : float(1).sub(smoothstep(FADE_FROM, 1, hit.distance.div(stage.maxDistance)));
        result.assign(vec4(delta.mul(reach), 0));
      });
    });
    return result;
  })();

  const node = rtt(graph, null, null, { type: HalfFloatType }) as Node<"vec4"> & {
    setResolutionScale?: (scale: number) => unknown;
  };
  if (stage.resolutionScale !== undefined && stage.resolutionScale !== 1)
    node.setResolutionScale?.(stage.resolutionScale);
  return node;
}

const toSun = [0, 1, 0] as [number, number, number];
/** The unit vector from the scene toward the sun: where the light sits, seen from where it aims. */
function sunVector(sun: DirectionalLight | undefined): readonly [number, number, number] {
  if (sun === undefined) return toSun;
  const x = sun.position.x - sun.target.position.x;
  const y = sun.position.y - sun.target.position.y;
  const z = sun.position.z - sun.target.position.z;
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}
