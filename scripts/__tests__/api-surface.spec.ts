import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  API_SURFACE_RELATIVE_PATH,
  type IApiSurface,
  type IApiSurfacePackage,
  announcedBreakingSymbols,
  apiSurfaceFindings,
  compareApiSurface,
  deriveApiSurface,
  recordApiSurface,
  unannouncedBreaks,
  unwrappedSignature,
} from "../check-api-surface.js";
import { publicWorkspacePackages } from "../workspace-packages.js";

const repo = path.resolve(import.meta.dirname, "../..");
const snapshot = (): IApiSurface =>
  JSON.parse(readFileSync(path.join(repo, API_SURFACE_RELATIVE_PATH), "utf8")) as IApiSurface;

const KEPT: IApiSurfacePackage = {
  exports: [".", "./package.json"],
  symbols: { "@threenative/kept#kept": "export function kept(): void { … }" },
};
const GONE: IApiSurfacePackage = {
  exports: ["."],
  symbols: { "@threenative/gone#dropped": "export function dropped(): void { … }" },
};
const SURFACE: IApiSurface = {
  packages: { "@threenative/kept": KEPT, "@threenative/gone": GONE },
};

/** The live surface as it looks once `pnpm build` has regenerated the manifest without it. */
const live = (change: "package" | "subpath" | "symbol"): IApiSurface => {
  const gone: IApiSurfacePackage | undefined =
    change === "package"
      ? undefined
      : change === "subpath"
        ? { exports: [], symbols: GONE.symbols }
        : { exports: GONE.exports, symbols: {} };
  return {
    packages:
      gone === undefined
        ? { "@threenative/kept": KEPT }
        : { "@threenative/kept": KEPT, "@threenative/gone": gone },
  };
};

const CHANGELOG = [
  "## [Unreleased]",
  "",
  "### Breaking",
  "",
  "- `dropped` is no longer exported; TEMPORARY probe.",
  "",
  "### Added",
  "",
  "- `kept` gained an optional argument.",
].join("\n");

const breaking = (bullet: string): string =>
  ["## [Unreleased]", "", "### Breaking", "", `- ${bullet}`, ""].join("\n");

describe("stable public API surface (PRD-446)", () => {
  it("reads a reformatted parameter list as the same signature, and a retyped one as changed", () => {
    // Biome split bakedNoise's parameters over lines; collapsed, that read as a changed signature.
    const joined = 'export function f(p: Node<"vec3">, amount = 1): Node<"float"> { … }';
    const wrapped = 'export function f( p: Node<"vec3">, amount = 1, ): Node<"float"> { … }';
    expect(unwrappedSignature(wrapped)).toBe(unwrappedSignature(joined));
    expect(unwrappedSignature(joined.replace("amount = 1", "amount = 2"))).not.toBe(
      unwrappedSignature(wrapped),
    );
  });

  it("fails closed when the committed snapshot has no packages", () => {
    expect(() => compareApiSurface({ packages: {} }, SURFACE)).toThrow(
      /TN_API_SURFACE_SNAPSHOT_EMPTY/u,
    );
  });

  it("records every published package, including one whose manifest declares no exports map", () => {
    expect(Object.keys(snapshot().packages).sort()).toEqual(
      publicWorkspacePackages(repo)
        .map(({ name }) => name)
        .sort(),
    );
    // The published host is the one a `hasPublicExports` filter drops: it ships native code and
    // no TypeScript, so its entry is honest about having no subpaths and no walked symbols.
    expect(snapshot().packages["@threenative/runtime-native"]).toEqual({
      exports: [],
      symbols: {},
    });
  });

  it("fails when the live surface drops a published package, a subpath or a symbol", () => {
    expect(compareApiSurface(SURFACE, live("package")).removedSubpaths).toEqual([
      { package: "@threenative/gone", subpath: "." },
    ]);
    expect(compareApiSurface(SURFACE, live("subpath")).removedSubpaths).toEqual([
      { package: "@threenative/gone", subpath: "." },
    ]);
    expect(compareApiSurface(SURFACE, live("symbol")).removedSymbols).toEqual([
      { key: "@threenative/gone @threenative/gone#dropped", symbol: "dropped" },
    ]);
  });

  it("fails when a published symbol changes its signature", () => {
    const retyped: IApiSurface = {
      packages: {
        ...SURFACE.packages,
        "@threenative/kept": {
          ...KEPT,
          symbols: { "@threenative/kept#kept": "export function kept(count: number): void { … }" },
        },
      },
    };
    expect(compareApiSurface(SURFACE, retyped).changed).toEqual([
      { key: "@threenative/kept @threenative/kept#kept", symbol: "kept" },
    ]);
  });

  it("accepts the same removal once a Breaking entry names it, and only that symbol", () => {
    const announced = announcedBreakingSymbols(CHANGELOG);
    expect(announced.has("dropped")).toBe(true);
    // The same changelog does not excuse a different symbol: `kept` is only an addition there.
    expect(announced.has("kept")).toBe(false);
    const unannounced = (symbols: readonly { readonly symbol: string }[]): number =>
      symbols.filter(({ symbol }) => !announced.has(symbol)).length;
    expect(unannounced(compareApiSurface(SURFACE, live("symbol")).removedSymbols)).toBe(0);
    expect(
      unannounced(
        compareApiSurface(SURFACE, {
          packages: {
            ...SURFACE.packages,
            "@threenative/kept": {
              ...KEPT,
              symbols: {
                "@threenative/kept#kept": "export function kept(count: number): void { … }",
              },
            },
          },
        }).changed,
      ),
    ).toBe(1);
  });

  it("passes a retyped config member once a Breaking entry names its dotted path", () => {
    // The surface records a config member as `importPath#parent.member`, so the symbol a changelog
    // must name carries a dot. `renderer.projection` is a symbol the gate can report as changed, so
    // the entry that names it has to be findable — and naming half of it must not pass.
    const recorded: IApiSurface = {
      packages: {
        ...SURFACE.packages,
        "@threenative/kept": {
          ...KEPT,
          symbols: {
            "src/game.ts#renderer.projection": "renderer.projection?: boolean",
          },
        },
      },
    };
    const retyped: IApiSurface = {
      packages: {
        ...SURFACE.packages,
        "@threenative/kept": {
          ...KEPT,
          symbols: {
            "src/game.ts#renderer.projection":
              "renderer.projection?: boolean | { materialChecks?: 'spread' }",
          },
        },
      },
    };
    const findings = unannouncedBreaks(
      recorded,
      retyped,
      breaking("`renderer.projection` now also accepts an object."),
    );
    expect(findings).toEqual([]);
    expect(
      unannouncedBreaks(
        recorded,
        retyped,
        breaking("`renderer` now also takes an object, and so does `projection`."),
      ),
    ).toEqual([
      "changed signature @threenative/kept src/game.ts#renderer.projection has no Breaking entry naming it",
    ]);
  });

  it("passes a removed export subpath once a Breaking entry names it, and only that subpath", () => {
    const recorded: IApiSurface = {
      packages: {
        ...SURFACE.packages,
        "@threenative/kept": {
          exports: [".", "./navigation", "./web-brand"],
          symbols: KEPT.symbols,
        },
      },
    };
    const announced = [
      "## [Unreleased]",
      "",
      "### Breaking",
      "",
      "- The `@threenative/kept/navigation` and `@threenative/kept/web-brand` subpaths are gone.",
      "",
    ].join("\n");
    expect(unannouncedBreaks(recorded, SURFACE, announced)).toEqual([]);
    // Without the entry the same removal is red, naming each subpath a fix has to name.
    expect(unannouncedBreaks(recorded, SURFACE, CHANGELOG)).toEqual([
      "export subpath @threenative/kept./navigation is gone without a Breaking entry",
      "export subpath @threenative/kept./web-brand is gone without a Breaking entry",
    ]);
  });

  it("passes a removed published package once a Breaking entry names it, and only that package", () => {
    const removed = live("package");
    const finding = ["export subpath @threenative/gone. is gone without a Breaking entry"];
    expect(
      unannouncedBreaks(SURFACE, removed, breaking("`@threenative/gone` is no longer published.")),
    ).toEqual([]);
    // Neither silence nor an entry naming a different package announces this one.
    expect(unannouncedBreaks(SURFACE, removed, CHANGELOG)).toEqual(finding);
    expect(
      unannouncedBreaks(SURFACE, removed, breaking("`@threenative/kept` is no longer published.")),
    ).toEqual(finding);
    // Nor does a longer name that merely starts with it: the matcher is exact, not a prefix.
    expect(
      unannouncedBreaks(SURFACE, removed, breaking("`@threenative/gone-native` is gone.")),
    ).toEqual(finding);
  });

  it("reads a Breaking entry only where the next release would carry it", () => {
    const note = "`@threenative/gone` is no longer published.";
    const removal = live("package");
    const finding = ["export subpath @threenative/gone. is gone without a Breaking entry"];
    const noteUnder = (...headings: readonly string[]): string =>
      [...headings, "", "### Breaking", "", `- ${note}`, ""].join("\n");
    // 0.3.2 already told its consumers what changed there; its note excuses nothing added since.
    expect(
      unannouncedBreaks(
        SURFACE,
        removal,
        noteUnder(
          "## [Unreleased]",
          "## [0.3.3] - unreleased (release candidate)",
          "## [0.3.2] - 2026-09-12",
        ),
      ),
    ).toEqual(finding);
    // A version without a date is still history unless it is explicitly unreleased.
    expect(unannouncedBreaks(SURFACE, removal, noteUnder("## [Unreleased]", "## [0.3.1]"))).toEqual(
      finding,
    );
    // The same note where the break would ship is the announcement.
    expect(unannouncedBreaks(SURFACE, removal, noteUnder("## [Unreleased]"))).toEqual([]);
    expect(
      unannouncedBreaks(SURFACE, removal, noteUnder("## [0.3.3] - unreleased (release candidate)")),
    ).toEqual([]);
    // A changelog with no section a break could be announced in cannot pass silently.
    expect(() => announcedBreakingSymbols(noteUnder("## [0.3.2] - 2026-09-12"))).toThrow(
      /TN_API_SURFACE_CHANGELOG_SCOPE_MISSING/u,
    );
  });

  it("keeps the committed snapshot current", () => {
    expect(apiSurfaceFindings(repo)).toEqual([]);
    // Currency is equality, not "no removals": a snapshot lagging behind the tree cannot notice
    // the next removal of a symbol it never recorded, which is a silent break by construction.
    expect(deriveApiSurface(repo)).toEqual(snapshot());
  });

  it("refuses to re-record a snapshot while a removal is still unannounced", async () => {
    const root = await makeTempDir("tn-api-surface-");
    const symbol: IApiSurfacePackage = {
      exports: ["."],
      symbols: { "@threenative/kept#kept": "export function kept(): void { … }" },
    };
    const recorded = `${JSON.stringify({ packages: { "@threenative/kept": symbol } }, null, 2)}\n`;
    const manifestPath = path.join(root, "packages", "core", "capabilities.json");
    const snapshotPath = path.join(root, API_SURFACE_RELATIVE_PATH);
    const changelogPath = path.join(root, "CHANGELOG.md");
    await mkdir(path.join(root, "packages", "kept"), { recursive: true });
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeFile(
      path.join(root, "packages", "kept", "package.json"),
      JSON.stringify({
        exports: { ".": "./dist/index.js" },
        name: "@threenative/kept",
        version: "0.1.0",
      }),
    );
    const manifest = (entries: readonly unknown[]): string =>
      JSON.stringify({ entries, notOwned: [], version: "1" });
    await writeFile(
      manifestPath,
      manifest([
        {
          importPath: "@threenative/kept",
          package: "@threenative/kept",
          signature: symbol.symbols["@threenative/kept#kept"],
          symbol: "kept",
        },
      ]),
    );
    await writeFile(snapshotPath, recorded);
    await writeFile(changelogPath, CHANGELOG);
    // `pnpm build` regenerates the manifest without the symbol, so the removal is simply absent.
    await writeFile(manifestPath, manifest([]));
    // The one command an author reaches for when the check is red must not silence the removal.
    expect(() => recordApiSurface(root)).toThrow(/TN_API_SURFACE_UNANNOUNCED_BREAK/u);
    expect(await readFile(snapshotPath, "utf8")).toBe(recorded);
    // Announced where the next release would carry it, the same removal re-records.
    await writeFile(changelogPath, breaking("`kept` is no longer exported."));
    expect(recordApiSurface(root).packages["@threenative/kept"]).toEqual({
      exports: ["."],
      symbols: {},
    });
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toEqual({
      packages: { "@threenative/kept": { exports: ["."], symbols: {} } },
    });
  });
});
