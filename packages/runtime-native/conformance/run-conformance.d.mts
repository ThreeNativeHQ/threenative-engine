/**
 * The declarations `@threenative/three-native` reads from the conformance runner.
 *
 * The runner is plain ESM because it is spawned by `pnpm parity` as `node`, and the fixture
 * differential suite imports its report validator rather than reimplementing the report shape.
 */

/** The report shape version this runner writes and accepts. */
export const REPORT_SCHEMA_VERSION: string;

export interface IReportOptions {
  /** A suite replaces the registry's rows with its own; every other lane matches the registry. */
  readonly suite?: string;
  /** The result ids a report must carry, in order. Defaults to the registry's row ids. */
  readonly expectedIds?: readonly string[];
}

export function validateRegistry(registry: unknown): string[];

export function validateReport(
  report: unknown,
  registry: unknown,
  options?: IReportOptions,
): string[];

export function reportExitCode(report: unknown): number;

export function buildProvenance(options?: {
  readonly runtime?: string | null;
  readonly referenceRoot?: string | null;
  readonly device?: string | null;
  readonly cwd?: string;
}): {
  commit: string;
  dirty: boolean;
  runtimeSha256: string | null;
  referenceSetSha256: string | null;
  device: string | null;
  env: { key: string; valueSha256: string | null }[];
};
