// Performance & Health's server half (PRD-923): the same checks `threenative doctor` runs, plus the
// cooked-asset totals `@threenative/assets` writes to `public/assets.manifest.json`. No check of
// its own: a check the Dashboard shows is a check the CLI shows.
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface IAssetCookRow {
  readonly name: string;
  readonly kind: string;
  readonly before: number;
  readonly after: number;
  /** A texture's quality gate, when the cook measured one. */
  readonly quality?: string;
}

export interface IHealthReport {
  readonly doctor: {
    readonly pass: boolean;
    readonly checks: readonly { name: string; status: string; detail: string; fix?: string }[];
  };
  readonly assets?: {
    readonly before: number;
    readonly after: number;
    readonly rows: readonly IAssetCookRow[];
  };
  readonly at: string;
}

/** `public/assets.manifest.json` as rows and totals; undefined before the first cook. */
export async function assetCook(root: string): Promise<IHealthReport["assets"]> {
  let manifest: { entries?: Record<string, Record<string, unknown>> };
  try {
    manifest = JSON.parse(await readFile(path.join(root, "public/assets.manifest.json"), "utf8"));
  } catch {
    return undefined;
  }
  const rows: IAssetCookRow[] = Object.entries(manifest.entries ?? {}).map(([name, entry]) => {
    const quality = (entry.quality as { status?: unknown } | undefined)?.status;
    return {
      name,
      kind: String(entry.kind ?? "file"),
      before: Number(entry.bytesBefore ?? entry.bytes ?? 0),
      after: Number(entry.bytesAfter ?? entry.bytes ?? 0),
      ...(typeof quality === "string" ? { quality } : {}),
    };
  });
  return {
    before: rows.reduce((sum, row) => sum + row.before, 0),
    after: rows.reduce((sum, row) => sum + row.after, 0),
    rows: rows.sort((a, b) => b.after - a.after),
  };
}

/** One doctor pass plus the cook summary. The doctor module loads on first use only. */
export async function projectHealth(root: string): Promise<IHealthReport> {
  const { readProject, diagnoseProject } = await import("../doctor.js");
  const report = diagnoseProject(await readProject(root));
  return {
    doctor: {
      pass: report.pass,
      checks: report.checks.map((check) => ({
        name: check.name,
        status: check.status,
        detail: check.detail,
        ...(check.fix ? { fix: check.fix } : {}),
      })),
    },
    assets: await assetCook(root),
    at: new Date().toISOString(),
  };
}
