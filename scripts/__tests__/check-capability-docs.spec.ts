import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  capabilityPackageSpecs,
  checkBuiltCapabilityImports,
  checkCapabilityDocs,
  checkCapabilityPackageCensus,
  collectPublicExports,
  findDocTagGaps,
  formatCapabilityReport,
  missingDocTags,
  validateCapabilityPackageAllowlist,
  validateInternalAllowlist,
} from "../check-capability-docs.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function writePackage(
  root: string,
  directory: string,
  name: string,
  source: string,
): Promise<void> {
  const packageRoot = path.join(root, "packages", directory);
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name, version: "0.3.0" }),
  );
  await writeFile(path.join(packageRoot, "src", "index.ts"), source);
}

async function writeExportedPackage(
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
      version: "0.3.0",
    }),
  );
  await writeFile(path.join(packageRoot, "src", "index.ts"), source);
}

async function writeCapabilityManifest(root: string, packages: readonly string[]): Promise<void> {
  const manifestRoot = path.join(root, "packages", "create-threenative");
  await mkdir(manifestRoot, { recursive: true });
  await writeFile(
    path.join(manifestRoot, "capabilities.json"),
    JSON.stringify({ entries: packages.map((packageName) => ({ package: packageName })) }),
  );
}

async function writeBuiltImportFixture(root: string): Promise<void> {
  const packageRoot = path.join(root, "node_modules", "@threenative", "probe");
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      exports: {
        ".": { import: "./dist/index.js" },
        "./feature": { import: "./dist/feature.js" },
      },
      name: "@threenative/probe",
      type: "module",
      version: "0.0.0",
    }),
  );
  await writeFile(path.join(packageRoot, "dist/index.js"), "export function probe() {}\n");
  await writeFile(path.join(packageRoot, "dist/feature.js"), "export function feature() {}\n");
  await writeFile(path.join(packageRoot, "src/index.js"), "export function probe() {}\n");
  await mkdir(path.join(root, "packages/create-threenative"), { recursive: true });
  await writeFile(
    path.join(root, "packages/create-threenative/capabilities.json"),
    JSON.stringify({
      entries: [
        { importPath: "@threenative/probe", symbol: "probe" },
        { importPath: "@threenative/probe/feature", symbol: "feature" },
      ],
    }),
  );
}

/** A two-package tree whose capabilities are written in every callable form TypeScript allows. */
async function arrowExportFixture(): Promise<string> {
  const root = await makeTempDir("threenative-capability-arrow-");
  temporaryRoots.push(root);
  const sources: Record<string, string> = {
    core: [
      "export const steerAroundWall = (): void => undefined;",
      "export const SnapToFloor = class { snap(): void {} };",
      "export const VERSION = 1;",
      "export interface INotACapability { readonly kind: string }",
    ].join("\n"),
    physics: [
      "export const holdWeapon = function attach(): void {};",
      "export function alsoCounted(): void {}",
    ].join("\n"),
  };
  for (const [packageName, source] of Object.entries(sources)) {
    const packageRoot = path.join(root, "packages", packageName);
    await mkdir(path.join(packageRoot, "src"), { recursive: true });
    await writeFile(path.join(packageRoot, "src", "index.ts"), `${source}\n`);
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: `@threenative/${packageName}`,
        version: "0.0.0",
        exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
      }),
    );
  }
  return root;
}

describe("capability documentation gate", () => {
  it("should fail an export whose doc tags are incomplete, naming symbol and tag", async () => {
    const root = await makeTempDir("threenative-capability-tags-");
    await writePackage(root, "core", "@threenative/core", "");
    const capabilities = [
      {
        entry: path.join(root, "packages/core/src/index.ts"),
        name: "HalfTagged",
        packageName: "@threenative/core" as const,
        subpath: "." as const,
      },
    ];
    const manifest = {
      entries: [
        {
          example: "",
          importPath: "@threenative/core",
          situations: ["test a half documented capability"],
          summary: "A capability with no example.",
          symbol: "HalfTagged",
        },
        {
          example: "",
          importPath: "@threenative/core",
          situations: [],
          summary: "Untagged",
          symbol: "Untagged",
        },
      ],
    };
    await mkdir(path.join(root, "packages/create-threenative"), { recursive: true });
    await writeFile(
      path.join(root, "packages/create-threenative/capabilities.json"),
      JSON.stringify(manifest),
    );

    const gaps = await findDocTagGaps(root, capabilities);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.missing).toEqual(["@example"]);
    expect(formatCapabilityReport({ exports: capabilities, gaps })).toContain("HalfTagged");
    expect(formatCapabilityReport({ exports: capabilities, gaps })).toContain("@example");
  });

  it("should demand every tag when an export is absent from the manifest", () => {
    expect(missingDocTags(undefined)).toEqual(["@example", "@situation", "summary"]);
  });

  it("should still honour INTERNAL_ALLOWLIST", async () => {
    const root = await makeTempDir("threenative-capability-allowlist-");
    await writePackage(root, "core", "@threenative/core", "");
    const capabilities = [
      {
        entry: path.join(root, "packages/core/src/index.ts"),
        name: "assertPortableState",
        packageName: "@threenative/core" as const,
        subpath: "./hot" as const,
      },
    ];
    await mkdir(path.join(root, "packages/create-threenative"), { recursive: true });
    await writeFile(
      path.join(root, "packages/create-threenative/capabilities.json"),
      JSON.stringify({ entries: [] }),
    );

    const gaps = await findDocTagGaps(root, capabilities);
    expect(gaps).toEqual([]);
  });

  it("should fail when an INTERNAL allowlist entry has an empty reason", () => {
    expect(() => validateInternalAllowlist({ "@threenative/core#Hidden": "" })).toThrow(
      "CAPABILITY_DOCS_INTERNAL_ALLOWLIST_INVALID",
    );
  });

  it("should scan subpath exports, not only the main package index", async () => {
    const capabilities = await collectPublicExports(process.cwd());

    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "NavigationAgent3D",
          packageName: "@threenative/physics",
          subpath: "./navigation",
        }),
        expect.objectContaining({
          name: "createReactOverlay",
          packageName: "@threenative/core",
          subpath: "./react",
        }),
        expect.objectContaining({
          name: "connectUiBridge",
          packageName: "@threenative/core",
          subpath: "./ui-layer",
        }),
        expect.objectContaining({
          name: "compileAssets",
          packageName: "@threenative/assets",
          subpath: ".",
        }),
        expect.objectContaining({
          name: "texturePass",
          packageName: "@threenative/assets",
          subpath: ".",
        }),
      ]),
    );
    // Hang guard, not a speed budget: this parses every public export with the compiler and took
    // 5 s on one tn-local slot but over 15 s on a loaded one (run 39066107986, test-unit 3/4).
  }, 60_000);

  it("should scan a capability written as an arrow const, not only declaration forms", async () => {
    // The gate's job is to make an undocumented capability a release defect. It counted only
    // `class`/`function` declarations, so `export const helper = () => {}` left the scan without a
    // word — the symbol simply stopped existing as far as documentation was concerned. A constant
    // that is not callable must still be ignored, or the gate starts demanding prose for every
    // exported number.
    const root = await arrowExportFixture();
    const capabilities = await collectPublicExports(root);
    const names = capabilities.map((capability) => capability.name);

    expect(names).toContain("steerAroundWall");
    expect(names).toContain("holdWeapon");
    expect(names).toContain("SnapToFloor");
    expect(names).not.toContain("VERSION");
  });

  it("should pass against the tagged engine tree", async () => {
    const report = await checkCapabilityDocs(process.cwd());

    expect(report.gaps).toEqual([]);
  }, 30_000);

  it("should import every package-backed capability from built exports", async () => {
    const root = await makeTempDir("threenative-capability-built-");
    temporaryRoots.push(root);
    await writeBuiltImportFixture(root);

    await expect(checkBuiltCapabilityImports(root)).resolves.toEqual({
      checkedImportPaths: 2,
      checkedSymbols: 2,
      skippedSourceEntries: 0,
    });
  });

  it("should fail with the import path and symbol when an export-map entry disappears", async () => {
    const root = await makeTempDir("threenative-capability-built-missing-export-");
    temporaryRoots.push(root);
    await writeBuiltImportFixture(root);
    await writeFile(
      path.join(root, "node_modules/@threenative/probe/package.json"),
      JSON.stringify({
        exports: { ".": { import: "./dist/index.js" } },
        name: "@threenative/probe",
        type: "module",
        version: "0.0.0",
      }),
    );

    await expect(checkBuiltCapabilityImports(root)).rejects.toThrow(
      /@threenative\/probe\/feature#feature/u,
    );
  });

  it("should fail when dist is absent instead of rewriting the import to src", async () => {
    const root = await makeTempDir("threenative-capability-built-no-dist-");
    temporaryRoots.push(root);
    await writeBuiltImportFixture(root);
    await rm(path.join(root, "node_modules/@threenative/probe/dist/feature.js"));

    await expect(checkBuiltCapabilityImports(root)).rejects.toThrow(
      /@threenative\/probe\/feature#feature/u,
    );
  });

  it("should reject a matching default function when the manifest names an export", async () => {
    const root = await makeTempDir("threenative-capability-built-default-only-");
    temporaryRoots.push(root);
    await writeBuiltImportFixture(root);
    await writeFile(
      path.join(root, "node_modules/@threenative/probe/dist/feature.js"),
      "export default function feature() {}\n",
    );

    await expect(checkBuiltCapabilityImports(root)).rejects.toThrow(
      /@threenative\/probe\/feature#feature/u,
    );
  });

  it("should fail for a public package with no capability coverage", async () => {
    const root = await makeTempDir("threenative-capability-census-uncovered-");
    temporaryRoots.push(root);
    await writeExportedPackage(
      root,
      "zzz-probe",
      "@threenative/zzz-probe",
      "export function probe() {}\n",
    );
    await writeCapabilityManifest(root, []);

    await expect(checkCapabilityPackageCensus(root, {})).rejects.toThrow(
      /@threenative\/zzz-probe.*public exports map.*no capability coverage/u,
    );
  });

  it("should pass when a public package is allowlisted with a reason", async () => {
    const root = await makeTempDir("threenative-capability-census-allowlisted-");
    temporaryRoots.push(root);
    await writeExportedPackage(
      root,
      "zzz-probe",
      "@threenative/zzz-probe",
      "export function probe() {}\n",
    );
    await writeCapabilityManifest(root, []);

    await expect(
      checkCapabilityPackageCensus(root, {
        "@threenative/zzz-probe": "Probe package is test-only infrastructure.",
      }),
    ).resolves.toMatchObject({ allowlisted: ["@threenative/zzz-probe"], walked: [] });
  });

  it("should reject an empty or multi-line package allowlist reason", () => {
    expect(() => validateCapabilityPackageAllowlist({ "@threenative/zzz-probe": "" })).toThrow(
      "CAPABILITY_PACKAGE_ALLOWLIST_INVALID",
    );
    expect(() =>
      validateCapabilityPackageAllowlist({ "@threenative/zzz-probe": "first\nsecond" }),
    ).toThrow("CAPABILITY_PACKAGE_ALLOWLIST_INVALID");
  });

  it("should derive the capability package set from public workspace export maps", () => {
    const names = capabilityPackageSpecs(process.cwd()).map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining([
        "@threenative/assets",
        "@threenative/core",
        "@threenative/physics",
        "@threenative/playtest",
        "@threenative/ui",
      ]),
    );
    expect(names).not.toContain("create-threenative");
    expect(names).not.toContain("threenative-engine-mcp");
  });
});
