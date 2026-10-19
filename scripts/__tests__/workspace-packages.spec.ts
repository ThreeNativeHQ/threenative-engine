import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  findLiteralPackageEnumerationViolations,
  workspacePackageArchives,
  workspacePackageSourceFlag,
  workspacePackages,
} from "../workspace-packages.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await makeTempDir("threenative-workspace-packages-");
  temporaryRoots.push(root);
  return root;
}

async function writePackage(root: string, directory: string, name: string): Promise<void> {
  const packageRoot = path.join(root, directory);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name, version: "0.3.0" }),
  );
}

describe("workspace package derivation", () => {
  it("derives names, versions, and archive prefixes from package manifests", async () => {
    const root = await fixtureRoot();
    await writePackage(root, "zeta", "@threenative/zeta");
    await writePackage(root, "alpha", "create-threenative");
    await mkdir(path.join(root, "scratch"));

    const packages = workspacePackages(root);
    expect(packages.map(({ name }) => name)).toEqual(["@threenative/zeta", "create-threenative"]);
    expect(workspacePackageArchives(root)).toEqual([
      ["@threenative/zeta", "threenative-zeta-"],
      ["create-threenative", "create-threenative-"],
    ]);
  });

  it("derives collision-safe scaffold flags from actual package names", () => {
    expect(workspacePackageSourceFlag("@threenative/cli")).toBe("--threenative-cli-package");
    expect(workspacePackageSourceFlag("@threenative/engine-mcp")).toBe(
      "--threenative-engine-mcp-package",
    );
    expect(workspacePackageSourceFlag("@threenative/threenative-cli")).toBe(
      "--threenative-threenative-cli-package",
    );
    expect(workspacePackageSourceFlag("@threenative/core")).toBe("--threenative-core-package");
    expect(workspacePackageSourceFlag("create-threenative")).toBe("--cli-package");
    expect(workspacePackageSourceFlag("threenative-engine-mcp")).toBe("--engine-mcp-package");
  });

  it("uses the derived archive prefix directly in the Playwright pack lookup", async () => {
    const config = await readFile(path.join(process.cwd(), "playwright.config.ts"), "utf8");
    expect(config).toContain("const tarball = files.find((file) => file.startsWith(prefix));");
  });

  it("keeps scaffold smoke package inventory derived when a package is added or renamed", async () => {
    const root = await fixtureRoot();
    await writePackage(root, "new-package", "@threenative/new-package");
    expect(workspacePackageArchives(root)).toContainEqual([
      "@threenative/new-package",
      "threenative-new-package-",
    ]);
    await rm(path.join(root, "new-package"), { force: true, recursive: true });
    await writePackage(root, "renamed-package", "@threenative/renamed-package");
    expect(workspacePackageArchives(root)).toContainEqual([
      "@threenative/renamed-package",
      "threenative-renamed-package-",
    ]);

    const workflow = await readFile(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    const scaffoldAction = await readFile(
      path.join(process.cwd(), ".github/actions/scaffold-from-tarballs/action.yml"),
      "utf8",
    );
    const workspaceAction = await readFile(
      path.join(process.cwd(), ".github/actions/workspace-dist/action.yml"),
      "utf8",
    );
    expect(workflow).toContain("uses: ./.github/actions/workspace-dist");
    expect(workspaceAction).toContain("scripts/workspace-packages.ts --archives");
    expect(workspaceAction).toContain("while IFS=$'\\t' read -r package_name _");
    expect(workspaceAction).toContain('pnpm --filter "$package_name"');
    expect(workflow).toContain("uses: ./.github/actions/scaffold-from-tarballs");
    expect(scaffoldAction).toContain('find "$TN_SCAFFOLD_ARCHIVES" -name "${archive_prefix}*.tgz"');
    // The L1 scan still inspects the workflow; these assertions follow its composite action
    // to keep the package/archive stream tied to the derivation helper.
    expect(findLiteralPackageEnumerationViolations(process.cwd())).toEqual([]);
  }, 30_000);

  it("detects a literal multi-package enumeration at a reverted call site", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "profile-starter.ts"),
      `const packages = [\n  ["@threenative/core", "threenative-core-"],\n  ["@threenative/playtest", "threenative-playtest-"]\n];\n`,
    );

    expect(findLiteralPackageEnumerationViolations(root)).toEqual(["profile-starter.ts"]);
  });

  it("detects the CLI's inline for-of package map when it is reverted", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "create-threenative.ts"),
      `for (const [name, flag] of [
  ["@threenative/core", "--core-package"],
  ["@threenative/playtest", "--playtest-package"]
]) {
  void name;
  void flag;
}
`,
    );

    expect(findLiteralPackageEnumerationViolations(root)).toEqual(["create-threenative.ts"]);
  });

  it("detects the generated shooter package enumeration and identifies the derivation remedy", async () => {
    const root = await fixtureRoot();
    const offendingFile = path.join(
      root,
      "packages/playtest/__tests__/generated-shooter-input.spec.ts",
    );
    await mkdir(path.dirname(offendingFile), { recursive: true });
    await writeFile(
      offendingFile,
      `const packages = [\n  ["@threenative/core", "threenative-core-"],\n  ["@threenative/playtest", "threenative-playtest-"]\n];\n`,
    );

    const violations = findLiteralPackageEnumerationViolations(root);
    expect(violations).toContain("packages/playtest/__tests__/generated-shooter-input.spec.ts");
    const error = `TN_WORKSPACE_PACKAGE_LITERAL_ENUMERATION: derive package names with workspace-packages.ts; offending files: ${violations.join(", ")}`;
    expect(error).toContain("packages/playtest/__tests__/generated-shooter-input.spec.ts");
    expect(error).toContain("derive package names with workspace-packages.ts");
  });

  it("keeps the checked-in call sites on derived package lists", async () => {
    expect(findLiteralPackageEnumerationViolations(process.cwd())).toEqual([]);
  }, 30_000);

  it("detects repeated literal package commands in a workflow inventory", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/native-platforms.yml"),
      [
        "run: |",
        "  pnpm --filter @threenative/playtest build",
        "  pnpm --filter @threenative/core build",
        "  pnpm --filter @threenative/physics build",
        "  pnpm --filter create-threenative build",
      ].join("\n"),
    );

    expect(findLiteralPackageEnumerationViolations(root)).toEqual([
      ".github/workflows/native-platforms.yml",
    ]);
  });

  it("reads two targeted package builds in unrelated jobs as two builds, not a list", async () => {
    // One workflow file now carries every integration lane, and two lanes each build their own
    // package. That is two commands; the drift this gate exists for is one command naming a set.
    const root = await fixtureRoot();
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/integration.yml"),
      [
        "jobs:",
        "  decals:",
        "    steps:",
        "      - run: pnpm --filter @threenative/runtime-native native:build",
        "  tone:",
        "    steps:",
        "      - run: pnpm --filter @threenative/playtest build",
      ].join("\n"),
    );

    expect(findLiteralPackageEnumerationViolations(root)).toEqual([]);
  });

  it("still reads one run block naming two packages as a hand-listed set", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/integration.yml"),
      [
        "jobs:",
        "  tone:",
        "    steps:",
        "      - run: |",
        "          pnpm --filter @threenative/playtest build",
        "          pnpm --filter @threenative/physics build",
      ].join("\n"),
    );

    expect(findLiteralPackageEnumerationViolations(root)).toEqual([
      ".github/workflows/integration.yml",
    ]);
  });

  it("detects chained literal package commands on one workflow line", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/native-platforms.yml"),
      "run: pnpm --filter @threenative/core build && pnpm --filter @threenative/physics build\n",
    );

    expect(findLiteralPackageEnumerationViolations(root)).toEqual([
      ".github/workflows/native-platforms.yml",
    ]);
  });

  it("detects literal package commands split before the filter flag", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/native-platforms.yml"),
      [
        "run: |",
        "  pnpm \\",
        "    --filter @threenative/core build",
        "  pnpm \\",
        "    --filter @threenative/physics build",
      ].join("\n"),
    );

    expect(findLiteralPackageEnumerationViolations(root)).toEqual([
      ".github/workflows/native-platforms.yml",
    ]);
  });

  it("detects literal package commands in a folded YAML scalar", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/native-platforms.yml"),
      [
        "run: >",
        "  pnpm",
        "    --filter @threenative/core build",
        "  pnpm",
        "    --filter @threenative/physics build",
      ].join("\n"),
    );

    expect(findLiteralPackageEnumerationViolations(root)).toEqual([
      ".github/workflows/native-platforms.yml",
    ]);
  });

  it("detects literal package commands in a reversed-indicator folded YAML scalar", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/native-platforms.yml"),
      [
        "run: >-2",
        "  pnpm",
        "    --filter @threenative/core build",
        "  pnpm",
        "    --filter @threenative/physics build",
      ].join("\n"),
    );

    expect(findLiteralPackageEnumerationViolations(root)).toEqual([
      ".github/workflows/native-platforms.yml",
    ]);
  });

  it("catches a stale YAML inventory after a package is renamed", async () => {
    const root = await fixtureRoot();
    await writePackage(root, "core", "@threenative/core");
    await writePackage(root, "old-package", "@threenative/old-package");
    await rm(path.join(root, "old-package"), { force: true, recursive: true });
    await writePackage(root, "renamed-package", "@threenative/renamed-package");
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/native-platforms.yml"),
      [
        "for package in @threenative/core @threenative/old-package \\",
        "  ; do",
        '  pnpm --filter "$package" pack',
        "done",
      ].join("\n"),
    );

    expect(workspacePackages(root).map(({ name }) => name)).toEqual([
      "@threenative/core",
      "@threenative/renamed-package",
    ]);
    expect(findLiteralPackageEnumerationViolations(root)).toEqual([
      ".github/workflows/native-platforms.yml",
    ]);
  });

  it("keeps checked-in workflow package inventories on the derived stream", async () => {
    expect(findLiteralPackageEnumerationViolations(process.cwd())).not.toContain(
      ".github/workflows/native-platforms.yml",
    );
    const workflow = await readFile(
      path.join(process.cwd(), ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    expect(workflow).toContain("scripts/workspace-packages.ts --archives");
  }, 30_000);
});
