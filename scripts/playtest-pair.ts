import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

type CameraState = "same" | "diff" | "n/a";
type Side = "A" | "B";

export interface IPairOptions {
  entity: string;
  fields: string[];
  equal: string[];
}

export interface IPairArgs {
  pathA: string;
  pathB: string;
  options: IPairOptions;
  json: boolean;
}

export interface IFieldPair {
  a: unknown;
  b: unknown;
}

export interface IPairRow {
  label: string;
  tickA?: number;
  tickB?: number;
  fields: Record<string, IFieldPair>;
  camera: CameraState;
}

export interface IPairMismatch {
  label?: string;
  reason: string;
}

export interface IPairResult {
  rows: IPairRow[];
  mismatches: IPairMismatch[];
}

interface ISample {
  label: string;
  tick: number;
  snapshots: Record<string, Record<string, unknown>>;
}

const CAMERA_FIELDS = ["cameraPosition", "cameraTarget"];

export function parsePairArgs(argv: string[]): IPairArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      entity: { type: "string" },
      fields: { type: "string" },
      equal: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const [pathA, pathB] = positionals;
  if (pathA === undefined || pathB === undefined || positionals.length > 2) {
    throw new Error("Pass exactly two report files.");
  }
  const fields = splitList(values.fields);
  if (!values.entity || fields.length === 0) {
    throw new Error("Pass --entity and at least one name in --fields.");
  }
  return {
    pathA,
    pathB,
    options: { entity: values.entity, fields, equal: splitList(values.equal) },
    json: values.json ?? false,
  };
}

export function pairReports(a: unknown, b: unknown, options: IPairOptions): IPairResult {
  const mismatches: IPairMismatch[] = [];
  const byLabelA = indexByLabel(readSeries(a, "A", mismatches), "A");
  const byLabelB = indexByLabel(readSeries(b, "B", mismatches), "B");
  const labels = [
    ...byLabelA.keys(),
    ...[...byLabelB.keys()].filter((label) => !byLabelA.has(label)),
  ];
  const rows: IPairRow[] = [];

  for (const label of labels) {
    const sa = byLabelA.get(label);
    const sb = byLabelB.get(label);
    rows.push(pairRow(label, sa, sb, options));
    mismatches.push(...rowMismatches(label, sa, sb, options));
  }
  return { rows, mismatches };
}

function pairRow(
  label: string,
  sa: ISample | undefined,
  sb: ISample | undefined,
  options: IPairOptions,
): IPairRow {
  const row: IPairRow = { label, tickA: sa?.tick, tickB: sb?.tick, fields: {}, camera: "n/a" };
  for (const field of options.fields) {
    row.fields[field] = {
      a: fieldValue(sa, options.entity, field),
      b: fieldValue(sb, options.entity, field),
    };
  }
  if (sa && sb) {
    row.camera = cameraState(sa, sb, options.entity);
  }
  return row;
}

function rowMismatches(
  label: string,
  sa: ISample | undefined,
  sb: ISample | undefined,
  options: IPairOptions,
): IPairMismatch[] {
  if (!sa || !sb) {
    return [{ label, reason: sa ? "missing in B" : "missing in A" }];
  }
  const found: IPairMismatch[] = [];
  for (const field of options.equal) {
    const va = fieldValue(sa, options.entity, field);
    const vb = fieldValue(sb, options.entity, field);
    if (va === undefined || vb === undefined) {
      found.push({ label, reason: `${field} is missing` });
    } else if (!sameValue(va, vb)) {
      found.push({ label, reason: `${field} differs: ${formatValue(va)}|${formatValue(vb)}` });
    }
  }
  return found;
}

function readSeries(report: unknown, side: Side, mismatches: IPairMismatch[]): ISample[] {
  const series = (report as { observations?: { componentSeries?: unknown } } | null)?.observations
    ?.componentSeries;
  if (series === undefined || series === null) {
    mismatches.push({ reason: `series ${side} is missing` });
    return [];
  }
  if (!Array.isArray(series)) {
    throw new Error(`componentSeries of series ${side} is not an array.`);
  }
  if (series.length === 0) {
    mismatches.push({ reason: `series ${side} is empty` });
  }
  return series.map(readSample);
}

function readSample(value: unknown): ISample {
  const { label, tick, snapshots } = (value ?? {}) as Record<string, unknown>;
  if (
    typeof label !== "string" ||
    typeof tick !== "number" ||
    typeof snapshots !== "object" ||
    snapshots === null
  ) {
    throw new Error("componentSeries sample needs label, tick and snapshots.");
  }
  return { label, tick, snapshots } as ISample;
}

function indexByLabel(samples: ISample[], side: Side): Map<string, ISample> {
  const index = new Map<string, ISample>();
  for (const sample of samples) {
    if (index.has(sample.label)) {
      throw new Error(`series ${side} repeats label "${sample.label}".`);
    }
    index.set(sample.label, sample);
  }
  return index;
}

function fieldValue(sample: ISample | undefined, entity: string, field: string): unknown {
  return sample?.snapshots[entity]?.[field];
}

function cameraState(a: ISample, b: ISample, entity: string): CameraState {
  const pairs = CAMERA_FIELDS.map((field) => ({
    a: fieldValue(a, entity, field),
    b: fieldValue(b, entity, field),
  }));
  if (pairs.some((pair) => pair.a === undefined || pair.b === undefined)) {
    return "n/a";
  }
  return pairs.every((pair) => sameValue(pair.a, pair.b)) ? "same" : "diff";
}

// ponytail: compares JSON text, so key order counts. Add a deep-equal if reports reorder keys.
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function renderTable(result: IPairResult, fields: string[]): string {
  const header = ["label", "tickA", "tickB", ...fields, "camera"];
  const body = result.rows.map((row) => [
    row.label,
    row.tickA === undefined ? "-" : String(row.tickA),
    row.tickB === undefined ? "-" : String(row.tickB),
    ...fields.map((field) => {
      const pair = row.fields[field];
      return `${formatValue(pair?.a)}|${formatValue(pair?.b)}`;
    }),
    row.camera,
  ]);
  const lines = [header, ...body];
  const widths = header.map((_, column) =>
    Math.max(...lines.map((line) => line[column]?.length ?? 0)),
  );
  const text = lines.map((line) =>
    line
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  for (const mismatch of result.mismatches) {
    text.push(`mismatch ${mismatch.label ? `${mismatch.label}: ` : ""}${mismatch.reason}`);
  }
  return text.join("\n");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(argv: string[]): number {
  try {
    const args = parsePairArgs(argv);
    const result = pairReports(readJson(args.pathA), readJson(args.pathB), args.options);
    const text = args.json
      ? JSON.stringify(result, null, 2)
      : renderTable(result, args.options.fields);
    process.stdout.write(`${text}\n`);
    return result.mismatches.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`playtest-pair: ${messageOf(error)}\n`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
