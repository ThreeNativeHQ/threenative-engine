import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expandSharedRegions, mirrorContent, readSharedFragments } from "./sync-agent-docs.js";

/**
 * P2-2: cold agents pay every word in a generated `AGENTS.md` before they can ask the
 * capability manifest anything, so the payload is bounded by measurement rather than taste.
 *
 * The contract, in one place:
 *
 * - One default maximum applies to every shipped template; an override exists only where the
 *   measured content justifies it (recorded in docs/verification/instruction-budgets-*.md).
 * - Words are counted over RENDERED text: shared-marker comments stripped, HTML comments
 *   stripped, placeholders substituted — exactly what a generated project's agent reads.
 * - Long recipes live in `packages/create-threenative/agent-docs/references/*.md` and are read
 *   from the installed package at
 *   `node_modules/create-threenative/agent-docs/references/<page>.md` (backticked or linked).
 * - Every reference target must exist in that bundle, and every `CLAUDE.md` mirror must equal
 *   the generated expansion of its `AGENTS.md`.
 */

export interface IBudgetConfig {
  readonly defaultMaxWords: number;
  readonly overrides: Readonly<Record<string, number>>;
}

export const INSTRUCTION_BUDGETS: IBudgetConfig = {
  // Measured across all seven shipped templates after the P2-2 reduction; see
  // docs/verification/instruction-budgets-2026-08-21.md for the before/after table and
  // per-template breakdowns.
  //
  // The four genre kits fit the default once their duplicated recipes moved to the reference
  // bundle. The three overrides are not slack: each names the mandatory inline content that
  // keeps its template above the default after two reduction passes.
  //
  // Every number carries a uniform +60 re-measured on 2026-08-22 (PRD-187): the generated
  // superseded-constructs region became mandatory inline content in all seven templates, and
  // survives the triplication cut that paid for most of it (the same override rule had been
  // stated in the context-surface prose, the generated trailer, and the engine-capabilities
  // instructions). See docs/verification/instruction-budgets-2026-08-22.md.
  // `minimal` and `starter` each carry a further re-measured increment from PRD-209
  // (2026-08-23): +53 and +65 rendered words for the portable-HUD convention. Both templates
  // had under 25 words of headroom, so stating the convention at all needed the override the
  // contract above allows. The measured content justifying it: a shipped Android build
  // rendered its world with no HUD whatsoever, because `starter`'s portability list called a
  // native HUD optional and no template said where a portable one comes from. The spike that
  // priced the alternatives — one geometry source rendering byte-identical text on web, Linux
  // desktop native, the Android emulator and a physical Pixel 8 — is
  // docs/verification/prd-209-2026-08-23.md; the before/after table is
  // docs/verification/instruction-budgets-2026-08-23.md.
  // A second uniform bump, +22, re-measured on 2026-08-23 (PRD-214): the frame budget ships on
  // by default and prints `TN_FRAME_BUDGET` on every platform, so the performance instructions
  // now have to name the marker, its five phases and the `frameBudget: false` override
  // — a convention missing from the templates' AGENTS.md does not exist. Measured worst case was
  // platformer at 2981 against 2960. See docs/verification/prd-214-2026-08-23.md.
  //
  // And a uniform +34 on 2026-08-23 (PRD-213): the performance instructions gained a
  // three-line mobile-memory pointer. It is the smallest form that survives — the table, the
  // arithmetic and the fix all live in `agent-docs/mobile-memory-budget.md`, so only the hook is
  // charged. It buys the one number a cold agent cannot derive and pays 48 MiB the first time it
  // is read: a game shipped one 3072x1536 equirect on both `scene.background` and
  // `scene.environment`, which costs an extra 1536x2048 rgba16float pair on a Pixel 8, and no
  // amount of reading the code tells you that. Measured before/after per template in
  // docs/verification/instruction-budgets-2026-08-23.md.
  // PRD-217 adds one shared pointer line to the reference index, naming the web-view UI page
  // (`agent-docs/webview-ui.md`): +11 rendered words in every template, measured. It is in the
  // shared skill rather than per template because the page ships to all seven, and a page the
  // instructions never name does not exist. Four templates sat exactly at their cap and carry the
  // increment here; `action-rpg`, `racing` and `starter` absorbed it inside existing headroom,
  // starter after trimming a `data-tn-interactive` sentence the new page states in full.
  // And a uniform +26 on 2026-08-25: `AnimationPlayer` gained stride sync — a travelling clip's
  // playback rate is matched to the ground the body covers, on by default. A convention missing
  // from the templates' AGENTS.md does not exist, and this one has to name its override or a game
  // cannot turn it off, so the line charges the mechanism, the `strideRoot` argument and the
  // `strideSync` override and nothing else. Measured: `defense`, the template sitting exactly at
  // the cap, renders 2753 against 2727.
  // And a uniform +177 on 2026-08-28 (PRD-228): `renderer.resolutionScale` gained an `"auto"`
  // loop and every template ships it on, so the engine holds the `display.maxFps` budget rather
  // than the game hand-authoring a resolution constant — one real game spent an afternoon and
  // three device rungs finding that constant. A convention missing from the templates' AGENTS.md
  // does not exist, and this one has to name its override, its validation and its per-window
  // reporting or a game can neither turn it off nor tell which resolution produced an fps number.
  // `defense`, the template sitting exactly at the default cap, renders 2930 against 2753.
  // It is its own performance skill section: the lightmap and frame-budget guidance carries an
  // executable 130-word cap of its own, and this is a different subject from the target table.
  // And a uniform +82 on 2026-08-28 (PRD-237 + PRD-241): the shared context table gained the
  // `ctx.pointer` row and paragraph (PRD-237's portable 3D pointer events) and the tween row grew
  // an `ease` option (PRD-241). Both are conventions a game cannot discover by grep, so they must
  // render inline; twelve redundant words were trimmed first (`optional fourth options argument`,
  // the pointer prose), and every template then measured +82 over its previous cap because the
  // fragment is shared — `racing` absorbed 33 of it in headroom and `action-rpg` all of it.
  // Measured per template on 2026-08-28: action-rpg 2933, defense 3012, minimal 3849, platformer
  // 3389, racing 2979, shooter 3077, starter 4223 — every cap moves by exactly +82.
  // PRD-256 adds the shared 24-word static-lightmap setup, rollback, and platform warning.
  //
  // Re-measured 2026-08-31 against 81698466 (the PRD-278 cap bump) because the gate had gone
  // red on main before this change: template-growth commits since that cap — the PRD-268 probe
  // volumes, the godrays refusal, and the see-it-in-numbers section (e5d64b5f) — added +530
  // (minimal, platformer, starter) or +569 (action-rpg, defense, racing, shooter) rendered
  // words without moving a limit. This change then adds the shared engine-bug-report instructions,
  // a uniform +104 measured everywhere. Caps now sit on the measured values; the per-template
  // table is docs/verification/instruction-budgets-2026-08-31.md.
  // And a uniform +134 on 2026-08-31 (PRD-304): every template now ships
  // `src/render/quality.ts`, a named three-tier quality switch whose presets carry the measured
  // GPU cost of each stage they enable. A convention missing from the templates' AGENTS.md does
  // not exist, and this one has to name the three tiers, the platform default, the `tier`
  // override and the `TN_QUALITY_TIER` report, or a game can neither ask for the cheap look on a
  // desktop nor tell which look produced a capture. The section was cut to its shortest form
  // first — the per-stage numbers live in `quality.ts` itself and are not repeated here — and
  // then measured: `defense` and `shooter`, the two templates sitting exactly at their caps,
  // both render exactly +134. `sailing` absorbed all of it in headroom (2971 against 3036).
  // The merged tree re-measures the quality section at +137 against the combined local template
  // text. Final counts are recorded in docs/verification/instruction-budgets-2026-08-31.md.
  defaultMaxWords: 3574,
  // The same measured +26 rides every override below — +27 on `platformer` and `shooter`, whose
  // own wrapping splits one more word — because the stride-sync line is in the shared skill, so all seven
  // templates carry it and none of them absorbed it in headroom.
  overrides: {
    // Touch-controls mapping, the stated desktop-has-no-HUD gap, and checkpoint level structure.
    // PRD-216 adds the complete native React style vocabulary (+76 measured rendered words).
    platformer: 3912,
    // PRD-216 adds the complete native React style vocabulary (+64 measured rendered words).
    shooter: 3639,
    // The no-React geometry HUD contract and its native-portability rules have no genre-kit peer.
    // PRD-248 adds +84 measured rendered words, `minimal` only, because only this template ships
    // the atmosphere: its sky dome, sun colour and depth haze now come from one `Atmosphere` node
    // and `sky.ts` therefore sets no fog, which contradicts the fog instruction the section used
    // to carry. A convention missing from the templates' AGENTS.md does not exist, and this one
    // has to name its WebGL fallback and the `baseColour` override or a game can neither
    // tell why the sky went flat nor turn the haze off. Measured 3767 against 3683.
    // +8 measured for the TSL silent-no-op traps, on the same clause: four post stages that
    // install and then do nothing (`SSRNode.maxDistance` defaulting to one world unit,
    // `reflectNonMetals` defaulting to false, a swizzled normal, a dangling graph branch). Each
    // has cost real debugging time here and each passes typecheck, lint and a playtest, so a
    // game that hits one has nothing to read. The detail is in the reference page, which this
    // budget does not count; only the naming is inline, and it was trimmed to its shortest form
    // before the limit moved.
    minimal: 4344,
    // React state bridge, native-proof game contract, the four-difference portability list, and
    // the React-HUD-is-invisible-natively rule that list has to carry.
    // PRD-216 replaces the web-only warning with the native mount and full style contract (+60).
    // PRD-218 adds the scene-backed menu recipe, carried state, and its click proof (+59).
    // +4 measured for the TSL silent-no-op traps; see the note on `minimal` for the reasoning.
    starter: 4691,
  },
};

/** Sections every generated instruction file must carry inline, wherever its budget lands. */
export const MANDATORY_INLINE_PROBES: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  {
    label: "first-use capability search",
    pattern: /engine_search_capabilities|`threenative-capabilities` before `prd-creator`/u,
  },
  { label: "lazy-first ponytail gate", pattern: /ponytail/u },
  {
    label: "fallback to plain Three.js",
    pattern: /When the framework blocks you, write plain Three\.js/u,
  },
  { label: "doctor-first diagnosis", pattern: /npx threenative doctor/u },
  { label: "durable playtest proof", pattern: /playtests\/survives\.playtest\.json/u },
  { label: "navigation subpath constraint", pattern: /@threenative\/physics\/navigation/u },
  { label: "look budget rule", pattern: /Budget real time for the look/u },
];

export type BudgetViolationCode =
  | "WORD_BUDGET_EXCEEDED"
  | "MISSING_MANDATORY_SECTION"
  | "MISSING_REFERENCE_TARGET"
  | "MIRROR_DRIFT";

export interface IBudgetViolation {
  readonly code: BudgetViolationCode;
  readonly message: string;
}

export interface IInstructionAudit {
  readonly limit: number;
  readonly mirrorPath: string;
  readonly missingMandatory: readonly string[];
  /** Reference hrefs found in the rendered instructions, resolved against the bundle. */
  readonly references: readonly string[];
  readonly template: string;
  readonly violations: readonly IBudgetViolation[];
  readonly wordCount: number;
}

/** Marker comments and ordinary comments never reach a generated project's reader. */
const COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;
const PLACEHOLDERS: ReadonlyArray<readonly [string, string]> = [
  ["__PROJECT_NAME__", "my-game"],
  ["__PROJECT_ID__", "mygame"],
];
const REFERENCE_DIRECTORY = path.join("agent-docs", "references");
/** The path a generated project reads a page at: the installed `create-threenative` copy (PRD-449).
 * Backticked paths and Markdown links share one prefix so both readers resolve identically. */
const REFERENCE_PREFIX = "node_modules/create-threenative/agent-docs/references/";
const REFERENCE_TOKEN_PATTERN = new RegExp(
  `\`${REFERENCE_PREFIX}([a-z0-9][a-z0-9./-]*\\.md)\`|` +
    `\\[[^\\]]*\\]\\(${REFERENCE_PREFIX}([^)#]+\\.md)\\)`,
  "gu",
);

/** The text a generated project's agent actually reads from a template instruction file. */
export function renderInstructionText(source: string): string {
  let rendered = source;
  for (const [placeholder, value] of PLACEHOLDERS) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  return rendered.replace(COMMENT_PATTERN, "").trim();
}

export function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

/** Reference page names named by rendered instructions, normalised to the bundle file name. */
export function referenceTargets(rendered: string): readonly string[] {
  const targets = new Set<string>();
  for (const match of rendered.matchAll(REFERENCE_TOKEN_PATTERN)) {
    const referenced = match[1] ?? match[2];
    if (referenced !== undefined) targets.add(referenced);
  }
  return [...targets].sort();
}

function limitFor(template: string, config: IBudgetConfig): number {
  return config.overrides[template] ?? config.defaultMaxWords;
}

/**
 * Audits one template directory containing `AGENTS.md` (+ generated `CLAUDE.md`) against its
 * budget, the mandatory inline sections, and the reference bundle.
 */
export async function auditTemplate(
  templateDirectory: string,
  fragments: ReadonlyMap<string, string>,
  bundleDirectory: string,
  config: IBudgetConfig = INSTRUCTION_BUDGETS,
): Promise<IInstructionAudit> {
  const template = path.basename(templateDirectory);
  const agentsPath = path.join(templateDirectory, "AGENTS.md");
  const claudePath = path.join(templateDirectory, "CLAUDE.md");
  const source = await readFile(agentsPath, "utf8");
  const rendered = renderInstructionText(source);
  const wordCount = countWords(rendered);
  const violations: IBudgetViolation[] = [];

  const limit = limitFor(template, config);
  if (wordCount > limit) {
    violations.push({
      code: "WORD_BUDGET_EXCEEDED",
      message: `RED observed: template word budget exceeded: '${template}' renders ${wordCount} words, limit ${limit}`,
    });
  }

  const missingMandatory = MANDATORY_INLINE_PROBES.filter(
    ({ pattern }) => !pattern.test(rendered),
  ).map(({ label }) => label);
  for (const label of missingMandatory) {
    violations.push({
      code: "MISSING_MANDATORY_SECTION",
      message: `missing mandatory inline section '${label}' in '${template}'`,
    });
  }

  const references: string[] = [];
  for (const file of referenceTargets(rendered)) {
    references.push(`${REFERENCE_PREFIX}${file}`);
    if (!existsSync(path.join(bundleDirectory, file))) {
      violations.push({
        code: "MISSING_REFERENCE_TARGET",
        message: `RED observed: missing generated reference: '${REFERENCE_PREFIX}${file}' linked from '${template}/AGENTS.md' is not in the shipped bundle`,
      });
    }
  }

  const expectedMirror = mirrorContent(
    expandSharedRegions(source, fragments, `${template}/AGENTS.md`),
  );
  const actualMirror = existsSync(claudePath) ? await readFile(claudePath, "utf8") : undefined;
  if (actualMirror !== expectedMirror) {
    violations.push({
      code: "MIRROR_DRIFT",
      message: `RED observed: agent docs out of sync: '${path.basename(claudePath)}' does not mirror '${path.relative(path.dirname(templateDirectory), agentsPath)}'; run pnpm sync:agents`,
    });
  }

  return {
    limit,
    mirrorPath: claudePath,
    missingMandatory,
    references,
    template,
    violations,
    wordCount,
  };
}

/** Discovers every shipped template under `<repoRoot>/packages/create-threenative/templates`. */
export async function auditAllTemplates(
  repoRoot: string,
  config: IBudgetConfig = INSTRUCTION_BUDGETS,
): Promise<readonly IInstructionAudit[]> {
  const createRoot = path.join(repoRoot, "packages", "create-threenative");
  const templatesDirectory = path.join(createRoot, "templates");
  const bundleDirectory = path.join(createRoot, REFERENCE_DIRECTORY);
  const fragments = await readSharedFragments(repoRoot);
  const entries = (await readdir(templatesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) {
    throw new Error(`INSTRUCTION_BUDGET_TEMPLATES_MISSING: ${templatesDirectory}`);
  }
  return Promise.all(
    entries.map((entry) =>
      auditTemplate(path.join(templatesDirectory, entry), fragments, bundleDirectory, config),
    ),
  );
}

async function main(): Promise<void> {
  const repoRoot = process.argv[2] ?? process.cwd();
  const audits = await auditAllTemplates(repoRoot);
  let failed = false;
  for (const audit of audits) {
    const status = audit.violations.length === 0 ? "OK" : "FAIL";
    console.log(
      `${audit.template.padEnd(12)} ${String(audit.wordCount).padStart(5)}/${audit.limit} words  ${status}`,
    );
    for (const violation of audit.violations) {
      failed = true;
      console.log(`  ${violation.code}: ${violation.message}`);
    }
  }
  if (failed) {
    console.error("RED observed: instruction payload budget failed");
    process.exitCode = 1;
    return;
  }
  console.log(`instruction budgets met across ${audits.length} templates`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
