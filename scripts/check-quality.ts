import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";

export const LIMITS = {
  fileNotice: 400,
  fileLoud: 800,
  fileCap: 3000,
  biomeIgnoreBaseline: 1,
  unknownCastBaseline: 10,
} as const;

const BASELINE_PATH = path.join("docs", "verification", "quality-baseline.json");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

export type QualityState = "new" | "grew" | "inherited" | "waived";

export type QualityFinding = {
  file: string;
  line: number;
  signal: string;
  value: number | string;
  threshold: number | string;
  state: QualityState;
};

type BaselineFinding = Omit<QualityFinding, "state">;

type QualityBaseline = {
  version: 1;
  generatedAt: string;
  counts: Record<string, number>;
  findings: BaselineFinding[];
};

type RawFinding = Omit<QualityFinding, "state">;

type Waiver = { file: string; line: number; reason: string };

function relativePath(root: string, absolute: string): string {
  return path.relative(root, absolute).replaceAll(path.sep, "/");
}

function lineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split(/\r?\n/u).length - (source.endsWith("\n") ? 1 : 0);
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolute)));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

async function packageSourceRoots(root: string): Promise<string[]> {
  const entries = await readdir(path.join(root, "packages"), { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, "packages", entry.name, "src"))
    .filter((directory) => existsSync(directory));
}

async function allPackageSourceRoots(root: string): Promise<string[]> {
  const entries = await readdir(path.join(root, "packages"), { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, "packages", entry.name, "src"))
    .filter((directory) => existsSync(directory));
}

function finding(
  file: string,
  line: number,
  signal: string,
  value: number | string,
  threshold: number | string,
): RawFinding {
  return { file, line, signal, value, threshold };
}

function objectTypeAliasFindings(file: string, source: string): RawFinding[] {
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const findings: RawFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node) && /^[A-Z]/u.test(node.name.text)) {
      let type = node.type;
      while (ts.isParenthesizedTypeNode(type)) type = type.type;
      if (ts.isTypeLiteralNode(type)) {
        findings.push(
          finding(
            file,
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            "interface-in-disguise",
            "object type alias",
            "interface",
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function waiverFromLine(file: string, line: number, sourceLine: string): Waiver | undefined {
  const match = sourceLine.match(/\/\/\s*quality-allow(?::\s*(.*))?$/u);
  if (!match) return undefined;
  return { file, line, reason: match[1]?.trim() ?? "" };
}

async function readBiomeIgnorePatterns(root: string): Promise<string[]> {
  const config = JSON.parse(await readFile(path.join(root, "biome.json"), "utf8")) as {
    files?: { ignore?: unknown };
  };
  if (config.files?.ignore === undefined) return [];
  if (
    !Array.isArray(config.files.ignore) ||
    !config.files.ignore.every((pattern): pattern is string => typeof pattern === "string")
  ) {
    throw new Error("biome.json files.ignore must be an array of strings.");
  }
  return config.files.ignore;
}

async function collectCoverageFindings(root: string): Promise<RawFinding[]> {
  const patterns = await readBiomeIgnorePatterns(root);
  const roots = await allPackageSourceRoots(root);
  return roots.flatMap((sourceRoot) => {
    const packageName = path.basename(path.dirname(sourceRoot));
    const packageRoot = `packages/${packageName}`;
    const sourcePath = `${packageRoot}/src`;
    const ignored = patterns.some(
      (pattern) =>
        pattern === `${packageRoot}/**` ||
        pattern === sourcePath ||
        pattern.startsWith(`${sourcePath}/`),
    );
    const hasNativeLint =
      packageName === "runtime-native" &&
      existsSync(path.join(path.dirname(sourceRoot), ".clang-tidy"));
    return ignored && !hasNativeLint
      ? [finding(relativePath(root, sourceRoot), 1, "lint-coverage-hole", "ignored", "linted")]
      : [];
  });
}

async function collectSourceFindings(root: string): Promise<{
  findings: RawFinding[];
  waivers: Waiver[];
}> {
  const findings: RawFinding[] = [];
  const waivers: Waiver[] = [];
  for (const sourceRoot of await packageSourceRoots(root)) {
    for (const absolute of await filesUnder(sourceRoot)) {
      const file = relativePath(root, absolute);
      const source = await readFile(absolute, "utf8");
      const lines = source.split(/\r?\n/u);
      const length = lineCount(source);
      if (length > LIMITS.fileNotice) {
        findings.push(
          finding(
            file,
            1,
            "file-length",
            length,
            length > LIMITS.fileLoud ? LIMITS.fileLoud : LIMITS.fileNotice,
          ),
        );
      }
      if (length > LIMITS.fileCap)
        findings.push(finding(file, 1, "file-cap", length, LIMITS.fileCap));
      lines.forEach((sourceLine, index) => {
        const line = index + 1;
        const waiver = waiverFromLine(file, line, sourceLine);
        if (waiver) waivers.push(waiver);
        if (sourceLine.includes("biome-ignore"))
          findings.push(
            finding(
              file,
              line,
              "suppression/biome-ignore",
              "biome-ignore",
              LIMITS.biomeIgnoreBaseline,
            ),
          );
        if (/@ts-(?:ignore|expect-error)/u.test(sourceLine))
          findings.push(finding(file, line, "suppression/ts-directive", "@ts-*", 0));
        if (/as unknown as/u.test(sourceLine))
          findings.push(
            finding(
              file,
              line,
              "suppression/unknown-cast",
              "as unknown as",
              LIMITS.unknownCastBaseline,
            ),
          );
        if (/\/\/\s*quality-allow(?:\s*:.*)?$/u.test(sourceLine) && waiver?.reason === "")
          findings.push(finding(file, line, "waiver-without-reason", "", "non-empty reason"));
      });
      findings.push(...objectTypeAliasFindings(file, source));
    }
  }
  findings.push(...(await collectCoverageFindings(root)));
  return { findings, waivers };
}

function findingKey(value: Pick<RawFinding, "file" | "line" | "signal">): string {
  return `${value.file}:${value.line}:${value.signal}`;
}

function findingGroupKey(value: Pick<RawFinding, "file" | "signal">): string {
  return `${value.file}:${value.signal}`;
}

function waiverTarget(
  findings: readonly RawFinding[],
  waiver: Waiver,
  claimed: ReadonlySet<string>,
): RawFinding | undefined {
  const candidates = findings.filter(
    (candidate) =>
      candidate.file === waiver.file &&
      candidate.line >= waiver.line &&
      candidate.line <= waiver.line + 1 &&
      candidate.signal !== "waiver-without-reason" &&
      candidate.signal !== "stale-waiver" &&
      !claimed.has(findingKey(candidate)),
  );
  return (
    candidates.find((candidate) => candidate.line === waiver.line + 1) ??
    candidates.find((candidate) => candidate.line === waiver.line)
  );
}

function applyWaivers(findings: RawFinding[], waivers: Waiver[]): RawFinding[] {
  const result = [...findings];
  const claimed = new Set<string>();
  for (const waiver of waivers) {
    if (waiver.reason === "") continue;
    const target = waiverTarget(result, waiver, claimed);
    if (target) claimed.add(findingKey(target));
    else
      result.push(
        finding(waiver.file, waiver.line, "stale-waiver", waiver.reason, "a current finding"),
      );
  }
  return result;
}

function waivedFindingKeys(findings: RawFinding[], waivers: Waiver[]): Set<string> {
  const waived = new Set<string>();
  for (const waiver of waivers) {
    if (waiver.reason === "") continue;
    const target = waiverTarget(findings, waiver, waived);
    if (target) waived.add(findingKey(target));
  }
  return waived;
}

function closestBaselineIndex(remaining: readonly BaselineFinding[], line: number): number {
  const first = remaining[0];
  if (first === undefined) return -1;
  let index = 0;
  for (let candidate = 1; candidate < remaining.length; candidate += 1) {
    const candidateRow = remaining[candidate];
    const selectedRow = remaining[index];
    if (candidateRow === undefined || selectedRow === undefined) continue;
    if (Math.abs(candidateRow.line - line) < Math.abs(selectedRow.line - line)) index = candidate;
  }
  return index;
}

function assignBaselineRow(
  item: RawFinding,
  index: number,
  remaining: BaselineFinding[],
  matches: Map<string, BaselineFinding>,
): void {
  const recorded = remaining.splice(index, 1)[0];
  if (recorded !== undefined) matches.set(findingKey(item), recorded);
}

function assignExactBaselineRows(
  current: readonly RawFinding[],
  remaining: BaselineFinding[],
  matches: Map<string, BaselineFinding>,
): void {
  const exact = current.filter((item) => remaining.some((recorded) => recorded.line === item.line));
  for (const item of exact) {
    const index = remaining.findIndex((recorded) => recorded.line === item.line);
    if (index >= 0) assignBaselineRow(item, index, remaining, matches);
  }
}

function assignRemainingBaselineRows(
  current: readonly RawFinding[],
  remaining: BaselineFinding[],
  matches: Map<string, BaselineFinding>,
  waived: ReadonlySet<string>,
  isWaived: boolean,
): void {
  for (const item of current) {
    const key = findingKey(item);
    if (matches.has(key) || waived.has(key) !== isWaived) continue;
    if (remaining.length === 0) break;
    assignBaselineRow(item, closestBaselineIndex(remaining, item.line), remaining, matches);
  }
}

function matchBaselineFindings(
  findings: readonly RawFinding[],
  baseline: readonly BaselineFinding[],
  waived: ReadonlySet<string>,
): ReadonlyMap<string, BaselineFinding> {
  const currentGroups = new Map<string, RawFinding[]>();
  for (const item of findings) {
    const key = findingGroupKey(item);
    currentGroups.set(key, [...(currentGroups.get(key) ?? []), item]);
  }
  const baselineGroups = new Map<string, BaselineFinding[]>();
  for (const item of baseline) {
    const key = findingGroupKey(item);
    baselineGroups.set(key, [...(baselineGroups.get(key) ?? []), item]);
  }

  const matches = new Map<string, BaselineFinding>();
  for (const [key, current] of currentGroups) {
    const remaining = [...(baselineGroups.get(key) ?? [])];
    assignExactBaselineRows(current, remaining, matches);

    // A newly inserted waived row can sort before the unchanged row it accompanies. Reserve
    // remaining baseline rows for current unwaived findings first, then let a waived current row
    // inherit one only when no unwaived row can account for it.
    assignRemainingBaselineRows(current, remaining, matches, waived, false);
    assignRemainingBaselineRows(current, remaining, matches, waived, true);
  }
  return matches;
}

function validateBaseline(value: unknown, file: string): QualityBaseline {
  if (typeof value !== "object" || value === null)
    throw new Error(`Malformed quality baseline at ${file}.`);
  const candidate = value as Partial<QualityBaseline>;
  if (candidate.version !== 1 || typeof candidate.generatedAt !== "string")
    throw new Error(`Malformed quality baseline at ${file}: version and generatedAt are required.`);
  if (
    !Array.isArray(candidate.findings) ||
    typeof candidate.counts !== "object" ||
    candidate.counts === null
  )
    throw new Error(`Malformed quality baseline at ${file}: findings and counts are required.`);
  const findings = candidate.findings as unknown[];
  if (
    !findings.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const finding = item as Partial<BaselineFinding>;
      return (
        typeof finding.file === "string" &&
        typeof finding.line === "number" &&
        Number.isInteger(finding.line) &&
        finding.line > 0 &&
        typeof finding.signal === "string" &&
        (typeof finding.value === "number" || typeof finding.value === "string") &&
        (typeof finding.threshold === "number" || typeof finding.threshold === "string")
      );
    })
  )
    throw new Error(
      `Malformed quality baseline at ${file}: every finding needs file, line, signal, value, and threshold.`,
    );
  const counts = candidate.counts as Record<string, unknown>;
  if (!Object.values(counts).every((count) => Number.isInteger(count) && (count as number) >= 0))
    throw new Error(`Malformed quality baseline at ${file}: counts must be non-negative integers.`);
  const expectedCounts = countBySignal(findings as RawFinding[]);
  const countsMatchFindings =
    Object.keys(counts).length === Object.keys(expectedCounts).length &&
    Object.entries(expectedCounts).every(([signal, count]) => counts[signal] === count);
  if (!countsMatchFindings)
    throw new Error(`Malformed quality baseline at ${file}: counts must match findings.`);
  return {
    version: 1,
    generatedAt: candidate.generatedAt,
    counts: counts as Record<string, number>,
    findings: findings as BaselineFinding[],
  };
}

export async function loadQualityBaseline(root = process.cwd()): Promise<QualityBaseline> {
  const file = path.join(root, BASELINE_PATH);
  if (!existsSync(file))
    throw new Error(
      `Quality baseline missing at ${relativePath(root, file)}; run pnpm quality --update-baseline.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Malformed quality baseline at ${relativePath(root, file)}: ${String(error)}`);
  }
  return validateBaseline(parsed, relativePath(root, file));
}

function countBySignal(findings: readonly RawFinding[]): Record<string, number> {
  return findings.reduce<Record<string, number>>((counts, current) => {
    counts[current.signal] = (counts[current.signal] ?? 0) + 1;
    return counts;
  }, {});
}

export async function collectQualityFindings(root = process.cwd()): Promise<RawFinding[]> {
  const source = await collectSourceFindings(root);
  return applyWaivers(source.findings, source.waivers).sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.signal.localeCompare(right.signal),
  );
}

export async function updateQualityBaseline(root = process.cwd()): Promise<QualityBaseline> {
  const findings = await collectQualityFindings(root);
  const baseline: QualityBaseline = {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: countBySignal(findings),
    findings,
  };
  const file = path.join(root, BASELINE_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

export async function runQuality(root = process.cwd()): Promise<QualityFinding[]> {
  const baseline = await loadQualityBaseline(root);
  const source = await collectSourceFindings(root);
  const findings = applyWaivers(source.findings, source.waivers);
  const waived = waivedFindingKeys(findings, source.waivers);
  const baselineMatches = matchBaselineFindings(findings, baseline.findings, waived);
  return findings
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.signal.localeCompare(right.signal),
    )
    .map((item) => {
      const recorded = baselineMatches.get(findingKey(item));
      if (waived.has(findingKey(item))) return { ...item, state: "waived" as const };
      if (recorded === undefined) return { ...item, state: "new" as const };
      const grew =
        typeof item.value === "number" && typeof recorded.value === "number"
          ? item.value > recorded.value
          : String(item.value) !== String(recorded.value);
      return { ...item, state: grew ? ("grew" as const) : ("inherited" as const) };
    });
}

export function fatalQualityFindings(
  findings: readonly QualityFinding[],
): readonly QualityFinding[] {
  return findings.filter((item) => {
    if (item.signal === "waiver-without-reason" || item.signal === "stale-waiver") return true;
    // A god file regrows the moment the gate lets it: the cap is fatal, the length notices stay advisory.
    if (item.signal === "file-cap") return item.state === "new" || item.state === "grew";
    // A terrain stage file over the loud threshold is a god file in the making: PRD-886 split one
    // folder per stage so the next one fails here instead of joining the baseline.
    if (item.signal === "file-length" && item.file.startsWith("packages/terrain/src/"))
      return (
        typeof item.value === "number" &&
        item.value > LIMITS.fileLoud &&
        (item.state === "new" || item.state === "grew")
      );
    const suppressionClass =
      item.signal.startsWith("suppression/") || item.signal === "lint-coverage-hole";
    return suppressionClass && (item.state === "new" || item.state === "grew");
  });
}

function printHuman(findings: readonly QualityFinding[]): void {
  const counts = findings.reduce<Record<string, number>>((result, item) => {
    result[item.state] = (result[item.state] ?? 0) + 1;
    return result;
  }, {});
  console.log(
    `quality report: ${findings.length} findings (${counts.new ?? 0} new, ${counts.grew ?? 0} grew, ${counts.inherited ?? 0} inherited, ${counts.waived ?? 0} waived)`,
  );
  for (const item of findings)
    console.log(
      `${item.state.padEnd(9)} ${item.file}:${item.line} ${item.signal} value=${String(item.value)} threshold=${String(item.threshold)}`,
    );
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  if (process.argv.includes("--update-baseline")) {
    const baseline = await updateQualityBaseline();
    console.log(`quality baseline updated: ${baseline.findings.length} findings`);
    return;
  }
  const findings = await runQuality();
  if (json) {
    for (const item of findings) console.log(JSON.stringify(item));
  } else printHuman(findings);
  const fatal = fatalQualityFindings(findings);
  if (fatal.length > 0) {
    console.error(
      `quality gate failed: ${fatal.length} fatal finding(s) are new, grew, or lack a waiver reason`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
