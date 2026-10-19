import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const REALISM_EFFECTS_EXPORTS = [
  "SSGIEffect",
  "SSREffect",
  "TRAAEffect",
  "TemporalReprojectPass",
  "PoissonDenoisePass",
  "MotionBlurEffect",
  "SharpnessEffect",
  "VelocityPass",
  "VelocityDepthNormalPass",
  "TAAPass",
  "HBAOEffect",
  "LensDistortionEffect",
  "SparkleEffect",
  "GradualBackgroundEffect",
] as const;

export const REALISM_EFFECTS_PLATFORMS = ["desktop", "android", "ios"] as const;
export type RealismEffectsCoverageKind = "upstream" | "template" | "not-covered";

export interface IRealismEffectsCoverageRow {
  readonly date?: string;
  readonly equivalent: readonly string[] | string | null;
  readonly evidencePath?: string;
  readonly exportName: string;
  readonly kind: RealismEffectsCoverageKind;
  readonly manifestSymbols?: readonly string[];
  readonly path?: string;
  readonly reason?: string;
  readonly situation: string;
}

export interface IRealismEffectsManifestEntry {
  readonly constraints: readonly string[];
  readonly example: string;
  readonly importPath: string;
  readonly kind: "class" | "function";
  readonly overrides: readonly string[];
  readonly package: string;
  readonly signature: string;
  readonly situations: readonly string[];
  readonly supersedes: readonly string[];
  readonly summary: string;
  readonly symbol: string;
}

export interface IRealismEffectsPlatformResult {
  readonly exportName: string;
  readonly platform: string;
  readonly reason?: string;
  readonly result: "fail" | "pass" | "skipped-with-reason";
}

const REALISM_EFFECTS_PLATFORM_RESULTS = ["fail", "pass", "skipped-with-reason"] as const;

const TEMPLATE_ROOT = "packages/create-threenative/templates/starter/src/render/effects";
const AO_EVIDENCE_PATH = "docs/verification/realism-effects-ao-2026-08-30.md";

/**
 * The one source of truth for the 14 names mined from `0beqz/realism-effects/src/index.js`.
 * `HBAOEffect` remains explicitly not-covered until a blind comparison can be run against a
 * real HBAO implementation; the reason and date are part of the row rather than a silent gap.
 */
export const REALISM_EFFECTS_COVERAGE: readonly IRealismEffectsCoverageRow[] = [
  upstream(
    "SSGIEffect",
    "ssgi",
    "three/examples/jsm/tsl/display/SSGINode.js",
    "add screen-space global illumination",
  ),
  upstream(
    "SSREffect",
    "ssr",
    "three/examples/jsm/tsl/display/SSRNode.js",
    "add screen-space reflections",
  ),
  upstream(
    "TRAAEffect",
    "traa",
    "three/examples/jsm/tsl/display/TRAANode.js",
    "temporally resolve a moving image",
  ),
  upstream(
    "TemporalReprojectPass",
    "temporalReproject",
    "three/examples/jsm/tsl/display/TemporalReprojectNode.js",
    "reproject a temporal history",
  ),
  upstream(
    "PoissonDenoisePass",
    ["denoise", "recurrentDenoise"],
    "three/examples/jsm/tsl/display",
    "denoise a noisy screen-space pass",
  ),
  upstream(
    "MotionBlurEffect",
    "motionBlur",
    "three/examples/jsm/tsl/display/MotionBlur.js",
    "blur motion using a velocity buffer",
  ),
  upstream(
    "SharpnessEffect",
    "sharpen",
    "three/examples/jsm/tsl/display/SharpenNode.js",
    "make the image sharper",
  ),
  upstream(
    "VelocityPass",
    ["velocity", "VelocityNode"],
    "three/src/nodes/accessors/VelocityNode.js",
    "provide motion vectors to temporal effects",
  ),
  upstream(
    "VelocityDepthNormalPass",
    ["mrt", "depth", "normalView"],
    "three/src/nodes",
    "provision velocity, normal, and depth render targets",
  ),
  upstream(
    "TAAPass",
    ["ssaaPass", "traa"],
    "three/examples/jsm/tsl/display",
    "anti-alias still and moving scenes",
  ),
  {
    date: "2026-08-30",
    equivalent: null,
    exportName: "HBAOEffect",
    evidencePath: AO_EVIDENCE_PATH,
    kind: "not-covered",
    reason:
      "No HBAO implementation is available in the pinned workspace for the required blind GTAO comparison; do not claim GTAO is equivalent until that comparison is run.",
    situation: "soften contact shadows",
  },
  template(
    "LensDistortionEffect",
    "lensDistortion",
    "lensDistortion.ts",
    "warp the image with radial lens distortion",
  ),
  template("SparkleEffect", "sparkle", "sparkle.ts", "add glints to bright highlights"),
  template(
    "GradualBackgroundEffect",
    "gradualBackground",
    "gradualBackground.ts",
    "grade a background by distance",
  ),
] as const;

/** Manifest additions for upstream and template equivalents that are not package exports. */
export const REALISM_EFFECTS_MANIFEST_ENTRIES: readonly IRealismEffectsManifestEntry[] = [
  manifest(
    "ssgi",
    "three/addons/tsl/display/SSGINode.js",
    "function",
    "add screen-space global illumination",
  ),
  manifest(
    "ssr",
    "three/addons/tsl/display/SSRNode.js",
    "function",
    "add screen-space reflections",
  ),
  manifest(
    "traa",
    "three/addons/tsl/display/TRAANode.js",
    "function",
    "temporally resolve a moving image",
  ),
  manifest(
    "temporalReproject",
    "three/addons/tsl/display/TemporalReprojectNode.js",
    "function",
    "reproject a temporal history",
  ),
  manifest(
    "denoise",
    "three/addons/tsl/display/DenoiseNode.js",
    "function",
    "denoise a noisy screen-space pass",
  ),
  manifest(
    "recurrentDenoise",
    "three/addons/tsl/display/RecurrentDenoiseNode.js",
    "function",
    "denoise a noisy screen-space pass",
  ),
  manifest(
    "motionBlur",
    "three/addons/tsl/display/MotionBlur.js",
    "function",
    "blur motion using a velocity buffer",
  ),
  manifest(
    "sharpen",
    "three/addons/tsl/display/SharpenNode.js",
    "function",
    "make the image sharper",
  ),
  manifest("velocity", "three/tsl", "function", "provide motion vectors to temporal effects"),
  manifest("VelocityNode", "three/webgpu", "class", "provide motion vectors to temporal effects"),
  manifest("mrt", "three/tsl", "function", "provision velocity, normal, and depth render targets"),
  manifest("depth", "three/tsl", "function", "provide depth to screen-space effects"),
  manifest("normalView", "three/tsl", "function", "provide normals to screen-space effects"),
  manifest(
    "ssaaPass",
    "three/addons/tsl/display/SSAAPassNode.js",
    "function",
    "anti-alias still and moving scenes",
  ),
  manifest(
    "lensDistortion",
    "@threenative/template/starter/src/render/effects/lensDistortion",
    "function",
    "warp the image with radial lens distortion",
    "template:starter",
  ),
  manifest(
    "sparkle",
    "@threenative/template/starter/src/render/effects/sparkle",
    "function",
    "add glints to bright highlights",
    "template:starter",
  ),
  manifest(
    "gradualBackground",
    "@threenative/template/starter/src/render/effects/gradualBackground",
    "function",
    "grade a background by distance",
    "template:starter",
  ),
] as const;

export function validateRealismEffectsCoverage(input: {
  coverage: readonly IRealismEffectsCoverageRow[];
  root?: string;
  manifest?: readonly { symbol: string; situations: readonly string[] }[];
}): string[] {
  const root = input.root ?? process.cwd();
  const known = new Set<string>(REALISM_EFFECTS_EXPORTS);
  const seen = new Set<string>();
  const manifestSymbols =
    input.manifest === undefined
      ? undefined
      : new Set(
          input.manifest
            .filter((entry) => entry.situations.length > 0)
            .map((entry) => entry.symbol),
        );
  const errors = input.coverage.flatMap((row) =>
    validateCoverageRow(row, root, known, seen, manifestSymbols),
  );
  for (const exportName of REALISM_EFFECTS_EXPORTS) {
    if (!seen.has(exportName)) errors.push(`${exportName}: coverage row is missing`);
  }
  return errors;
}

function validateCoverageRow(
  row: IRealismEffectsCoverageRow,
  root: string,
  known: ReadonlySet<string>,
  seen: Set<string>,
  manifestSymbols: ReadonlySet<string> | undefined,
): string[] {
  const errors: string[] = [];
  if (!known.has(row.exportName)) errors.push(`${row.exportName}: unknown realism-effects export`);
  if (seen.has(row.exportName)) errors.push(`${row.exportName}: duplicate coverage row`);
  seen.add(row.exportName);
  if (row.situation.trim() === "") errors.push(`${row.exportName}: situation must not be empty`);
  if (row.kind === "not-covered") return [...errors, ...validateNotCoveredRow(row, root)];
  if (row.equivalent === null || normaliseNames(row.equivalent).length === 0) {
    errors.push(`${row.exportName}: covered rows require an equivalent`);
    return errors;
  }
  return [...errors, ...validateCoveredRow(row, root, manifestSymbols)];
}

function validateNotCoveredRow(row: IRealismEffectsCoverageRow, root: string): string[] {
  const errors: string[] = [];
  if (row.reason?.trim() === undefined || row.reason.trim() === "")
    errors.push(`${row.exportName}: not-covered rows require a reason`);
  if (row.date === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(row.date))
    errors.push(`${row.exportName}: not-covered rows require an ISO date`);
  if (row.equivalent !== null)
    errors.push(`${row.exportName}: not-covered rows must have no equivalent`);
  if (row.evidencePath === undefined || !existsSync(resolve(root, row.evidencePath))) {
    errors.push(
      `${row.exportName}: not-covered rows require an evidence record at '${row.evidencePath ?? "<missing>"}'`,
    );
  }
  return errors;
}

function validateCoveredRow(
  row: IRealismEffectsCoverageRow,
  root: string,
  manifestSymbols: ReadonlySet<string> | undefined,
): string[] {
  const errors: string[] = [];
  if (row.path === undefined || row.path.trim() === "")
    errors.push(`${row.exportName}: covered rows require a source path`);
  if (row.kind === "upstream") validateUpstreamRow(row, root, errors);
  if (row.kind === "template") validateTemplateRow(row, root, errors);
  if (manifestSymbols !== undefined) {
    const equivalents = row.equivalent === null ? [] : normaliseNames(row.equivalent);
    for (const symbol of row.manifestSymbols ?? equivalents) {
      if (!manifestSymbols.has(symbol))
        errors.push(`${row.exportName}: manifest entry '${symbol}' is missing a situation`);
    }
  }
  return errors;
}

export function validateRealismEffectsPlatformMatrix(
  results: readonly IRealismEffectsPlatformResult[],
  coverage: readonly IRealismEffectsCoverageRow[] = REALISM_EFFECTS_COVERAGE,
): string[] {
  const expectedRows = coverage.filter((row) => row.kind !== "not-covered");
  const expected = new Set(expectedRows.map((row) => row.exportName));
  const seen = new Set<string>();
  return [
    ...results.flatMap((result) => validatePlatformResult(result, expected, seen)),
    ...expectedRows.flatMap((row) =>
      REALISM_EFFECTS_PLATFORMS.filter(
        (platform) => !seen.has(`${row.exportName}:${platform}`),
      ).map((platform) => `${row.exportName}: platform '${platform}' is unobservable`),
    ),
  ];
}

function validatePlatformResult(
  result: IRealismEffectsPlatformResult,
  expected: ReadonlySet<string>,
  seen: Set<string>,
): string[] {
  const key = `${result.exportName}:${result.platform}`;
  const errors: string[] = [];
  if (!expected.has(result.exportName)) errors.push(`${key}: unknown or not-covered export`);
  if (!(REALISM_EFFECTS_PLATFORMS as readonly string[]).includes(result.platform))
    errors.push(`${key}: unknown platform`);
  if (seen.has(key)) errors.push(`${key}: duplicate platform result`);
  seen.add(key);
  if (!(REALISM_EFFECTS_PLATFORM_RESULTS as readonly string[]).includes(result.result))
    errors.push(`${key}: result must be pass, fail, or skipped-with-reason`);
  if (result.result === "fail") {
    errors.push(`${key}: fail is not admissible in checked-in platform evidence`);
  }
  if (
    (result.result === "fail" || result.result === "skipped-with-reason") &&
    (result.reason?.trim() ?? "") === ""
  ) {
    errors.push(`${key}: ${result.result} requires a reason`);
  }
  return errors;
}

export function renderRealismEffectsCoverageTable(
  coverage: readonly IRealismEffectsCoverageRow[] = REALISM_EFFECTS_COVERAGE,
): string {
  const lines = [
    "| `realism-effects` export | Equivalent here | Where it comes from |",
    "| --- | --- | --- |",
  ];
  for (const row of coverage) {
    const equivalent =
      row.equivalent === null
        ? "not covered"
        : normaliseNames(row.equivalent)
            .map((name) => `\`${name}\``)
            .join(", ");
    const source = row.path === undefined ? (row.reason ?? "") : `\`${row.path}\``;
    lines.push(`| \`${row.exportName}\` | ${equivalent} | ${source} |`);
  }
  return lines.join("\n");
}

function upstream(
  exportName: string,
  equivalent: string | readonly string[],
  path: string,
  situation: string,
): IRealismEffectsCoverageRow {
  return {
    equivalent,
    exportName,
    kind: "upstream",
    manifestSymbols: normaliseNames(equivalent),
    path,
    situation,
  };
}

function template(
  exportName: string,
  equivalent: string,
  file: string,
  situation: string,
): IRealismEffectsCoverageRow {
  return {
    equivalent,
    exportName,
    kind: "template",
    manifestSymbols: [equivalent],
    path: join(TEMPLATE_ROOT, file),
    situation,
  };
}

function manifest(
  symbol: string,
  importPath: string,
  kind: "class" | "function",
  situation: string,
  packageName = "three",
): IRealismEffectsManifestEntry {
  return {
    constraints: [
      "Use the running WebGPU renderer and keep appearance choices in template render source.",
    ],
    example: `${symbol}(...)`,
    importPath,
    kind,
    overrides: [],
    package: packageName,
    signature: `${kind} ${symbol}`,
    situations: [situation],
    supersedes: [],
    summary: `ThreeNative equivalent for realism-effects ${symbol}.`,
    symbol,
  };
}

function normaliseNames(value: readonly string[] | string): string[] {
  return typeof value === "string" ? [value] : [...value];
}

function validateUpstreamRow(
  row: IRealismEffectsCoverageRow,
  root: string,
  errors: string[],
): void {
  const sourcePath = row.path;
  const equivalents = row.equivalent;
  if (sourcePath === undefined || equivalents === null) return;
  const sources = resolveThreeSources(root, sourcePath);
  if (sources === undefined) {
    errors.push(`${row.exportName}: upstream source '${sourcePath}' does not resolve`);
    return;
  }
  const text = sources.map((source) => readFileSync(source, "utf8")).join("\n");
  for (const symbol of normaliseNames(equivalents)) {
    if (
      !new RegExp(
        `(?:\\bclass\\s+${escapeRegExp(symbol)}\\b|\\bfunction\\s+${escapeRegExp(symbol)}\\b|\\b(?:const|let|var)\\s+${escapeRegExp(symbol)}\\b)`,
        "u",
      ).test(text)
    ) {
      errors.push(`${row.exportName}: equivalent '${symbol}' is not exported by '${sourcePath}'`);
    }
  }
}

function validateTemplateRow(
  row: IRealismEffectsCoverageRow,
  root: string,
  errors: string[],
): void {
  const sourcePath = row.path;
  const equivalents = row.equivalent;
  if (sourcePath === undefined || equivalents === null) return;
  const source = resolve(root, sourcePath);
  if (!existsSync(source)) {
    errors.push(`${row.exportName}: template source '${sourcePath}' does not resolve`);
    return;
  }
  const text = readFileSync(source, "utf8");
  for (const symbol of normaliseNames(equivalents)) {
    if (!new RegExp(`export\\s+(?:const|function)\\s+${escapeRegExp(symbol)}\\b`, "u").test(text))
      errors.push(`${row.exportName}: template source does not export '${symbol}'`);
  }
}

function resolveThreeSources(root: string, source: string): string[] | undefined {
  const threeRootCandidates = [
    join(root, "packages/core/node_modules/three"),
    join(root, "node_modules/three"),
  ];
  for (const threeRoot of threeRootCandidates) {
    const candidate = join(threeRoot, source.replace(/^three\//u, ""));
    if (existsSync(candidate)) {
      const files: string[] = [];
      collectSourceFiles(candidate, files);
      if (files.length > 0) return files;
    }
  }
  return undefined;
}

function collectSourceFiles(path: string, files: string[]): void {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path).sort()) collectSourceFiles(join(path, entry), files);
    return;
  }
  if (path.endsWith(".js")) files.push(path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
