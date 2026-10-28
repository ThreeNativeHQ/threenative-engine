import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { checkCoreBoundary, checkWorkerGlobals } from "../check-core-boundary.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await makeTempDir("threenative-core-boundary-");
  temporaryRoots.push(root);
  await mkdir(path.join(root, "packages/core/src"), { recursive: true });
  await mkdir(path.join(root, "packages/create-threenative/templates/starter/src/render"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "packages/create-threenative/templates/starter/package.json"),
    JSON.stringify({ dependencies: { vite: "1.0.0" } }),
  );
  await writeFile(
    path.join(root, "packages/create-threenative/templates/starter/src/render/lighting.ts"),
    "export const lighting = true;\n",
  );
  await writeFile(
    path.join(root, "packages/create-threenative/templates/starter/src/render/hud.ts"),
    "export const hud = true;\n",
  );
  return root;
}

describe("core boundary gate", () => {
  it("passes the entity and scaffold rules on a clean fixture", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "packages/core/src/entities.ts"), "export const ok = true;\n");
    await expect(checkCoreBoundary(root)).resolves.toEqual([]);
  });

  it("fails the entity line limit and banned-token rule locally", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "packages/core/src/entities.ts"),
      `${"const line = 1;\n".repeat(80)}export const System = 1;\n`,
    );

    const findings = await checkCoreBoundary(root);
    expect(findings.join("\n")).toMatch(/entities\.ts has 81 lines.*fewer than 80/isu);
    expect(findings.join("\n")).toContain("banned entity-registry token 'System'");
  });

  it("names a banned entity-registry token in a second core source file", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "packages/core/src/entities.ts"), "export const ok = true;\n");
    await writeFile(
      path.join(root, "packages/core/src/entity-snapshot.ts"),
      "export const snapshot = Component;\n",
    );

    await expect(checkCoreBoundary(root)).resolves.toContain(
      "packages/core/src/entity-snapshot.ts:1 uses banned entity-registry token 'Component'",
    );
  });

  it("fails scaffold hygiene when generated render code imports the framework", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "packages/core/src/entities.ts"), "export const ok = true;\n");
    await writeFile(
      path.join(root, "packages/create-threenative/templates/starter/src/render/lighting.ts"),
      'import { defineGame } from "@threenative/core";\n',
    );

    await expect(checkCoreBoundary(root)).resolves.toEqual([
      expect.stringContaining("starter/src/render/lighting.ts imports @threenative/"),
    ]);
  });

  // The waiver in `check-core-boundary.ts` lets a template's `src/render/` import named
  // mechanism-only symbols from `@threenative/core`. It has to fail closed on every other shape
  // an import can take, or "narrow allowlist" is just a hole with a comment over it. Each row
  // says what the gate must decide, and the reason it is not obvious from the allowlist alone.
  const waiverCases: ReadonlyArray<readonly [string, string, "allow" | "reject"]> = [
    ["a plain named import", 'import { SpectralOcean } from "@threenative/core";\n', "allow"],
    [
      "a type and a value together",
      'import { type ISpectralOceanOptions, SpectralOcean } from "@threenative/core";\n',
      "allow",
    ],
    [
      "the same import wrapped over lines by the formatter",
      'import {\n  type ISpectralOceanOptions,\n  SpectralOcean,\n} from "@threenative/core";\n',
      "allow",
    ],
    ["single quotes", "import { SpectralOcean } from '@threenative/core';\n", "allow"],
    ["no trailing semicolon", 'import { SpectralOcean } from "@threenative/core"\n', "allow"],
    [
      "an allowed symbol renamed at the import",
      'import { SpectralOcean as Sea } from "@threenative/core";\n',
      "allow",
    ],
    ["a look-owning symbol", 'import { defineGame } from "@threenative/core";\n', "reject"],
    [
      "a look-owning symbol smuggled beside an allowed one",
      'import { defineGame, SpectralOcean } from "@threenative/core";\n',
      "reject",
    ],
    [
      "a look-owning symbol renamed to hide it",
      'import { defineGame as go } from "@threenative/core";\n',
      "reject",
    ],
    [
      "an allowed name taken from another package",
      'import { SpectralOcean } from "@threenative/physics";\n',
      "reject",
    ],
    [
      "an allowed name taken from a core subpath",
      'import { SpectralOcean } from "@threenative/core/ocean";\n',
      "reject",
    ],
    ["a namespace import", 'import * as core from "@threenative/core";\n', "reject"],
    ["a default import", 'import core from "@threenative/core";\n', "reject"],
    ["a side-effect import", 'import "@threenative/core";\n', "reject"],
    ["a re-export", 'export { SpectralOcean } from "@threenative/core";\n', "reject"],
    [
      "a look-owning symbol in the type re-export form",
      'export type { Daylight } from "@threenative/core";\n',
      "reject",
    ],
    [
      "a type re-export mixing an allowed name and an unlisted one",
      'export type { QualityTier, Daylight } from "@threenative/core";\n',
      "reject",
    ],
    ["a wildcard type re-export", 'export type * from "@threenative/core";\n', "reject"],
    [
      "a type re-export from another package",
      'export type { QualityTier } from "@threenative/physics";\n',
      "reject",
    ],
    [
      "a type re-export from a core subpath",
      'export type { QualityTier } from "@threenative/core/look";\n',
      "reject",
    ],
    ["a dynamic import", 'const m = await import("@threenative/core");\n', "reject"],
    ["an empty brace clause", 'import {} from "@threenative/core";\n', "reject"],
    ["the package named in a string", 'export const which = "@threenative/core";\n', "reject"],
    ["the package named in a comment", "// see @threenative/core for the simulation\n", "reject"],
  ];

  for (const [name, source, expected] of waiverCases) {
    it(`${expected === "allow" ? "allows" : "rejects"} ${name} in generated render source`, async () => {
      const root = await fixtureRoot();
      await writeFile(
        path.join(root, "packages/core/src/entities.ts"),
        "export const ok = true;\n",
      );
      await writeFile(
        path.join(root, "packages/create-threenative/templates/starter/src/render/lighting.ts"),
        source,
      );

      const findings = await checkCoreBoundary(root);
      expect(
        findings.some((finding) => finding.includes("imports @threenative/")),
        `${name}: ${findings.join(" | ") || "(no findings)"}`,
      ).toBe(expected === "reject");
    });
  }

  it("allows PRD-723 shared default-look plumbing imports in generated render source", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "packages/core/src/entities.ts"), "export const ok = true;\n");
    await writeFile(
      path.join(root, "packages/create-threenative/templates/starter/src/render/lighting.ts"),
      [
        "import type {",
        "  IWorldEnvironmentOptions,",
        "  IExposureSettings,",
        "  QualityTier,",
        "  OutputRenderer,",
        "  ChainStage,",
        "  IWorldEnvironmentStageContext,",
        '} from "@threenative/core";',
        'import { WorldEnvironment, qualityPreset as coreQualityPreset, qualityTiers, exposureSettings } from "@threenative/core";',
        'export type { QualityTier, IExposureSettings } from "@threenative/core";',
        "export const pipeline = [WorldEnvironment, coreQualityPreset, qualityTiers, exposureSettings];",
      ].join("\n"),
    );

    await expect(checkCoreBoundary(root)).resolves.toEqual([]);
  });
});

describe("core reaches worker-missing globals only through platform.ts (PRD-752)", () => {
  const core = (root: string, file: string) => path.join(root, "packages/core/src", file);

  it("names a core file that reads document or window directly", async () => {
    const root = await fixtureRoot();
    await writeFile(core(root, "entities.ts"), "export const ok = true;\n");
    await writeFile(
      core(root, "hud.ts"),
      'export const live = typeof window !== "undefined";\nexport const body = document.body;\n',
    );
    const findings = await checkCoreBoundary(root);
    expect(findings).toContain(
      "packages/core/src/hud.ts:1 reads 'window', which a worker does not have; reach it through packages/core/src/platform.ts",
    );
    expect(findings.join("\n")).toContain("packages/core/src/hud.ts:2 reads 'document'");
  });

  it("allows the host layer, type-only DOM names and a local named window", async () => {
    const root = await fixtureRoot();
    await writeFile(core(root, "platform.ts"), "export const body = () => document.body;\n");
    await writeFile(
      core(root, "frames.ts"),
      [
        "export function size(canvas: HTMLCanvasElement): number { return canvas.width; }",
        "const window = { fps: 60 };",
        "export const fps = window.fps;",
      ].join("\n"),
    );
    await expect(checkWorkerGlobals(root)).resolves.toEqual([]);
  });

  it("finds no worker-missing global in the real core source", { timeout: 120_000 }, async () => {
    await expect(checkWorkerGlobals(path.resolve(import.meta.dirname, "../.."))).resolves.toEqual(
      [],
    );
  });
});
