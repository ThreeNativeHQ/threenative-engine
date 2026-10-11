// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file. `sky.ts` owns the numbers; this file is the fog maths.
import { Color, type FogExp2, type Vector3 } from "three";
import {
  cameraPosition,
  densityFogFactor,
  dot,
  exp2,
  float,
  fog,
  max,
  mix,
  positionWorld,
  pow,
  saturate,
  select,
  uniform,
  vec3,
} from "three/tsl";

/**
 * Height fog, in metres, y up. Density falls off exponentially above `fogHeight`; the fog along the
 * ray from the camera to a fragment is the closed-form integral of that density, so low ground
 * reads hazier than a ridge at the same distance and a camera above the layer looks down through it.
 * Every control says which way to move it.
 */
export const HEIGHT_FOG = {
  /** Optical depth per metre at `fogHeight` (base 2). Up: thicker ground mist. */
  density: 0.0012,
  /** Per metre above `fogHeight`. Up: a thinner, lower layer. Down: mist climbs the hills. */
  heightFalloff: 0.08,
  /** World y where density equals `density`. Move it to the ground of your world. */
  fogHeight: 0,
  /** Floor on the height term's transparency, 0..1. Below 1 leaves a clear window in the mist. */
  maxOpacity: 1,
  /** Metres from the camera before the mist starts. Up: a clear foreground. */
  startDistance: 0,
  /** Sun lobe sharpness. Up: a tighter glow around the sun. */
  sunExponent: 4,
  /** Metres before sun glow starts, so nearby objects are not tinted. */
  sunStartDistance: 100,
  /** Metres past which the height term is off. 0 = never. Never set it inside a streaming ring. */
  cutoffDistance: 0,
} as const;
export type HeightFogParams = { -readonly [K in keyof typeof HEIGHT_FOG]: number };

const LN2 = Math.LN2;

// Camera density term, clamped so exp2 stays finite (Unreal clamps the exponent at -127).
const clampExponent = (x: number): number => Math.min(127, Math.max(-127, x));

/** `density` times the integral of 2^(-k t) over [a, b]; k is the ray's slope times `falloff`. */
function segment(density: number, k: number, a: number, b: number): number {
  if (b <= a) return 0;
  if (Math.abs(k * b) < 0.01) return density * (b - a - 0.5 * LN2 * k * (b * b - a * a));
  return (density * (2 ** (-k * a) - 2 ** (-k * b))) / (k * LN2);
}

function rayTerms(p: HeightFogParams, cameraY: number, fragmentY: number, length: number) {
  const camera = p.density * 2 ** clampExponent(-p.heightFalloff * (cameraY - p.fogHeight));
  const k = length > 0 ? (p.heightFalloff * (fragmentY - cameraY)) / length : 0;
  return { camera, k };
}

/** Base-2 optical depth (transmittance is 2^-depth) of the mist between the camera and a fragment. */
export function heightFogDepth(
  p: HeightFogParams,
  cameraY: number,
  fragmentY: number,
  length: number,
): number {
  if (p.cutoffDistance > 0 && length > p.cutoffDistance) return 0;
  const { camera, k } = rayTerms(p, cameraY, fragmentY, length);
  return segment(camera, k, p.startDistance, length);
}

const SUN_COLOUR = new Color(0xfff1d6);

/**
 * `T_distance x T_height`, on `scene.fogNode`: three applies it to every material where `scene.fog`
 * would be. The distance term reads the live `FogExp2`, so changing its colour or density at runtime
 * still works. It is never more transparent than that term alone, so wherever the distance term
 * reaches 0 the frame stays fully fogged. Pass `sun` for a glow toward it past `sunStartDistance`.
 */
export function heightFogNode(distanceFog: FogExp2, p: HeightFogParams, sun?: Vector3) {
  const color = uniform(new Color());
  color.onRenderUpdate(() => color.value.copy(distanceFog.color));
  const density = uniform(0);
  density.onRenderUpdate(() => {
    density.value = distanceFog.density;
  });
  // Density at the camera, once per frame instead of once per fragment.
  const cameraDensity = uniform(0);
  cameraDensity.onRenderUpdate(({ camera }) => {
    const y = camera?.matrixWorld.elements[13] ?? 0;
    cameraDensity.value = p.density * 2 ** clampExponent(-p.heightFalloff * (y - p.fogHeight));
  });
  const ray = positionWorld.sub(cameraPosition);
  const length = ray.length().max(1e-4);
  const k = float(p.heightFalloff).mul(positionWorld.y.sub(cameraPosition.y)).div(length);
  const integral = (a: number) => {
    const b = max(length, a);
    const curved = cameraDensity
      .mul(exp2(k.mul(a).negate()).sub(exp2(k.mul(b).negate())))
      .div(k.mul(LN2));
    return select(k.mul(b).abs().lessThan(0.01), cameraDensity.mul(b.sub(a)), curved);
  };
  const cut = p.cutoffDistance > 0 ? select(length.greaterThan(p.cutoffDistance), 0, 1) : float(1);
  const heightT = max(exp2(integral(p.startDistance).mul(cut).negate()), 1 - p.maxOpacity);
  const opacity = densityFogFactor(density).oneMinus().mul(heightT).oneMinus();
  if (sun === undefined) return fog(color, opacity);
  const lobe = pow(saturate(dot(ray.div(length), vec3(sun.x, sun.y, sun.z))), p.sunExponent);
  const glow = float(1)
    .sub(exp2(integral(Math.max(p.sunStartDistance, p.startDistance)).negate()))
    .mul(lobe)
    .mul(p.maxOpacity);
  return fog(mix(color, vec3(SUN_COLOUR.r, SUN_COLOUR.g, SUN_COLOUR.b), glow), opacity);
}
