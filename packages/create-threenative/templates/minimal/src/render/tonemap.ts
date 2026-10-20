// Generated for you: ordinary Three.js; ThreeNative does not read this file. Delete or rewrite
// it freely.
//
// A filmic tone curve with the parameters and the defaults of a fresh Unreal Engine 5 project:
// slope 0.88, toe 0.55, shoulder 0.26, black clip 0, white clip 0.04 (Unreal 5.8.3,
// `Engine/Source/Runtime/Engine/Private/Scene.cpp:440-448`). Written from the published shape,
// not from Unreal code: each channel, in the ACEScg (AP1) primaries, follows a straight line in
// log10 space through mid grey (0.18 in, 0.18 out), and two sigmoids replace the line below the
// toe and above the shoulder. A small desaturation before and after keeps saturated highlights
// from shifting hue, as the ACES reference rendering does.
//
// `worldEnvironment.ts` installs it as three's `CustomToneMapping` when `tonemapMode` is
// `"filmic"`. `"aces"` stays available as the named override. `filmicToneMap()` is the same
// curve on plain numbers, so a test or a capture script can apply it to a scene-linear image.
import { CustomToneMapping } from "three";
import { clamp, dot, exp, log, mat3, max, mix, step, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

export interface IFilmicCurve {
  readonly slope: number;
  readonly toe: number;
  readonly shoulder: number;
  readonly blackClip: number;
  readonly whiteClip: number;
}

/** Unreal 5.8.3 project defaults. Change these numbers to change the curve. */
export const FILMIC_CURVE: IFilmicCurve = {
  slope: 0.88,
  toe: 0.55,
  shoulder: 0.26,
  blackClip: 0,
  whiteClip: 0.04,
};

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

// Linear sRGB (D65) <-> ACEScg (AP1, D60) with a Bradford adaptation, row-major.
const SRGB_TO_AP1: Mat3 = [
  0.6130974024, 0.3395231462, 0.0473794514, 0.0701937225, 0.9163538791, 0.0134523985, 0.0206155929,
  0.1095697729, 0.8698146342,
];
const AP1_TO_SRGB: Mat3 = [
  1.7050509927, -0.6217921207, -0.083258872, -0.1302564175, 1.1408047366, -0.0105483191,
  -0.0240033568, -0.1289689761, 1.1529723329,
];
const AP1_LUMA: Vec3 = [0.2722287168, 0.6740817658, 0.0536895174];
const PRE_SATURATION = 0.96;
const POST_SATURATION = 0.93;
const MID_GREY = 0.18;
const LOG10 = Math.log(10);

/** The constants the curve needs, derived once from the five parameters. */
function curveMatches(c: IFilmicCurve): {
  toeScale: number;
  shoulderScale: number;
  toeMatch: number;
  shoulderMatch: number;
  straightMatch: number;
} {
  const toeScale = 1 + c.blackClip - c.toe;
  const shoulderScale = 1 + c.whiteClip - c.shoulder;
  const logMid = Math.log10(MID_GREY);
  let toeMatch: number;
  if (c.toe > 0.8) {
    // A toe this long never reaches the straight segment through mid grey from below.
    toeMatch = (1 - c.toe - MID_GREY) / c.slope + logMid;
  } else {
    const bt = (MID_GREY + c.blackClip) / toeScale - 1;
    toeMatch = logMid - 0.5 * Math.log((1 + bt) / (1 - bt)) * (toeScale / c.slope);
  }
  const straightMatch = (1 - c.toe) / c.slope - toeMatch;
  const shoulderMatch = c.shoulder / c.slope - straightMatch;
  return { toeScale, shoulderScale, toeMatch, shoulderMatch, straightMatch };
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** One AP1 channel through the curve. Input is scene-linear, output is display-linear. */
export function filmicCurve(value: number, c: IFilmicCurve = FILMIC_CURVE): number {
  const m = curveMatches(c);
  const logValue = Math.log10(Math.max(value, 1e-10));
  const straight = c.slope * (logValue + m.straightMatch);
  const toe =
    logValue < m.toeMatch
      ? -c.blackClip +
        (2 * m.toeScale) / (1 + Math.exp((-2 * c.slope * (logValue - m.toeMatch)) / m.toeScale))
      : straight;
  const shoulder =
    logValue > m.shoulderMatch
      ? 1 +
        c.whiteClip -
        (2 * m.shoulderScale) /
          (1 + Math.exp((2 * c.slope * (logValue - m.shoulderMatch)) / m.shoulderScale))
      : straight;
  let t = Math.min(1, Math.max(0, (logValue - m.toeMatch) / (m.shoulderMatch - m.toeMatch)));
  if (m.shoulderMatch < m.toeMatch) t = 1 - t;
  return toe + (shoulder - toe) * smooth(t);
}

function multiply(m: Mat3, v: Vec3): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function saturate(v: Vec3, amount: number): [number, number, number] {
  const y = v[0] * AP1_LUMA[0] + v[1] * AP1_LUMA[1] + v[2] * AP1_LUMA[2];
  return [y + (v[0] - y) * amount, y + (v[1] - y) * amount, y + (v[2] - y) * amount];
}

/** Scene-linear sRGB in, display-linear sRGB out (before the sRGB transfer), on plain numbers. */
export function filmicToneMap(
  rgb: readonly [number, number, number],
  exposure = 1,
  c: IFilmicCurve = FILMIC_CURVE,
): [number, number, number] {
  const [r, g, b] = rgb.map((v) => Math.max(0, v * exposure)) as unknown as Vec3;
  const pre = saturate(multiply(SRGB_TO_AP1, [r, g, b]), PRE_SATURATION);
  const toned = saturate(
    [filmicCurve(pre[0], c), filmicCurve(pre[1], c), filmicCurve(pre[2], c)],
    POST_SATURATION,
  );
  const [x, y, z] = multiply(AP1_TO_SRGB, toned);
  const unit = (v: number): number => Math.min(1, Math.max(0, v));
  return [unit(x), unit(y), unit(z)];
}

/** The same curve as a TSL tone-mapping function, `(color, exposure) => color`. */
export function filmicToneMappingNode(
  c: IFilmicCurve = FILMIC_CURVE,
): (color: Node<"vec3">, exposure: Node<"float">) => Node<"vec3"> {
  const m = curveMatches(c);
  // mat3 takes columns, so the row-major tables go in transposed.
  const column = (r: Mat3) => mat3(r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]);
  const toAp1 = column(SRGB_TO_AP1);
  const toSrgb = column(AP1_TO_SRGB);
  const luma = vec3(...AP1_LUMA);
  return (color, exposure) => {
    const ap1 = toAp1.mul(max(color.mul(exposure), vec3(0)));
    const pre = mix(vec3(dot(ap1, luma)), ap1, PRE_SATURATION);
    const logValue = log(max(pre, vec3(1e-10))).div(LOG10);
    const straight = logValue.add(m.straightMatch).mul(c.slope);
    const toeCurve = vec3(-c.blackClip).add(
      vec3(2 * m.toeScale).div(
        exp(logValue.sub(m.toeMatch).mul((-2 * c.slope) / m.toeScale)).add(1),
      ),
    );
    const shoulderCurve = vec3(1 + c.whiteClip).sub(
      vec3(2 * m.shoulderScale).div(
        exp(logValue.sub(m.shoulderMatch).mul((2 * c.slope) / m.shoulderScale)).add(1),
      ),
    );
    // Per channel: the sigmoid below the toe match, the line above it; and the mirror for the
    // shoulder. step() is the vector form of the comparison; mix() takes only a scalar weight.
    const blend = (a: Node<"vec3">, b: Node<"vec3">, w: Node<"vec3">) => a.add(b.sub(a).mul(w));
    const toe = blend(toeCurve, straight, step(vec3(m.toeMatch), logValue));
    const shoulder = blend(straight, shoulderCurve, step(vec3(m.shoulderMatch), logValue));
    const linear = clamp(logValue.sub(m.toeMatch).div(m.shoulderMatch - m.toeMatch), 0, 1);
    const t = m.shoulderMatch < m.toeMatch ? linear.oneMinus() : linear;
    const toned = blend(toe, shoulder, t.mul(t).mul(t.mul(-2).add(3)));
    const post = mix(vec3(dot(toned, luma)), toned, POST_SATURATION);
    return clamp(toSrgb.mul(post), 0, 1);
  };
}

/**
 * Registers the curve with a WebGPU renderer and returns the tone-mapping constant to assign.
 * A renderer without a node library (the WebGL fallback) keeps ACES and says so.
 */
export function installFilmicToneMapping(
  raw: unknown,
  c: IFilmicCurve = FILMIC_CURVE,
): number | undefined {
  const library = (raw as { library?: { addToneMapping?(node: unknown, mode: number): void } })
    .library;
  if (library?.addToneMapping === undefined) return undefined;
  library.addToneMapping(filmicToneMappingNode(c), CustomToneMapping);
  return CustomToneMapping;
}
