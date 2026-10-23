// The tone curve of a fresh Unreal Engine 5.8.3 project, the default tone mapping of `createRenderer`
// (owner exception to "never own the look", 2026-10-22). The harness keeps a copy while its lanes tune
// the look (`scripts/unreal-look/scaffold/render/tonemap.ts`); this file is the engine's.
//
// Filmic curve with the parameters and defaults of a fresh Unreal Engine 5 project:
// slope 0.88, toe 0.55, shoulder 0.26, black clip 0, white clip 0.04 (Unreal 5.8.3,
// `Engine/Source/Runtime/Engine/Private/Scene.cpp:440-448`). Written from the published shape,
// not from Unreal code: each channel, in the ACEScg (AP1) primaries, follows a straight line in
// log10 space through mid grey (0.18 in, 0.18 out), and two sigmoids replace the line below the
// toe and above the shoulder. A small desaturation before and after keeps saturated highlights
// from shifting hue, as the ACES reference rendering does.
//
// Before the curve, as in Unreal's colour LUT, bright saturated colour is expanded toward a wider
// gamut (`expandGamut`, 1 by default) and the blue correction runs (`blueCorrection`, 0.6).
// `filmicToneMap()` is the same curve on plain numbers, so a test or a capture script can apply it
// to a scene-linear image.
import { CustomToneMapping, Matrix3 } from "three";
import {
  abs,
  atan,
  clamp,
  dot,
  exp,
  exp2,
  float,
  log,
  max,
  min,
  mix,
  pow,
  screenCoordinate,
  sign,
  sqrt,
  step,
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";

export interface IFilmicCurve {
  readonly slope: number;
  readonly toe: number;
  readonly shoulder: number;
  readonly blackClip: number;
  readonly whiteClip: number;
  readonly blueCorrection: number;
  /**
   * Unreal's "Expand Gamut" (1 in a fresh project, `Engine/Source/Runtime/Engine/Private/Scene.cpp:437`): bright,
   * saturated colour is pushed toward a wider gamut before the blue correction and the curve. 0 turns it off.
   * Unreal's linear EXR frames are taken after this step (`Engine/Shaders/Private/PostProcessCombineLUTs.usf`,
   * the expansion runs before the output-device branches), so a curve applied to an Unreal EXR needs 0 here.
   */
  readonly expandGamut: number;
  /**
   * The ACES reference rendering's glow, which Unreal keeps in its filmic curve (`Engine/Shaders/Private/TonemapCommon.ush`):
   * dark, saturated colour gets up to 5% brighter. 1 is Unreal's amount, 0 turns it off.
   */
  readonly glow: number;
  /**
   * The ACES reference rendering's red modifier, also in Unreal's filmic curve: the red of a saturated red is pulled
   * toward a dark pivot, up to 18%. 1 is Unreal's amount, 0 turns it off.
   */
  readonly redModifier: number;
  /**
   * Output dither in 8-bit steps: triangular grain added to the display colour before the backbuffer rounds it.
   * Unreal 5.8.3 uses one step for an 8-bit backbuffer, so a dim gradient reads as grain of one level instead of
   * contour bands. 0 turns it off. Only the tone-mapping node dithers; `filmicToneMap()` stays noise-free.
   */
  readonly dither: number;
  /**
   * The largest scene-linear value, after exposure, that one channel can hold when the colour goes into Unreal's
   * colour LUT (the top of its 14-stop log shaper, `Engine/Shaders/Private/GammaCorrectionCommon.ush`: `LogToLin(1)`
   * minus `LogToLin(0)`). A channel above it is clipped there, so the sun disc and a hot emitter lose their hue
   * earlier than an unbounded curve would. 0, the default, leaves the channel unbounded; pass `LUT_CLIP` for Unreal's.
   */
  readonly lutClip: number;
}

// Unreal's log shaper: 14 stops about mid grey 0.18, grey at code 444 of 1023.
/** Unreal's LUT channel clip, 43.7. Off by default (it moves hot-emitter pixels); `filmicCurve: { lutClip: LUT_CLIP }` turns it on. */
export const LUT_CLIP = 2 ** ((1 - 444 / 1023) * 14) * 0.18 - 2 ** ((-444 / 1023) * 14) * 0.18;

/** Unreal 5.8.3 project defaults. Change these numbers to change the curve. */
export const FILMIC_CURVE: IFilmicCurve = {
  slope: 0.88,
  toe: 0.55,
  shoulder: 0.26,
  blackClip: 0,
  whiteClip: 0.04,
  blueCorrection: 0.6,
  expandGamut: 1,
  glow: 1,
  redModifier: 1,
  dither: 1,
  lutClip: 0,
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
// Standard published ACES AP0 -> AP1 matrix (both D60), row-major.
const AP0_TO_AP1 = new Matrix3().set(
  1.4514393161,
  -0.2365107469,
  -0.2149285693,
  -0.0765537734,
  1.1762296998,
  -0.0996759264,
  0.0083161484,
  -0.0060324498,
  0.9977163014,
);
// ACES LMT Blue Light Artifact Fix, (c) Academy of Motion Picture Arts and Sciences, ACES licence
// ampas/aces-dev v1.3.1, transforms/ctl/lmt/LMT.Academy.BlueLightArtifactFix.ctl.
// Transposed from CTL's row-vector matrix for M*v here.
/*
# License Terms for Academy Color Encoding System Components #

Academy Color Encoding System (ACES) software and tools are provided by the
Academy under the following terms and conditions: A worldwide, royalty-free,
non-exclusive right to copy, modify, create derivatives, and use, in source and
binary forms, is hereby granted, subject to acceptance of this license.

Copyright © 2015 Academy of Motion Picture Arts and Sciences (A.M.P.A.S.).
Portions contributed by others as indicated. All rights reserved.

Performance of any of the aforementioned acts indicates acceptance to be bound
by the following terms and conditions:

* Copies of source code, in whole or in part, must retain the above copyright
notice, this list of conditions and the Disclaimer of Warranty.

* Use in binary form must retain the above copyright notice, this list of
conditions and the Disclaimer of Warranty in the documentation and/or other
materials provided with the distribution.

* Nothing in this license shall be deemed to grant any rights to trademarks,
copyrights, patents, trade secrets or any other intellectual property of
A.M.P.A.S. or any contributors, except as expressly stated herein.

* Neither the name "A.M.P.A.S." nor the name of any other contributors to this
software may be used to endorse or promote products derivative of or based on
this software without express prior written permission of A.M.P.A.S. or the
contributors, as appropriate.

This license shall be construed pursuant to the laws of the State of
California, and any disputes related thereto shall be subject to the
jurisdiction of the courts therein.

Disclaimer of Warranty: THIS SOFTWARE IS PROVIDED BY A.M.P.A.S. AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
NON-INFRINGEMENT ARE DISCLAIMED. IN NO EVENT SHALL A.M.P.A.S., OR ANY
CONTRIBUTORS OR DISTRIBUTORS, BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, RESITUTIONARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

WITHOUT LIMITING THE GENERALITY OF THE FOREGOING, THE ACADEMY SPECIFICALLY
DISCLAIMS ANY REPRESENTATIONS OR WARRANTIES WHATSOEVER RELATED TO PATENT OR
OTHER INTELLECTUAL PROPERTY RIGHTS IN THE ACADEMY COLOR ENCODING SYSTEM, OR
APPLICATIONS THEREOF, HELD BY PARTIES OTHER THAN A.M.P.A.S.,WHETHER DISCLOSED OR
UNDISCLOSED.
*/
const blueAP0 = new Matrix3().set(
  0.9404372683,
  -0.0183068787,
  0.0778696104,
  0.0083786969,
  0.8286599939,
  0.1629613092,
  0.0005471261,
  -0.0008833746,
  1.0003362486,
);
const blueAP1 = AP0_TO_AP1.clone().multiply(blueAP0).multiply(AP0_TO_AP1.clone().invert());
// Transpose only for serialization: Matrix3 stores columns, apply()/multiply() consume rows.
export const BLUE_CORRECTION_AP1 = blueAP1.clone().transpose().toArray() as Mat3;
export const BLUE_CORRECTION_INVERSE_AP1 = blueAP1.clone().invert().transpose().toArray() as Mat3;

// The glow and the red modifier of the ACES reference rendering (ACES licence as above, ampas/aces-dev
// v1.3.1, transforms/ctl/rrt/RRT.ctl). Unreal keeps both in its filmic curve: they run in AP0 after the
// blue correction and before the desaturation (`Engine/Shaders/Private/TonemapCommon.ush`). The glow
// lifts saturated colour that is dark; the red modifier pulls the red channel of a saturated red toward
// a pivot, by a weight that is 1 at red and 0 half the width away. The gain, mid level, scale, pivot and
// width are the published ACES numbers. Without them Unreal's red box is 5 to 7 levels off on red.
const GLOW_GAIN = 0.05;
const GLOW_MID = 0.08;
const RED_SCALE = 0.82;
const RED_PIVOT = 0.03;
const RED_WIDTH = (135 * Math.PI) / 180;
const AP0_TO_AP1_ROWS = AP0_TO_AP1.clone().transpose().toArray() as Mat3;
const AP1_TO_AP0 = AP0_TO_AP1.clone().invert().transpose().toArray() as Mat3;

/** The red modifier's weight at a hue, in radians from red: 1 at red, 0 at half the width away and beyond. */
export function redModifierWeight(hue: number): number {
  const edge = Math.min(1, Math.max(0, 1 - Math.abs((2 * hue) / RED_WIDTH)));
  return (edge * edge * (3 - 2 * edge)) ** 2;
}

/** The glow and the red modifier on one AP1 colour; `glow` and `red` scale their amounts (1 is Unreal's). */
function glowAndRed(ap1: Vec3, glow: number, red: number): [number, number, number] {
  const [r, g, b] = multiply(AP1_TO_AP0, ap1);
  const high = Math.max(r, g, b);
  const saturation =
    (Math.max(high, 1e-10) - Math.max(Math.min(r, g, b), 1e-10)) / Math.max(high, 1e-2);
  const spread = 0.5 * ((r - g) ** 2 + (g - b) ** 2 + (b - r) ** 2);
  const brightness = (r + g + b + 1.75 * Math.sqrt(spread)) / 3;
  const x = (saturation - 0.4) / 0.2;
  const tail = Math.max(1 - Math.abs(x / 2), 0);
  const shaper = (1 + Math.sign(x) * (1 - tail * tail)) / 2;
  const fade = Math.min(1, Math.max(0, GLOW_MID / Math.max(brightness, 1e-10) - 0.5));
  const lift = 1 + glow * GLOW_GAIN * shaper * fade;
  const [lr, lg, lb] = [r * lift, g * lift, b * lift];
  const hue = Math.atan2(Math.sqrt(3) * (lg - lb), 2 * lr - lg - lb);
  const pulled =
    lr + red * redModifierWeight(hue) * saturation * (RED_PIVOT - lr) * (1 - RED_SCALE);
  return multiply(AP0_TO_AP1_ROWS, [pulled, lg, lb]);
}

// Gamut expansion, in AP1 -> AP1: the sRGB gamut re-expressed in a wider set of primaries (CIE xy
// red 0.6965 0.3065, green 0.245 0.718, blue 0.1302 0.0456, white 0.3127 0.329), between P3 and
// AP1. It is what Unreal's colour LUT mixes in by `expandAmount()`. The matrix takes AP1 to sRGB,
// reads those numbers as numbers in the wide primaries and carries them to AP1; all of it follows
// from the chromaticities, and the spec derives it again to 1e-6. Without it the clear sky carries
// a red excess against the Unreal L2 frames (PRD-632).
export const EXPAND_AP1: Mat3 = [
  1.370412273, -0.329292155, -0.063683161, -0.083433332, 1.097092614, -0.010861358, -0.025793271,
  -0.098625844, 1.203694898,
];

/**
 * How much of the expansion a colour gets: more for saturated colour, and for brighter colour
 * (luminance squared), none for grey. `chroma` is the colour over its luminance.
 */
export function expandAmount(chromaDistanceSquared: number, luma: number, gamut: number): number {
  return (1 - 2 ** (-4 * chromaDistanceSquared)) * (1 - 2 ** (-4 * gamut * luma * luma));
}

const AP1_LUMA: Vec3 = [0.2722287168, 0.6740817658, 0.0536895174];

function expandAp1(ap1: Vec3, gamut: number): Vec3 {
  const luma = ap1[0] * AP1_LUMA[0] + ap1[1] * AP1_LUMA[1] + ap1[2] * AP1_LUMA[2];
  if (luma <= 0) return ap1;
  const d2 = ap1.reduce((sum, v) => sum + (v / luma - 1) ** 2, 0);
  const amount = expandAmount(d2, luma, gamut);
  const wide = multiply(EXPAND_AP1, ap1);
  return ap1.map((v, i) => v + ((wide[i] ?? 0) - v) * amount) as number[] & Vec3;
}

/** The gamut expansion alone, scene-linear sRGB in and out (negative results clip to zero). */
export function expandGamutLinear(
  rgb: readonly [number, number, number],
  gamut = FILMIC_CURVE.expandGamut,
): [number, number, number] {
  const [x, y, z] = multiply(AP1_TO_SRGB, expandAp1(multiply(SRGB_TO_AP1, rgb), gamut));
  return [Math.max(0, x), Math.max(0, y), Math.max(0, z)];
}
const PRE_SATURATION = 0.96;
const POST_SATURATION = 0.93;
const MID_GREY = 0.18;
const LOG10 = Math.log(10);

/** The constants the curve needs, derived once from its shape parameters. */
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

function correctBlue(v: Vec3, matrix: Mat3, amount: number): [number, number, number] {
  const corrected = multiply(matrix, v);
  return [
    v[0] + (corrected[0] - v[0]) * amount,
    v[1] + (corrected[1] - v[1]) * amount,
    v[2] + (corrected[2] - v[2]) * amount,
  ];
}

function saturate(v: Vec3, amount: number): [number, number, number] {
  const y = v[0] * AP1_LUMA[0] + v[1] * AP1_LUMA[1] + v[2] * AP1_LUMA[2];
  return [y + (v[0] - y) * amount, y + (v[1] - y) * amount, y + (v[2] - y) * amount];
}

const at = (v: readonly number[], i: number): number => v[i] ?? 0;
/** Red, green, blue and a master factor, as Unreal's colour grading panel shows each control. */
export type Vec4 = readonly [number, number, number, number];

/** One set of Unreal's colour grading controls. */
export interface IGradeControls {
  readonly saturation: Vec4;
  readonly contrast: Vec4;
  readonly gamma: Vec4;
  readonly gain: Vec4;
  readonly offset: Vec4;
}

/**
 * Unreal's colour grading and white balance, run in the combined LUT before the film curve
 * (`Engine/Shaders/Private/PostProcessCombineLUTs.usf:88-140` and `:369-403`; defaults in
 * `Engine/Source/Runtime/Engine/Private/Scene.cpp:405-433`). Every default below is Unreal's, and at the
 * defaults none of it costs a shader instruction.
 */
export interface IColorGrade {
  /** Kelvin, 1500 to 15000. 6500 with tint 0 is a no-op. */
  readonly whiteTemp: number;
  /** -1 to 1 along the isotherm. */
  readonly whiteTint: number;
  /**
   * `"whiteBalance"`: the temperature is the light the scene was lit by, and it turns neutral.
   * `"colorTemperature"`: neutral turns into that temperature.
   */
  readonly temperatureMode: "whiteBalance" | "colorTemperature";
  /** 1 is the full film curve, 0 the graded colour with no curve. */
  readonly toneCurveAmount: number;
  /** Applied to every pixel, and combined with each range below. */
  readonly global: IGradeControls;
  readonly shadows: IGradeControls;
  readonly midtones: IGradeControls;
  readonly highlights: IGradeControls;
  /** Luma (AP1) up to which the shadows range has full weight, fading out by here. */
  readonly shadowsMax: number;
  /** Luma where the highlights range starts and where it has full weight. */
  readonly highlightsMin: number;
  readonly highlightsMax: number;
}

const ONES: Vec4 = [1, 1, 1, 1];
const ZEROS: Vec4 = [0, 0, 0, 0];
const NEUTRAL_CONTROLS: IGradeControls = {
  saturation: ONES,
  contrast: ONES,
  gamma: ONES,
  gain: ONES,
  offset: ZEROS,
};

/** Unreal 5.8.3 project defaults: a neutral grade. */
export const COLOR_GRADE: IColorGrade = {
  whiteTemp: 6500,
  whiteTint: 0,
  temperatureMode: "whiteBalance",
  toneCurveAmount: 1,
  global: NEUTRAL_CONTROLS,
  shadows: NEUTRAL_CONTROLS,
  midtones: NEUTRAL_CONTROLS,
  highlights: NEUTRAL_CONTROLS,
  shadowsMax: 0.09,
  highlightsMin: 0.5,
  highlightsMax: 1,
};

type RangeName = "global" | "shadows" | "midtones" | "highlights";
const RANGES: readonly RangeName[] = ["global", "shadows", "midtones", "highlights"];
const CONTROLS = ["saturation", "contrast", "gamma", "gain", "offset"] as const;

/** What a game passes: any field, and any control of a range. */
export type ColorGradeOptions = {
  readonly [K in keyof IColorGrade]?: K extends RangeName
    ? Partial<IGradeControls>
    : IColorGrade[K];
};

/** Refuses a value Unreal's panel would not allow. */
function validateGrade(g: IColorGrade): void {
  if (!(g.whiteTemp >= 1500 && g.whiteTemp <= 15000)) {
    throw new Error(`colorGrade.whiteTemp must be 1500 to 15000 K, got ${g.whiteTemp}.`);
  }
  if (!(Math.abs(g.whiteTint) <= 1))
    throw new Error(`colorGrade.whiteTint must be -1 to 1, got ${g.whiteTint}.`);
  if (g.temperatureMode !== "whiteBalance" && g.temperatureMode !== "colorTemperature") {
    throw new Error(`colorGrade.temperatureMode must be "whiteBalance" or "colorTemperature".`);
  }
  if (!(g.toneCurveAmount >= 0 && g.toneCurveAmount <= 1)) {
    throw new Error(`colorGrade.toneCurveAmount must be 0 to 1, got ${g.toneCurveAmount}.`);
  }
  if (!(g.shadowsMax > 0) || !(g.highlightsMin < g.highlightsMax)) {
    throw new Error("colorGrade needs shadowsMax > 0 and highlightsMin < highlightsMax.");
  }
}

/** Fills the defaults and refuses a malformed control, so a typo cannot pass as a neutral grade. */
export function resolveColorGrade(options: ColorGradeOptions = {}): IColorGrade {
  const out: Record<string, unknown> = { ...COLOR_GRADE, ...options };
  for (const range of RANGES) {
    const given = (options[range] ?? {}) as Partial<IGradeControls>;
    const merged: Record<string, Vec4> = {};
    for (const name of CONTROLS) {
      const v = given[name] ?? NEUTRAL_CONTROLS[name];
      if (v.length !== 4 || !v.every(Number.isFinite)) {
        throw new Error(
          `colorGrade.${range}.${name} needs [red, green, blue, master], got ${JSON.stringify(v)}.`,
        );
      }
      merged[name] = v;
    }
    out[range] = merged;
  }
  const g = out as Record<string, unknown> & IColorGrade;
  validateGrade(g);
  return g;
}

const same = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => v === b[i]);
const neutralControls = (k: IGradeControls): boolean =>
  CONTROLS.every((name) => same(k[name], NEUTRAL_CONTROLS[name]));
const whiteBalanceActive = (g: IColorGrade): boolean =>
  Math.abs(g.whiteTemp - 6500) > 1e-8 || Math.abs(g.whiteTint) > 1e-8;
const gradingActive = (g: IColorGrade): boolean => RANGES.some((r) => !neutralControls(g[r]));
const rangesActive = (g: IColorGrade): boolean =>
  !neutralControls(g.shadows) || !neutralControls(g.midtones) || !neutralControls(g.highlights);

/** True when the grade changes nothing, so the tone node emits no grade instruction. */
export function colorGradeIsIdentity(g: IColorGrade): boolean {
  return !whiteBalanceActive(g) && !gradingActive(g) && g.toneCurveAmount === 1;
}

// ---- White balance: Planckian locus below 4000 K, daylight locus above, Bradford adaptation. ----
const SRGB_TO_XYZ: Mat3 = [
  0.4123907993, 0.3575843394, 0.1804807884, 0.2126390059, 0.7151686788, 0.0721923154, 0.0193308187,
  0.1191947798, 0.9505321522,
];
const XYZ_TO_SRGB: Mat3 = [
  3.2409699419, -1.5373831776, -0.4986107603, -0.9692436363, 1.8759675015, 0.0415550574,
  0.0556300797, -0.2039769589, 1.0569715142,
];
const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INVERSE: Mat3 = [
  0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428,
  0.9684867,
];
const D65_XY: readonly [number, number] = [0.3127, 0.329];

function matMul(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out.push(
        at(a, r * 3) * at(b, c) + at(a, r * 3 + 1) * at(b, 3 + c) + at(a, r * 3 + 2) * at(b, 6 + c),
      );
    }
  }
  return out as number[] & Mat3;
}

/** Krystek's rational fit of the Planckian locus in CIE 1960 (u, v) [Krystek 1985], 1000 to 15000 K. */
function planckianUv(t: number): [number, number] {
  const u =
    (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) /
    (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
  const v =
    (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) /
    (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
  return [u, v];
}

function uvToXy([u, v]: readonly [number, number]): [number, number] {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
}

/** CIE daylight locus chromaticity. The 1.4388 / 1.438 factor corrects Planck's constant, so 6500 K is D65. */
function daylightXy(kelvin: number): [number, number] {
  const inv = 1 / (kelvin * (1.4388 / 1.438));
  const x =
    kelvin * (1.4388 / 1.438) <= 7000
      ? 0.244063 + (0.09911e3 + (2.9678e6 - 4.607e9 * inv) * inv) * inv
      : 0.23704 + (0.24748e3 + (1.9018e6 - 2.0064e9 * inv) * inv) * inv;
  return [x, -3 * x * x + 2.87 * x - 0.275];
}

/** The Planckian chromaticity moved along its isotherm by `tint`, up to 0.05 in (u, v). */
function isothermXy(t: number, tint: number): [number, number] {
  const [u, v] = planckianUv(t);
  const ud =
    (-1.13758118e9 - 1.91615621e6 * t - 1.53177 * t * t) /
    (1.41213984e6 + 1189.62 * t + t * t) ** 2;
  const vd =
    (1.97471536e9 - 705674 * t - 308.607 * t * t) / (6.19363586e6 - 179.456 * t + t * t) ** 2;
  const n = Math.hypot(ud, vd);
  return uvToXy([u + (vd / n) * tint * 0.05, v - (ud / n) * tint * 0.05]);
}

/** The 3x3 on scene-linear sRGB that Unreal's white balance applies (Bradford von Kries). */
export function whiteBalanceMatrix(g: IColorGrade): Mat3 {
  const locus = uvToXy(planckianUv(g.whiteTemp));
  const white = g.whiteTemp < 4000 ? locus : daylightXy(g.whiteTemp);
  const iso = isothermXy(g.whiteTemp, g.whiteTint);
  const lit: [number, number] = [white[0] + iso[0] - locus[0], white[1] + iso[1] - locus[1]];
  const [from, to] = g.temperatureMode === "whiteBalance" ? [lit, D65_XY] : [D65_XY, lit];
  const cone = (xy: readonly [number, number]): Vec3 =>
    multiply(BRADFORD, [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]]);
  const [a, b] = [cone(from), cone(to)];
  const scale: Mat3 = [b[0] / a[0], 0, 0, 0, b[1] / a[1], 0, 0, 0, b[2] / a[2]];
  return matMul(
    XYZ_TO_SRGB,
    matMul(BRADFORD_INVERSE, matMul(scale, matMul(BRADFORD, SRGB_TO_XYZ))),
  );
}

// ---- Colour grading, in AP1 (Nuke-style, shadows / midtones / highlights by luma). ----
interface IEffective {
  readonly saturation: Vec3;
  readonly contrast: Vec3;
  readonly gamma: Vec3;
  readonly gain: Vec3;
  readonly offset: Vec3;
}
const channels = (f: (i: number) => number): Vec3 => [f(0), f(1), f(2)];

/** One range with the global controls: vectors multiply (master included), offsets add. */
function effective(range: IGradeControls, global: IGradeControls): IEffective {
  const product = (name: "saturation" | "contrast" | "gamma" | "gain"): Vec3 => {
    const w = range[name][3] * global[name][3];
    return channels((i) => at(range[name], i) * at(global[name], i) * w);
  };
  const offset = range.offset[3] + global.offset[3];
  return {
    saturation: product("saturation"),
    contrast: product("contrast"),
    gamma: product("gamma"),
    gain: product("gain"),
    offset: channels((i) => at(range.offset, i) + at(global.offset, i) + offset),
  };
}

const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
const ap1Luma = (v: Vec3): number => v[0] * AP1_LUMA[0] + v[1] * AP1_LUMA[1] + v[2] * AP1_LUMA[2];

function correct(v: Vec3, e: IEffective): Vec3 {
  const y = ap1Luma(v);
  return channels((i) => {
    const saturated = Math.max(0, y + (at(v, i) - y) * at(e.saturation, i));
    const contrasted = Math.max(saturated / MID_GREY, 1e-10) ** at(e.contrast, i) * MID_GREY;
    return contrasted ** (1 / at(e.gamma, i)) * at(e.gain, i) + at(e.offset, i);
  });
}

function correctAll(v: Vec3, g: IColorGrade): Vec3 {
  if (!rangesActive(g)) return correct(v, effective(g.global, NEUTRAL_CONTROLS));
  const y = ap1Luma(v);
  const shadows = 1 - smoothstep(0, g.shadowsMax, y);
  const highlights = smoothstep(g.highlightsMin, g.highlightsMax, y);
  const s = correct(v, effective(g.shadows, g.global));
  const m = correct(v, effective(g.midtones, g.global));
  const h = correct(v, effective(g.highlights, g.global));
  return channels(
    (i) => at(s, i) * shadows + at(m, i) * (1 - shadows - highlights) + at(h, i) * highlights,
  );
}

/** Scene-linear sRGB in, display-linear sRGB out (before the sRGB transfer), on plain numbers. */
export function filmicToneMap(
  rgb: readonly [number, number, number],
  exposure = 1,
  c: IFilmicCurve = FILMIC_CURVE,
  grade: IColorGrade = COLOR_GRADE,
): [number, number, number] {
  const exposed = rgb.map((v) => Math.max(0, v * exposure)) as number[] & Vec3;
  const lit =
    c.lutClip > 0 ? (exposed.map((v) => Math.min(v, c.lutClip)) as number[] & Vec3) : exposed;
  const balanced = whiteBalanceActive(grade) ? multiply(whiteBalanceMatrix(grade), lit) : lit;
  let ap1: Vec3 = multiply(SRGB_TO_AP1, balanced);
  // Order: Engine/Shaders/Private/PostProcessCombineLUTs.usf and TonemapCommon.ush.
  if (c.expandGamut !== 0) ap1 = expandAp1(ap1, c.expandGamut);
  if (gradingActive(grade)) ap1 = correctAll(ap1, grade);
  if (c.blueCorrection !== 0) ap1 = correctBlue(ap1, BLUE_CORRECTION_AP1, c.blueCorrection);
  const corrected = ap1;
  if (c.glow !== 0 || c.redModifier !== 0) ap1 = glowAndRed(ap1, c.glow, c.redModifier);
  const pre = saturate(ap1.map((v) => Math.max(0, v)) as number[] & Vec3, PRE_SATURATION);
  let toned: Vec3 = saturate(
    [filmicCurve(pre[0], c), filmicCurve(pre[1], c), filmicCurve(pre[2], c)],
    POST_SATURATION,
  );
  if (grade.toneCurveAmount !== 1) {
    toned = channels(
      (i) => at(corrected, i) + (at(toned, i) - at(corrected, i)) * grade.toneCurveAmount,
    );
  }
  const restored =
    c.blueCorrection === 0
      ? toned
      : correctBlue(toned, BLUE_CORRECTION_INVERSE_AP1, c.blueCorrection);
  const [x, y, z] = multiply(AP1_TO_SRGB, restored);
  const unit = (v: number): number => Math.min(1, Math.max(0, v));
  return [unit(x), unit(y), unit(z)];
}

/** One 8-bit step of display value. */
const EIGHT_BIT_STEP = 1 / 255;
const blend3 = (a: Node<"vec3">, b: Node<"vec3">, w: Node<"vec3">) => a.add(b.sub(a).mul(w));
const toDisplay = (c: Node<"vec3">) =>
  blend3(
    c.mul(12.92),
    c
      .pow(1 / 2.4)
      .mul(1.055)
      .sub(0.055),
    step(vec3(0.0031308), c),
  );
const toLinear = (v: Node<"vec3">) =>
  blend3(v.div(12.92), v.add(0.055).div(1.055).pow(2.4), step(vec3(0.04045), v));

/**
 * Triangular grain, `steps` 8-bit steps wide, added in display space. Unreal 5.8.3 does this to its 8-bit output
 * (`Engine/Shaders/Private/PostProcessTonemap.usf`, scaled by `BackbufferQuantizationDithering` in
 * `Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessTonemap.cpp`). The pipeline applies the sRGB
 * transfer after this node, so the grain goes in on the display value and the result comes back to linear.
 * The shape is Unreal's triangle on [-1, 1]. The hash is white noise of the pixel position, with the sine
 * argument kept under pi. Unreal's grain moves every frame; this one stays on its pixel, so two captures of
 * one frame match bit for bit. The hash reads the pixel position: `screenUV` gave no grain in this stage on
 * the owned engine.
 */
function dithered(linear: Node<"vec3">, steps: number): Node<"vec3"> {
  const uniform = dot(screenCoordinate, vec2(12.9898, 78.233))
    .mod(Math.PI)
    .sin()
    .mul(43758.5453)
    .fract();
  // The inverse of the triangular CDF: one root for each half of the unit interval.
  const grain = mix(
    uniform.mul(2).sqrt().sub(1),
    float(1).sub(float(2).sub(uniform.mul(2)).sqrt()),
    step(0.5, uniform),
  );
  return toLinear(clamp(toDisplay(linear).add(grain.mul(steps * EIGHT_BIT_STEP)), 0, 1));
}

// One dot product per row: no row- or column-major convention to get wrong.
const applyMatrix = (m: Mat3, v: Node<"vec3">) =>
  vec3(
    dot(vec3(m[0], m[1], m[2]), v),
    dot(vec3(m[3], m[4], m[5]), v),
    dot(vec3(m[6], m[7], m[8]), v),
  );

/** The glow and the red modifier on an AP1 colour, as TSL. */
function glowAndRedNode(ap1: Node<"vec3">, c: IFilmicCurve): Node<"vec3"> {
  const apply = applyMatrix;
  // The same maths as glowAndRed() above, in AP0. The hue's x argument carries a 1e-10 so a grey stays defined.
  const ap0 = apply(AP1_TO_AP0, ap1);
  const [r, g, b] = [ap0.x, ap0.y, ap0.z];
  const high = max(max(r, g), b);
  const saturation = max(high, 1e-10)
    .sub(max(min(min(r, g), b), 1e-10))
    .div(max(high, 1e-2));
  const spread = r.mul(r).add(g.mul(g)).add(b.mul(b)).sub(r.mul(g)).sub(g.mul(b)).sub(b.mul(r));
  const brightness = r
    .add(g)
    .add(b)
    .add(sqrt(max(spread, 0)).mul(1.75))
    .div(3);
  const x = saturation.sub(0.4).div(0.2);
  const tail = max(float(1).sub(abs(x.div(2))), 0);
  const shaper = float(1)
    .add(sign(x).mul(float(1).sub(tail.mul(tail))))
    .div(2);
  const fade = clamp(float(GLOW_MID).div(max(brightness, 1e-10)).sub(0.5), 0, 1);
  const lifted = ap0.mul(
    shaper
      .mul(fade)
      .mul(c.glow * GLOW_GAIN)
      .add(1),
  );
  const hue = atan(
    lifted.y.sub(lifted.z).mul(Math.sqrt(3)),
    lifted.x.mul(2).sub(lifted.y).sub(lifted.z).add(1e-10),
  );
  const edge = clamp(float(1).sub(abs(hue.mul(2 / RED_WIDTH))), 0, 1);
  const smooth = edge.mul(edge).mul(edge.mul(-2).add(3));
  const pulled = lifted.x.add(
    smooth
      .mul(smooth)
      .mul(saturation)
      .mul(float(RED_PIVOT).sub(lifted.x))
      .mul(c.redModifier * (1 - RED_SCALE)),
  );
  return apply(AP0_TO_AP1_ROWS, vec3(pulled, lifted.y, lifted.z));
}

/** Pre-desaturation and the film curve on an AP1 colour, as TSL; the colour comes back before the post desaturation. */
function curveNode(ap1: Node<"vec3">, c: IFilmicCurve): Node<"vec3"> {
  const m = curveMatches(c);
  const luma = vec3(...AP1_LUMA);
  const pre = mix(vec3(dot(max(ap1, vec3(0)), luma)), max(ap1, vec3(0)), PRE_SATURATION);
  const logValue = log(max(pre, vec3(1e-10))).div(LOG10);
  const straight = logValue.add(m.straightMatch).mul(c.slope);
  const toeCurve = vec3(-c.blackClip).add(
    vec3(2 * m.toeScale).div(exp(logValue.sub(m.toeMatch).mul((-2 * c.slope) / m.toeScale)).add(1)),
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
  return toned;
}

/** The same curve as a TSL tone-mapping function, `(color, exposure) => color`. */
export function filmicToneMappingNode(
  c: IFilmicCurve = FILMIC_CURVE,
  grade: IColorGrade = COLOR_GRADE,
): (color: Node<"vec3">, exposure: Node<"float">) => Node<"vec3"> {
  const apply = applyMatrix;
  const luma = vec3(...AP1_LUMA);
  // The grade is constants, so every vector below is built once, and a control at its default adds no node.
  const toAp1 = whiteBalanceActive(grade)
    ? matMul(SRGB_TO_AP1, whiteBalanceMatrix(grade))
    : SRGB_TO_AP1;
  const correctNode = (v: Node<"vec3">, e: IEffective): Node<"vec3"> => {
    const y = dot(v, luma);
    const saturated = max(y.add(v.sub(y).mul(vec3(...e.saturation))), vec3(0));
    const contrasted = pow(max(saturated.div(MID_GREY), vec3(1e-10)), vec3(...e.contrast)).mul(
      MID_GREY,
    );
    return pow(contrasted, vec3(1).div(vec3(...e.gamma)))
      .mul(vec3(...e.gain))
      .add(vec3(...e.offset));
  };
  const smoothstepNode = (lo: number, hi: number, x: Node<"float">) => {
    const t = clamp(x.sub(lo).div(hi - lo), 0, 1);
    return t.mul(t).mul(t.mul(-2).add(3));
  };
  const gradeNode = (v: Node<"vec3">): Node<"vec3"> => {
    if (!rangesActive(grade)) return correctNode(v, effective(grade.global, NEUTRAL_CONTROLS));
    const y = dot(v, luma);
    const shadows = float(1).sub(smoothstepNode(0, grade.shadowsMax, y));
    const highlights = smoothstepNode(grade.highlightsMin, grade.highlightsMax, y);
    const middle = float(1).sub(shadows).sub(highlights);
    return correctNode(v, effective(grade.shadows, grade.global))
      .mul(shadows)
      .add(correctNode(v, effective(grade.midtones, grade.global)).mul(middle))
      .add(correctNode(v, effective(grade.highlights, grade.global)).mul(highlights));
  };
  return (color, exposure) => {
    let lit: Node<"vec3"> = max(color.mul(exposure), vec3(0));
    if (c.lutClip > 0) lit = min(lit, vec3(c.lutClip));
    let ap1: Node<"vec3"> = apply(toAp1, lit);
    if (c.expandGamut !== 0) {
      const luma = max(dot(ap1, vec3(...AP1_LUMA)), 1e-10);
      const chroma = ap1.div(luma).sub(1);
      const amount = float(1)
        .sub(exp2(dot(chroma, chroma).mul(-4)))
        .mul(float(1).sub(exp2(luma.mul(luma).mul(-4 * c.expandGamut))));
      ap1 = mix(ap1, apply(EXPAND_AP1, ap1), amount);
    }
    if (gradingActive(grade)) ap1 = gradeNode(ap1);
    if (c.blueCorrection !== 0) ap1 = mix(ap1, apply(BLUE_CORRECTION_AP1, ap1), c.blueCorrection);
    const corrected = ap1;
    if (c.glow !== 0 || c.redModifier !== 0) ap1 = glowAndRedNode(ap1, c);
    const toned = curveNode(ap1, c);
    const filmed = mix(vec3(dot(toned, luma)), toned, POST_SATURATION);
    const post =
      grade.toneCurveAmount === 1 ? filmed : mix(corrected, filmed, grade.toneCurveAmount);
    const restored =
      c.blueCorrection === 0
        ? post
        : mix(post, apply(BLUE_CORRECTION_INVERSE_AP1, post), c.blueCorrection);
    const display = clamp(apply(AP1_TO_SRGB, restored), 0, 1);
    return c.dither === 0 ? display : dithered(display, c.dither);
  };
}

/**
 * Registers the curve with a WebGPU renderer and returns the tone-mapping constant to assign.
 * A renderer without a node library (the WebGL fallback) keeps ACES and says so.
 */
export function installFilmicToneMapping(
  raw: unknown,
  c: IFilmicCurve = FILMIC_CURVE,
  grade: IColorGrade = COLOR_GRADE,
): number | undefined {
  const library = (raw as { library?: { addToneMapping?(node: unknown, mode: number): void } })
    .library;
  if (library?.addToneMapping === undefined) return undefined;
  library.addToneMapping(filmicToneMappingNode(c, grade), CustomToneMapping);
  return CustomToneMapping;
}
