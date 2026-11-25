import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverKitManifests,
  templateForGenre,
} from "../../packages/create-threenative/src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const templatesDirectory = path.join(repoRoot, "packages", "create-threenative", "templates");

/** Every document that tells a reader how to scaffold a game. `getting-started.md` named
 * `defense` for months beside a template table that had no such row, so a new game could not be
 * created with the command the guide printed. */
const SCAFFOLD_DOCS = [
  "README.md",
  path.join("docs", "guides", "getting-started.md"),
  path.join("packages", "create-threenative", "README.md"),
] as const;

/** Template names the guides once used and the package never shipped. Add a name here when a kit
 * is renamed, so the next doc that repeats the old one fails instead of shipping. */
const RETIRED_TEMPLATE_NAMES = ["defense"] as const;

async function shippedTemplates(): Promise<string[]> {
  const entries = await readdir(templatesDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function readDoc(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), "utf8");
}

/** The README's `## Templates` table as `name -> row`, so a missing row and a phantom row are both
 * one assertion rather than a grep nobody runs. */
async function readmeTemplateTable(): Promise<Map<string, string>> {
  const readme = await readDoc("README.md");
  const start = readme.indexOf("## Templates");
  expect(start, "README.md has no ## Templates section").toBeGreaterThanOrEqual(0);
  const end = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, end === -1 ? undefined : end);
  const rows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const name = /^\| `([a-z0-9-]+)`/u.exec(line)?.[1];
    if (name !== undefined) rows.set(name, line);
  }
  return rows;
}

describe("guides name templates the package ships", () => {
  it("should list every shipped template in the README table, and nothing else", async () => {
    const table = await readmeTemplateTable();
    expect([...table.keys()].sort()).toEqual(await shippedTemplates());
  });

  it("should name no retired template in any doc that teaches scaffolding", async () => {
    for (const doc of SCAFFOLD_DOCS) {
      const text = await readDoc(doc);
      for (const retired of RETIRED_TEMPLATE_NAMES) {
        expect(
          text.includes(`\`${retired}\``),
          `${doc} names the retired template \`${retired}\``,
        ).toBe(false);
      }
    }
  });

  it("should resolve every --template example to a shipped directory", async () => {
    const shipped = new Set(await shippedTemplates());
    for (const doc of SCAFFOLD_DOCS) {
      const text = await readDoc(doc);
      for (const match of text.matchAll(/--template ([a-z0-9-]+)/gu)) {
        const name = match[1] ?? "";
        expect(shipped.has(name), `${doc}: --template ${name} is not a template directory`).toBe(
          true,
        );
      }
    }
  });

  it("should resolve every --genre example to the kit its own kit.json claims", async () => {
    const manifests = discoverKitManifests();
    const words = new Set(
      manifests.flatMap(({ aliases, genre }) => [genre.toLowerCase(), ...aliases]),
    );
    const shipped = new Set(await shippedTemplates());
    for (const doc of SCAFFOLD_DOCS) {
      const text = await readDoc(doc);
      for (const match of text.matchAll(/--genre ([a-z0-9-]+)/gu)) {
        const word = match[1] ?? "";
        expect(words.has(word), `${doc}: --genre ${word} is no kit's genre or alias`).toBe(true);
        expect(
          shipped.has(templateForGenre(word)),
          `${doc}: --genre ${word} resolves nowhere`,
        ).toBe(true);
      }
    }
  });

  // The guide prints these two mappings as facts. A kit that renames its alias would otherwise
  // leave the example scaffolding the wrong kit, silently, because `minimal` is a valid fallback.
  it("should map the documented genre examples to the kits the guides promise", () => {
    expect(templateForGenre("mario")).toBe("collectathon");
    expect(templateForGenre("zelda")).toBe("adventure");
    expect(templateForGenre("a-word-no-kit-claims")).toBe("minimal");
  });
});
