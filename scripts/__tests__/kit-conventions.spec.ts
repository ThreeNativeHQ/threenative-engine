import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type IConventionRow, conventionProblems, rowAppliesTo } from "../kit-agent-docs.js";

/**
 * PRD-825: one registry of conventions replaces the per-convention phrase specs. A convention
 * missing from a kit's convention index does not exist, so every row must be indexed by every kit
 * that applies it, and by no kit that does not.
 */
const CREATE = path.resolve("packages/create-threenative");
const TEMPLATES = path.join(CREATE, "templates");
const rows = (
  JSON.parse(readFileSync(path.join(CREATE, "conventions.json"), "utf8")) as {
    rows: IConventionRow[];
  }
).rows;
const page = readFileSync(path.join(CREATE, "agent-docs/references/conventions.md"), "utf8");
const kits = readdirSync(TEMPLATES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/u.test(entry.name) ? [full] : [];
  });
}
function callsSymbol(kit: string, symbol: string): boolean {
  const call = new RegExp(`\\b${symbol}\\(`, "u");
  return sourceFiles(path.join(TEMPLATES, kit, "src")).some((file) =>
    call.test(readFileSync(file, "utf8")),
  );
}
describe("convention registry", () => {
  it("is sound: every row has an override, an anchor and real kits", () => {
    expect(conventionProblems(rows, page, kits, callsSymbol)).toEqual([]);
  });

  it("fails closed on a row with no override or no page anchor", () => {
    const [first, ...rest] = rows as [IConventionRow, ...IConventionRow[]];
    const noOverride = [{ ...first, override: " " }, ...rest];
    expect(conventionProblems(noOverride, page, kits, callsSymbol)).toContain(
      `row '${first.id}': no override`,
    );
    const noPage = page.replace(`<a id="${first.id}"></a>`, "");
    expect(conventionProblems(rows, noPage, kits, callsSymbol)).toContain(
      `row '${first.id}': no anchor in conventions.md`,
    );
    const extra = [...rows, { ...first, id: "unlisted-extra" }];
    expect(conventionProblems(extra, page, kits, callsSymbol)).toContain(
      "row 'unlisted-extra': no anchor in conventions.md",
    );
  });
});
