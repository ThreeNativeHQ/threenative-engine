import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_SERVERS } from "../../packages/core/mcp/servers.mjs";
import { threenativeCommands } from "../../packages/create-threenative/src/commands.js";
import { cliHelp as scaffoldCliHelp } from "../../packages/create-threenative/src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The primary docs an authoring agent reads before it can find the code. Generated CLAUDE.md
 * mirrors are deliberately absent: they follow their AGENTS.md sources, enforced by
 * scripts/__tests__/sync-agent-docs.spec.ts instead. */
const PRIMARY_DOCS = [
  "README.md",
  "AGENTS.md",
  path.join("docs", "architecture", "AGENT-INTERFACE.md"),
  path.join("packages", "create-threenative", "AGENTS.md"),
] as const;

async function readRepoFile(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), "utf8");
}

async function countPlaytestFiles(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) count += await countPlaytestFiles(entryPath);
    else if (entry.name.endsWith(".playtest.json")) count += 1;
  }
  return count;
}

interface IShippedPackage {
  readonly public: boolean;
}

async function shippedPackages(): Promise<Map<string, IShippedPackage>> {
  const packages = new Map<string, IShippedPackage>();
  const entries = await readdir(path.join(repoRoot, "packages"), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, "packages", entry.name, "package.json"), "utf8"),
    ) as { name?: string; publishConfig?: { access?: string } };
    if (manifest.name === undefined) continue;
    packages.set(manifest.name, {
      public: manifest.publishConfig?.access === "public",
    });
  }
  return packages;
}

/** External ThreeNative packages the templates pin (the asset MCP server is one; it lives on npm,
 * not in this workspace) — real shipped surfaces a doc may name. */
async function templatePinnedPackages(): Promise<Set<string>> {
  const pinned = new Set<string>();
  const templates = path.join(repoRoot, "packages", "create-threenative", "templates");
  for (const entry of await readdir(templates, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(
      await readFile(path.join(templates, entry.name, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const source of [
      manifest.dependencies ?? {},
      manifest.devDependencies ?? {},
      manifest.optionalDependencies ?? {},
    ]) {
      for (const name of Object.keys(source)) {
        if (/^(?:@threenative\/|threenative-|create-)/u.test(name)) pinned.add(name);
      }
    }
  }
  return pinned;
}

async function workspacePinnedPackages(): Promise<Set<string>> {
  const pinned = new Set<string>();
  const packagesRoot = path.join(repoRoot, "packages");
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(
      await readFile(path.join(packagesRoot, entry.name, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const source of [manifest.dependencies, manifest.optionalDependencies]) {
      for (const name of Object.keys(source ?? {})) pinned.add(name);
    }
  }
  return pinned;
}

/** Server names written into every generated project's `.mcp.json` by installing core. */
async function shippedMcpServerNames(): Promise<string[]> {
  const config = JSON.parse(
    await readRepoFile(
      path.join("packages", "create-threenative", "templates", "starter", ".mcp.json"),
    ),
  ) as { mcpServers?: Record<string, unknown> };
  return Object.keys(config.mcpServers ?? {});
}

function packageTokens(rawDoc: string): Set<string> {
  // A Markdown link destination names a file path, not a surface (`PRD-084-threenative-studio.md`
  // is history, not a shipped package), so only labels and prose are scanned.
  const doc = rawDoc.replace(/\]\([^)]*\)/gu, "]()");
  return new Set(
    [
      ...doc.matchAll(
        /@threenative\/[a-z0-9-]+|\b(?:create-threenative|threenative-[a-z][a-z-]*)\b/gu,
      ),
    ].map((match) => match[0]),
  );
}

/** `threenative <word>` invocations in prose or code. The scaffolder form (`pnpm create
 * threenative my-game`) names a directory, not a command, so it is skipped here and checked as
 * `create-threenative <subcommand>` separately. */
function threenativeCommandClaims(doc: string): Set<string> {
  const claims = new Set<string>();
  for (const match of doc.matchAll(/(?<![\w.@/-])threenative\s+([a-z][a-z0-9]*)/gu)) {
    const start = match.index ?? 0;
    if (/create\s*$/u.test(doc.slice(Math.max(0, start - 7), start))) continue;
    claims.add(match[1] ?? "");
  }
  return claims;
}

function scaffolderCommandClaims(doc: string): Set<string> {
  return new Set(
    [...doc.matchAll(/(?<![\w@/-])create-threenative\s+([a-z][a-z0-9]*)/gu)].map(
      (match) => match[1] ?? "",
    ),
  );
}

function scaffoldSubcommands(help: string): Set<string> {
  const commands = new Set<string>();
  const body = help.slice(help.indexOf("Commands:")).split("\n").slice(1);
  for (const line of body) {
    if (line.trim().length === 0) break;
    const match = /^ {2}([a-z][a-z0-9-]*)\b/u.exec(line);
    if (match?.[1] !== undefined) commands.add(match[1]);
  }
  return commands;
}

describe("primary documentation agrees with the shipped surfaces", () => {
  // The same gap: leaving AGENT-INTERFACE at three servers passed every check, so the one document
  // that describes the agent surface could describe a surface that no longer exists.
  it("should name every MCP server the scaffold wires in the agent interface", async () => {
    const document = await readFile(
      path.resolve(repoRoot, "docs/architecture/AGENT-INTERFACE.md"),
      "utf8",
    );
    const wired = Object.keys(MCP_SERVERS);
    expect(wired.length).toBeGreaterThan(3);
    for (const name of wired) expect(document, name).toContain(`\`${name}\``);
  });

  it("should name only packages that a shipped manifest declares", async () => {
    const allowed = new Set([
      ...(await shippedPackages()).keys(),
      ...(await templatePinnedPackages()),
      ...(await workspacePinnedPackages()),
      ...(await shippedMcpServerNames()),
    ]);
    for (const docPath of PRIMARY_DOCS) {
      const unknown = [...packageTokens(await readRepoFile(docPath))].filter(
        (token) => !allowed.has(token),
      );
      expect(unknown, `${docPath} names packages no shipped manifest declares`).toEqual([]);
    }
  });

  it("should list every published package in the README without a version column", async () => {
    const readme = await readRepoFile("README.md");
    const tokens = packageTokens(readme);
    expect(readme).toContain("| Package | Purpose |\n| --- | --- |");
    expect(readme).not.toContain("| Package | Version | Purpose |");
    for (const [name, shipped] of [...(await shippedPackages()).entries()].sort()) {
      if (!shipped.public) continue;
      expect(tokens.has(name), `README omits the shipped package ${name}`).toBe(true);
      const row = readme
        .split("\n")
        .find((line) => line.startsWith("| ") && line.includes(`\`${name}\``));
      expect(row, `README has no Packages table row for ${name}`).toBeDefined();
    }
  });

  it("should advertise only commands the executable CLIs dispatch", async () => {
    const canonicalCommands = new Set<string>(threenativeCommands);
    const canonicalScaffoldCommands = scaffoldSubcommands(scaffoldCliHelp());
    expect(canonicalScaffoldCommands.size).toBeGreaterThan(0);
    for (const docPath of PRIMARY_DOCS) {
      const doc = await readRepoFile(docPath);
      const phantom = [...threenativeCommandClaims(doc)].filter(
        (command) => !canonicalCommands.has(command),
      );
      expect(
        phantom,
        `${docPath} advertises a threenative command the CLI does not dispatch`,
      ).toEqual([]);
      const phantomScaffold = [...scaffolderCommandClaims(doc)].filter(
        (command) => !canonicalScaffoldCommands.has(command),
      );
      expect(
        phantomScaffold,
        `${docPath} advertises a create-threenative subcommand that does not exist`,
      ).toEqual([]);
    }
  });

  it("should keep the engine capability route discoverable", async () => {
    const engineServerSource = await readRepoFile(
      path.join("packages", "engine-mcp", "src", "index.ts"),
    );
    const tools = [
      ...new Set(
        [...engineServerSource.matchAll(/"(engine_[a-z_]+)"/gu)].map((match) => match[1] ?? ""),
      ),
    ].sort();
    expect(tools.length).toBeGreaterThan(0);
    for (const docPath of ["AGENTS.md", path.join("docs", "architecture", "AGENT-INTERFACE.md")]) {
      const doc = await readRepoFile(docPath);
      for (const tool of tools) {
        expect(doc.includes(tool), `${docPath} never names the shipped tool ${tool}`).toBe(true);
      }
      expect(
        doc.includes("threenative-engine-mcp"),
        `${docPath} never names the shipped engine MCP server`,
      ).toBe(true);
    }
  });

  it("should keep Charter's reference workload tied to executable scenarios", async () => {
    const scenarioDirectory = path.join(
      repoRoot,
      "packages",
      "create-threenative",
      "templates",
      "platformer",
      "playtests",
    );
    const scenarioCount = await countPlaytestFiles(scenarioDirectory);
    expect(
      scenarioCount,
      "platformer scenario count changed; update the Charter with the tree",
    ).toBe(16);

    const charter = await readRepoFile(path.join("docs", "architecture", "CHARTER.md"));
    const start = charter.indexOf("### 10a. Performance");
    const end = charter.indexOf("### 10b. Cost caps");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const workload = charter.slice(start, end).replace(/\s+/gu, " ");
    expect(workload).toContain(
      `It is the reference template with the broadest scenario suite: ${scenarioCount} playtest files`,
    );
    expect(workload).not.toMatch(/heaviest|source LOC/iu);
  });

  it("should distinguish an assertion frame from visual inspection", async () => {
    const quality = await readRepoFile(path.join("docs", "verification", "PRD-251-quality.md"));
    expect(quality).toContain("--no-screenshots");
    expect(quality).toContain("captureMethod: page.screenshot");
    expect(quality).toContain("No visual inspection was performed");
    expect(quality).not.toMatch(/\binspected\b/iu);
  });
  it("names material controls or the explicit custom-storm exception in generated instructions", async () => {
    const root = path.join(repoRoot, "packages/create-threenative/templates");
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const instructions = await readFile(path.join(root, entry.name, "AGENTS.md"), "utf8");
      expect(instructions, entry.name).toContain("rimGain");
      expect(instructions, entry.name).toContain("fillGain");
      if (entry.name === "rain") {
        expect(instructions).toContain("conversion is unqualified");
        expect(instructions).toContain("radiance is unknown until sampled");
      } else {
        expect(instructions, entry.name).toContain("TN_ENVIRONMENT_CONTRIBUTION");
        expect(instructions, entry.name).toMatch(/original materials|retain originals/u);
      }
    }
  });
});
