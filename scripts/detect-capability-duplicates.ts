import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The reinvention gate (PRD-187 phase 2). A game reaching past an engine capability to the raw
 * API it wraps cannot merge silently: every public capability may declare `@supersedes <source
 * construct>` in its doc tags, and this gate fails on game source containing that construct,
 * naming the superseding symbol. The escape is an inline fact, not a review conversation:
 * annotate the line `// engine-override: <reason>` and the hit is legitimate by construction.
 *
 * Two structural rules cover the reinventions that are not a single call (a hand-written A* calls
 * no superseded construct), each earned by a real prior miss rather than speculation. The list is
 * deliberately closed: every rule costs false positives forever.
 *
 * The old name-token heuristic survives only behind `--names`, advisory, because it measured
 * 25% precision (4 findings, 1 true positive, 2 real misses against fps-framework at 46dfa34)
 * and fired on exactly the wrong things. It is kept for its occasional true positive, never gated.
 *
 * Usage:
 *   pnpm tsx scripts/detect-capability-duplicates.ts <project-dir>… [--strict] [--names]
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ISupersession {
  /** Source construct that means the capability was bypassed, e.g. `new Raycaster(` */
  readonly construct: string;
  /** The capability that replaces the construct. */
  readonly symbol: string;
  /** Where the capability is imported from. */
  readonly importPath: string;
}

export interface IFinding {
  readonly file: string;
  readonly line: number;
  readonly construct: string;
  readonly symbol: string;
  readonly importPath: string;
}

/** A finding whose `// engine-override:` annotation carries no reason. Always fatal. */
export interface IEmptyOverride extends IFinding {
  readonly emptyOverride: true;
}

export interface IReinventionReport {
  readonly filesScanned: number;
  readonly findings: readonly IFinding[];
  readonly emptyOverrides: readonly IEmptyOverride[];
}

/**
 * Structural rules: token co-occurrences that mean a capability was rebuilt from scratch.
 * `required` tokens must all appear; for rules with `anyOf`, at least one must too. Anchored at
 * the first line carrying a `primary` match.
 */
interface IStructuralRule {
  readonly id: string;
  readonly construct: string;
  readonly symbol: string;
  readonly importPath: string;
  readonly primary: RegExp;
  readonly required: readonly RegExp[];
  readonly anyOf?: readonly RegExp[];
  /** When set, the rule skips files containing this token anywhere (an import or a mention). */
  readonly exemptToken?: string;
}

const STRUCTURAL_RULES: readonly IStructuralRule[] = [
  {
    construct: "hand-written grid pathfinding (gScore plus an open-set/fScore/cameFrom map)",
    id: "hand-written-pathfinding",
    importPath: "@threenative/physics/navigation",
    // The fps sandbox's #findPath used fScore/gScore/cameFrom over Maps and no openSet name, so
    // the open-set arm is disjunctive. gScore alone would also catch Dijkstra variants — close
    // enough cousins of the same miss.
    anyOf: [/\bcameFrom\b/u, /\bfScore\b/u, /\bopenSet\b/u, /\bfrontier\b/u],
    primary: /\bgScore\b/u,
    required: [/\bgScore\b/u],
    symbol: "NavigationAgent3D",
  },
  {
    construct: "zero-opacity surface kept visible instead of prewarmed",
    id: "prewarm-by-hand",
    importPath: "@threenative/core",
    primary: /opacity\s*[:=]\s*0(?![.\d])/u,
    required: [/opacity\s*[:=]\s*0(?![.\d])/u, /\.visible\s*=\s*true\b/u],
    exemptToken: "prewarm",
    symbol: "prewarm",
  },
];

const OVERRIDE_ANNOTATION = /\/\/\s*engine-override:(.*)$/u;

/**
 * Blank out comments and string contents while preserving line structure, so constructs are
 * matched in code only. Template-literal `${…}` nesting is treated as literal text — a construct
 * hidden inside an interpolation is missed rather than false-positive.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let index = 0;
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        out += "  ";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        out += "  ";
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        state = char === "'" ? "single" : char === '"' ? "double" : "template";
        out += " ";
        index += 1;
        continue;
      }
      out += char;
      index += 1;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += "\n";
      } else out += " ";
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (char === "\\") {
      out += "  ";
      index += 2;
      continue;
    }
    if (char === quote) {
      state = "code";
      out += " ";
      index += 1;
      continue;
    }
    out += char === "\n" ? "\n" : " ";
    index += 1;
  }
  return out;
}

/**
 * Read the override annotation for a finding on `lineIndex` (0-based). Returns:
 * - `undefined` — no annotation;
 * - a trimmed non-empty string — a valid reason;
 * - an empty string — an annotation with no reason, which still fails the gate.
 */
function overrideReason(lines: readonly string[], lineIndex: number): string | undefined {
  for (const candidate of [lines[lineIndex], lines[lineIndex - 1]]) {
    if (candidate === undefined) continue;
    const match = OVERRIDE_ANNOTATION.exec(candidate);
    if (match !== null) return match[1]?.trim() ?? "";
  }
  return undefined;
}

async function walkSources(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      out.push(...(await walkSources(full)));
    } else if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/u.test(entry.name) &&
      !/\.spec\.|\.test\./u.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Scan one file's stripped code for literal constructs and structural rules. */
async function scanFile(
  file: string,
  relativeName: string,
  supersessions: readonly ISupersession[],
): Promise<{ emptyOverrides: IEmptyOverride[]; findings: IFinding[] }> {
  const raw = await readFile(file, "utf8");
  const lines = raw.split(/\r?\n/u);
  const code = stripCommentsAndStrings(raw);
  const codeLines = code.split(/\r?\n/u);
  const findings: IFinding[] = [];
  const emptyOverrides: IEmptyOverride[] = [];

  const record = (lineIndex: number, session: ISupersession): void => {
    const reason = overrideReason(lines, lineIndex);
    const finding: IFinding = {
      construct: session.construct,
      file: relativeName,
      importPath: session.importPath,
      line: lineIndex + 1,
      symbol: session.symbol,
    };
    if (reason === undefined) findings.push(finding);
    else if (reason.length === 0) emptyOverrides.push({ ...finding, emptyOverride: true });
  };

  for (const session of supersessions) {
    for (let index = 0; index < codeLines.length; index += 1) {
      if (codeLines[index]?.includes(session.construct) === true) record(index, session);
    }
  }

  for (const rule of STRUCTURAL_RULES) {
    if (rule.exemptToken !== undefined && raw.includes(rule.exemptToken)) continue;
    const hasRequired = rule.required.every((pattern) => pattern.test(code));
    if (!hasRequired) continue;
    if (rule.anyOf !== undefined && !rule.anyOf.some((pattern) => pattern.test(code))) continue;
    for (let index = 0; index < codeLines.length; index += 1) {
      if (rule.primary.test(codeLines[index] ?? "")) {
        record(index, {
          construct: rule.construct,
          importPath: rule.importPath,
          symbol: rule.symbol,
        });
        break;
      }
    }
  }

  return { emptyOverrides, findings };
}

/**
 * Scan every source file under `projectRoot` for superseded constructs. Structural-rule hits are
 * folded into the same finding list; the name-overlap heuristic lives in `--names` main-only.
 */
export async function detectReinventions(
  projectRoot: string,
  supersessions: readonly ISupersession[],
): Promise<IReinventionReport> {
  // A scaffolded project keeps its code in src/; scanning the whole tree would drag scratch
  // directories and probe scripts into a gate. Projects without src/ (a workspace root holding
  // several) are walked whole, with dependencies excluded by name.
  const sourceRoot = path.join(projectRoot, "src");
  const walkRoot = existsSync(sourceRoot) ? sourceRoot : projectRoot;
  const files = await walkSources(walkRoot);
  const findings: IFinding[] = [];
  const emptyOverrides: IEmptyOverride[] = [];
  for (const file of files) {
    const result = await scanFile(file, path.relative(projectRoot, file), supersessions);
    findings.push(...result.findings);
    emptyOverrides.push(...result.emptyOverrides);
  }
  return { filesScanned: files.length, findings, emptyOverrides };
}

export function loadSupersessions(manifest: {
  entries: readonly { importPath: string; supersedes: readonly string[]; symbol: string }[];
}): ISupersession[] {
  return (
    manifest.entries
      // Only game-authoring surfaces count. Harness-internal exports (@threenative/playtest runner
      // machinery) are not something a game imports, so matching them manufactures noise.
      .filter(
        (entry) =>
          /@threenative\/(?:core|physics)/u.test(entry.importPath) && entry.supersedes.length > 0,
      )
      .flatMap((entry) =>
        entry.supersedes.map((construct) => ({
          construct,
          importPath: entry.importPath,
          symbol: entry.symbol,
        })),
      )
  );
}

// --- The retired heuristic, kept advisory behind --names -------------------------------
// Measured at 4 findings / 1 true positive / 2 real misses against fps-framework at 46dfa34.
// It fires on unrelated names sharing a noun and stays silent on private-method reinvention —
// the two failures it was written to catch. Never wire this into a failing gate.

const NAME_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "update",
  "create",
  "make",
  "load",
  "build",
  "resolve",
  "tag",
  "capture",
  "default",
  "face",
  "normal",
]);

interface ICapabilityEntry {
  readonly importPath: string;
  readonly kind: string;
  readonly symbol: string;
}

function nameTokens(value: string): readonly string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.replace(/[0-9]+$/u, "").toLowerCase())
    .filter((token) => token.length >= 4 && !NAME_STOPWORDS.has(token));
}

function roleOverlap(left: readonly string[], right: readonly string[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (a === b) return true;
      if (
        a.length >= 5 &&
        b.length >= 5 &&
        (a.startsWith(b.slice(0, -1)) || b.startsWith(a.slice(0, -1)))
      )
        return true;
    }
  }
  return false;
}

const EXPORT_PATTERN =
  /export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(class|function|const)\s+([A-Za-z][A-Za-z0-9_]*)/gu;

async function advisoryNameFindings(
  projectRoot: string,
  capabilities: readonly ICapabilityEntry[],
): Promise<IFinding[]> {
  const findings: IFinding[] = [];
  for (const file of await walkSources(projectRoot)) {
    const content = await readFile(file, "utf8");
    if (content.includes("@threenative")) continue; // already importing the engine — not a rewrite
    for (const match of content.matchAll(EXPORT_PATTERN)) {
      const [, kind, symbol] = match;
      if (kind === undefined || symbol === undefined) continue;
      const tokens = nameTokens(symbol);
      if (tokens.length === 0) continue;
      const hit = capabilities.find((capability) =>
        roleOverlap(tokens, nameTokens(capability.symbol)),
      );
      if (hit !== undefined) {
        findings.push({
          construct: `export ${kind} ${symbol} (name-overlap, advisory)`,
          file: path.relative(projectRoot, file),
          importPath: hit.importPath,
          line: content.slice(0, match.index ?? 0).split("\n").length,
          symbol: hit.symbol,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const names = args.includes("--names");
  const projects = args.filter((argument) => !argument.startsWith("--"));
  if (projects.length === 0) {
    console.error(
      "usage: tsx scripts/detect-capability-duplicates.ts <game-project-dir>… [--strict] [--names]",
    );
    process.exitCode = 2;
    return;
  }

  const manifest: {
    entries: { importPath: string; supersedes: readonly string[]; symbol: string }[];
  } = JSON.parse(await readFile(path.join(repoRoot, "packages/core/capabilities.json"), "utf8"));
  const supersessions = loadSupersessions(manifest);

  let failed = false;
  for (const project of projects) {
    const projectRoot = path.resolve(project);
    const report = await detectReinventions(projectRoot, supersessions);
    for (const finding of [...report.findings, ...report.emptyOverrides]) {
      failed = true;
      if ("emptyOverride" in finding) {
        console.error(
          `${path.join(path.relative(process.cwd(), projectRoot), finding.file)}:${finding.line}: // engine-override: needs a reason on the construct line or the one above`,
        );
        continue;
      }
      console.error(
        `${path.join(path.relative(process.cwd(), projectRoot), finding.file)}:${finding.line}: \`${finding.construct}\` — \`${finding.symbol}\` (${finding.importPath}) supersedes it. Use ${finding.symbol}, or annotate this line // engine-override: <reason>`,
      );
    }
    if (report.findings.length === 0 && report.emptyOverrides.length === 0) {
      console.log(`${project}: no superseded constructs across ${report.filesScanned} files`);
    }
    if (names) {
      const capabilities = manifest.entries
        .filter((entry) => /@threenative\/(?:core|physics)/u.test(entry.importPath))
        .map((entry) => ({ importPath: entry.importPath, kind: "", symbol: entry.symbol }));
      for (const finding of await advisoryNameFindings(projectRoot, capabilities)) {
        console.warn(
          `[advisory] ${path.join(project, finding.file)}:${finding.line}: possible duplicate of ${finding.symbol} (${finding.importPath}); go read both before keeping this copy`,
        );
      }
    }
  }

  if (failed && strict) process.exitCode = 1;
  else if (failed) console.warn("findings above; pass --strict to fail (budgets does)");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  await main();
}
