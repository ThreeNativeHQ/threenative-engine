/**
 * PRD-886: the terrain map stays true.
 *
 * `packages/terrain/docs/architecture/architecture.md` names files an agent edits and folders it lands in. A move
 * that forgets the map leaves an agent reading a path that no longer exists, which is exactly the
 * failure the map was written to end. So this spec fails in the same commit: every repository path
 * the document names in backticks exists, and every folder under the three code roots has a row.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");

/** The map itself, relative to the repository root. */
const MAP = "packages/terrain/docs/architecture/architecture.md";

/** Roots whose every folder must appear in the folder table: one row per place an agent lands in. */
const CENSUS_ROOTS = [
  "packages/terrain/src",
  "examples/strata-terrain-preview/src/render",
  "examples/strata-terrain-preview/scripts",
] as const;

/** A backticked span is a path this spec can check only when it names a repository root. */
const REPO_PATH = /^(?:docs|examples|packages|scripts)\//u;

const map = readFileSync(path.join(repoRoot, MAP), "utf8");

/** Every document in the map's folder: the map plus its companions, all held to real paths. */
const DOCS = readdirSync(path.join(repoRoot, path.dirname(MAP)))
  .filter((name) => name.endsWith(".md"))
  .map((name) => `${path.dirname(MAP)}/${name}`);

function backtickSpans(markdown: string): string[] {
  return Array.from(markdown.matchAll(/`([^`\n]+)`/g), (match) => match[1] as string);
}

/** Every folder below `relative`, itself included, with a trailing slash. */
function foldersUnder(relative: string): string[] {
  const found: string[] = [`${relative}/`];
  for (const entry of readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    found.push(...foldersUnder(`${relative}/${entry.name}`));
  }
  return found;
}

describe("terrain architecture map", () => {
  it.each(DOCS)("%s names only repository paths that exist", (doc) => {
    const named = backtickSpans(readFileSync(path.join(repoRoot, doc), "utf8"))
      .filter((span) => REPO_PATH.test(span))
      // `<world>` is a placeholder filled per starter, and a glob names a set, not one path.
      .filter((span) => !span.includes("<") && !span.includes("*"));
    expect(named.length).toBeGreaterThan(doc === MAP ? 10 : 0);

    const missing = named.filter((span) => !existsSync(path.join(repoRoot, span)));
    expect([...new Set(missing)].sort()).toEqual([]);
  });

  it("names only package scripts that exist", () => {
    const scripts = (manifest: string) =>
      Object.keys(
        (JSON.parse(readFileSync(path.join(repoRoot, manifest), "utf8")) as { scripts: object })
          .scripts,
      );
    const known = new Map([
      ["@threenative/terrain", scripts("packages/terrain/package.json")],
      ["strata-terrain-preview", scripts("examples/strata-terrain-preview/package.json")],
    ]);
    const unknown = DOCS.flatMap((doc) =>
      backtickSpans(readFileSync(path.join(repoRoot, doc), "utf8")).flatMap((span) =>
        Array.from(span.matchAll(/pnpm --filter (\S+) (\S+)/gu), ([call, name, script]) =>
          known.get(name as string)?.includes(script as string) === false ? call : [],
        ).flat(),
      ),
    );
    expect(unknown).toEqual([]);
  });

  it("gives every terrain, preview render and preview script folder a row", () => {
    const spanned = new Set(backtickSpans(map));
    const undocumented = CENSUS_ROOTS.flatMap(foldersUnder).filter(
      (folder) => !spanned.has(folder),
    );
    expect(undocumented).toEqual([]);
  });

  it("keeps the four diagrams and the two tables a reader needs", () => {
    expect(map.match(/```mermaid/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    for (const heading of [
      "## 1. The pipeline",
      "## 2. The packages",
      "## 3. The three producers",
      "## 4. Edit to pixel",
      "## 5. Where a change goes",
      "## 6. Stale output",
      "## 7. Folders",
    ])
      expect(map).toContain(heading);
  });

  it("links the map from the package and preview agent rules", () => {
    for (const agents of [
      "packages/terrain/AGENTS.md",
      "examples/strata-terrain-preview/AGENTS.md",
    ]) {
      const text = readFileSync(path.join(repoRoot, agents), "utf8");
      const target = path.relative(
        path.dirname(agents),
        "packages/terrain/docs/architecture/architecture.md",
      );
      expect(text).toContain(`(${target})`);
      expect(statSync(path.join(repoRoot, agents)).isFile()).toBe(true);
    }
  });
});
