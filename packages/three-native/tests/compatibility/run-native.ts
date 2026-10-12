/**
 * The native side of the compatibility corpus: run every fixture through a native driver and diff
 * the answers against the pinned reference goldens.
 *
 *   pnpm parity -- --suite native-engine
 *   node packages/three-native/tests/compatibility/run-native.ts --driver <path>
 *
 * The driver speaks the line protocol in `src/fixture-protocol.ts`: the fixture goes in on stdin,
 * one reply per observation comes back on stdout, then the driver exits 0. There is no driver on
 * this machine yet, so every row is reported `blocked`, which is the honest answer and is never
 * `pass`. A render fixture is blocked even with a driver: the native renderer cannot draw a frame
 * yet, so its reason names the work that will (`NATIVE_RENDER_BLOCKED`).
 *
 * The report is the conformance report, not a second format: the same fields, the same validator
 * and the same exit-code rule, under `target: "native-engine"`.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareCaptures } from "../../../runtime-native/conformance/metrics.mjs";
import {
  REPORT_SCHEMA_VERSION,
  buildProvenance,
  reportExitCode,
  validateRegistry,
  validateReport,
} from "../../../runtime-native/conformance/run-conformance.mjs";
import {
  FIXTURES_DIR,
  GOLDENS_DIR,
  type IFixture,
  type IFixtureGolden,
  REPO_ROOT,
  loadFixtures,
  pinnedThreeVersion,
  readGolden,
} from "../../src/fixture-format.js";
import {
  type FixtureStatus,
  type IFixtureResult,
  resolveDriver,
  runFixtures,
} from "../../src/fixture-native.js";

const RUNTIME_ROOT = path.join(REPO_ROOT, "packages", "runtime-native");
const REGISTRY_FILE = path.join(RUNTIME_ROOT, "conformance", "registry.json");
const SUITE = "native-engine";

/** The parity registry row fields this suite fills. Pixel slots stay null: a fixture has no pixels. */
interface IParityResult {
  id: string;
  fixture: {
    readonly adaptedFrom: string;
    readonly observations: number;
    readonly matched: number;
    readonly status: FixtureStatus;
    readonly reason: string;
    readonly firstDifference: IFixtureResult["firstDifference"];
  };
  status: FixtureStatus;
  tolerance: IFixture["tolerance"];
  scene: string | null;
  browser: null;
  native: { readonly completed: boolean; readonly driver: string } | null;
  metrics: { pixelMismatchRatio: null; perceptualDeltaE: null };
  gpuValidationErrors: string[];
  blockedReason?: string;
  failureReason?: string;
}

function valueAfter(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

/** `--out` is a file when it ends in `.json` and a directory otherwise, as the parity runner does. */
function reportPath(out: string | null): string {
  const absolute =
    out === null
      ? path.join(RUNTIME_ROOT, "artifacts", "conformance", SUITE)
      : path.isAbsolute(out)
        ? out
        : path.resolve(REPO_ROOT, out);
  return path.extname(absolute).toLowerCase() === ".json"
    ? absolute
    : path.join(absolute, "report.json");
}

/** The parity result for one fixture, in the shape every other lane's rows use. */
function parityRow(result: IFixtureResult, driver: string | null): IParityResult {
  return {
    id: result.id,
    fixture: {
      adaptedFrom: result.adaptedFrom,
      observations: result.observations,
      matched: result.matched,
      status: result.status,
      reason: result.reason,
      firstDifference: result.firstDifference,
    },
    status: result.status,
    tolerance: result.tolerance,
    // A fixture row compares numbers, not captures: there is no scene and no reference capture.
    scene: null,
    browser: null,
    native: driver === null ? null : { completed: result.status !== "blocked", driver },
    metrics: { pixelMismatchRatio: null, perceptualDeltaE: null },
    gpuValidationErrors: [],
    ...(result.status === "blocked" ? { blockedReason: result.reason } : {}),
    ...(result.status === "fail" ? { failureReason: result.reason } : {}),
  };
}

/** Every recorded golden for this reference version, keyed by fixture name. */
function loadGoldens(version: string): ReadonlyMap<string, IFixtureGolden> {
  const goldens = new Map<string, IFixtureGolden>();
  for (const fixture of loadFixtures(FIXTURES_DIR)) {
    const golden = readGolden(fixture.name, version);
    if (golden !== null) goldens.set(fixture.name, golden);
  }
  return goldens;
}

/**
 * `--only` takes globs over fixture names (`math-core-*`), comma-separated for several
 * (`lit-render,materials-*`), so a ctest case can run part of the corpus without the rest. Only `*`
 * and `?` are wildcards; every other character is the name's own, because a fixture name is an
 * identifier and a regex metacharacter in one is a typo.
 */
export function fixturePattern(globs: string): RegExp {
  const alternatives = globs.split(",").map((glob) =>
    glob
      .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\\\*/gu, ".*")
      .replace(/\\\?/gu, "."),
  );
  return new RegExp(`^(?:${alternatives.join("|")})$`, "u");
}

/** The fixtures `--only` selects, or every fixture. A glob that selects nothing is an error. */
export function selectFixtures(argv: readonly string[]): readonly IFixture[] {
  const fixtures = loadFixtures(FIXTURES_DIR);
  const only = valueAfter(argv, "--only");
  if (only === null) return fixtures;
  const pattern = fixturePattern(only);
  const selected = fixtures.filter((fixture) => pattern.test(fixture.name));
  // Fail closed: an empty run would report a clean summary for a corpus it never touched.
  if (selected.length === 0)
    throw new Error(`TN_FIXTURE_SELECTION_EMPTY: --only ${only} matched none`);
  return selected;
}

function main(argv: readonly string[]): number {
  const version = pinnedThreeVersion(REPO_ROOT);
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as unknown;
  const registryErrors = validateRegistry(registry);
  if (registryErrors.length > 0)
    throw new Error(`Invalid conformance registry:\n- ${registryErrors.join("\n- ")}`);

  const driver = resolveDriver(valueAfter(argv, "--driver"));
  const fixtures = selectFixtures(argv);
  // `--renders`: the driver draws render fixtures, measured against the golden frames with the
  // conformance lane's own comparison. Without it a render fixture stays blocked.
  const renders = argv.includes("--renders")
    ? {
        frameDir: mkdtempSync(path.join(tmpdir(), "tn-native-frames-")),
        goldensDir: path.join(GOLDENS_DIR, version),
        compare: compareCaptures,
      }
    : undefined;
  const results = runFixtures(fixtures, {
    driver,
    version,
    goldens: loadGoldens(version),
    ...(renders === undefined ? {} : { renders }),
  });
  const summary = { pass: 0, fail: 0, blocked: 0, planned: 0, validated: 0 };
  for (const result of results) summary[result.status] += 1;

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    registrySchemaVersion: (registry as { schemaVersion: string }).schemaVersion,
    generatedAt: new Date().toISOString(),
    threeVersion: version,
    mode: "execution",
    target: SUITE,
    project: null,
    host: { platform: process.platform, arch: process.arch, browser: null, runtime: driver },
    provenance: buildProvenance({ runtime: driver, cwd: REPO_ROOT }),
    summary,
    results: results.map((result) => parityRow(result, driver)),
  };
  const reportErrors = validateReport(report, registry, {
    suite: SUITE,
    // The rows this run selected: every fixture, or the prefix `--only` named.
    expectedIds: fixtures.map((fixture) => fixture.name),
  });
  if (reportErrors.length > 0)
    throw new Error(`Generated an invalid conformance report:\n- ${reportErrors.join("\n- ")}`);

  const file = reportPath(valueAfter(argv, "--out"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

  for (const result of results)
    process.stdout.write(
      `${result.status.toUpperCase()} ${result.id}\n${result.reason
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}\n`,
    );
  process.stdout.write(`${JSON.stringify({ wrote: file, suite: SUITE, summary }, null, 2)}\n`);
  if (argv.includes("--allow-blocked") && summary.blocked > 0)
    process.stdout.write(
      `ALLOWED_BLOCKED ${results
        .filter((result) => result.status === "blocked")
        .map((result) => result.id)
        .join(", ")}\n`,
    );
  return reportExitCode(report);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { main as runNativeSuite };
