import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The tier vocabulary every template's `src/render/quality.ts` ships. Three names, not two: a
 * desktop that is dropping frames needs somewhere to go that is not the phone look.
 */
export const QUALITY_TIERS = ["low", "medium", "high"] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number];

/** Boolean options in `IWorldEnvironmentOptions` that turn a render stage on. */
const STAGE_OPTIONS = [
  "bloomEnabled",
  "denoiseEnabled",
  "godraysEnabled",
  "gtaoEnabled",
  "sharpenEnabled",
  "ssgiEnabled",
  "ssrEnabled",
] as const;

/**
 * A cost comment names a measurement or admits there is none.
 *
 * `~4.6 ms` is a reading; `unmeasured` is an honest gap. Anything else beside an enabled stage is
 * a stage whose price nobody wrote down, which is the thing this gate exists to prevent — the
 * file's whole value is that "make it cheaper" can be answered without opening `packages/`.
 */
const COST_COMMENT = /\bms\b|\bunmeasured\b/u;

/** Every template directory on disk. Throws rather than reporting a green zero. */
export async function templateNames(templatesDir: string): Promise<string[]> {
  const entries = await readdir(templatesDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`TEMPLATE_QUALITY_NO_TEMPLATES: no template directories under ${templatesDir}`);
  }
  return names;
}

/**
 * Anonymous preset literals — the incumbent this switch replaces. Two of these per template was
 * the state before `quality.ts`: a look with no name, no tier and no recorded cost.
 */
export function presetLiteralsIn(source: string): string[] {
  return [...source.matchAll(/const\s+(\w*[Pp]reset)\s*[:=]/gu)].map((match) => match[1] ?? "");
}

/** The stages a preset object turns on. */
export function enabledStages(preset: Record<string, unknown>): string[] {
  return STAGE_OPTIONS.filter((option) => preset[option] === true);
}

/**
 * Stage options enabled in `quality.ts` with no cost comment above them.
 *
 * Deliberately a source scan and not a check on the imported object: the requirement is that the
 * number is *written next to the switch*, where an agent editing the tier will read it. An
 * imported preset cannot carry a comment.
 */
export function costCommentGaps(source: string): string[] {
  const lines = source.split("\n");
  const gaps: string[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(\w+Enabled):\s*true,/u.exec(line);
    if (match === null) continue;
    const option = match[1] ?? "";
    let cursor = index - 1;
    let documented = false;
    while (cursor >= 0 && lines[cursor]?.trim().startsWith("//") === true) {
      if (COST_COMMENT.test(lines[cursor] ?? "")) documented = true;
      cursor -= 1;
    }
    if (!documented) gaps.push(`${option} (line ${index + 1})`);
  }
  return gaps;
}

/**
 * Where the shared span starts, and the function whose closing brace ends it.
 *
 * Structural anchors, not a line range and not a marker comment. A line range drifts the moment a
 * doc comment above the type grows; a marker would put gate machinery into source whose first
 * line promises the game "ordinary Three.js; ThreeNative does not read this file". The anchors
 * below are the code itself.
 */
const CONTRACT_START = "export type QualityTier";
const CONTRACT_FUNCTION = "export function resolveQualityTier";

/**
 * The span of `quality.ts` that must be byte-identical across every template: the tier type, the
 * tier array, the narrower, and `resolveQualityTier`'s fail-closed body.
 *
 * It deliberately stops at that function's closing brace. Everything below is `high`, `medium`,
 * `low` and `qualityPreset` — the game's look, which differs on purpose. A gate that hashed those
 * too would freeze exactly the variation the framework exists to allow.
 *
 * Throws rather than returning `undefined`: a template whose contract cannot be delimited is a
 * finding, never a silently skipped row.
 */
export function qualityContractSpan(source: string): string {
  const coreResolver = "export const resolveQualityTier = qualityTiers.resolve;";
  if (
    source.includes(coreResolver) &&
    /import\s*\{[^}]*\bqualityTiers\b[^}]*\}\s*from\s*["']@threenative\/core["']/u.test(source)
  ) {
    return `import { qualityTiers } from "@threenative/core";\n${coreResolver}`;
  }
  const start = source.indexOf(CONTRACT_START);
  if (start === -1) {
    throw new Error(`declares no \`${CONTRACT_START}\``);
  }
  const fn = source.indexOf(CONTRACT_FUNCTION, start);
  if (fn === -1) {
    throw new Error(`declares no \`${CONTRACT_FUNCTION}\` after \`${CONTRACT_START}\``);
  }
  // A top-level function body closes on a brace alone at column 0. A preset object closes on
  // `};`, so this cannot run past the contract into the look below it.
  const close = source.indexOf("\n}\n", fn);
  if (close === -1) {
    throw new Error(`\`${CONTRACT_FUNCTION}\` has no closing brace at column 0`);
  }
  const span = source.slice(start, close + 3);
  const opens = (span.match(/\{/gu) ?? []).length;
  const closes = (span.match(/\}/gu) ?? []).length;
  if (opens !== closes) {
    throw new Error(
      `the tier contract span does not balance (${String(opens)} \`{\` against ${String(closes)} \`}\`)`,
    );
  }
  return span;
}

/** Short, stable identity for a contract span. Long enough to name in a failure message. */
export function contractSpanHash(span: string): string {
  return createHash("sha256").update(span).digest("hex").slice(0, 12);
}

/**
 * The property the span exists to protect.
 *
 * Hash agreement alone is not enough: eleven copies that all lost the throw agree with each other
 * perfectly. This asserts the fail-closed behaviour itself, so the gate catches the drift that
 * moves every copy at once.
 */
export function contractSpanThrows(span: string): boolean {
  return (
    /\bthrow new Error\(/u.test(span) ||
    span ===
      'import { qualityTiers } from "@threenative/core";\nexport const resolveQualityTier = qualityTiers.resolve;'
  );
}

interface IContractSpan {
  readonly template: string;
  readonly hash: string;
}

/**
 * Names every template whose contract span disagrees with the largest group.
 *
 * The largest group wins; a tie is broken by the alphabetically first template in it, so the
 * message is the same on every machine.
 */
export function contractDriftFindings(
  spans: readonly IContractSpan[],
): readonly ITemplateQualityFinding[] {
  const groups = new Map<string, string[]>();
  for (const { hash, template } of spans) {
    const members = groups.get(hash) ?? [];
    members.push(template);
    groups.set(hash, members);
  }
  if (groups.size <= 1) return [];
  const ranked = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[1][0] ?? "").localeCompare(b[1][0] ?? ""),
  );
  const [majorityHash, majorityMembers] = ranked[0] ?? ["", []];
  const findings: ITemplateQualityFinding[] = [];
  for (const [hash, members] of ranked.slice(1)) {
    for (const template of members) {
      findings.push({
        problem: `quality.ts's fail-closed tier contract drifted (${hash}) from the ${String(majorityMembers.length)} templates that agree (${majorityHash}, e.g. ${majorityMembers[0] ?? "?"})`,
        template,
      });
    }
  }
  return findings;
}

export interface ITemplateQualityFinding {
  readonly template: string;
  readonly problem: string;
}

export interface ITemplateQualityReport {
  readonly templates: readonly string[];
  readonly findings: readonly ITemplateQualityFinding[];
  /** The contract hash every template agreed on, or `undefined` when they did not. */
  readonly contractHash: string | undefined;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The switch itself: three named tiers, each with the cost of what it turns on beside it. */
async function qualityProblems(
  source: string | undefined,
  file: string,
  coreSource: string | undefined,
): Promise<string[]> {
  if (source === undefined) return ["no src/render/quality.ts"];
  const delegated =
    /import\s*\{[^}]*\bqualityPreset\b[^}]*\}\s*from\s*["']@threenative\/core["']/u.test(source);
  const problems = delegated
    ? []
    : QUALITY_TIERS.filter((tier) => !new RegExp(`^const ${tier}:`, "mu").test(source)).map(
        (tier) => `quality.ts declares no \`${tier}\` tier`,
      );
  if (delegated) {
    try {
      const module = await import(pathToFileURL(file).href);
      if (typeof module.qualityPreset !== "function")
        throw new Error("qualityPreset is not a function");
      for (const tier of QUALITY_TIERS) {
        const preset: unknown = module.qualityPreset(tier);
        if (preset === null || typeof preset !== "object" || Array.isArray(preset))
          throw new Error(`${tier} did not return a preset object`);
        const options = preset as Record<string, unknown>;
        if (!(QUALITY_TIERS as readonly unknown[]).includes(options.renderChainTier))
          throw new Error(`${tier} returned an invalid renderChainTier`);
        for (const stage of STAGE_OPTIONS)
          if (options[stage] !== undefined && typeof options[stage] !== "boolean")
            throw new Error(`${tier} returned a non-boolean ${stage}`);
      }
      let refused = false;
      try {
        module.qualityPreset("ultra");
      } catch {
        refused = true;
      }
      if (!refused) throw new Error("factory silently accepts an unknown quality tier");
    } catch (error) {
      problems.push(
        `quality.ts cannot evaluate public quality presets: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (coreSource === undefined)
      problems.push("quality.ts has no shared core quality source for inherited costs");
    else
      for (const gap of costCommentGaps(coreSource))
        problems.push(`core quality.ts enables ${gap} with no measured cost beside it`);
  }
  for (const gap of costCommentGaps(source)) {
    problems.push(`quality.ts enables ${gap} with no measured cost beside it`);
  }
  return problems;
}

/**
 * The fail-closed half of the switch: the shared span is delimitable, and it still throws.
 *
 * Records the span's hash into `spans` as a side effect so the caller can compare templates
 * against each other. A template whose span cannot be read contributes no hash — it has already
 * produced a finding, and inventing one would make it look like a drifter instead of a break.
 */
function contractProblems(
  source: string | undefined,
  template: string,
  spans: IContractSpan[],
): string[] {
  if (source === undefined) return [];
  let span: string;
  try {
    span = qualityContractSpan(source);
  } catch (error) {
    return [`quality.ts ${error instanceof Error ? error.message : String(error)}`];
  }
  spans.push({ hash: contractSpanHash(span), template });
  if (!contractSpanThrows(span)) {
    return [
      "quality.ts's resolveQualityTier does not throw on an unknown tier — a silent fallback here looks exactly like a tier that turned out to have no effect",
    ];
  }
  return [];
}

/** The switch is *reached*, the incumbent literals are gone, and the tier is reported. */
function postprocessingProblems(source: string | undefined): string[] {
  if (source === undefined) return ["no src/render/postprocessing.ts"];
  const problems: string[] = [];
  if (!source.includes('from "./quality.js"')) {
    problems.push("postprocessing.ts does not read quality.ts");
  }
  for (const literal of presetLiteralsIn(source)) {
    problems.push(`postprocessing.ts still holds the \`${literal}\` literal the tiers replace`);
  }
  if (!source.includes("TN_QUALITY_TIER")) {
    problems.push("postprocessing.ts does not report TN_QUALITY_TIER");
  }
  return problems;
}

/**
 * Surface-data texture nodes must be requested lazily, or the frame goes black.
 *
 * `PassNode` adds every named colour texture requested through `getTextureNode()` to its
 * framebuffer, so asking for `normal`, `metalness` or `roughness` at the top of `apply()` gives a
 * pass an attachment no fragment shader writes. WebGPU refuses that pipeline — *"Color target has
 * no corresponding fragment stage output"* — and the frame renders black **while the chain reports
 * every stage as applied**.
 *
 * This is a gate rather than a fix because the fix already existed. It was found, understood and
 * written down in `sailing`'s `worldEnvironment.ts` on 2026-08-31, and the other seven templates
 * carried the defect anyway until 2026-09-01, shipping a black mobile look on every phone. A
 * comment in one template is not a convention.
 */
const LAZY_SURFACE_NODES = ["normal", "metalness", "roughness"] as const;

export function eagerSurfaceNodes(source: string): string[] {
  const eager: string[] = [];
  for (const name of LAZY_SURFACE_NODES) {
    const needle = `getTextureNode("${name}")`;
    let at = source.indexOf(needle);
    while (at !== -1) {
      // Walk back to the start of the statement this call sits in. An `=>` inside that span means
      // the call is an arrow body — deferred, which is the fix. Line-based matching cannot do
      // this: the accessors wrap, so `=>` routinely lands on the previous line.
      const statement = source.lastIndexOf(";", at);
      const block = source.lastIndexOf("{", at);
      const from = Math.max(statement, block) + 1;
      const preceding = source.slice(from, at);
      const commented = /(^|\n)\s*(\/\/|\*)[^\n]*$/u.test(source.slice(from, at + needle.length));
      if (!preceding.includes("=>") && !commented) {
        eager.push(`${name} (line ${source.slice(0, at).split("\n").length})`);
      }
      at = source.indexOf(needle, at + needle.length);
    }
  }
  return eager.sort();
}

/** A convention missing from the template's `AGENTS.md` does not exist. */
function docProblems(source: string | undefined): string[] {
  if (source === undefined) return ["no AGENTS.md"];
  const problems: string[] = [];
  const named = QUALITY_TIERS.every((tier) => source.includes(`\`${tier}\``));
  if (!source.includes("quality.ts") || !named) {
    problems.push("AGENTS.md does not name quality.ts and its three tiers");
  }
  if (!source.includes('tier: "low"')) problems.push("AGENTS.md does not show the tier override");
  return problems;
}

/**
 * Checks that every template ships the switch, reads it, records what each enabled stage costs,
 * and documents the tiers where an authoring agent will look.
 */
export async function checkTemplateQuality(root: string): Promise<ITemplateQualityReport> {
  const templatesDir = path.join(root, "packages", "create-threenative", "templates");
  const templates = await templateNames(templatesDir);
  const findings: ITemplateQualityFinding[] = [];
  const spans: IContractSpan[] = [];
  for (const template of templates) {
    const render = path.join(templatesDir, template, "src", "render");
    const world = await readOptional(
      path.join(root, "packages/core/src/look/world-environment.ts"),
    );
    const quality = await readOptional(path.join(render, "quality.ts"));
    const problems = [
      ...(await qualityProblems(
        quality,
        path.join(render, "quality.ts"),
        await readOptional(path.join(root, "packages/core/src/look/quality.ts")),
      )),
      ...contractProblems(quality, template, spans),
      ...postprocessingProblems(await readOptional(path.join(render, "postprocessing.ts"))),
      ...docProblems(await readOptional(path.join(templatesDir, template, "AGENTS.md"))),
      ...(world === undefined
        ? ["no core WorldEnvironment source"]
        : eagerSurfaceNodes(world).map(
            (entry) =>
              `core WorldEnvironment requests ${entry} eagerly — that attaches a colour target no fragment shader writes, and the frame renders black while the chain reports success`,
          )),
    ];
    for (const problem of problems) findings.push({ problem, template });
  }
  findings.push(...contractDriftFindings(spans));
  const hashes = new Set(spans.map((span) => span.hash));
  return {
    contractHash: hashes.size === 1 ? [...hashes][0] : undefined,
    findings,
    templates,
  };
}

export function formatTemplateQualityReport(report: ITemplateQualityReport): string {
  if (report.findings.length === 0) {
    return `template quality: ${report.templates.length} templates ship src/render/quality.ts, read it, and document it; all agree on the fail-closed tier contract (${report.contractHash ?? "no span"})`;
  }
  const lines = [`TEMPLATE_QUALITY_INCOMPLETE: ${report.findings.length} problems`];
  for (const finding of report.findings) lines.push(`- ${finding.template}: ${finding.problem}`);
  return lines.join("\n");
}
