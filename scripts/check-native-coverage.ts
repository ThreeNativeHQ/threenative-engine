import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const REGENERATE = "run `pnpm --filter @threenative/runtime-native native:coverage`";

/**
 * A committed floor more than this many percentage points below its measured value is stale
 * slack: it would let a real coverage regression ship without the gate noticing. Floors ratchet
 * up to `measured - margin`; a floor already tighter than that is never loosened.
 */
export const NATIVE_COVERAGE_FLOOR_MARGIN = 5;

type CoverageBySubsystem = Map<string, number>;

function parseTable(record: string, heading: string): CoverageBySubsystem {
  const start = record.indexOf(heading);
  if (start < 0) throw new Error(`native coverage record is missing ${heading}`);
  const values = new Map<string, number>();
  for (const line of record.slice(start).split(/\r?\n/u).slice(2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2 || cells[0]?.includes("---") || cells[0]?.includes("TOTAL")) continue;
    const subsystem = cells[0]?.replaceAll("`", "");
    const percentage = cells.at(-1)?.replace("%", "");
    if (!subsystem || !percentage || !/^\d+(?:\.\d+)?$/u.test(percentage)) {
      throw new Error(`native coverage record contains a malformed row: ${line}`);
    }
    if (values.has(subsystem)) {
      throw new Error(`native coverage record contains duplicate row: ${subsystem}`);
    }
    values.set(subsystem, Number(percentage));
  }
  if (values.size === 0) throw new Error(`native coverage record has no rows under ${heading}`);
  return values;
}

export function nativeCoverageGateErrors(record: string, currentDigest: string): string[] {
  const digest = record.match(/Source digest: `sha256:([a-f0-9]+)`/u)?.[1];
  if (!digest) throw new Error("native coverage record is missing its source digest");
  const measured = parseTable(
    record,
    "| Subsystem | Instrumented lines | Covered | Line coverage |",
  );
  const floors = parseTable(record, "| Coverage floor | Minimum |");
  const errors: string[] = [];
  if (digest !== currentDigest) {
    errors.push(
      `native coverage report is stale: source digest changed to ${currentDigest}; ${REGENERATE}`,
    );
  }
  const measuredSubsystems = [...measured.keys()].sort();
  const floorSubsystems = [...floors.keys()].sort();
  if (measuredSubsystems.join("\0") !== floorSubsystems.join("\0")) {
    errors.push(
      `native coverage floor set differs from measured subsystems: measured [${measuredSubsystems.join(", ")}], floors [${floorSubsystems.join(", ")}]`,
    );
  }
  for (const [subsystem, floor] of floors) {
    const actual = measured.get(subsystem);
    if (actual === undefined) {
      errors.push(`native coverage omitted floor subsystem: ${subsystem}`);
    } else if (actual < floor) {
      errors.push(
        `native coverage dropped: ${subsystem} measured ${actual.toFixed(2)}%, floor ${floor.toFixed(2)}%`,
      );
    } else if (Math.round((actual - floor) * 100) > NATIVE_COVERAGE_FLOOR_MARGIN * 100) {
      errors.push(
        `native coverage floor too loose: ${subsystem} floor ${floor.toFixed(2)}%, measured ${actual.toFixed(2)}%; raise it to at least ${(actual - NATIVE_COVERAGE_FLOOR_MARGIN).toFixed(2)}% (measured - ${NATIVE_COVERAGE_FLOOR_MARGIN} percentage points)`,
      );
    }
  }
  return errors;
}

export async function nativeSourceDigest(root: string): Promise<string> {
  const evidenceModule = (await import(
    new URL("../packages/runtime-native/scripts/native-coverage-evidence.mjs", import.meta.url).href
  )) as { nativeCoverageEvidenceDigest(runtimeRoot: string): string };
  return evidenceModule.nativeCoverageEvidenceDigest(path.join(root, "packages", "runtime-native"));
}

export async function checkNativeCoverage(root: string): Promise<void> {
  const recordPath = path.join(root, "docs", "verification", "native-coverage-2026-08-28.md");
  if (!existsSync(recordPath)) throw new Error(`native coverage record is missing: ${recordPath}`);
  const errors = nativeCoverageGateErrors(
    await readFile(recordPath, "utf8"),
    await nativeSourceDigest(root),
  );
  if (errors.length > 0) throw new Error(errors.join("\n"));
}
