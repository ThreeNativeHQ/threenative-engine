import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import * as capabilityManifest from "../build-capability-manifest.js";
import {
  budgetErrors,
  budgetTriggers,
  capabilityManifestErrors,
  collectBudgets,
  enforceBudgets,
  measureNativeCensusAreas,
  nativeCensusDrift,
} from "../check-budgets";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await makeTempDir("threenative-budget-");
  temporaryRoots.push(root);
  return root;
}

async function nativeFixture(root: string): Promise<void> {
  const directory = path.join(root, "packages", "runtime-native");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "runtime.cpp"), "owned");
  await writeFile(path.join(directory, "CMakeLists.txt"), "owned");
}

async function writeCapabilityPackage(
  root: string,
  directory: string,
  name: string,
  source: string,
): Promise<void> {
  const packageRoot = path.join(root, "packages", directory);
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
      name,
    }),
  );
  await writeFile(path.join(packageRoot, "src", "index.ts"), source);
}

async function writeTemplatePackage(
  root: string,
  template: string,
  manifest: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  },
): Promise<void> {
  const templateRoot = path.join(root, "packages", "create-threenative", "templates", template);
  await mkdir(templateRoot, { recursive: true });
  await writeFile(
    path.join(templateRoot, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function writeTemplateSource(
  root: string,
  template: string,
  relativePath: string,
  source: string,
): Promise<void> {
  const file = path.join(
    root,
    "packages",
    "create-threenative",
    "templates",
    template,
    relativePath,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
}

async function budgetSupportFixture(root: string): Promise<void> {
  await nativeFixture(root);
  for (const file of ["CMakeLists.txt", "CMakePresets.json", "build-matrix.json"]) {
    await writeFile(
      path.join(root, "packages", "runtime-native", file),
      await readFile(path.join(process.cwd(), "packages", "runtime-native", file), "utf8"),
    );
  }
  const measurement = await measureNativeCensusAreas(root);
  await writeNativeCensus(
    root,
    [...measurement.areas.entries()].map(([area, lines]) => [`\`${area}\``, lines] as const),
    measurement.total,
  );
}

async function capabilityFixture(root: string): Promise<void> {
  await writeCapabilityPackage(
    root,
    "core",
    "@threenative/core",
    [
      "/**",
      " * A fixture capability.",
      " * @situation test a documented capability",
      " * @example const capability = new FixtureCapability();",
      " */",
      "export class FixtureCapability {}",
      "",
    ].join("\n"),
  );
  await writeTemplatePackage(root, "starter", {
    dependencies: { "@threenative/core": "0.0.0", three: "0.0.0" },
    devDependencies: {},
  });
  await capabilityManifest.writeCapabilityManifest(root);
  await budgetSupportFixture(root);
}

async function writeNativeCensus(
  root: string,
  rows: readonly (readonly [string, number])[],
  total: number,
  overrides?: {
    readonly alternative?: string;
    readonly liveProof?: string;
    readonly owner?: string;
    readonly verdict?: string;
  },
): Promise<void> {
  const recordPath = path.join(root, "docs", "verification", "native-runtime-census-2026-08-16.md");
  await mkdir(path.dirname(recordPath), { recursive: true });
  const owner = overrides?.owner ?? "owner";
  const liveProof = overrides?.liveProof ?? "live proof";
  const alternative = overrides?.alternative ?? "alternative considered";
  const verdict = overrides?.verdict ?? "**KEEP** — judged.";
  const tableRows = rows
    .map(
      ([area, lines]) =>
        `| ${area} | ${lines} | ${owner} | ${liveProof} | ${alternative} | ${verdict} |`,
    )
    .join("\n");
  await writeFile(
    recordPath,
    [
      "| Counted area | Lines | Owner |",
      "| --- | ---: | --- |",
      tableRows,
      `| **Total** | **${total}** | |`,
    ].join("\n"),
  );
}

describe("budget gate", () => {
  it("should count active PRDs recursively without counting done or blocked records", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "docs", "PRDs", "performance"), { recursive: true });
    await mkdir(path.join(root, "docs", "PRDs", "done"), { recursive: true });
    await mkdir(path.join(root, "docs", "PRDs", "BLOCKED", "requires-device"), {
      recursive: true,
    });
    await writeFile(path.join(root, "docs", "PRDs", "performance", "PRD-224-example.md"), "active");
    await writeFile(path.join(root, "docs", "PRDs", "done", "PRD-001-example.md"), "done");
    await writeFile(
      path.join(root, "docs", "PRDs", "BLOCKED", "requires-device", "PRD-002-example.md"),
      "blocked",
    );

    const report = await collectBudgets(root);

    expect(report.prdFiles).toBe(1);
  });

  it("should allow 8 framework packages plus example workspaces", async () => {
    const root = await fixtureRoot();
    for (let index = 0; index < 8; index += 1) {
      const directory = path.join(root, "packages", `package-${index}`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "package.json"), "{}");
    }
    for (let index = 0; index < 3; index += 1) {
      const directory = path.join(root, "examples", `example-${index}`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "package.json"), "{}");
    }
    const report = await collectBudgets(root);
    expect(report.frameworkPackages).toBe(8);
    expect(report.exampleWorkspaces).toBe(3);
    expect(budgetErrors(report)).not.toContainEqual(
      expect.stringContaining("framework package cap exceeded"),
    );
  });

  it("should report framework package count without inventing a numeric cap", async () => {
    const root = await fixtureRoot();
    for (let index = 0; index < 9; index += 1) {
      const directory = path.join(root, "packages", `package-${index}`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "package.json"), "{}");
    }
    const report = await collectBudgets(root);
    expect(report.frameworkPackages).toBe(9);
    expect(budgetErrors(report)).toEqual([]);
    expect(budgetTriggers(report)).toEqual([]);
  });

  it("should trigger review when framework LOC exceeds 15000", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "core", "src");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, "packages", "core", "package.json"), "{}");
    await writeFile(path.join(directory, "large.ts"), "x\n".repeat(15_000));
    const report = await collectBudgets(root);
    expect(budgetTriggers(report).join("\n")).toContain("framework LOC review trigger");
    expect(budgetErrors(report)).toEqual([]);
  });

  it("should allow framework LOC at 14999 lines", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "core", "src");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, "packages", "core", "package.json"), "{}");
    await writeFile(path.join(directory, "large.ts"), "x\n".repeat(14_998));
    const report = await collectBudgets(root);
    expect(budgetTriggers(report)).toEqual([]);
    expect(budgetErrors(report)).toEqual([]);
  });

  it("should count native source and build files toward the framework LOC trigger", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "physics-native", "src");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, "packages", "physics-native", "package.json"), "{}");
    await writeFile(path.join(root, "packages", "physics-native", "CMakeLists.txt"), "x\n");
    await writeFile(path.join(directory, "binding.cpp"), "x\n".repeat(15_000));
    const report = await collectBudgets(root);
    expect(budgetTriggers(report).join("\n")).toContain("framework LOC review trigger");
    expect(budgetErrors(report)).toEqual([]);
  });

  it("should fail when the asset MCP is vendored into packages", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "asset-mcp");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "threenative-asset-mcp" }),
    );
    const report = await collectBudgets(root);
    expect(report.vendoredExternalMcp).toEqual(["asset-mcp"]);
    expect(budgetErrors(report).join("\n")).toContain("must stay external");
  });

  it("should allow core to carry the asset MCP automatically", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "core");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ dependencies: { "threenative-asset-mcp": "0.4.0" }, name: "core" }),
    );
    const report = await collectBudgets(root);
    expect(budgetErrors(report)).toEqual([]);
  });

  it("should fail when the sculpt MCP is vendored into packages", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "sculpt-mcp");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "threenative-sculpt-mcp" }),
    );
    const report = await collectBudgets(root);
    expect(report.vendoredExternalMcp).toEqual(["sculpt-mcp"]);
    expect(budgetErrors(report).join("\n")).toContain("must stay external");
  });

  it("should fail when a workspace package other than core depends on the sculpt MCP", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "physics");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ dependencies: { "threenative-sculpt-mcp": "0.1.0" }, name: "physics" }),
    );
    const report = await collectBudgets(root);
    expect(budgetErrors(report).join("\n")).toContain("must stay external");
  });

  it("should keep external MCP source out of the real tree and dependencies owned by core", async () => {
    const report = await collectBudgets(process.cwd());
    expect(report.vendoredExternalMcp).toEqual([]);
  });

  it("should allow the Mystral native runtime only in its owned package", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "runtime-native", "include", "mystral");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, "packages", "runtime-native", "package.json"), "{}");
    await writeFile(path.join(directory, "runtime.h"), "#pragma once\n");
    const report = await collectBudgets(root);
    expect(report.vendoredNativeRuntime).toEqual([]);
    expect(budgetErrors(report)).not.toContainEqual(
      expect.stringContaining("runtime is allowed only"),
    );
  });

  it("should fail when the Mystral native runtime is outside its owned package", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "anything-else", "include", "mystral");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "runtime.h"), "#pragma once\n");
    const report = await collectBudgets(root);
    expect(report.vendoredNativeRuntime).toEqual([path.join("packages", "anything-else")]);
    expect(budgetErrors(report).join("\n")).toContain("runtime is allowed only");
  });

  it("should ignore a scratch git worktree that checks the runtime out again", async () => {
    const root = await fixtureRoot();
    const directory = path.join(
      root,
      ".worktrees",
      "prd-000-scratch",
      "packages",
      "runtime-native",
      "include",
      "mystral",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "runtime.h"), "#pragma once\n");
    const report = await collectBudgets(root);
    expect(report.vendoredNativeRuntime).toEqual([]);
    expect(budgetErrors(report)).not.toContainEqual(
      expect.stringContaining("runtime is allowed only"),
    );
  });

  it("should fire the native runtime trigger past 100k lines without charging framework LOC", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "runtime-native", "src");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, "packages", "runtime-native", "package.json"), "{}");
    // A trailing newline adds a final empty split segment: repeat(100_000) counts 100_001 lines,
    // plus package.json's one line.
    await writeFile(path.join(directory, "runtime.cpp"), "x\n".repeat(100_000));
    const report = await collectBudgets(root);
    expect(report.frameworkLoc).toBe(0);
    expect(report.nativeRuntimeLoc).toBe(100_002);
    expect(budgetTriggers(report).join("\n")).toContain(
      "native runtime LOC review trigger: 100002 lines (trigger 100000",
    );
    expect(budgetErrors(report)).toEqual([]);
  });

  it("should stay silent at the pinned native trigger", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "runtime-native", "src");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, "packages", "runtime-native", "package.json"), "{}");
    // repeat(99_998) counts 99_999 lines; with package.json that is exactly the pinned trigger.
    await writeFile(path.join(directory, "runtime.cpp"), "x\n".repeat(99_998));
    const report = await collectBudgets(root);
    expect(report.nativeRuntimeLoc).toBe(100_000);
    expect(budgetTriggers(report)).toEqual([]);
    await expect(enforceBudgets(root)).resolves.toMatchObject({
      nativeRuntimeLoc: report.nativeRuntimeLoc,
    });
  });

  it("should reject a census row with no KEEP/DELETE verdict", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    await writeNativeCensus(root, [["`runtime.cpp`", 1]], 2, { verdict: "seems fine" });

    await expect(enforceBudgets(root)).rejects.toThrow(
      "native census row runtime.cpp has no KEEP/DELETE verdict",
    );
  });

  it("should reject a census row missing its owner, proof, or alternative", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    await writeNativeCensus(root, [["`runtime.cpp`", 1]], 2, { owner: "" });

    await expect(enforceBudgets(root)).rejects.toThrow(
      "native census row runtime.cpp is missing its owner, live proof or caller, or alternative considered",
    );
  });

  it("should reject a measured area with no census row", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    await writeNativeCensus(root, [["`runtime.cpp`", 1]], 1);

    await expect(enforceBudgets(root)).rejects.toThrow(
      "native census record has no row for counted area Root CMakeLists.txt",
    );
  });

  it("should reject a census row whose area left the runtime tree", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    await writeNativeCensus(
      root,
      [
        ["`runtime.cpp`", 1],
        ["Root `CMakeLists.txt`", 1],
        ["`deleted/`", 12],
      ],
      14,
    );

    await expect(enforceBudgets(root)).rejects.toThrow(
      "native census row deleted/ counts an area the runtime tree no longer has",
    );
  });

  it("should reject a census total that disagrees with its own rows", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    await writeNativeCensus(
      root,
      [
        ["`runtime.cpp`", 1],
        ["Root `CMakeLists.txt`", 1],
      ],
      3,
    );

    await expect(enforceBudgets(root)).rejects.toThrow(
      "native census total disagrees with its own area rows: rows sum to 2, total row says 3",
    );
  });

  it("should allow census line drift within the recorded tolerance", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    // The table judges both areas and stays internally consistent; only its numbers trail the
    // tree once runtime.cpp grows. The bounded tolerance leaves a short regeneration window.
    await writeNativeCensus(
      root,
      [
        ["`runtime.cpp`", 1],
        ["Root `CMakeLists.txt`", 1],
      ],
      2,
    );
    await writeFile(path.join(root, "packages", "runtime-native", "runtime.cpp"), "owned\nmore\n");

    await expect(enforceBudgets(root)).resolves.toMatchObject({ nativeRuntimeLoc: 4 });
    expect(await nativeCensusDrift(root)).toEqual([]);
  });

  it("reports census line drift without failing budgets", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    await writeNativeCensus(
      root,
      [
        ["`runtime.cpp`", 1],
        ["Root `CMakeLists.txt`", 1],
      ],
      2,
    );
    await writeFile(
      path.join(root, "packages", "runtime-native", "runtime.cpp"),
      "owned\nmore\nmore\nmore\nmore\nmore\n",
    );

    await expect(enforceBudgets(root)).resolves.toMatchObject({ nativeRuntimeLoc: 8 });
    expect(await nativeCensusDrift(root)).toEqual([
      expect.stringMatching(
        /native census drift: runtime\.cpp recorded 1, measured 7.*exceeds tolerance/u,
      ),
    ]);
  });

  it("should reject stale capabilities when budgets run", async () => {
    const root = await fixtureRoot();
    await capabilityFixture(root);
    const manifestPath = path.join(root, "packages/create-threenative/capabilities.json");
    await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")}\n`);

    await expect(enforceBudgets(root)).rejects.toThrow(/Capability manifest is stale/u);
  });

  it("should reject missing template closures when budgets run", async () => {
    const root = await fixtureRoot();
    await writeCapabilityPackage(
      root,
      "core",
      "@threenative/core",
      [
        "/**",
        " * A fixture capability.",
        " * @situation test a documented capability",
        " * @example const capability = new FixtureCapability();",
        " */",
        "export class FixtureCapability {}",
        "",
      ].join("\n"),
    );
    await capabilityManifest.writeCapabilityManifest(root);
    await budgetSupportFixture(root);

    await expect(enforceBudgets(root)).rejects.toThrow(/templates.*missing/u);
  });

  it("should reject an unresolved capability import when budgets run", async () => {
    const root = await fixtureRoot();
    await writeCapabilityPackage(
      root,
      "core",
      "@threenative/core",
      [
        "/**",
        " * A fixture capability.",
        " * @situation test a documented capability",
        " * @example const capability = new FixtureCapability();",
        " */",
        "export class FixtureCapability {}",
        "",
      ].join("\n"),
    );
    await writeCapabilityPackage(
      root,
      "nope",
      "@threenative/nope",
      [
        "/**",
        " * A fabricated package capability.",
        " * @situation prove the budgets gate fails closed",
        " * @example const nope = new NopeCapability();",
        " */",
        "export class NopeCapability {}",
        "",
      ].join("\n"),
    );
    await writeTemplatePackage(root, "starter", {
      dependencies: { "@threenative/core": "0.0.0", three: "0.0.0" },
      devDependencies: {},
    });
    await capabilityManifest.writeCapabilityManifest(root);
    await budgetSupportFixture(root);

    await expect(enforceBudgets(root)).rejects.toThrow(/NopeCapability.*@threenative\/nope/u);
  });

  it("should reject a template UI import without a dependency when budgets run", async () => {
    const root = await fixtureRoot();
    await writeCapabilityPackage(
      root,
      "core",
      "@threenative/core",
      [
        "/**",
        " * A fixture capability.",
        " * @situation test a documented capability",
        " * @example const capability = new FixtureCapability();",
        " */",
        "export class FixtureCapability {}",
        "",
      ].join("\n"),
    );
    await writeCapabilityPackage(
      root,
      "ui",
      "@threenative/ui",
      [
        "/**",
        " * A fixture UI layer.",
        " * @situation render a React HUD over the game",
        " * @example const layer = new UiLayer();",
        " */",
        "export class UiLayer {}",
        "",
      ].join("\n"),
    );
    await writeTemplatePackage(root, "minimal", {
      dependencies: { "@threenative/core": "0.0.0", three: "0.0.0" },
      devDependencies: {},
    });
    await writeTemplatePackage(root, "starter", {
      dependencies: { "@threenative/core": "0.0.0", three: "0.0.0" },
      devDependencies: {},
    });
    await writeTemplateSource(
      root,
      "starter",
      path.join("src", "ui", "App.tsx"),
      'import { UiLayer } from "@threenative/ui";\nexport const layer = UiLayer;\n',
    );
    await capabilityManifest.writeCapabilityManifest(root);
    await budgetSupportFixture(root);

    await expect(enforceBudgets(root)).rejects.toThrow(/starter.*UiLayer.*@threenative\/ui/u);
    // Each template is judged by its own closure: starter for the import its source makes,
    // minimal because it cannot resolve an entry that carries no install instruction.
    await expect(enforceBudgets(root)).rejects.toThrow(
      /starter: UiLayer -> @threenative\/ui \(@threenative\/ui\); template source imports/u,
    );
    await expect(enforceBudgets(root)).rejects.toThrow(
      /minimal: UiLayer -> @threenative\/ui \(@threenative\/ui\); this template's dependency closure does not install/u,
    );
  });

  it("should check the capability manifest once when the root budget chain runs", async () => {
    const root = await fixtureRoot();
    await capabilityFixture(root);
    const check = vi.spyOn(capabilityManifest, "checkCapabilityManifest");
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      scripts?: { budgets?: string };
    };

    await expect(enforceBudgets(root)).resolves.toMatchObject({ prdFiles: 0 });
    expect(check).toHaveBeenCalledTimes(1);
    expect(packageJson.scripts?.budgets).not.toContain("pnpm capabilities:check");
    check.mockRestore();
  });

  it("should pass fixtures that carry no census record at all", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);

    await expect(enforceBudgets(root)).resolves.toMatchObject({ nativeRuntimeLoc: 2 });
  });

  it("should fail a real runtime tree with no native coverage record", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    await writeFile(
      path.join(root, "packages", "runtime-native", "package.json"),
      JSON.stringify({ name: "@threenative/runtime-native" }),
    );

    await expect(enforceBudgets(root)).rejects.toThrow("native coverage record is missing");
  });

  it("should not let the real tree silence the verdict gate by deleting the census record", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    const coreDirectory = path.join(root, "packages", "core");
    await mkdir(coreDirectory, { recursive: true });
    await writeFile(path.join(coreDirectory, "package.json"), "{}");

    await expect(enforceBudgets(root)).rejects.toThrow(
      "native census record is missing: the counted-area verdict gate has nothing to enforce",
    );
  });

  it("should pass a complete native census", async () => {
    const root = await fixtureRoot();
    await nativeFixture(root);
    await writeNativeCensus(
      root,
      [
        ["`runtime.cpp`", 1],
        ["Root `CMakeLists.txt`", 1],
      ],
      2,
    );

    await expect(enforceBudgets(root)).resolves.toMatchObject({ nativeRuntimeLoc: 2 });
  });

  it("should exclude only the ignored generated Android bundle artifacts from native LOC", async () => {
    const root = await fixtureRoot();
    const directory = path.join(
      root,
      "packages",
      "runtime-native",
      "android",
      "app",
      "src",
      "main",
      "assets",
      "scripts",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "main.js"), "generated\n".repeat(60_000));
    await writeFile(path.join(directory, "main.js.meta.json"), "generated\n".repeat(60_000));
    await writeFile(path.join(directory, "bridge.js"), "owned\n");
    const report = await collectBudgets(root);
    expect(report.nativeRuntimeLoc).toBe(2);
  });

  it("should exclude generated Cargo target metadata from native LOC", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "packages", "runtime-native", "native", "physics", "target");
    await mkdir(path.join(target, "debug"), { recursive: true });
    await writeFile(path.join(root, "packages", "runtime-native", "package.json"), "{}\n");
    await writeFile(path.join(root, "packages", "runtime-native", "runtime.cpp"), "owned\n");
    await writeFile(path.join(target, "debug", "metadata.json"), "generated\n".repeat(60_000));
    const report = await collectBudgets(root);
    expect(report.nativeRuntimeLoc).toBe(4);
  });

  it("should fail when native third_party content is tracked", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "runtime-native", "third_party");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, "packages", "runtime-native", "package.json"), "{}");
    await writeFile(path.join(directory, "dependency.cpp"), "x\n");
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "add", "-f", "packages/runtime-native/third_party"]);
    const report = await collectBudgets(root);
    expect(report.trackedNativeThirdParty).toEqual([
      "packages/runtime-native/third_party/dependency.cpp",
    ]);
    expect(budgetErrors(report).join("\n")).toContain("third_party must stay untracked");
  });

  it("should allow untracked native third_party content", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "packages", "runtime-native", "third_party");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "dependency.cpp"), "x\n");
    const report = await collectBudgets(root);
    expect(report.trackedNativeThirdParty).toEqual([]);
    expect(budgetErrors(report)).not.toContainEqual(
      expect.stringContaining("third_party must stay untracked"),
    );
  });

  it("should keep the Mystral native runtime free of hard budget errors", async () => {
    const report = await collectBudgets(process.cwd());
    expect(report.vendoredNativeRuntime).toEqual([]);
    expect(report.trackedNativeThirdParty).toEqual([]);
    expect(budgetErrors(report)).toEqual([]);
  });

  it("should keep the real tree under every hard limit", async () => {
    const report = await collectBudgets(process.cwd());
    expect(budgetErrors(report)).toEqual([]);
  });
});
