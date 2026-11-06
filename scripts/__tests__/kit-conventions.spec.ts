import { existsSync, readFileSync, readdirSync } from "node:fs";
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
function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return "";
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
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

describe("kit convention index", () => {
  it.each(kits)("%s indexes exactly the rows it applies, in AGENTS.md and CLAUDE.md", (kit) => {
    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      const index = section(readFileSync(path.join(TEMPLATES, kit, file), "utf8"), "Conventions");
      expect(index, `${kit}/${file} has no ## Conventions`).not.toBe("");
      for (const row of rows) {
        const line = new RegExp(`^- \\*\\*.+\\*\\* \`#${row.id}\`: `, "mu");
        if (rowAppliesTo(row, kit)) {
          expect(index, `${kit}/${file} is missing convention '${row.id}'`).toMatch(line);
          expect(index, `${kit}/${file} drops the override of '${row.id}'`).toContain(row.override);
        } else {
          expect(index, `${kit}/${file} indexes '${row.id}', which it does not apply`).not.toMatch(
            line,
          );
        }
      }
    }
  });

  it.each(kits)("%s keeps its kit notes page and at most six hand lines", (kit) => {
    const source = readFileSync(path.join(TEMPLATES, kit, "AGENTS.md"), "utf8");
    expect(existsSync(path.join(CREATE, "agent-docs/references", `kit-${kit}.md`))).toBe(true);
    const hand = section(source, "This kit")
      .replace(/<!-- shared: [^>]+ -->[\s\S]*?<!-- \/shared -->/gu, "")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("## "));
    expect(hand.length, `${kit} hand block`).toBeLessThanOrEqual(6);
  });
});

/**
 * PRD-825: the authoring step list lives in two places only, `agent-docs/kit-router.md` (and the
 * kit files generated from it) and the `threenative-capabilities` skill. The engine server
 * instructions, the ponytail hook, the other skills and the reference pages point to that flow.
 */
describe("authoring step list", () => {
  const STEP_LIST = /\*\*Built-ins\*\*|steps? 1-8|steps? 5-7/u;
  const AGENT_FILES = path.join(CREATE, "agent-files");

  function filesUnder(directory: string, suffix: RegExp): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(full, suffix);
      return suffix.test(entry.name) ? [full] : [];
    });
  }

  const outside = [
    path.resolve("packages/engine-mcp/src/index.ts"),
    path.resolve("packages/core/mcp/engine-server.mjs"),
    ...filesUnder(path.join(AGENT_FILES, ".claude"), /\.mjs$/u),
    ...filesUnder(path.join(AGENT_FILES, ".agents/skills"), /SKILL\.md$/u).filter(
      (file) => !file.includes("threenative-capabilities"),
    ),
    ...filesUnder(path.join(CREATE, "agent-docs"), /\.md$/u).filter(
      (file) => !file.endsWith("kit-router.md"),
    ),
  ];

  it("appears only in the router fragment and the capabilities skill", () => {
    expect(outside.length).toBeGreaterThan(10);
    for (const file of outside) {
      expect(readFileSync(file, "utf8"), path.relative(process.cwd(), file)).not.toMatch(STEP_LIST);
    }
  });

  it("is present in both homes", () => {
    for (const file of [
      path.join(CREATE, "agent-docs/kit-router.md"),
      path.join(AGENT_FILES, ".agents/skills/threenative-capabilities/SKILL.md"),
    ]) {
      expect(readFileSync(file, "utf8"), file).toMatch(/\*\*Built-ins\*\*/u);
    }
  });
});
