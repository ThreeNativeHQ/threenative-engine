import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_SERVERS } from "../../packages/core/mcp/servers.mjs";
import { discoverTemplateNames } from "../../packages/create-threenative/src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const guidesDirectory = path.join(repoRoot, "docs", "guides");

/** The published documentation. A shipped surface that appears in none of these is a surface a
 * reader cannot find, which is how whole systems (spells, particles, navigation) went undocumented
 * while the code shipped. */
async function guideTexts(): Promise<Array<{ name: string; text: string }>> {
  const names = (await readdir(guidesDirectory)).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await readFile(path.join(guidesDirectory, name), "utf8"),
    })),
  );
}

async function coreSubpaths(): Promise<string[]> {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "packages", "core", "package.json"), "utf8"),
  ) as { exports?: Record<string, unknown> };
  return Object.keys(manifest.exports ?? {})
    .filter((entry) => entry.startsWith("./") && entry !== "./package.json")
    .sort();
}

/** Every shipped package name, from the manifest each one declares. */
async function packageNames(): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(path.join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = await readFile(
      path.join(repoRoot, "packages", entry.name, "package.json"),
      "utf8",
    ).catch(() => undefined);
    if (manifest === undefined) continue;
    const name = (JSON.parse(manifest) as { name?: string }).name;
    if (name !== undefined) names.push(name);
  }
  return names.sort();
}

/** One read of every shipped source file, so a `TN_*` code a guide quotes is checked against the
 * code that raises it rather than against a list this spec maintains by hand. */
async function sourceText(): Promise<string> {
  const chunks: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "templates") {
          continue;
        }
        await walk(entryPath);
      } else if (/\.(?:ts|mjs)$/u.test(entry.name)) {
        // Specs count: a guide may document a test lane's own opt-in variable.
        chunks.push(await readFile(entryPath, "utf8").catch(() => ""));
      }
    }
  };
  await walk(path.join(repoRoot, "packages"));
  await walk(path.join(repoRoot, "scripts"));
  return chunks.join("\n");
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  eight: 8,
  eleven: 11,
  fifteen: 15,
  five: 5,
  four: 4,
  fourteen: 14,
  nine: 9,
  nineteen: 19,
  one: 1,
  seven: 7,
  seventeen: 17,
  six: 6,
  sixteen: 16,
  ten: 10,
  thirteen: 13,
  three: 3,
  twelve: 12,
  twenty: 20,
  two: 2,
};

describe("the guides cover what ships", () => {
  it("should document every @threenative/core subpath", async () => {
    const guides = await guideTexts();
    for (const subpath of await coreSubpaths()) {
      const specifier =
        subpath === "." ? "@threenative/core" : `@threenative/core/${subpath.slice(2)}`;
      // A boundary, not `includes`: `react` is a prefix of `react-css`, and `spells` of
      // `spells/ultra`, so one documented subpath would otherwise vouch for its neighbour.
      const pattern = new RegExp(`${specifier.replace(/[/.]/gu, "\\$&")}(?![a-z0-9/-])`, "u");
      const named = guides.filter(({ text }) => pattern.test(text)).map(({ name }) => name);
      expect(named, `${specifier} appears in no guide`).not.toEqual([]);
    }
  });

  it("should name every shipped package in a guide", async () => {
    const guides = await guideTexts();
    const missing = (await packageNames()).filter(
      (name) => !guides.some(({ text }) => text.includes(name)),
    );
    expect(missing, "shipped packages no guide mentions").toEqual([]);
  });

  it("should quote only TN_ codes the source raises", async () => {
    const guides = await guideTexts();
    const quoted = new Set<string>();
    for (const { text } of guides) {
      for (const match of text.matchAll(/TN_[A-Z0-9_]+/gu)) quoted.add(match[0]);
    }
    expect(quoted.size).toBeGreaterThan(20);
    const source = await sourceText();
    const phantom = [...quoted].filter((code) => !source.includes(code)).sort();
    expect(phantom, "a guide quotes a TN_ code no source line raises").toEqual([]);
  });

  it("should name every wired MCP server in a guide", async () => {
    const guides = await guideTexts();
    for (const server of Object.keys(MCP_SERVERS)) {
      const named = guides.filter(({ text }) => text.includes(server)).map(({ name }) => name);
      expect(named, `${server} is wired by servers.mjs and no guide names it`).not.toEqual([]);
    }
  });

  // "eight templates" outlived the tenth one by two releases, and a guide that lists ten of sixteen
  // is a reader's first impression. The count a doc states is checked against the directories that
  // exist, in the two places that state one.
  it("should state the shipped template count the package actually has", async () => {
    const shipped = discoverTemplateNames().length;
    expect(shipped).toBeGreaterThan(10);
    for (const relative of [
      path.join("docs", "guides", "getting-started.md"),
      path.join("packages", "create-threenative", "README.md"),
    ]) {
      const text = await readFile(path.join(repoRoot, relative), "utf8");
      const stated = /(\w+) templates ship/u.exec(text)?.[1];
      expect(stated, `${relative} states no template count`).toBeDefined();
      expect(
        NUMBER_WORDS[(stated ?? "").toLowerCase()],
        `${relative} states "${stated}" templates`,
      ).toBe(shipped);
    }
  });
});
