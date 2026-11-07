import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { MCP_HOSTS } from "../../core/mcp/install.mjs";
import { createProject, discoverTemplateNames } from "../src/index.js";

/**
 * PRD-826: what a generated game receives is an allowlist, not whatever the kit directory held.
 * The tree-hash pin in `scaffold.spec.ts` only detects change, and a re-pin accepts a new junk file
 * without comment. Here a new kind of file fails until someone writes the pattern and its reason.
 */

const templates = discoverTemplateNames();

const HOST_CONFIG_FILES = MCP_HOSTS.map((host) => host.file.replaceAll("\\", "/"));

/** Every path a scaffold may hold, with the reason it ships. First match wins. */
const ALLOWED: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(AGENTS|CLAUDE)\.md$/u, "the agent instruction pair"],
  [
    /^(package\.json|tsconfig\.json|vite\.config\.ts|threenative\.config\.ts|index\.html|main\.html|tailwind\.config\.ts|eslint\.config\.js|biome\.json|\.gitignore)$/u,
    "project and tool configuration",
  ],
  [
    new RegExp(
      `^(${HOST_CONFIG_FILES.map((file) => file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})$`,
      "u",
    ),
    "one MCP host config per supported agent host, written by the scaffolder",
  ],
  [
    /^(\.codex\/hooks\.json|\.claude\/(settings\.json|hooks\/|agents\/|skills\/)|\.agents\/skills\/|\.threenative\/agents\/)/u,
    "the canonical agent roles, skills and hooks from agent-files",
  ],
  [/^scripts\/(reference|visual-loop)\.mjs$/u, "the two authoring scripts agent-files ships"],
  [
    /^\.threenative\/agent-files\.json$/u,
    "the authoring layer stamp threenative doctor --fix reads (PRD-829)",
  ],
  [/^patches\//u, "the dependency patches a kit's package.json declares"],
  [/^(src|public|assets|playtests|native-playtests|tools)\//u, "the kit's own game content"],
];

/** Names that are junk wherever they sit: lookup data the scaffolder consumes, and stray output. */
const FORBIDDEN_ANYWHERE =
  /(^|\/)(kit\.json|README\.md|\.DS_Store|Thumbs\.db)$|\.(log|bak|orig|tmp)$/u;

/** The paths of `files` that match no allowlist pattern or match a forbidden name. */
function unexpectedPaths(files: readonly string[]): string[] {
  return files.filter(
    (file) => FORBIDDEN_ANYWHERE.test(file) || !ALLOWED.some(([pattern]) => pattern.test(file)),
  );
}

describe("scaffold file allowlist", () => {
  it("rejects a stray note, a README, a log and the lookup file", () => {
    expect(
      unexpectedPaths(["notes.md", "README.md", "src/run.log", "kit.json", "AGENTS.md"]),
    ).toEqual(["notes.md", "README.md", "src/run.log", "kit.json"]);
  });

  it(
    "gives every kit a scaffold of allowed paths only",
    async () => {
      const root = await makeTempDir("threenative-scaffold-allowlist-");
      const unexpected: string[] = [];
      for (const template of templates) {
        const { target } = await createProject(
          { install: false, target: template, template },
          root,
        );
        const entries = await readdir(target, { recursive: true, withFileTypes: true });
        const files = entries
          .filter((entry) => !entry.isDirectory())
          .map((entry) =>
            path.relative(target, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
          );
        for (const file of unexpectedPaths(files)) unexpected.push(`${template}/${file}`);
      }
      expect(unexpected, "a scaffold holds a file no allowlist pattern names").toEqual([]);
    },
    Math.max(60_000, templates.length * 6_000),
  );
});
