import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEVANCE_FLOOR,
  capabilitySituationTokens,
  searchCapabilities,
} from "../../packages/engine-mcp/src/index.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  buildCapabilityManifest,
  checkCapabilityManifest,
  checkCapabilityScaffoldImports,
  validateCapabilityAllowlist,
  validateNotOwned,
  writeCapabilityManifest,
} from "../build-capability-manifest.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writePackage(
  root: string,
  directory: string,
  name: string,
  source: string,
  exports = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
): Promise<void> {
  const packageRoot = path.join(root, "packages", directory);
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ exports, name }));
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

async function writeTemplatePackageJsonDirectory(root: string, template: string): Promise<void> {
  await mkdir(
    path.join(root, "packages", "create-threenative", "templates", template, "package.json"),
    { recursive: true },
  );
}

const documentedClass = [
  "/**",
  " * A fixture capability.",
  " * @situation test a documented capability",
  " * @constraint use it from the fixture",
  " * @example const capability = new DocumentedCapability();",
  " */",
  "export class DocumentedCapability {}",
  "",
].join("\n");

describe("capability manifest generator", () => {
  it("includes subpath exports with the literal import path", async () => {
    const root = await makeTempDir("threenative-capability-subpath-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    const physicsRoot = path.join(root, "packages", "physics");
    await mkdir(path.join(physicsRoot, "src", "navigation"), { recursive: true });
    await writeFile(
      path.join(physicsRoot, "package.json"),
      JSON.stringify({
        exports: {
          "./navigation": {
            types: "./dist/navigation/index.d.ts",
            import: "./dist/navigation/index.js",
          },
        },
        name: "@threenative/physics",
      }),
    );
    await writeFile(
      path.join(physicsRoot, "src", "navigation", "index.ts"),
      [
        "/**",
        " * A navigation fixture.",
        " * @situation enemy walks around a wall",
        " * @example const agent = new NavigationAgent3D();",
        " */",
        "export class NavigationAgent3D {}",
        "",
      ].join("\n"),
    );

    const manifest = buildCapabilityManifest(root);
    expect(manifest.entries).toContainEqual(
      expect.objectContaining({
        importPath: "@threenative/physics/navigation",
        symbol: "NavigationAgent3D",
      }),
    );
  });

  it("fails closed and names every untagged public class or function", async () => {
    const root = await makeTempDir("threenative-capability-missing-situation-");
    temporaryRoots.push(root);
    await writePackage(
      root,
      "core",
      "@threenative/core",
      `${documentedClass}\nexport function MissingSituation(): void {}\n`,
    );

    expect(() => buildCapabilityManifest(root)).toThrow(/MissingSituation/u);
  });

  it("classifies callable exports by type, so an alias or re-bound function is no orphan", async () => {
    const root = await makeTempDir("threenative-capability-callable-alias-");
    temporaryRoots.push(root);
    const source = [
      documentedClass,
      "function helper(): void {}",
      "const upstream = { trace: helper };",
      "export const AliasedHelper = helper;",
      "export const ReboundTrace = upstream.trace;",
      "export const PLAIN_LIMIT = 4;",
      "",
    ].join("\n");
    await writePackage(root, "core", "@threenative/core", source);

    expect(() => buildCapabilityManifest(root)).toThrow(/AliasedHelper.*ReboundTrace/su);
    expect(() => buildCapabilityManifest(root)).not.toThrow(/PLAIN_LIMIT/u);
  });

  it("rejects an allowlist entry with an empty reason", () => {
    expect(() =>
      validateCapabilityAllowlist([{ package: "@threenative/core", reason: "", symbol: "Hidden" }]),
    ).toThrow(/non-empty.*reason/u);
  });

  it("rejects a one-token owned situation when the notOwned match clears the relevance floor", () => {
    const entries = [
      {
        constraints: [],
        example: "const capability = new InventoryCapability();",
        importPath: "@threenative/core",
        kind: "class" as const,
        overrides: [],
        package: "@threenative/core",
        signature: "class InventoryCapability",
        situations: ["inventory"],
        summary: "Manages inventory.",
        supersedes: [],
        symbol: "InventoryCapability",
      },
    ];
    const notOwnedSituation = "inventory system";
    const notOwned = [
      {
        guidance: "Write inventory state in the game's src/.",
        id: "inventory-system",
        situations: [notOwnedSituation],
      },
    ];
    const rawOverlapScore = 1 / Math.max(notOwnedSituation.split(" ").length, 1);

    expect(rawOverlapScore).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    expect(() => validateNotOwned(entries, notOwned)).toThrow(
      /notOwned 'inventory-system'.*InventoryCapability/u,
    );
  });

  it("rejects inflection-equivalent owned and notOwned situations", () => {
    const entries = [
      {
        constraints: [],
        example: "const capability = new SaveCapability();",
        importPath: "@threenative/core",
        kind: "class" as const,
        overrides: [],
        package: "@threenative/core",
        signature: "class SaveCapability",
        situations: ["saving progress"],
        summary: "Saves progress.",
        supersedes: [],
        symbol: "SaveCapability",
      },
    ];
    const notOwned = [
      {
        guidance: "Write save state in the game's src/.",
        id: "save-progress",
        situations: ["save progress"],
      },
    ];

    expect(() => validateNotOwned(entries, notOwned)).toThrow(
      /notOwned 'save-progress'.*SaveCapability/u,
    );
  });

  it("rejects an alias that overlaps a notOwned situation", () => {
    const entries = [
      {
        aliases: ["inventory system"],
        constraints: [],
        example: "const capability = new InventoryCapability();",
        importPath: "@threenative/core",
        kind: "class" as const,
        overrides: [],
        package: "@threenative/core",
        signature: "class InventoryCapability",
        situations: ["manage item slots"],
        summary: "Manages inventory.",
        supersedes: [],
        symbol: "InventoryCapability",
      },
    ];
    const notOwned = [
      {
        guidance: "Write inventory state in the game's src/.",
        id: "inventory-system",
        situations: ["inventory system"],
      },
    ];

    expect(() => validateNotOwned(entries, notOwned)).toThrow(
      /notOwned 'inventory-system'.*InventoryCapability/u,
    );
  });

  it("writes and checks a generated manifest instead of accepting a stale copy", async () => {
    const root = await makeTempDir("threenative-capability-freshness-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    await writeTemplatePackage(root, "starter", {
      dependencies: { "@threenative/core": "0.0.0", three: "0.0.0" },
      devDependencies: {},
    });
    const generated = await writeCapabilityManifest(root);
    await expect(checkCapabilityManifest(root)).resolves.toMatchObject({
      entries: generated.entries,
    });

    const file = path.join(root, "packages/create-threenative/capabilities.json");
    await writeFile(file, `${await readFile(file, "utf8")}\n`);
    await expect(checkCapabilityManifest(root)).rejects.toThrow(/stale/u);
  });

  it("fails loudly with the manifest path when the committed copy is missing", async () => {
    const root = await makeTempDir("threenative-capability-missing-manifest-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    await writeTemplatePackage(root, "starter", {
      dependencies: { "@threenative/core": "0.0.0", three: "0.0.0" },
      devDependencies: {},
    });

    await expect(checkCapabilityManifest(root)).rejects.toThrow(
      path.join(root, "packages/create-threenative/capabilities.json"),
    );
  });

  it("proves the committed manifest contains the navigation regression entry", async () => {
    const manifest = await checkCapabilityManifest(process.cwd());
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(manifest.entries).toContainEqual(
      expect.objectContaining({
        importPath: "@threenative/physics/navigation",
        symbol: "NavigationAgent3D",
      }),
    );
  });

  it("keeps the IComputeDriven cloth and fluid capability searchable in both manifests", async () => {
    for (const file of [
      "packages/core/capabilities.json",
      "packages/create-threenative/capabilities.json",
    ]) {
      const manifest = JSON.parse(await readFile(file, "utf8")) as {
        entries: Array<{ symbol: string; situations: string[] }>;
      };
      const search = (query: string) =>
        manifest.entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(query));
      expect(
        search("icomputedriven").some((entry) => entry.symbol === "ComputeDrivenRegistry"),
        file,
      ).toBe(true);
      expect(
        search("cloth").some((entry) => entry.symbol === "ComputeDrivenRegistry"),
        file,
      ).toBe(true);
      expect(
        search("fluid").some((entry) => entry.symbol === "ComputeDrivenRegistry"),
        file,
      ).toBe(true);
    }
  });

  it("keeps the measured Pixel 8 cloth cost in the shipped capability manifests", async () => {
    for (const file of [
      "packages/core/capabilities.json",
      "packages/create-threenative/capabilities.json",
    ]) {
      const manifest = JSON.parse(await readFile(file, "utf8")) as {
        entries: Array<{ constraints: string[]; symbol: string }>;
      };
      const softBody = manifest.entries.find((entry) => entry.symbol === "SoftBody3D");
      expect(softBody, file).toBeDefined();
      expect(softBody?.constraints.join(" "), file).toMatch(/Pixel 8.*steady.*ms/iu);
    }
  });

  it("keeps every public velocity example provisioned across the render boundary", async () => {
    const velocitySymbols = new Set([
      "VelocityTracker",
      "ensureVelocityOutput",
      "readVelocityPreviousBoneMatrices",
      "readVelocityPreviousMatrices",
      "readVelocityPreviousWorldMatrix",
      "velocityTexture",
      "withVelocityContext",
    ]);
    const manifest = await checkCapabilityManifest(process.cwd());
    const entries = manifest.entries.filter(
      (entry) => entry.importPath === "@threenative/core" && velocitySymbols.has(entry.symbol),
    );

    expect(entries.map((entry) => entry.symbol).sort()).toEqual([...velocitySymbols].sort());
    for (const entry of entries) {
      expect(entry.example, entry.symbol).toContain("ensureVelocityOutput(scenePass)");
      expect(entry.example, entry.symbol).toContain("renderer.setOutputNode(scenePass)");
      expect(entry.example, entry.symbol).toContain("tracker.update(scene)");
      expect(entry.example, entry.symbol).toContain("renderer.render(scene, camera)");
      expect(entry.example, entry.symbol).toContain("tracker.commit(scene)");
    }
  });

  it("carries @supersedes into the manifest entry as a source construct", async () => {
    const root = await makeTempDir("threenative-capability-supersedes-");
    temporaryRoots.push(root);
    await writePackage(
      root,
      "core",
      "@threenative/core",
      [
        "/**",
        " * A fixture capability that replaces a raw three construct.",
        " * @situation test what the ray hit",
        " * @supersedes new Raycaster(",
        " * @example const capability = new DocumentedCapability();",
        " */",
        "export class DocumentedCapability {}",
        "",
      ].join("\n"),
    );

    const manifest = buildCapabilityManifest(root);
    expect(manifest.entries).toContainEqual(
      expect.objectContaining({
        symbol: "DocumentedCapability",
        supersedes: ["new Raycaster("],
      }),
    );
  });

  it("carries @deprecatedOption into the manifest entry, and omits it when untagged", async () => {
    const root = await makeTempDir("threenative-capability-deprecated-");
    temporaryRoots.push(root);
    await writePackage(
      root,
      "core",
      "@threenative/core",
      [
        "/**",
        " * A fixture capability with one deprecated option.",
        " * @situation test what the deprecation names",
        " * @deprecatedOption constructor option `world`; pass `physics` instead",
        " * @example const capability = new DocumentedCapability();",
        " */",
        "export class DocumentedCapability {}",
        "",
        "/**",
        " * A fixture capability with nothing deprecated.",
        " * @situation test an undeprecated neighbour",
        " * @example const plain = new PlainCapability();",
        " */",
        "export class PlainCapability {}",
        "",
        "/**",
        " * A fixture capability whose class, not an option, is retired.",
        " * @situation test a class-level deprecation",
        " * @deprecated use PlainCapability instead",
        " * @example const retired = new RetiredCapability();",
        " */",
        "export class RetiredCapability {}",
        "",
      ].join("\n"),
    );

    const manifest = buildCapabilityManifest(root);
    const entry = manifest.entries.find((candidate) => candidate.symbol === "DocumentedCapability");
    const plain = manifest.entries.find((candidate) => candidate.symbol === "PlainCapability");
    const retired = manifest.entries.find((candidate) => candidate.symbol === "RetiredCapability");

    expect(entry?.deprecated).toEqual(["constructor option `world`; pass `physics` instead"]);
    // Absent, not an empty list: the entry field is optional and an untagged capability must not
    // grow a field the manifest schema only reserves for entries that carry a deprecation.
    expect(plain?.deprecated).toBeUndefined();
    // The capability tag is `@deprecatedOption` precisely because a bare `@deprecated` on an
    // export deprecates the whole class in TypeScript and every IDE. It must not reach the
    // manifest, where it would read as "this capability is retired".
    expect(retired?.deprecated).toBeUndefined();
  });

  it("leaves supersedes empty rather than undefined when untagged", async () => {
    const root = await makeTempDir("threenative-capability-no-supersedes-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);

    const manifest = buildCapabilityManifest(root);
    const entry = manifest.entries.find((candidate) => candidate.symbol === "DocumentedCapability");
    expect(entry?.supersedes).toEqual([]);
  });

  it("emits authored aliases without changing the displayed situations", async () => {
    const root = await makeTempDir("threenative-capability-alias-");
    temporaryRoots.push(root);
    await writePackage(
      root,
      "core",
      "@threenative/core",
      [
        "/**",
        " * A fixture capability with an alternate search key.",
        " * @situation display the readable fixture sentence",
        " * @alias fixture alternate wording",
        " * @example const capability = new DocumentedCapability();",
        " */",
        "export class DocumentedCapability {}",
        "",
      ].join("\n"),
    );

    const manifest = buildCapabilityManifest(root);
    expect(manifest.entries).toContainEqual(
      expect.objectContaining({
        aliases: ["fixture alternate wording"],
        situations: ["display the readable fixture sentence"],
        symbol: "DocumentedCapability",
      }),
    );
  });

  it("carries @requires into the manifest entry as an install instruction", async () => {
    const root = await makeTempDir("threenative-capability-requires-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    await writePackage(
      root,
      "raw-unreal",
      "@threenative/raw-unreal",
      [
        "/**",
        " * A fixture Unreal loader.",
        " * @situation load an Unreal mesh fixture",
        " * @requires npm i @threenative/raw-unreal",
        " * @example const mesh = loadUnrealMesh(bytes);",
        " */",
        "export function loadUnrealMesh(bytes: Uint8Array): Uint8Array { return bytes; }",
        "",
      ].join("\n"),
    );

    const manifest = buildCapabilityManifest(root);

    expect(manifest.entries).toContainEqual(
      expect.objectContaining({
        importPath: "@threenative/raw-unreal",
        requires: ["npm i @threenative/raw-unreal"],
        symbol: "loadUnrealMesh",
      }),
    );
  });

  it("fails when a manifest import has no scaffold dependency or requires instruction", async () => {
    const root = await makeTempDir("threenative-capability-scaffold-missing-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    await writePackage(
      root,
      "nope",
      "@threenative/nope",
      [
        "/**",
        " * A fabricated package capability.",
        " * @situation prove the scaffold import resolver fails closed",
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

    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).rejects.toThrow(/NopeCapability.*@threenative\/nope/u);
  });

  it("fails closed when the templates root is missing", async () => {
    const root = await makeTempDir("threenative-capability-no-templates-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);

    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).rejects.toThrow(/templates.*missing/u);
  });

  it("fails closed when no template closures are discovered", async () => {
    const root = await makeTempDir("threenative-capability-empty-templates-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    await mkdir(path.join(root, "packages", "create-threenative", "templates"), {
      recursive: true,
    });

    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).rejects.toThrow(/no template closures/u);
  });

  it("fails closed when a template package manifest is missing", async () => {
    const root = await makeTempDir("threenative-capability-template-no-package-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    await mkdir(path.join(root, "packages", "create-threenative", "templates", "starter"), {
      recursive: true,
    });

    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).rejects.toThrow(/starter.*package\.json.*missing/u);
  });

  it("fails closed when a template package manifest is unreadable or invalid", async () => {
    const root = await makeTempDir("threenative-capability-template-bad-package-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    await writeTemplatePackageJsonDirectory(root, "directory-package");

    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).rejects.toThrow(/directory-package.*package\.json.*unreadable/u);

    await rm(path.join(root, "packages", "create-threenative", "templates", "directory-package"), {
      recursive: true,
      force: true,
    });
    await mkdir(path.join(root, "packages", "create-threenative", "templates", "invalid-package"), {
      recursive: true,
    });
    await writeFile(
      path.join(
        root,
        "packages",
        "create-threenative",
        "templates",
        "invalid-package",
        "package.json",
      ),
      "{\n",
    );

    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).rejects.toThrow(/invalid-package.*package\.json.*invalid/u);
  });

  it("derives template dependency closure from package.json and source imports", async () => {
    const root = await makeTempDir("threenative-capability-template-closure-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    await writePackage(
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

    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).rejects.toThrow(/starter.*UiLayer.*@threenative\/ui/u);

    await writeTemplatePackage(root, "starter", {
      dependencies: {
        "@threenative/core": "0.0.0",
        "@threenative/ui": "0.0.0",
        three: "0.0.0",
      },
      devDependencies: {},
    });
    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).resolves.toEqual(expect.objectContaining({ problems: [] }));
  });

  it("checks each template closure on its own, so another template's install does not count", async () => {
    const root = await makeTempDir("threenative-capability-per-template-");
    temporaryRoots.push(root);
    await writePackage(root, "core", "@threenative/core", documentedClass);
    const uiLayer = (requires: string): string =>
      [
        "/**",
        " * A fixture UI layer.",
        " * @situation render a React HUD over the game",
        " * @example const layer = new UiLayer();",
        requires,
        " */",
        "export class UiLayer {}",
        "",
      ].join("\n");
    await writePackage(root, "ui", "@threenative/ui", uiLayer(" *"));
    await writeTemplatePackage(root, "starter", {
      dependencies: { "@threenative/core": "0.0.0", "@threenative/ui": "0.0.0", three: "0.0.0" },
      devDependencies: {},
    });
    await writeTemplatePackage(root, "minimal", {
      dependencies: { "@threenative/core": "0.0.0", three: "0.0.0" },
      devDependencies: {},
    });

    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).rejects.toThrow(/- minimal: UiLayer -> @threenative\/ui/u);

    await writePackage(
      root,
      "ui",
      "@threenative/ui",
      uiLayer(" * @requires npm i @threenative/ui"),
    );
    await expect(
      checkCapabilityScaffoldImports(root, buildCapabilityManifest(root)),
    ).resolves.toEqual(expect.objectContaining({ problems: [] }));
  });

  it("maps every authored alias to a named predecessor corpus row", async () => {
    const manifest = await checkCapabilityManifest(process.cwd());
    const aliases = manifest.entries.flatMap((entry) => entry.aliases ?? []);
    const predecessorRows = {
      "third-person camera": { ids: ["request.third-person-camera"], owners: ["defineGame"] },
      "restart run without page reload": {
        ids: ["brief.endless-runner.5"],
        owners: ["defineGame"],
      },
      "field of view while aiming": { ids: ["brief.fps.2"], owners: ["defineGame"] },
      "nearest target crosshair spawns": { ids: ["brief.fps.4"], owners: ["defineGame"] },
      "obstacles collectibles increasing pace": {
        ids: ["brief.endless-runner.3"],
        owners: ["InstancedBatch"],
      },
      "readable world lighting": { ids: ["brief.exploration.5"], owners: ["ProbeVolume"] },
      "different area props": {
        ids: ["brief.exploration.3"],
        owners: ["createAssetLoader"],
      },
      "journal objective panel": {
        ids: ["brief.exploration.4"],
        owners: ["publishUiState"],
      },
      "objective panel journal": { ids: ["brief.exploration.4"], owners: ["Text"] },
      "readable HUD": { ids: ["brief.physics-puzzle.6"], owners: ["publishUiState"] },
      "stream terrain across chunks": {
        ids: ["brief.open-world.2"],
        owners: ["TerrainTiles"],
        baselineAlreadyRecalled: true,
      },
      "landmarks points of interest": {
        ids: ["brief.open-world.4"],
        owners: ["InstancedBatch"],
      },
      "first playable screen external assets": {
        ids: ["brief.open-world.5"],
        owners: ["createAssetLoader"],
      },
      "fixed seed fixed-step simulation": {
        ids: ["brief.physics-puzzle.5"],
        owners: ["createReplayDriver", "replay"],
      },
      "spawn waves": { ids: ["request.spawn-waves"], owners: ["Scheduler"] },
      "tower defense game": { ids: ["request.tower-defense-game"], owners: ["Scheduler"] },
      "pick up item": { ids: ["request.pick-up-item"], owners: ["Area3D"] },
      "platformer double jump": {
        ids: ["request.platformer-double-jump"],
        owners: ["CharacterBody3D"],
      },
      "first person": { ids: ["brief.fps.1"], owners: ["CharacterBody3D"] },
      "run jump coins goal": { ids: ["brief.platformer.2"], owners: ["CharacterBody3D"] },
      "passes through body": { ids: ["brief.physics-puzzle.3"], owners: ["CollisionShape3D"] },
      "arena walls pickups": {
        ids: ["brief.topdown-action.4"],
        owners: ["CollisionShape3D"],
      },
      "hitscan camera": {
        ids: ["brief.fps.7"],
        owners: ["PhysicsDirectSpaceState3D"],
      },
      "raised platform gap hazard restart": {
        ids: ["brief.platformer.3"],
        owners: ["CharacterBody3D"],
      },
      "green platforms bright saturated sky": {
        ids: ["brief.platformer.4"],
        owners: ["Atmosphere"],
      },
      "enemy targets cooldown reload win condition": {
        ids: ["brief.topdown-action.3"],
        owners: ["CharacterBody3D"],
      },
      "close engagement range": { ids: ["brief.fps.12"], owners: ["NavigationAgent3D"] },
      "racing car racing kart drift vehicle go-kart": {
        ids: ["request.drive-a-racing-kart"],
        owners: ["VehicleBody3D"],
      },
      "suspension wheel traction tyre grip": {
        ids: ["request.vehicle-suspension-grip"],
        owners: ["VehicleBody3D"],
      },
      "accelerator pedal handbrake steering wheel": {
        ids: ["request.vehicle-pedals-steering"],
        owners: ["VehicleBody3D"],
      },
      "rescue respawn flip back on track": {
        ids: ["request.vehicle-rescue-respawn"],
        owners: ["VehicleBody3D"],
      },
    } as const;

    expect([...new Set(aliases)].sort()).toEqual(Object.keys(predecessorRows).sort());
    const corpus = JSON.parse(
      await readFile(
        path.join(process.cwd(), "scripts/fixtures/capability-recall/corpus.json"),
        "utf8",
      ),
    ) as {
      rows: readonly {
        readonly expect: readonly string[];
        readonly id: string;
        readonly query: string;
        readonly scope: "mechanic" | "request";
        readonly source: string;
      }[];
    };
    const rows = new Map(corpus.rows.map((row) => [row.id, row]));
    const predecessorRoot = await makeTempDir("threenative-capability-predecessor-");
    temporaryRoots.push(predecessorRoot);
    const predecessorFile = path.join(predecessorRoot, "capabilities.json");
    await writeFile(
      predecessorFile,
      JSON.stringify({
        ...manifest,
        entries: manifest.entries.map((entry) => ({ ...entry, aliases: [] })),
      }),
    );

    for (const [alias, predecessor] of Object.entries(predecessorRows)) {
      const owners = manifest.entries.filter((entry) => entry.aliases?.includes(alias));
      expect(owners.map((entry) => entry.symbol).sort(), alias).toEqual(
        predecessor.owners.slice().sort(),
      );
      for (const id of predecessor.ids) {
        const row = rows.get(id);
        expect(row, `${alias} -> ${id}`).toBeDefined();
        if (row === undefined) continue;
        const rowTokens = new Set(capabilitySituationTokens(row.query));
        expect(
          capabilitySituationTokens(alias).every((token) => rowTokens.has(token)),
          `${alias} uses vocabulary absent from ${row.source}`,
        ).toBe(true);
        const expectedOwners = predecessor.owners.filter((owner) => row.expect.includes(owner));
        expect(expectedOwners.length, `${alias} -> ${id} has no expected owner`).toBeGreaterThan(0);
        const before = searchCapabilities(row.query, predecessorFile, row.scope).results.map(
          (result) => result.symbol,
        );
        const baselineAlreadyRecalled =
          "baselineAlreadyRecalled" in predecessor && predecessor.baselineAlreadyRecalled === true;
        if (!baselineAlreadyRecalled) {
          expect(
            expectedOwners.some((owner) => before.includes(owner)),
            `${alias} -> ${id} was already recalled without aliases`,
          ).toBe(false);
        }
        const after = searchCapabilities(
          row.query,
          "packages/create-threenative/capabilities.json",
          row.scope,
        ).results.map((result) => result.symbol);
        expect(
          expectedOwners.some((owner) => after.includes(owner)),
          `${alias} -> ${id} is not recalled with its alias`,
        ).toBe(true);
      }
    }
  });

  it("should fail when one normalized alias spans more than MAX_ALIAS_FANOUT entries", async () => {
    const root = await makeTempDir("threenative-capability-alias-fanout-");
    temporaryRoots.push(root);
    await writePackage(
      root,
      "core",
      "@threenative/core",
      [
        "/**",
        " * First fixture.",
        " * @situation first fixture",
        " * @alias RACING",
        " * @example const first = new First();",
        " */",
        "export class First {}",
        "/**",
        " * Second fixture.",
        " * @situation second fixture",
        " * @alias racing!",
        " * @example const second = new Second();",
        " */",
        "export class Second {}",
        "/**",
        " * Third fixture.",
        " * @situation third fixture",
        " * @alias racing",
        " * @example const third = new Third();",
        " */",
        "export class Third {}",
        "",
      ].join("\n"),
    );

    expect(() => buildCapabilityManifest(root)).toThrow(/racing.*First.*Second.*Third/u);
  });
});
