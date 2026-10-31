import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  type IPublishPackage,
  type IRegistryFacts,
  type ITarballContents,
  RELEASE_WORKFLOW,
  type RegistryLookup,
  type TarballReader,
  checkPublishState,
  gitSourceCommits,
  missingPackageReadmes,
  missingPackedFiles,
  pnpmPackReader,
  prebuiltReleaseCensus,
  publishSet,
  relativeSpecifiers,
  satisfiesRange,
  staleInternalPeerRanges,
  templatePinCensus,
  unresolvableTarballImports,
  unresolvedTarballSpecifiers,
  unresolvedTemplateSpecifiers,
} from "../check-publish-state.js";

const roots: string[] = [];

/** A tarball that ships nothing but a clean manifest, so the fixture's other gates stay in view. */
const cleanTarballs: TarballReader = (item) => ({
  entries: ["package.json"],
  text: new Map([["package.json", JSON.stringify({ name: item.name, version: item.version })]]),
});

function tarball(files: Record<string, string>): ITarballContents {
  return { entries: Object.keys(files).sort(), text: new Map(Object.entries(files)) };
}

const PACKED: IPublishPackage = {
  directory: "/nowhere",
  manifest: "/nowhere/package.json",
  name: "@threenative/runtime-native",
  version: "0.3.0",
};

const PUBLISHED = "2026-08-09T07:32:33.145Z";

const PACKAGES = [
  { dir: "core", name: "@threenative/core", version: "0.1.0" },
  { dir: "create-threenative", name: "create-threenative", version: "0.1.0" },
] as const;

function write(root: string, relative: string, contents: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

async function fixture(): Promise<string> {
  const root = await makeTempDir("threenative-publish-check-");
  roots.push(root);
  for (const item of PACKAGES) {
    write(
      root,
      `packages/${item.dir}/package.json`,
      JSON.stringify({
        files: item.dir === "core" ? ["dist", "README.md"] : undefined,
        name: item.name,
        version: item.version,
      }),
    );
    write(root, `packages/${item.dir}/README.md`, `# ${item.name}\n`);
    write(root, `packages/${item.dir}/src/index.ts`, "export const x = 1;\n");
  }
  write(
    root,
    "packages/create-threenative/templates/starter/package.json",
    JSON.stringify({ dependencies: { "@threenative/core": "0.1.0", three: "0.185.1" } }),
  );
  write(root, RELEASE_WORKFLOW, PACKAGES.map((item) => `#   ${item.name}`).join("\n"));
  return root;
}

/** Everything published, at a version the workspace has already moved past. */
const everythingPublished: RegistryLookup = (name) => ({
  published: PUBLISHED,
  state: "present",
  version: PACKAGES.find((item) => item.name === name)?.version ?? "0.0.0",
});

describe("pnpm publish:check", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("passes when every version moved past what the registry holds", async () => {
    const root = await fixture();
    const report = await checkPublishState({
      lookup: (name) => ({ ...everythingPublished(name), version: "0.0.9" }),
      repo: root,
      sourceCommits: () => 12,
      tarballs: cleanTarballs,
    });
    expect(report.findings).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it("fails when a local version equals the published version and the source has moved", async () => {
    const root = await fixture();
    const report = await checkPublishState({
      lookup: everythingPublished,
      repo: root,
      sourceCommits: () => 144,
      tarballs: cleanTarballs,
    });
    expect(report.exitCode).toBe(1);
    expect(report.findings.map((finding) => finding.package)).toContain("@threenative/core");
    expect(report.findings[0]?.detail).toMatch(/144 commit\(s\) since.*bump it/u);
  });

  it("passes a version that equals the published one when the source has not moved", async () => {
    // Republishing an identical tree is not the defect. Publishing a *changed* tree under a
    // version string the registry already serves is, because npm will refuse it.
    const root = await fixture();
    const report = await checkPublishState({
      lookup: everythingPublished,
      repo: root,
      sourceCommits: () => 0,
      tarballs: cleanTarballs,
    });
    expect(report.findings).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it("counts a changed non-src publication input for an already published version", async () => {
    const root = await makeTempDir("threenative-publish-source-census-");
    const packageRoot = path.join(root, "packages/core");
    write(
      root,
      "packages/core/package.json",
      JSON.stringify({
        files: ["dist", "gpl", "README.md"],
        name: "@threenative/core",
        version: "0.1.0",
      }),
    );
    write(root, "packages/core/src/index.ts", "export const x = 1;\n");
    write(root, "packages/core/gpl/LICENSE.GPL", "GPL text\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      },
    });
    write(root, "packages/core/gpl/LICENSE.GPL", "GPL text changed\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "change-gpl"], { cwd: root });

    expect(gitSourceCommits(root)(packageRoot, "2025-01-01T00:00:00Z")).toBe(1);
  });

  it("counts package-local build configs and helpers for an already published version", async () => {
    const root = await makeTempDir("threenative-publish-build-inputs-");
    const packageRoot = path.join(root, "packages/core");
    write(
      root,
      "packages/core/package.json",
      JSON.stringify({
        files: ["dist", "README.md"],
        name: "@threenative/core",
        scripts: {
          build: "tsup --config tsup.config.ts && node scripts/build-helper.mjs",
          postinstall: "node scripts/build-helper.mjs",
        },
        version: "0.1.0",
      }),
    );
    write(root, "packages/core/README.md", "# core\n");
    write(root, "packages/core/src/index.ts", "export const x = 1;\n");
    write(root, "packages/core/tsup.config.ts", "export default {};\n");
    write(root, "packages/core/scripts/build-helper.mjs", "export {};\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      },
    });
    write(root, "packages/core/tsup.config.ts", "export default { minify: true };\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "change-build-config"], { cwd: root });
    write(root, "packages/core/scripts/build-helper.mjs", "export const helper = true;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "change-build-helper"], { cwd: root });

    expect(gitSourceCommits(root)(packageRoot, "2025-01-01T00:00:00Z")).toBe(2);
  });

  it("counts a package tsconfig change for an already published version", async () => {
    const root = await makeTempDir("threenative-publish-tsconfig-");
    const packageRoot = path.join(root, "packages/core");
    write(
      root,
      "packages/core/package.json",
      JSON.stringify({
        files: ["dist", "README.md"],
        name: "@threenative/core",
        version: "0.1.0",
      }),
    );
    write(root, "packages/core/README.md", "# core\n");
    write(root, "packages/core/src/index.ts", "export const x = 1;\n");
    write(root, "packages/core/tsconfig.json", '{"extends":"../../tsconfig.base.json"}\n');
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      },
    });
    write(
      root,
      "packages/core/tsconfig.json",
      '{"extends":"../../tsconfig.base.json","strict":true}\n',
    );
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "change-tsconfig"], { cwd: root });

    expect(gitSourceCommits(root)(packageRoot, "2025-01-01T00:00:00Z")).toBe(1);
  });

  it("counts shared workspace and catalog inputs for every package", async () => {
    const root = await makeTempDir("threenative-publish-shared-inputs-");
    const packageRoot = path.join(root, "packages/core");
    write(
      root,
      "packages/core/package.json",
      JSON.stringify({
        files: ["dist", "README.md"],
        name: "@threenative/core",
        version: "0.1.0",
      }),
    );
    write(root, "packages/core/README.md", "# core\n");
    write(root, "packages/core/src/index.ts", "export const x = 1;\n");
    write(root, "tsconfig.base.json", '{"compilerOptions":{"strict":true}}\n');
    write(root, "pnpm-workspace.yaml", "packages: ['packages/*']\ncatalog:\n  three: 0.185.1\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      },
    });
    write(root, "tsconfig.base.json", '{"compilerOptions":{"strict":false}}\n');
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "change-shared-tsconfig"], { cwd: root });
    write(root, "pnpm-workspace.yaml", "packages: ['packages/*']\ncatalog:\n  three: 0.185.2\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "change-catalog"], { cwd: root });

    expect(gitSourceCommits(root)(packageRoot, "2025-01-01T00:00:00Z")).toBe(2);
  });

  it("counts changes in a workspace sibling consumed by the package build", async () => {
    const root = await makeTempDir("threenative-publish-sibling-inputs-");
    const packageRoot = path.join(root, "packages/core");
    write(
      root,
      "packages/core/package.json",
      JSON.stringify({
        devDependencies: { "@threenative/blender-bridge": "workspace:*" },
        files: ["dist", "README.md"],
        name: "@threenative/core",
        version: "0.1.0",
      }),
    );
    write(root, "packages/core/README.md", "# core\n");
    write(root, "packages/core/src/index.ts", "export const x = 1;\n");
    write(
      root,
      "packages/blender-bridge/package.json",
      JSON.stringify({ name: "@threenative/blender-bridge", version: "0.1.0" }),
    );
    write(root, "packages/blender-bridge/gpl/convert.py", "print('initial')\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      },
    });
    write(root, "packages/blender-bridge/gpl/convert.py", "print('changed')\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "change-sibling"], { cwd: root });

    expect(gitSourceCommits(root)(packageRoot, "2025-01-01T00:00:00Z")).toBe(1);
  });

  it("does not fail a package that was never published", async () => {
    // A 404 is what this whole lane exists to fix; refusing to publish because of it would make
    // the preflight unsatisfiable.
    const root = await fixture();
    const report = await checkPublishState({
      lookup: (name) =>
        name === "create-threenative"
          ? ({ state: "absent" } satisfies IRegistryFacts)
          : { ...everythingPublished(name), version: "0.0.9" },
      repo: root,
      sourceCommits: () => 5,
      tarballs: cleanTarballs,
    });
    expect(report.findings).toEqual([]);
  });

  it("fails when a publishable package is missing from the release workflow's publish set", async () => {
    const root = await fixture();
    write(root, RELEASE_WORKFLOW, "#   @threenative/core\n");
    const report = await checkPublishState({
      lookup: (name) => ({ ...everythingPublished(name), version: "0.0.9" }),
      repo: root,
      sourceCommits: () => 1,
      tarballs: cleanTarballs,
    });
    expect(report.exitCode).toBe(1);
    expect(report.findings[0]?.detail).toMatch(
      /create-threenative is publishable but is not named/u,
    );
  });

  it("fails when a publishable package has no README", async () => {
    const root = await fixture();
    await rm(path.join(root, "packages/core/README.md"));
    const findings = missingPackageReadmes(publishSet(root));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ package: "@threenative/core", severity: "fail" });
    expect(findings[0]?.detail).toMatch(/missing README\.md/u);
  });

  it("fails when a package's explicit files list excludes its README", async () => {
    const root = await fixture();
    write(
      root,
      "packages/core/package.json",
      JSON.stringify({ files: ["dist"], name: "@threenative/core", version: "0.1.0" }),
    );
    const findings = missingPackageReadmes(publishSet(root));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ package: "@threenative/core", severity: "fail" });
    expect(findings[0]?.detail).toMatch(/files list.*dist.*README\.md/u);
  });

  it("accepts an existing README with no files list or an explicit README entry", async () => {
    const root = await fixture();
    expect(missingPackageReadmes(publishSet(root))).toEqual([]);
  });

  it("blocks, never passes, when the release workflow does not exist", async () => {
    const root = await fixture();
    await rm(path.join(root, RELEASE_WORKFLOW));
    const report = await checkPublishState({
      lookup: (name) => ({ ...everythingPublished(name), version: "0.0.9" }),
      repo: root,
      sourceCommits: () => 1,
      tarballs: cleanTarballs,
    });
    expect(report.exitCode).toBe(2);
    expect(report.findings[0]?.severity).toBe("blocked");
  });

  it("blocks, never passes, when the registry cannot be reached", async () => {
    const root = await fixture();
    const report = await checkPublishState({
      lookup: () => ({ state: "unreachable" }),
      repo: root,
      sourceCommits: () => 1,
      tarballs: cleanTarballs,
    });
    expect(report.exitCode).toBe(2);
    expect(report.findings.every((finding) => finding.severity === "blocked")).toBe(true);
  });

  it("fails when a catalog: specifier survives into a template manifest", async () => {
    const root = await fixture();
    write(
      root,
      "packages/create-threenative/templates/starter/package.json",
      JSON.stringify({ dependencies: { "@threenative/core": "catalog:" } }),
    );
    const findings = unresolvedTemplateSpecifiers(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toMatch(/no meaning outside this workspace/u);
  });

  it("fails when a template pins a package the registry does not have", async () => {
    const root = await fixture();
    write(
      root,
      "packages/create-threenative/templates/starter/package.json",
      JSON.stringify({ dependencies: { "@threenative/core": "9.9.9", three: "0.185.1" } }),
    );
    const findings = templatePinCensus(root, (name, version) =>
      name === "@threenative/core" && version === "9.9.9"
        ? { state: "absent" }
        : { state: "present", version: "0.0.0" },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.package).toBe("template:starter");
    expect(findings[0]?.detail).toMatch(/@threenative\/core@9\.9\.9/u);
  });

  it("rejects an absent exact internal pin at the version in the current publish set by default", async () => {
    const root = await fixture();
    const lookup: RegistryLookup = (name, version) =>
      name === "@threenative/core" && (version === undefined || version === "0.1.0")
        ? { state: "absent" }
        : { published: PUBLISHED, state: "present", version: "0.0.0" };

    expect(templatePinCensus(root, lookup)).toContainEqual(
      expect.objectContaining({
        package: "template:starter",
        severity: "fail",
      }),
    );
    const report = await checkPublishState({
      lookup,
      prebuiltProbe: () => "present",
      repo: root,
      sourceCommits: () => 0,
      tarballs: cleanTarballs,
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        package: "template:starter",
        severity: "fail",
      }),
    );
    expect(report.exitCode).toBe(1);
  });

  it("allows an absent exact current-set pin only with the explicit release opt-in", async () => {
    const root = await fixture();
    const lookup: RegistryLookup = (name, version) =>
      name === "@threenative/core" && (version === undefined || version === "0.1.0")
        ? { state: "absent" }
        : { published: PUBLISHED, state: "present", version: "0.0.0" };

    expect(templatePinCensus(root, lookup, { allowCurrentPublishSetPins: true })).toEqual([]);
    const report = await checkPublishState({
      allowCurrentPublishSetPins: true,
      lookup,
      prebuiltProbe: () => "present",
      repo: root,
      sourceCommits: () => 0,
      tarballs: cleanTarballs,
    });
    expect(report.findings).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it("still fails an absent pin outside the current publish set with the opt-in", async () => {
    const root = await fixture();
    write(
      root,
      "packages/create-threenative/templates/starter/package.json",
      JSON.stringify({ dependencies: { "@threenative/core": "9.9.9" } }),
    );
    const findings = templatePinCensus(root, () => ({ state: "absent" }), {
      allowCurrentPublishSetPins: true,
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        package: "template:starter",
        severity: "fail",
      }),
    );
  });

  it("keeps the coordinated pin opt-in explicit in the npm release workflow", () => {
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../.github/workflows/npm-release.yml"),
      "utf8",
    );
    expect(workflow).toContain("run: pnpm publish:check --allow-current-publish-set-pins");
  });

  it("reuses the exact commit's green CI result instead of rerunning generic gates", () => {
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../.github/workflows/npm-release.yml"),
      "utf8",
    );
    const gates = workflow.match(/ {2}gates:\n([\s\S]*?)\n {2}publish:/u)?.[1];
    expect(gates).toBeDefined();
    expect(gates).toContain("Require a green CI run for this commit");
    expect(gates).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(gates).toContain("--workflow ci.yml");
    expect(gates).toContain('--commit "$GITHUB_SHA"');
    expect(gates).not.toContain("run: pnpm typecheck");
    expect(gates).not.toContain("run: pnpm lint");
    expect(gates).not.toContain("run: pnpm test");
  });

  it("passes a template pin resolved by the registry", async () => {
    const root = await fixture();
    expect(templatePinCensus(root, () => ({ state: "present", version: "0.1.0" }))).toEqual([]);
  });

  it("fails when no prebuilt release exists for the runtime version", async () => {
    const root = await fixture();
    const findings = prebuiltReleaseCensus(root, () => "absent", "0.3.0");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toMatch(/runtime-native-v0\.3\.0.*prebuilt-lock\.json/u);
  });

  it("blocks, never passes, when the prebuilt release probe is unreachable", async () => {
    const root = await fixture();
    const findings = prebuiltReleaseCensus(root, () => "unreachable", "0.3.0");
    expect(findings).toMatchObject([
      { package: "@threenative/runtime-native", severity: "blocked" },
    ]);
  });

  it("fails when a workspace: specifier survives into a template manifest", async () => {
    const root = await fixture();
    write(
      root,
      "packages/create-threenative/templates/starter/package.json",
      JSON.stringify({ devDependencies: { "@threenative/playtest": "workspace:*" } }),
    );
    expect(unresolvedTemplateSpecifiers(root)).toHaveLength(1);
  });

  it("fails the publish report when an optional template pin still uses workspace:", async () => {
    const root = await fixture();
    write(
      root,
      "packages/create-threenative/templates/starter/package.json",
      JSON.stringify({
        optionalDependencies: { "@threenative/runtime-native": "workspace:*" },
      }),
    );
    const report = await checkPublishState({
      lookup: (name) => ({ ...everythingPublished(name), version: "0.0.9" }),
      repo: root,
      sourceCommits: () => 0,
    });
    expect(report.exitCode).toBe(1);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ package: "template:starter", severity: "fail" }),
    );
    expect(report.findings.map(({ detail }) => detail).join("\n")).toMatch(
      /optionalDependencies\.@threenative\/runtime-native.*workspace:\*/u,
    );
  });

  it("fails when a peer range on a sibling excludes the version shipping beside it", async () => {
    // @threenative/physics@0.2.0 and @threenative/ui@0.2.0 shipped declaring
    // @threenative/core@">=0.1.0 <0.2.0", so npm install in a scaffolded project died with
    // ERESOLVE and no stranger could build anything. The range is hand-maintained and had to
    // move with the release; nothing made it, so this does.
    const root = await fixture();
    write(
      root,
      "packages/core/package.json",
      JSON.stringify({
        name: "@threenative/core",
        peerDependencies: { "create-threenative": ">=0.1.0 <0.2.0" },
        version: "0.2.0",
      }),
    );
    write(
      root,
      "packages/create-threenative/package.json",
      JSON.stringify({ name: "create-threenative", version: "0.2.0" }),
    );
    const findings = staleInternalPeerRanges(publishSet(root));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toMatch(/excludes the 0\.2\.0 being published beside it/u);
  });

  it("accepts a peer range that admits the sibling version", async () => {
    const root = await fixture();
    write(
      root,
      "packages/core/package.json",
      JSON.stringify({
        name: "@threenative/core",
        peerDependencies: { "create-threenative": ">=0.2.0 <0.3.0" },
        version: "0.2.0",
      }),
    );
    write(
      root,
      "packages/create-threenative/package.json",
      JSON.stringify({ name: "create-threenative", version: "0.2.0" }),
    );
    expect(staleInternalPeerRanges(publishSet(root))).toEqual([]);
  });

  it("evaluates the range forms this repository writes, and refuses ones it cannot read", () => {
    expect(satisfiesRange("0.2.0", ">=0.1.0 <0.2.0")).toBe(false);
    expect(satisfiesRange("0.2.0", ">=0.2.0 <0.3.0")).toBe(true);
    expect(satisfiesRange("0.2.1", "^0.2.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfiesRange("0.2.1", "~0.2.0")).toBe(true);
    expect(satisfiesRange("0.2.0", "0.2.0")).toBe(true);
    expect(satisfiesRange("0.2.0", "*")).toBe(true);
    // Guessing at a range it cannot parse is how a preflight reports green while asserting
    // nothing, so an unreadable range is an error rather than an optimistic true.
    expect(() => satisfiesRange("0.2.0", "1.x || >=2")).toThrow(/TN_PUBLISH_RANGE_UNREADABLE/u);
  });

  it("fails when a shipped script imports a file the tarball does not contain", async () => {
    // The defect this was built for: runtime-native shipped package-android.mjs while
    // asset-preflight.mjs was absent from `files`, so `build --target android` from a published
    // install died ERR_MODULE_NOT_FOUND before it reached a single fetch.
    const findings = await unresolvableTarballImports(
      PACKED,
      tarball({
        "package.json": JSON.stringify({ name: PACKED.name, version: PACKED.version }),
        "scripts/package-android.mjs": "import { x } from './asset-preflight.mjs';\n",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ package: PACKED.name, severity: "fail" });
    expect(findings[0]?.detail).toMatch(
      /ships scripts\/package-android\.mjs.*'\.\/asset-preflight\.mjs'.*ERR_MODULE_NOT_FOUND/u,
    );
  });

  it("fails when a files entry is missing from the tarball, and passes once it is built", () => {
    // runtime-native lists build/web/tn-native-engine-web.wasm in `files`. No workflow built it, and
    // pnpm pack drops the missing entry silently, so a release shipped without the web engine.
    const manifest = JSON.stringify({
      files: ["build/web/tn-native-engine-web.wasm", "scripts", "dist/*.js", "./README.md"],
      name: PACKED.name,
      version: PACKED.version,
    });
    const common = { "README.md": "x", "package.json": manifest, "scripts/a.mjs": "export {};\n" };
    const missing = missingPackedFiles(PACKED, tarball(common));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ package: PACKED.name, severity: "fail" });
    expect(missing[0]?.detail).toContain("build/web/tn-native-engine-web.wasm");
    expect(
      missingPackedFiles(PACKED, tarball({ ...common, "build/web/tn-native-engine-web.wasm": "" })),
    ).toEqual([]);
  });

  it("accepts a shipped script whose imports all shipped beside it", async () => {
    expect(
      await unresolvableTarballImports(
        PACKED,
        tarball({
          "package.json": JSON.stringify({ name: PACKED.name, version: PACKED.version }),
          "scripts/asset-preflight.mjs": "export const x = 1;\n",
          "scripts/package-android.mjs": "import { x } from './asset-preflight.mjs';\n",
        }),
      ),
    ).toEqual([]);
  });

  it("counts a dynamic import that escapes the tarball, and ignores one written into a string", async () => {
    const findings = await unresolvableTarballImports(
      PACKED,
      tarball({
        "package.json": JSON.stringify({ name: PACKED.name, version: PACKED.version }),
        "scripts/profile-production.mjs":
          'const generated = `import game from "./game.js";`;\n' +
          "export async function record() {\n" +
          "  const { createGateRecorder } = await import('../../../scripts/gate-records.mjs');\n" +
          "  return [createGateRecorder, generated];\n" +
          "}\n",
      }),
    );
    // Two claims in one: the CLI-guarded dynamic import still fails on an installed copy and is
    // reported, while `./game.js` — which this script writes into a generated bundle as text —
    // is not an import of this script at all. A gate whose failures are half fiction gets
    // suppressed rather than fixed.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toMatch(/gate-records\.mjs/u);
  });

  it("reads imports out of source rather than out of strings and comments", async () => {
    expect(
      await relativeSpecifiers(
        "sample.mjs",
        "// import './commented.mjs';\nconst s = `import x from \"./quoted.mjs\"`;\nimport './real.mjs';\nexport * from './re-exported.mjs';\n",
      ),
    ).toEqual(["./re-exported.mjs", "./real.mjs"]);
  });

  it("refuses a shipped module it cannot parse rather than reporting it clean", async () => {
    await expect(
      unresolvableTarballImports(
        PACKED,
        tarball({
          "package.json": JSON.stringify({ name: PACKED.name, version: PACKED.version }),
          "scripts/broken.mjs": "import { from './a.mjs'\n",
        }),
      ),
    ).rejects.toThrow(/TN_PUBLISH_MODULE_UNREADABLE/u);
  });

  it("names a relative import that escapes the package rather than treating it as a local miss", async () => {
    const findings = await unresolvableTarballImports(
      PACKED,
      tarball({
        "package.json": JSON.stringify({ name: PACKED.name, version: PACKED.version }),
        "scripts/consumer.mjs": "import '../../engine/src/index.js';\n",
      }),
    );

    expect(findings).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("outside the package tarball"),
        severity: "fail",
      }),
    ]);
  });

  it("fails when a packed manifest still carries a workspace protocol specifier", () => {
    // `npm pack` leaves catalog:/workspace: verbatim where `pnpm pack` substitutes them. The
    // tarball installs nowhere — EUNSUPPORTEDPROTOCOL on a stranger's machine and nowhere else.
    const findings = unresolvedTarballSpecifiers(
      PACKED,
      tarball({
        "package.json": JSON.stringify({
          dependencies: { three: "catalog:" },
          devDependencies: { "@threenative/core": "workspace:*" },
          name: PACKED.name,
          version: PACKED.version,
        }),
      }),
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.detail)).toEqual([
      expect.stringMatching(/dependencies\.three as 'catalog:'/u),
      expect.stringMatching(/devDependencies\.@threenative\/core as 'workspace:\*'/u),
    ]);
  });

  it("accepts a packed manifest whose specifiers were substituted", () => {
    expect(
      unresolvedTarballSpecifiers(
        PACKED,
        tarball({
          "package.json": JSON.stringify({
            dependencies: { three: "0.185.1" },
            name: PACKED.name,
            version: PACKED.version,
          }),
        }),
      ),
    ).toEqual([]);
  });

  it("blocks, never passes, on a tarball with no manifest to read", () => {
    const findings = unresolvedTarballSpecifiers(PACKED, tarball({ "README.md": "# x\n" }));
    expect(findings).toEqual([
      expect.objectContaining({ package: PACKED.name, severity: "blocked" }),
    ]);
  });

  it("packs this repository's runtime-native and finds every import inside the tarball", async () => {
    // The unit cases above plant their own tarballs; this one packs the real package, which is
    // the only way the `files` list itself is under test.
    const repo = path.resolve(import.meta.dirname, "../..");
    const item = publishSet(repo).find((entry) => entry.name === "@threenative/runtime-native");
    expect(item).toBeDefined();
    const contents = pnpmPackReader()(item as IPublishPackage);
    expect(contents.entries).toContain("scripts/asset-preflight.mjs");
    expect(await unresolvableTarballImports(item as IPublishPackage, contents)).toEqual([]);
    expect(unresolvedTarballSpecifiers(item as IPublishPackage, contents)).toEqual([]);
  }, 120_000);

  it("packs only self-contained core scripts and excludes the VSM development proof", async () => {
    const repo = path.resolve(import.meta.dirname, "../..");
    const item = publishSet(repo).find((entry) => entry.name === "@threenative/core");
    expect(item).toBeDefined();
    const contents = pnpmPackReader()(item as IPublishPackage);

    expect(contents.entries).toContain("scripts/postinstall.mjs");
    expect(contents.entries).toContain("LICENSE");
    expect(contents.entries).not.toContain("scripts/vsm-proof/run.mjs");
    expect(contents.entries.some((entry) => entry.startsWith("scripts/vsm-proof/"))).toBe(false);
    expect(await unresolvableTarballImports(item as IPublishPackage, contents)).toEqual([]);
  }, 120_000);

  it("refuses an empty publish set rather than reporting nothing to do", async () => {
    const root = await makeTempDir("threenative-publish-empty-");
    roots.push(root);
    fs.mkdirSync(path.join(root, "packages"), { recursive: true });
    expect(() => publishSet(root)).toThrow(/TN_PUBLISH_EMPTY_SET/u);
  });

  it("skips private packages, which are not shipped", async () => {
    const root = await fixture();
    write(
      root,
      "packages/internal/package.json",
      JSON.stringify({ name: "@threenative/internal", private: true, version: "9.9.9" }),
    );
    expect(publishSet(root).map((item) => item.name)).toEqual([
      "@threenative/core",
      "create-threenative",
    ]);
  });
});

// The prebuilt release is the one finding this repository has shipped past before:
// `@threenative/runtime-native@0.2.0` is on the registry today with no prebuilt release behind it.
// `install-prebuilt.mjs` treats that as a packaging fact rather than a broken download — it warns,
// the install finishes, and the native lanes fail closed later on the binary that is not there. So
// it is publishable on purpose, and only on purpose.
describe("acknowledging a missing prebuilt release", () => {
  it("refuses by default and reports rather than refuses when named", () => {
    const absent = () => "absent" as const;
    const refusing = prebuiltReleaseCensus("/repo", absent, "0.3.0", false);
    expect(refusing).toHaveLength(1);
    expect(refusing[0]?.severity).toBe("fail");

    const acknowledged = prebuiltReleaseCensus("/repo", absent, "0.3.0", true);
    expect(acknowledged).toHaveLength(1);
    // Still reported: an acknowledged finding that stopped being printed would be a silent one.
    expect(acknowledged[0]?.severity).toBe("warn");
    expect(acknowledged[0]?.detail).toContain("--allow-missing-prebuilt");
    expect(acknowledged[0]?.detail).toContain("fails closed");
  });

  it("acknowledges only the missing release, never an unreachable one", () => {
    // "unreachable" means the question was not answered. Acknowledging an answer nobody has would
    // publish on the strength of a network failure.
    const unreachable = () => "unreachable" as const;
    const findings = prebuiltReleaseCensus("/repo", unreachable, "0.3.0", true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocked");
  });
});
