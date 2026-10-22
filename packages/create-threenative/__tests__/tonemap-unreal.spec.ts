import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

// PRD-632 Phase 4: the colour grade, the white balance, the tone curve amount and the colour LUT
// domain of Unreal's combined LUT (`Engine/Shaders/Private/PostProcessCombineLUTs.usf`), checked
// against plain-number references written here from the same equations. The overlay has no
// node_modules, so the spec bundles its real dependencies from this package.
const require = createRequire(import.meta.url);
const bundled = buildSync({
  entryPoints: [
    new URL("../../../scripts/unreal-look/scaffold/render/tonemap.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  alias: {
    three: require.resolve("three"),
    "three/tsl": require.resolve("three/tsl"),
    "three/webgpu": require.resolve("three/webgpu"),
  },
});

type RGB = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];
interface IControls {
  saturation: Vec4;
  contrast: Vec4;
  gamma: Vec4;
  gain: Vec4;
  offset: Vec4;
}
interface IGrade {
  whiteTemp: number;
  whiteTint: number;
  temperatureMode: "whiteBalance" | "colorTemperature";
  toneCurveAmount: number;
  global: IControls;
  shadows: IControls;
  midtones: IControls;
  highlights: IControls;
  shadowsMax: number;
  highlightsMin: number;
  highlightsMax: number;
}
interface IOverlayTonemap {
  COLOR_GRADE: IGrade;
  FILMIC_CURVE: Readonly<Record<string, number>>;
  colorGradeIsIdentity(grade: IGrade): boolean;
  filmicToneMap(
    rgb: RGB,
    exposure?: number,
    curve?: Readonly<Record<string, number>>,
    grade?: IGrade,
  ): [number, number, number];
  filmicToneMappingNode(
    curve?: unknown,
    grade?: unknown,
  ): (color: unknown, exposure: unknown) => unknown;
  resolveColorGrade(partial?: unknown): IGrade;
}
const tonemap = (await import(
  /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? "").toString("base64")}`
)) as IOverlayTonemap;
const { COLOR_GRADE, FILMIC_CURVE, colorGradeIsIdentity, filmicToneMap, resolveColorGrade } =
  tonemap;

const at = (v: readonly number[], i: number): number => v[i] ?? 0;
// ---- References, from Unreal's published matrices and equations. ----
const SRGB_TO_AP1 = [
  [0.6130974024, 0.3395231462, 0.0473794514],
  [0.0701937225, 0.9163538791, 0.0134523985],
  [0.0206155929, 0.1095697729, 0.8698146342],
];
const AP1_TO_SRGB = [
  [1.7050509927, -0.6217921207, -0.083258872],
  [-0.1302564175, 1.1408047366, -0.0105483191],
  [-0.0240033568, -0.1289689761, 1.1529723329],
];
const AP1_LUMA = [0.2722287168, 0.6740817658, 0.0536895174];
const mul = (m: number[][], v: RGB): RGB =>
  m.map((r) => at(r, 0) * v[0] + at(r, 1) * v[1] + at(r, 2) * v[2]) as unknown as RGB;
const luma = (v: RGB): number =>
  v[0] * at(AP1_LUMA, 0) + v[1] * at(AP1_LUMA, 1) + v[2] * at(AP1_LUMA, 2);
const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
const mix4 = (a: Vec4, b: Vec4): Vec4 => [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];

/** One Nuke-style correction, as the combined LUT applies it, on an AP1 colour. */
function correct(c: RGB, k: IControls): RGB {
  const y = luma(c);
  const sat = [0, 1, 2].map((i) => at(k.saturation, i) * at(k.saturation, 3));
  let out = c.map((v, i) => Math.max(0, y + (v - y) * at(sat, i))) as unknown as RGB;
  out = out.map(
    (v, i) => (v / 0.18) ** (at(k.contrast, i) * at(k.contrast, 3)) * 0.18,
  ) as unknown as RGB;
  out = out.map((v, i) => v ** (1 / (at(k.gamma, i) * at(k.gamma, 3)))) as unknown as RGB;
  return out.map(
    (v, i) => v * at(k.gain, i) * at(k.gain, 3) + at(k.offset, i) + at(k.offset, 3),
  ) as unknown as RGB;
}

/** The colour grade alone: sRGB in, AP1 graded, sRGB out, no curve. */
function gradeReference(rgb: RGB, g: IGrade): RGB {
  const ap1 = mul(SRGB_TO_AP1, rgb);
  const y = luma(ap1);
  const range = (r: IControls): IControls => ({
    saturation: mix4(r.saturation, g.global.saturation),
    contrast: mix4(r.contrast, g.global.contrast),
    gamma: mix4(r.gamma, g.global.gamma),
    gain: mix4(r.gain, g.global.gain),
    offset: r.offset.map((v, i) => v + at(g.global.offset, i)) as unknown as Vec4,
  });
  const wShadows = 1 - smoothstep(0, g.shadowsMax, y);
  const wHighlights = smoothstep(g.highlightsMin, g.highlightsMax, y);
  const wMid = 1 - wShadows - wHighlights;
  const s = correct(ap1, range(g.shadows));
  const m = correct(ap1, range(g.midtones));
  const h = correct(ap1, range(g.highlights));
  const mixed = [0, 1, 2].map(
    (i) => at(s, i) * wShadows + at(m, i) * wMid + at(h, i) * wHighlights,
  ) as unknown as RGB;
  return mul(AP1_TO_SRGB, mixed).map((v) => Math.min(1, Math.max(0, v))) as unknown as RGB;
}

const CLIP = FILMIC_CURVE.lutClip ?? 0;
// With these three off, the tone curve amount 0 leaves only the grade (and the white balance).
const NO_CURVE = { ...FILMIC_CURVE, blueCorrection: 0, expandGamut: 0, glow: 0, redModifier: 0 };
const gradeOnly = (rgb: RGB, partial: unknown, exposure = 1): RGB =>
  filmicToneMap(
    rgb,
    exposure,
    NO_CURVE,
    resolveColorGrade({ ...(partial as object), toneCurveAmount: 0 }),
  );
const near = (a: RGB, b: RGB, tolerance: number): void => {
  for (let i = 0; i < 3; i++) expect(Math.abs(at(a, i) - at(b, i))).toBeLessThan(tolerance);
};

// Colours in the shadows (luma < 0.09), the middle and the highlights (luma > 0.5).
const SAMPLES: RGB[] = [
  [0.02, 0.03, 0.015],
  [0.05, 0.02, 0.08],
  [0.2, 0.3, 0.12],
  [0.4, 0.25, 0.1],
  [0.7, 0.6, 0.5],
  [0.9, 0.95, 0.4],
];

describe("the default grade changes nothing", () => {
  // Epic head 18169a606 (before the grade existed), exposure 1: the plain-number twin of the curve.
  const GOLDEN: [RGB, RGB][] = [
    [
      [0.18, 0.18, 0.18],
      [0.18, 0.18, 0.18],
    ],
    [
      [0.002, 0.01, 0.03],
      [0, 0.001460936178, 0.009951927278],
    ],
    [
      [0.9, 0.04, 0.03],
      [0.7900582601, 0.03511277724, 0.02103911931],
    ],
    [
      [0.02, 0.05, 1.2],
      [0.02958122079, 0.09157971357, 0.7814433464],
    ],
    [
      [6, 0.3, 0.2],
      [1, 0.5052098578, 0.2820790056],
    ],
    [
      [0.3, 5, 0.3],
      [0.6555300567, 1, 0.5548267445],
    ],
    [
      [40, 3, 0.5],
      [1, 0.9667813024, 0.7143423957],
    ],
    [
      [0.5, 0.3, 0.1],
      [0.5317560379, 0.3412339782, 0.100124215],
    ],
  ];
  it("reproduces the frames of the epic head to 1e-8", () => {
    for (const [input, expected] of GOLDEN) near(filmicToneMap(input), expected, 1e-8);
  });
  it("is identity only while no control moves", () => {
    expect(colorGradeIsIdentity(COLOR_GRADE)).toBe(true);
    expect(colorGradeIsIdentity(resolveColorGrade({ whiteTemp: 6500 }))).toBe(true);
    expect(colorGradeIsIdentity(resolveColorGrade({ toneCurveAmount: 0.9 }))).toBe(false);
    expect(colorGradeIsIdentity(resolveColorGrade({ shadows: { gain: [1, 1, 1, 1.1] } }))).toBe(
      false,
    );
  });
});

describe("colour grading controls (Unreal ColorCorrect, ColorCorrectAll)", () => {
  const global = resolveColorGrade({
    global: {
      saturation: [1.1, 0.9, 1, 0.8],
      contrast: [1, 1.05, 1, 1.2],
      gamma: [1, 1, 1.1, 1.15],
      gain: [1.05, 1, 0.95, 1.1],
      offset: [0.002, 0, -0.001, 0.003],
    },
  });
  it("matches the equations for the global controls in every luma band", () => {
    for (const s of SAMPLES)
      near(
        gradeOnly(s, global),
        gradeReference(s, resolveColorGrade({ ...global, toneCurveAmount: 0 })),
        1e-6,
      );
  });
  it("matches the equations for every range at once", () => {
    const all = resolveColorGrade({
      ...global,
      shadows: { gain: [1.2, 1, 1, 1], offset: [0.004, 0, 0, 0] },
      midtones: { saturation: [1, 1, 1, 0.7], contrast: [1, 1, 1, 1.1] },
      highlights: { gamma: [1, 1, 1, 0.9], gain: [1, 1, 0.9, 1] },
      shadowsMax: 0.12,
      highlightsMin: 0.4,
      highlightsMax: 0.9,
    });
    for (const s of SAMPLES)
      near(
        gradeOnly(s, all),
        gradeReference(s, resolveColorGrade({ ...all, toneCurveAmount: 0 })),
        1e-6,
      );
  });
  it("keeps a range inside its luma band", () => {
    const shadowsOnly = { shadows: { gain: [1.5, 1.5, 1.5, 1.5] } };
    const highlightsOnly = { highlights: { gain: [1.1, 1.1, 1.1, 1.1] } };
    const bright: RGB = [0.8, 0.85, 0.7];
    const dark: RGB = [0.02, 0.03, 0.015];
    near(gradeOnly(bright, shadowsOnly), gradeOnly(bright, {}), 1e-7);
    near(gradeOnly(dark, highlightsOnly), gradeOnly(dark, {}), 1e-7);
    expect(gradeOnly(dark, shadowsOnly)[1]).toBeGreaterThan(gradeOnly(dark, {})[1] * 1.4);
    expect(gradeOnly(bright, highlightsOnly)[1]).toBeGreaterThan(gradeOnly(bright, {})[1] * 1.05);
  });
  it("refuses a malformed control", () => {
    expect(() => resolveColorGrade({ global: { gain: [1, 1, 1] } })).toThrow(/gain/);
    expect(() => resolveColorGrade({ highlightsMin: 0.9, highlightsMax: 0.5 })).toThrow(
      /highlights/,
    );
    expect(() => resolveColorGrade({ whiteTemp: 500 })).toThrow(/whiteTemp/);
  });
});

describe("tone curve amount", () => {
  it("is 1 for the full curve and 0 for the grade alone", () => {
    const grey: RGB = [0.05, 0.05, 0.05];
    const full = filmicToneMap(grey, 1, FILMIC_CURVE, resolveColorGrade({ toneCurveAmount: 1 }));
    near(full, filmicToneMap(grey), 1e-9);
    const none = filmicToneMap(grey, 1, FILMIC_CURVE, resolveColorGrade({ toneCurveAmount: 0 }));
    near(none, grey, 1e-5);
    const half = filmicToneMap(grey, 1, FILMIC_CURVE, resolveColorGrade({ toneCurveAmount: 0.5 }));
    near(half, [0, 1, 2].map((i) => 0.5 * (at(none, i) + at(full, i))) as unknown as RGB, 1e-5);
  });
});

describe("white balance (Unreal WhiteBalance)", () => {
  // CIE xy of the white a viewer adapts to. Daylight 5000 K (D50) and the Planckian 3000 K locus.
  const xyz = (x: number, y: number): RGB => [x / y, 1, (1 - x - y) / y];
  const XYZ_TO_SRGB = [
    [3.2409699419, -1.5373831776, -0.4986107603],
    [-0.9692436363, 1.8759675015, 0.0415550574],
    [0.0556300797, -0.2039769589, 1.0569715142],
  ];
  const D50 = mul(XYZ_TO_SRGB, xyz(0.3457, 0.3585));
  const WARM = mul(XYZ_TO_SRGB, xyz(0.4369, 0.4041));
  const chroma = (rgb: RGB): [number, number] => {
    const toXyz = [
      [0.4123907993, 0.3575843394, 0.1804807884],
      [0.2126390059, 0.7151686788, 0.0721923154],
      [0.0193308187, 0.1191947798, 0.9505321522],
    ];
    const [X, Y, Z] = mul(toXyz, rgb);
    return [X / (X + Y + Z), Y / (X + Y + Z)];
  };
  const spread = (rgb: RGB): number => (Math.max(...rgb) - Math.min(...rgb)) / Math.max(...rgb);
  it("is a no-op at 6500 K, tint 0", () => {
    const c: RGB = [0.3, 0.2, 0.1];
    near(gradeOnly(c, { whiteTemp: 6500, whiteTint: 0 }), gradeOnly(c, {}), 1e-12);
  });
  it("turns the chosen white neutral in white balance mode", () => {
    expect(spread(gradeOnly(D50, { whiteTemp: 5000 }))).toBeLessThan(0.02);
    expect(spread(gradeOnly(WARM, { whiteTemp: 3000 }))).toBeLessThan(0.03);
  });
  it("turns neutral into the chosen white in colour temperature mode", () => {
    const out = gradeOnly([0.5, 0.5, 0.5], {
      whiteTemp: 5000,
      temperatureMode: "colorTemperature",
    });
    const [x, y] = chroma(out);
    expect(Math.abs(x - 0.3457)).toBeLessThan(0.004);
    expect(Math.abs(y - 0.3585)).toBeLessThan(0.004);
  });
  it("moves neutral in opposite directions for opposite tints", () => {
    const up = gradeOnly([0.5, 0.5, 0.5], { whiteTint: 0.5 });
    const down = gradeOnly([0.5, 0.5, 0.5], { whiteTint: -0.5 });
    expect((at(up, 1) - at(up, 0)) * (at(down, 1) - at(down, 0))).toBeLessThan(0);
    expect(spread(up)).toBeGreaterThan(0.02);
  });
});

describe("the colour LUT domain", () => {
  it("clips each channel at Unreal's 43.7 after exposure", () => {
    expect(FILMIC_CURVE.lutClip).toBeGreaterThan(43.6);
    expect(FILMIC_CURVE.lutClip).toBeLessThan(43.8);
    near(filmicToneMap([100, 5, 1]), filmicToneMap([CLIP, 5, 1]), 1e-9);
    near(filmicToneMap([1000, 1000, 1000]), [1, 1, 1], 1e-9);
  });
  it("is off at 0, the named override", () => {
    const off = { ...FILMIC_CURVE, lutClip: 0 };
    const a = filmicToneMap([100, 5, 1], 1, off);
    const b = filmicToneMap([CLIP, 5, 1], 1, off);
    expect(Math.abs(at(a, 1) - at(b, 1))).toBeGreaterThan(1e-4);
  });
  it("applies after the exposure, not before", () => {
    near(filmicToneMap([200, 5, 1], 0.5), filmicToneMap([100, 5, 1], 0.5), 1e-12);
    near(filmicToneMap([1000, 25, 5], 0.2), filmicToneMap([CLIP / 0.2, 25, 5], 0.2), 1e-9);
  });
});

describe("the tone-mapping node", () => {
  it("builds with and without a grade", async () => {
    const { vec3, float } = await import("three/tsl");
    for (const grade of [
      undefined,
      resolveColorGrade({
        whiteTemp: 5000,
        toneCurveAmount: 0.8,
        shadows: { gain: [1, 1, 1, 1.1] },
      }),
    ]) {
      const node = tonemap.filmicToneMappingNode(FILMIC_CURVE, grade)(
        vec3(0.4, 0.3, 0.2),
        float(1),
      );
      expect(node).toBeDefined();
    }
  });
});
