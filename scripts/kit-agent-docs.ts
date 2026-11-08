import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * PRD-825: a kit `AGENTS.md` is a router. The flow, MCP and stuck sections are shared fragments in
 * `agent-docs/`. The identity, file map, commands and convention index are generated here, per
 * kit, from `kit.json`, the kit's own tree, `package.json` and `conventions.json`, and expand
 * through the same `<!-- shared: name -->` regions. Each generated region is fail-closed: a kit with
 * no `playtests/survives.playtest.json` or no kit notes page does not render.
 */

const REFERENCE_PREFIX = "node_modules/create-threenative/agent-docs/references/";

export interface IConventionRow {
  readonly default: string;
  readonly id: string;
  readonly kits: "all" | readonly string[];
  readonly marker: string;
  readonly name: string;
  readonly override: string;
  readonly symbol?: string;
}

interface IKitJson {
  readonly aliases?: readonly string[];
  readonly blurb: string;
  readonly genre: string;
  readonly kit: boolean;
  readonly name: string;
  readonly title: string;
}

/** Scripts the router lists, with the one-line comment it prints; absent scripts are skipped. */
const COMMAND_LINES: ReadonlyArray<readonly [script: string, command: string, comment: string]> = [
  ["dev", "pnpm dev", "play in the browser"],
  ["test", "pnpm test", "typecheck, lint, format, then every playtest"],
  ["build", "pnpm build --target desktop", "also: web, android, ios"],
  ["studio", "pnpm studio", "open the game in Studio"],
  ["test:native", "pnpm test:native", "native proof"],
];

export async function readConventionRows(root: string): Promise<readonly IConventionRow[]> {
  const registry = JSON.parse(
    await readFile(path.join(root, "packages", "create-threenative", "conventions.json"), "utf8"),
  ) as { rows: IConventionRow[] };
  return registry.rows;
}

export function rowAppliesTo(row: IConventionRow, kit: string): boolean {
  return row.kits === "all" || row.kits.includes(kit);
}

function markers(marker: string): string {
  return marker === "—"
    ? ""
    : ` Marker: ${marker
        .split(",")
        .map((token) => `\`${token.trim()}\``)
        .join(", ")}.`;
}

export function renderConventions(rows: readonly IConventionRow[], kit: string): string {
  const lines = rows
    .filter((row) => rowAppliesTo(row, kit))
    .map(
      (row) =>
        `- **${row.name}** \`#${row.id}\`: ${row.default}. Override: ${row.override}.${markers(row.marker)}`,
    );
  return [
    "## Conventions",
    "",
    `Each is on by default with a named override. Detail: \`${REFERENCE_PREFIX}conventions.md#<id>\`.`,
    "",
    ...lines,
  ].join("\n");
}

async function listDirectory(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .filter((name) => name !== "style.css")
    .sort();
}

/** The per-kit regions, keyed by the fragment name a kit `AGENTS.md` includes. */
export async function kitFragments(templateDirectory: string): Promise<Map<string, string>> {
  const fragments = new Map<string, string>();
  const manifestPath = path.join(templateDirectory, "kit.json");
  if (!existsSync(manifestPath)) return fragments;
  const kit = path.basename(templateDirectory);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as IKitJson;
  const root = path.resolve(templateDirectory, "..", "..", "..", "..");
  const pages = path.join(root, "packages", "create-threenative", "agent-docs", "references");

  const words = [...new Set([manifest.genre, ...(manifest.aliases ?? [])])].join(", ");
  fragments.set(
    "kit-identity",
    [
      `# AGENTS.md — __PROJECT_NAME__ (${manifest.title}, the ${kit} ${manifest.kit ? "kit" : "template"})`,
      "",
      `${manifest.blurb} Routing words: ${words}. \`CLAUDE.md\` is a copy of this file.`,
    ].join("\n"),
  );

  const survives = path.join(templateDirectory, "playtests", "survives.playtest.json");
  if (!existsSync(survives))
    throw new Error(`${kit}: playtests/survives.playtest.json is missing.`);
  const scenarios = (await readdir(path.join(templateDirectory, "playtests"))).filter((name) =>
    name.endsWith(".playtest.json"),
  ).length;
  const notes = `kit-${kit}.md`;
  if (!existsSync(path.join(pages, notes)))
    throw new Error(`${kit}: reference page ${notes} is missing.`);
  const source = (await listDirectory(path.join(templateDirectory, "src")))
    .map((name) => `\`${name}\``)
    .join(", ");
  fragments.set(
    "kit-files",
    [
      `Source in \`src/\`: ${source}.`,
      `${scenarios} scenarios in \`playtests/\`; \`playtests/survives.playtest.json\` is the smoke proof.`,
      ...(existsSync(path.join(templateDirectory, "src", "render", "exposure.ts"))
        ? [`Exposure policy: \`src/render/exposure.ts\` (\`${REFERENCE_PREFIX}auto-exposure.md\`).`]
        : []),
      `Kit notes: \`${REFERENCE_PREFIX}${notes}\`.`,
    ].join("\n"),
  );

  const scripts = (
    JSON.parse(await readFile(path.join(templateDirectory, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const commands = COMMAND_LINES.filter(([script]) => scripts[script] !== undefined);
  const width = Math.max(...commands.map(([, command]) => command.length), 22) + 2;
  fragments.set(
    "kit-commands",
    [
      "## Commands",
      "",
      "```sh",
      ...commands.map(([, command, comment]) => `${command.padEnd(width)}# ${comment}`),
      `${"npx threenative doctor".padEnd(width)}# build, import, device or blank-frame failure`,
      `${"npx threenative doctor --fix".padEnd(width)}# refresh agent files`,
      "```",
    ].join("\n"),
  );

  fragments.set("kit-conventions", renderConventions(await readConventionRows(root), kit));
  return fragments;
}

/** The floor the registry started from: the 27 caps-scout conventions plus the ones kits state. */
export const MIN_CONVENTION_ROWS = 30;

/**
 * Problems in the registry, empty when it is sound. A row needs a name, a default, a named
 * override and a marker (or "—"); an anchor in the reference page; known kits; and, with a
 * `symbol`, exactly the kits whose `src/` calls it.
 */
export function conventionProblems(
  rows: readonly IConventionRow[],
  page: string,
  kitNames: readonly string[],
  callsSymbol: (kit: string, symbol: string) => boolean,
): string[] {
  const problems: string[] = [];
  if (rows.length < MIN_CONVENTION_ROWS) problems.push(`only ${rows.length} rows`);
  const seen = new Set<string>();
  for (const row of rows) {
    if (!/^[a-z][a-z0-9-]*$/u.test(row.id)) problems.push(`row '${row.id}': id is not kebab-case`);
    if (seen.has(row.id)) problems.push(`row '${row.id}': duplicate id`);
    seen.add(row.id);
    for (const field of ["name", "default", "override", "marker"] as const) {
      if (row[field].trim() === "") problems.push(`row '${row.id}': no ${field}`);
    }
    if (!page.includes(`<a id="${row.id}"></a>`))
      problems.push(`row '${row.id}': no anchor in conventions.md`);
    const kits = row.kits === "all" ? kitNames : row.kits;
    if (kits.length === 0) problems.push(`row '${row.id}': no kit applies it`);
    for (const kit of kits)
      if (!kitNames.includes(kit)) problems.push(`row '${row.id}': unknown kit '${kit}'`);
    if (row.symbol !== undefined) {
      for (const kit of kitNames) {
        if (rowAppliesTo(row, kit) !== callsSymbol(kit, row.symbol)) {
          problems.push(
            `row '${row.id}': kit '${kit}' and the src/ calls of ${row.symbol} disagree`,
          );
        }
      }
    }
  }
  for (const [, anchor] of page.matchAll(/<a id="([^"]+)"><\/a>/gu)) {
    if (anchor !== "general" && !seen.has(anchor ?? ""))
      problems.push(`anchor '${anchor}' has no row`);
  }
  return problems;
}
