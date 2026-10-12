// A two-arm bench is a measurement only when both arms did the same work under the same treatment.
// Every fact an arm can differ in without anyone noticing is read from its own output, compared
// across the arms, and a mismatch fails the run with the table. Engine-neutral: the caller names the
// arms and the facets, so the same guard serves legacy against native and ThreeNative against Godot.

/** One run's facts: facet name to a single printable value. */
export type Facets = Record<string, string>;

export interface IParityRow {
  facet: string;
  left: string;
  pass: boolean;
  right: string;
}

export interface IParityOptions {
  /** Fixed values a facet must hold in both arms: both arms wrong the same way is still wrong. */
  expected?: Readonly<Record<string, string>>;
  /** Facets that must appear in both arms; a facet with no value makes the arm unreadable, not equal. */
  required?: readonly string[];
  /** Values both arms were handed from one source (scenario, sources, package bytes), shown for the record. */
  shared?: ReadonlyArray<{
    facet: string;
    left?: string;
    pass?: boolean;
    right?: string;
    value?: string;
  }>;
}

const joined = (runs: readonly Facets[], key: string): string[] => [
  ...new Set(runs.flatMap((run) => (run[key] === undefined ? [] : [run[key]]))),
];

/**
 * One row per facet. A row passes when every run of both arms agrees on one value, so an arm that
 * disagrees with itself across runs fails too.
 */
export function parityRows(
  left: readonly Facets[],
  right: readonly Facets[],
  { expected = {}, required = [], shared = [] }: IParityOptions = {},
): IParityRow[] {
  const keys = [
    ...new Set([...required, ...[...left, ...right].flatMap((run) => Object.keys(run))]),
  ].sort();
  const rows = keys.map((facet): IParityRow => {
    const leftValues = joined(left, facet);
    const rightValues = joined(right, facet);
    const pass =
      leftValues.length === 1 &&
      rightValues.length === 1 &&
      leftValues[0] === rightValues[0] &&
      (expected[facet] === undefined || leftValues[0] === expected[facet]);
    return {
      facet,
      left: leftValues.join(" | ") || "missing",
      pass,
      right: rightValues.join(" | ") || "missing",
    };
  });
  return [
    ...shared.map((row) => ({
      facet: row.facet,
      left: row.left ?? row.value ?? "",
      pass: row.pass ?? true,
      right: row.right ?? row.value ?? "",
    })),
    ...rows,
  ];
}

export function parityTable(
  rows: readonly IParityRow[],
  labels: readonly [string, string] = ["left", "right"],
): string {
  const cell = (value: string) => value.replaceAll("|", "\\|");
  return [
    `| facet | ${labels[0]} | ${labels[1]} | parity |`,
    "| --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.facet} | ${cell(row.left)} | ${cell(row.right)} | ${row.pass ? "match" : "MISMATCH"} |`,
    ),
  ].join("\n");
}

/** The failure message, or undefined when every row matches. */
export function parityProblem(
  rows: readonly IParityRow[],
  labels: readonly [string, string] = ["left", "right"],
): string | undefined {
  const failed = rows.filter((row) => !row.pass);
  return failed.length === 0
    ? undefined
    : `The arms are not apples to apples (${failed.length} facet${failed.length === 1 ? "" : "s"}):\n${parityTable(failed, labels)}`;
}

/** What one run wrote into the driver's on-disk shader caches. */
export interface IDriverCacheDelta {
  added: number;
  bytes: number;
}
export type CacheSnapshot = ReadonlyMap<string, number>;

/**
 * A warm run may append a few shaders to the driver's current cache file; a cold run writes the
 * whole set, megabytes (measured: 18 MB and 2.7 MB cache files), and warms the other arm.
 */
export const COLD_CACHE_BYTES = 1024 * 1024;

export function cacheDelta(before: CacheSnapshot, after: CacheSnapshot): IDriverCacheDelta {
  let added = 0;
  let bytes = 0;
  for (const [file, size] of after) {
    const was = before.get(file);
    if (was === undefined) added++;
    bytes += Math.max(0, size - (was ?? 0));
  }
  return { added, bytes };
}

/** Both arms must emit the same span families; one arm's silence is an instrument gap, not a zero. */
export function assertSymmetricSpans(
  left: Iterable<string>,
  right: Iterable<string>,
  labels: readonly [string, string] = ["left", "right"],
): void {
  const a = new Set(left);
  const b = new Set(right);
  const only = (x: Set<string>, y: Set<string>) => [...x].filter((span) => !y.has(span)).sort();
  const [aOnly, bOnly] = [only(a, b), only(b, a)];
  if (aOnly.length || bOnly.length)
    throw new Error(
      `span families differ: ${labels[0]} only [${aOnly}], ${labels[1]} only [${bOnly}]; the arms must emit the same spans`,
    );
}

const WALL_CLOCK_PHASES = ["render", "update", "ui", "overlay", "residual"] as const;

/**
 * A TN_FRAME_BUDGET window whose render, update, ui, overlay and residual phases all read zero came
 * from a clock that never moves inside a frame (a fixed-step `performance.now`), not from a fast frame.
 * A run that printed no window at all measured nothing, so it fails too.
 */
export function assertWallClock(text: string): void {
  const windows = [...text.matchAll(/TN_FRAME_BUDGET:(\{.+\})/g)].map(
    (match) => JSON.parse(match[1] ?? "{}") as { phases?: Record<string, { mean?: number }> },
  );
  if (windows.length === 0) throw new Error("no TN_FRAME_BUDGET window in the run output");
  const moving = windows.some((window) =>
    WALL_CLOCK_PHASES.some((phase) => (window.phases?.[phase]?.mean ?? 0) > 0),
  );
  if (!moving)
    throw new Error(
      "TN_FRAME_BUDGET phases all read 0: performance.now does not advance inside a frame on this host",
    );
}
