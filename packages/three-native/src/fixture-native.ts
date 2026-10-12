/**
 * The differential half: a native driver's answers against the pinned reference goldens.
 *
 * One driver process per fixture. The fixture goes in as the line protocol on stdin, one reply
 * per observation comes back on stdout, and every observation is compared with the fixture's own
 * tolerance. The three statuses are the whole answer:
 *
 *   pass     every observation matched inside the tolerance
 *   fail     an observation differed; the message names the first difference in bits and decimals
 *   blocked  the driver is missing, or it answered `unsupported` for the fixture or an observation
 *
 * `blocked` is never `pass`. A row nobody ran is a row nobody proved.
 *
 *   pnpm parity -- --suite native-engine
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type IFixture,
  type IFixtureGolden,
  type IFixtureTolerance,
  type IGoldenObservation,
  REPO_ROOT,
  decimalOf,
  numberBits,
  ulpDistance,
} from "./fixture-format.js";
import { type DriverReply, decodeNumbers, encodeFixture, parseReply } from "./fixture-protocol.js";

export type FixtureStatus = "pass" | "fail" | "blocked";

/** A render fixture's reason for being blocked on this side. Named, dated, and never a pass. */
export const NATIVE_RENDER_BLOCKED = "native renderer pending (PRD-514)";

export interface IFirstDifference {
  readonly index: number;
  readonly id: string;
  readonly source: string;
  readonly expected: string;
  readonly expectedDecimal: string;
  readonly actual: string;
  readonly actualDecimal: string;
}

export interface IFixtureResult {
  readonly id: string;
  readonly adaptedFrom: string;
  readonly tolerance: IFixtureTolerance;
  readonly status: FixtureStatus;
  /** The reason a blocked row did not run, or the reason a failure is not a value difference. */
  readonly reason: string;
  readonly observations: number;
  readonly matched: number;
  readonly firstDifference: IFirstDifference | null;
}

/** One reported number, in both forms the message prints. */
function describe(value: number): { readonly bits: string; readonly decimal: string } {
  return { bits: numberBits(value), decimal: decimalOf(value) };
}

/**
 * Why two doubles are not equal inside this tolerance. Null when they are equal.
 *
 * A declared bound is a bound: `{"ulps": 4}` alone does not also demand bit equality. Two values
 * pass when they are inside *any* bound the fixture declared, and fail only when they are outside
 * every one of them.
 */
function mismatch(expected: number, actual: number, tolerance: IFixtureTolerance): string | null {
  // `Object.is` is the bit comparison: -0 differs from 0, and Infinity matches itself. A tolerance
  // of zero still refuses a driver that answers +0 where the reference wrote -0.
  if (Object.is(expected, actual)) return null;
  // One NaN against something that is not NaN. Two NaNs never reach this line: any NaN payload is
  // equal to any other, because hardware raises several for the same invalid operation and a
  // payload is not part of what a driver agreed to compute.
  if (Number.isNaN(expected) || Number.isNaN(actual))
    return `expected ${decimalOf(expected)}, observed ${decimalOf(actual)}`;
  const ulps = tolerance.ulps ?? Number.POSITIVE_INFINITY;
  const distance = Math.abs(expected - actual);
  if (tolerance.ulps !== undefined && ulpDistance(expected, actual) <= ulps) return null;
  // `abs: 0` means bit-exact, and the `Object.is` above already refused a bit difference. Only a
  // wider absolute bound can forgive anything, which is what keeps -0 from passing as 0.
  if (tolerance.abs !== undefined && tolerance.abs > 0 && distance <= tolerance.abs) return null;
  if (distance === 0) return "the sign of zero differs";
  const bound =
    tolerance.ulps === undefined
      ? `absolute tolerance ${decimalOf(tolerance.abs ?? 0)}`
      : tolerance.abs === undefined
        ? `tolerance of ${String(tolerance.ulps)} ulps`
        : `absolute tolerance ${decimalOf(tolerance.abs)} or ${String(tolerance.ulps)} ulps`;
  return `${decimalOf(distance)} apart, outside ${bound}`;
}

/**
 * Compares one observation against its golden.
 *
 * Numbers compare element by element under the tolerance; text, booleans and JSON compare as
 * whole values, because a tolerance on a name or a flag would hide the difference it exists to
 * expose.
 */
export function compareObservation(
  golden: IGoldenObservation,
  actual: DriverReply & { kind: "obs" },
  tolerance: IFixtureTolerance,
): IFirstDifference | null {
  const source =
    golden.path ?? (golden.method === undefined ? "(returned value)" : `${golden.method}()`);
  if (golden.kind === "number" || golden.kind === "numbers") {
    const expectedValues = decodeNumbers(golden.value);
    const actualValues = decodeNumbers(actual.value);
    if (actual.observation !== golden.kind)
      return difference(
        golden,
        source,
        golden.value,
        golden.decimal ?? "",
        actual.value,
        actual.value,
      );
    for (const [position, expected] of expectedValues.entries()) {
      const observed = actualValues[position];
      if (observed === undefined)
        return difference(
          golden,
          source,
          golden.value,
          golden.decimal ?? "",
          actual.value,
          actual.value,
        );
      const reason = mismatch(expected, observed, tolerance);
      if (reason !== null) {
        const left = describe(expected);
        const right = describe(observed);
        return difference(
          golden,
          `${source}[${position}]`,
          `n:${left.bits}`,
          left.decimal,
          `n:${right.bits}`,
          right.decimal,
        );
      }
    }
    return null;
  }
  if (golden.value === actual.value) return null;
  return difference(golden, source, golden.value, golden.decimal ?? "", actual.value, actual.value);
}

function difference(
  golden: IGoldenObservation,
  source: string,
  expected: string,
  expectedDecimal: string,
  actual: string,
  actualDecimal: string,
): IFirstDifference {
  return {
    index: golden.index,
    id: golden.id,
    source,
    expected,
    expectedDecimal,
    actual,
    actualDecimal,
  };
}

export interface IDriverRun {
  readonly lines: readonly string[];
  /** The driver could not run here. The row is blocked, because nothing was proved. */
  readonly blocked?: string;
  /** The driver ran and misbehaved. The row fails, because something was proved and it was wrong. */
  readonly error?: string;
}

/** Runs one fixture against one driver. A driver that cannot run here is a block, never a pass. */
export function runFixture(
  fixture: IFixture,
  driver: string | null,
  renderPng?: string,
): IDriverRun {
  const script = `${encodeFixture(fixture, renderPng).join("\n")}\n`;
  if (driver === null)
    return {
      lines: [],
      blocked: "no native driver: pass --driver PATH or set TN_NATIVE_FIXTURE_DRIVER",
    };
  if (!existsSync(driver)) return { lines: [], blocked: `native driver not found: ${driver}` };
  const command = /\.[cm]?js$/u.test(driver)
    ? { file: process.execPath, prefix: [driver] }
    : { file: driver, prefix: [] };
  const run = spawnSync(command.file, command.prefix, {
    input: script,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  const spawnCode = (run.error as NodeJS.ErrnoException | undefined)?.code;
  if (spawnCode !== undefined && ["ENOENT", "EACCES", "EPERM"].includes(spawnCode))
    return { lines: [], blocked: `native driver could not start: ${run.error?.message ?? driver}` };
  const lines = (run.stdout ?? "").split("\n").filter((line) => line.trim() !== "");
  const error =
    run.error?.message ??
    (run.status === 0
      ? undefined
      : `driver exited ${String(run.status)}${(run.stderr ?? "") === "" ? "" : `: ${(run.stderr ?? "").trim().split("\n").slice(-3).join(" ")}`}`);
  return { lines, ...(error === undefined ? {} : { error }) };
}

/** How two frames differ, as the conformance lane measures it (metrics.mjs compareCaptures). */
export interface IPixelComparison {
  readonly pixelMismatchRatio: number;
  readonly perceptualDeltaE: number;
}

/** What a render-capable driver needs: where to write frames, and how to compare them. */
export interface IRenderOptions {
  readonly frameDir: string;
  readonly goldensDir: string;
  readonly compare: (golden: Uint8Array, native: Uint8Array, levels: number) => IPixelComparison;
}

export interface IRunFixturesOptions {
  readonly driver: string | null;
  /** Present when the driver can draw frames; a render fixture is blocked without it. */
  readonly renders?: IRenderOptions;
  /** Where a fixture with no golden for this reference version is reported. Default: fail. */
  readonly version: string;
  readonly goldens: ReadonlyMap<string, IFixtureGolden>;
}

export function runFixtures(
  fixtures: readonly IFixture[],
  options: IRunFixturesOptions,
): readonly IFixtureResult[] {
  return fixtures.map((fixture) => runOne(fixture, options));
}

function runOne(fixture: IFixture, options: IRunFixturesOptions): IFixtureResult {
  const base = {
    id: fixture.name,
    adaptedFrom: fixture.adaptedFrom,
    tolerance: fixture.tolerance,
    observations: fixture.observe.length,
  };
  // A frame the reference drew in a browser is not a frame the native renderer can draw yet, so the
  // row is blocked before any golden or driver is consulted: a render fixture is never a failure,
  // and never a pass, until the driver can answer a `render` request.
  if (fixture.render !== undefined && options.renders === undefined)
    return {
      ...base,
      status: "blocked",
      reason: NATIVE_RENDER_BLOCKED,
      matched: 0,
      firstDifference: null,
    };
  const golden = options.goldens.get(fixture.name);
  if (golden === undefined)
    return {
      ...base,
      status: "fail",
      reason: `no golden for three ${options.version}: run pnpm --filter @threenative/three-native test:reference`,
      matched: 0,
      firstDifference: null,
    };
  if (golden.blocked !== null)
    return {
      ...base,
      status: "blocked",
      reason: golden.blocked,
      matched: 0,
      firstDifference: null,
    };

  const renderPng =
    fixture.render !== undefined && options.renders !== undefined
      ? path.join(options.renders.frameDir, `${fixture.name}.png`)
      : undefined;
  const run = runFixture(fixture, options.driver, renderPng);
  if (run.blocked !== undefined)
    return { ...base, status: "blocked", reason: run.blocked, matched: 0, firstDifference: null };

  const replies: DriverReply[] = [];
  let parseFailure: string | null = null;
  for (const line of run.lines) {
    try {
      replies.push(parseReply(line));
    } catch (error) {
      parseFailure = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  if (parseFailure !== null)
    return { ...base, status: "fail", reason: parseFailure, matched: 0, firstDifference: null };

  for (const reply of replies) {
    if (reply.kind === "unsupported")
      return {
        ...base,
        status: "blocked",
        reason: `driver reported unsupported${reply.index === null ? "" : ` observation ${reply.index}`}: ${reply.reason}`,
        matched: 0,
        firstDifference: null,
      };
    if (reply.kind === "error")
      return {
        ...base,
        status: "fail",
        reason: `driver error: ${reply.message}`,
        matched: 0,
        firstDifference: null,
      };
  }

  const values = replies.filter((reply) => reply.kind === "obs");
  if (values.length !== golden.observations.length)
    return {
      ...base,
      status: "fail",
      reason: `driver answered ${values.length} observation(s), the fixture asserts ${golden.observations.length}`,
      matched: 0,
      firstDifference: null,
    };
  for (const reply of values) {
    const expected = golden.observations[reply.index];
    if (expected === undefined)
      return {
        ...base,
        status: "fail",
        reason: `driver answered observation ${reply.index}, which the golden does not record`,
        matched: 0,
        firstDifference: null,
      };
    if (expected.kind === "pixels") {
      const failure = comparePixels(fixture, golden, reply.value, options.renders);
      if (failure !== null)
        return { ...base, status: "fail", reason: failure, matched: 0, firstDifference: null };
      continue;
    }
    let found: IFirstDifference | null;
    try {
      found = compareObservation(expected, reply, fixture.tolerance);
    } catch (error) {
      // A driver that prints something this protocol does not define failed this observation. It is
      // a failure of that fixture, not of the run.
      return {
        ...base,
        status: "fail",
        reason: `observation ${reply.index} (${expected.id}) is not a protocol value: ${error instanceof Error ? error.message : String(error)}`,
        matched: 0,
        firstDifference: null,
      };
    }
    if (found !== null)
      return {
        ...base,
        status: "fail",
        reason: [
          `observation ${found.index} (${found.id} ${found.source}) differs`,
          `expected ${found.expected} = ${found.expectedDecimal}`,
          `observed ${found.actual} = ${found.actualDecimal}`,
        ].join("\n"),
        matched: 0,
        firstDifference: found,
      };
  }
  if (run.error !== undefined)
    return { ...base, status: "fail", reason: run.error, matched: 0, firstDifference: null };
  return {
    ...base,
    status: "pass",
    reason: `${golden.observations.length} observation(s) matched`,
    matched: golden.observations.length,
    firstDifference: null,
  };
}

/**
 * A `pixels` observation: the driver's frame against the golden PNG, under the fixture's metric.
 * Returns the failure, or null when the frame is within bounds.
 */
function comparePixels(
  fixture: IFixture,
  golden: IFixtureGolden,
  value: string,
  renders: IRenderOptions | undefined,
): string | null {
  const metric = fixture.observe.find((o) => o.kind === "pixels")?.metric;
  if (renders === undefined || golden.render === undefined || metric === undefined)
    return "a pixels observation needs a render-capable driver, a golden frame and a metric";
  if (!value.startsWith("s:")) return `pixels observation is not a frame path: ${value}`;
  const nativePng = decodeURIComponent(value.slice(2));
  if (!existsSync(nativePng)) return `the driver named a frame it did not write: ${nativePng}`;
  const goldenPng = path.join(renders.goldensDir, golden.render.png);
  let measured: IPixelComparison;
  try {
    measured = renders.compare(
      readFileSync(goldenPng),
      readFileSync(nativePng),
      metric.levels ?? 0,
    );
  } catch (error) {
    return `frame comparison failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const within =
    measured.pixelMismatchRatio <= metric.maxPixelMismatchRatio &&
    measured.perceptualDeltaE <= metric.maxPerceptualDeltaE;
  return within
    ? null
    : `frame differs: pixelMismatchRatio ${measured.pixelMismatchRatio} (max ${metric.maxPixelMismatchRatio}), ` +
        `perceptualDeltaE ${measured.perceptualDeltaE} (max ${metric.maxPerceptualDeltaE}); native ${nativePng}`;
}

/** The driver this machine has, or null. `--driver` wins over the environment. */
export function resolveDriver(
  driver: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const chosen = driver ?? env.TN_NATIVE_FIXTURE_DRIVER ?? null;
  return chosen === null || chosen === "" ? null : path.resolve(REPO_ROOT, chosen);
}
