import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  expandSharedRegions,
  fragmentsFor,
  mirrorContent,
  readSharedFragments,
} from "./sync-agent-docs.js";

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
  // PRD-825: a kit `AGENTS.md` is a router of at most 120 lines, bounded by one word maximum for
  // every kit. A new convention is a row in `conventions.json`, not a paragraph here, so no kit
  // carries an override. History of the old per-kit caps: docs/verification/instruction-budgets-*.md.
  //
  // 1,250 measured 2026-11-12 after PRD-880's `#gamepad` row: the widest kit renders 1,234 words
  // and four others sat within four words of the old 1,200, so one mandatory convention row broke
  // six kits. The cap is that measured maximum plus one median row (15 words).
  defaultMaxWords: 1250,
  overrides: {},
};

/** The line cap a generated kit `AGENTS.md` and its mirror keep (PRD-825). */
export const INSTRUCTION_MAX_LINES = 120;

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
  | "LINE_BUDGET_EXCEEDED"
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
  const expanded = expandSharedRegions(
    source,
    await fragmentsFor(agentsPath, fragments),
    `${template}/AGENTS.md`,
  );
  const rendered = renderInstructionText(expanded);
  const wordCount = countWords(rendered);
  const violations: IBudgetViolation[] = [];

  const limit = limitFor(template, config);
  if (wordCount > limit) {
    violations.push({
      code: "WORD_BUDGET_EXCEEDED",
      message: `RED observed: template word budget exceeded: '${template}' renders ${wordCount} words, limit ${limit}`,
    });
  }

  const lines = expanded.split(/\r?\n/u).length;
  if (lines > INSTRUCTION_MAX_LINES) {
    violations.push({
      code: "LINE_BUDGET_EXCEEDED",
      message: `RED observed: template line budget exceeded: '${template}' has ${lines} lines, limit ${INSTRUCTION_MAX_LINES}`,
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
    expandSharedRegions(source, await fragmentsFor(agentsPath, fragments), `${template}/AGENTS.md`),
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
