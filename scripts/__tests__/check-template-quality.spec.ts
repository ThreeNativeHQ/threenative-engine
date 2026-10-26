import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  checkTemplateQuality,
  contractDriftFindings,
  contractSpanHash,
  contractSpanThrows,
  costCommentGaps,
  eagerSurfaceNodes,
  formatTemplateQualityReport,
  presetLiteralsIn,
  qualityContractSpan,
  templateNames,
} from "../template-quality.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONTRACT = `export type QualityTier = "low" | "medium" | "high";

const QUALITY_TIERS: readonly QualityTier[] = ["low", "medium", "high"];

function isQualityTier(value: string): value is QualityTier {
  return (QUALITY_TIERS as readonly string[]).includes(value);
}

export function resolveQualityTier(
  request: { readonly mobile?: boolean; readonly tier?: string } = {},
): QualityTier {
  const requested = request.tier;
  if (requested !== undefined) {
    if (!isQualityTier(requested)) {
      throw new Error(\`Unknown quality tier \${JSON.stringify(requested)}.\`);
    }
    return requested;
  }
  return request.mobile === true ? "low" : "high";
}
`;

const QUALITY = `import type { IWorldEnvironmentOptions } from "./worldEnvironment.js";
${CONTRACT}
const high: IWorldEnvironmentOptions = {
  // Bloom: ~4.6 ms.
  bloomEnabled: true,
};
const medium: IWorldEnvironmentOptions = {};
const low: IWorldEnvironmentOptions = {};
`;

const POST = `import { qualityPreset, resolveQualityTier } from "./quality.js";
export function setupPost(): void {
  const tier = resolveQualityTier({});
  console.info(\`TN_QUALITY_TIER \${tier}\`);
  qualityPreset(tier);
}
`;

const DOC = `# AGENTS.md

## Quality tiers

\`src/render/quality.ts\` names \`low\`, \`medium\` and \`high\`. Override with
\`setupPost(renderer, scene, camera, { tier: "low" })\`.
`;

async function fixture(
  overrides: { quality?: string; post?: string; doc?: string } = {},
): Promise<string> {
  const root = await makeTempDir("template-quality");
  await mkdir(path.join(root, "node_modules/@threenative"), { recursive: true });
  await symlink(
    path.join(repoRoot, "packages/core"),
    path.join(root, "node_modules/@threenative/core"),
    "dir",
  );
  await mkdir(path.join(root, "packages/core/src/look"), { recursive: true });
  await writeFile(
    path.join(root, "packages/core/src/look/quality.ts"),
    await readFile(path.join(repoRoot, "packages/core/src/look/quality.ts"), "utf8"),
  );
  const render = path.join(
    root,
    "packages",
    "create-threenative",
    "templates",
    "demo",
    "src",
    "render",
  );
  await mkdir(render, { recursive: true });
  await writeFile(path.join(render, "quality.ts"), overrides.quality ?? QUALITY);
  await writeFile(path.join(render, "postprocessing.ts"), overrides.post ?? POST);
  await writeFile(
    path.join(root, "packages", "create-threenative", "templates", "demo", "AGENTS.md"),
    overrides.doc ?? DOC,
  );
  return root;
}

describe("check-template-quality", () => {
  it("should pass against this repository's own templates", async () => {
    const report = await checkTemplateQuality(repoRoot);
    expect(formatTemplateQualityReport(report)).toMatch(/^template quality: /u);
    expect(report.findings).toEqual([]);
    expect(report.templates.length).toBeGreaterThanOrEqual(8);
  });

  it("evaluates public delegated tiers and accepts authored caps and overrides", async () => {
    const quality = `import { qualityPreset as coreQualityPreset, qualityTiers } from "@threenative/core";
export const resolveQualityTier = qualityTiers.resolve;
export function qualityPreset(tier: string) {
  const renderTier = tier === "high" ? "medium" : tier;
  return { ...coreQualityPreset(renderTier), gtaoRadius: 0.35, samples: 4 };
}`;
    const report = await checkTemplateQuality(await fixture({ quality }));
    expect(report.findings.filter((finding) => finding.problem.startsWith("quality.ts"))).toEqual(
      [],
    );
  });

  it.each([
    "null",
    "[]",
    '{ renderChainTier: "ultra" }',
    '{ renderChainTier: "low", bloomEnabled: 1 }',
  ])("rejects a malformed delegated preset: %s", async (result) => {
    const quality = `import { qualityPreset as coreQualityPreset, qualityTiers } from "@threenative/core";
export const resolveQualityTier = qualityTiers.resolve;
export function qualityPreset(tier: string) { coreQualityPreset(tier); return ${result}; }`;
    const report = await checkTemplateQuality(await fixture({ quality }));
    expect(formatTemplateQualityReport(report)).toContain("cannot evaluate public quality presets");
  });

  it("rejects delegated factories that silently accept unknown tiers", async () => {
    const quality = `import { qualityPreset as coreQualityPreset, qualityTiers } from "@threenative/core";
export const resolveQualityTier = qualityTiers.resolve;
export function qualityPreset() { return coreQualityPreset("low"); }`;
    const report = await checkTemplateQuality(await fixture({ quality }));
    expect(formatTemplateQualityReport(report)).toContain("unknown quality tier");
  });

  it("retains inherited core cost checks for delegated presets", async () => {
    const quality = `import { qualityPreset as coreQualityPreset, qualityTiers } from "@threenative/core";
export const resolveQualityTier = qualityTiers.resolve;
export const qualityPreset = coreQualityPreset;`;
    const root = await fixture({ quality });
    const file = path.join(root, "packages/core/src/look/quality.ts");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "  // Bloom cost: ~4.6 ms in the reference ablation — the second most expensive stage there.\n",
        "",
      ),
    );
    expect(formatTemplateQualityReport(await checkTemplateQuality(root))).toContain(
      "core quality.ts enables bloomEnabled",
    );
  });

  it("should agree on one fail-closed tier contract across every shipped template", async () => {
    const report = await checkTemplateQuality(repoRoot);
    expect(report.findings).toEqual([]);
    expect(report.contractHash).toMatch(/^[0-9a-f]{12}$/u);
    expect(formatTemplateQualityReport(report)).toContain("all agree on the fail-closed tier");
  });

  it("should end the contract span at resolveQualityTier, not at the presets below it", () => {
    const span = qualityContractSpan(QUALITY);
    expect(span.startsWith("export type QualityTier")).toBe(true);
    expect(span.trimEnd().endsWith("}")).toBe(true);
    // The look lives below the span and must not be hashed, or the gate becomes a look freeze.
    expect(span).not.toContain("bloomEnabled");
    expect(span).not.toContain("IWorldEnvironmentOptions");
  });

  it("should hash a preset edit identically and a contract edit differently", () => {
    const preset = qualityContractSpan(
      QUALITY.replace("bloomEnabled: true", "bloomEnabled: false"),
    );
    expect(contractSpanHash(preset)).toBe(contractSpanHash(qualityContractSpan(QUALITY)));
    const narrowed = qualityContractSpan(
      QUALITY.replace(".includes(value)", ".includes(value.trim())"),
    );
    expect(contractSpanHash(narrowed)).not.toBe(contractSpanHash(qualityContractSpan(QUALITY)));
  });

  it("should fail closed when the contract span cannot be delimited", () => {
    expect(() => qualityContractSpan("const x = 1;\n")).toThrow(
      /declares no `export type QualityTier`/u,
    );
    expect(() => qualityContractSpan("export type QualityTier = string;\n")).toThrow(
      /declares no `export function resolveQualityTier`/u,
    );
    expect(() =>
      qualityContractSpan(
        "export type QualityTier = string;\nexport function resolveQualityTier() {",
      ),
    ).toThrow(/no closing brace at column 0/u);
  });

  it("should see a lost throw even when every copy lost it together", async () => {
    const lost = QUALITY.replace(/ {6}throw new Error\([^;]*\);/u, '      return "high";');
    expect(lost).not.toContain("throw new Error");
    expect(contractSpanThrows(qualityContractSpan(lost))).toBe(false);
    const report = await checkTemplateQuality(await fixture({ quality: lost }));
    expect(formatTemplateQualityReport(report)).toContain("does not throw on an unknown tier");
  });

  it("should name the drifting template and the group it left", () => {
    expect(
      contractDriftFindings([
        { hash: "aaaaaaaaaaaa", template: "action-rpg" },
        { hash: "aaaaaaaaaaaa", template: "shooter" },
        { hash: "bbbbbbbbbbbb", template: "racing" },
      ]),
    ).toEqual([
      {
        problem:
          "quality.ts's fail-closed tier contract drifted (bbbbbbbbbbbb) from the 2 templates that agree (aaaaaaaaaaaa, e.g. action-rpg)",
        template: "racing",
      },
    ]);
    expect(contractDriftFindings([{ hash: "aaaaaaaaaaaa", template: "only" }])).toEqual([]);
  });

  it("should gate only what this repository generates, never a sandbox game", async () => {
    // AC4. The walk is rooted at packages/create-threenative/templates; a sibling copy of
    // quality.ts outside it is another repository's file and contributes no hash.
    const root = await fixture();
    const outside = path.join(root, "sandbox", "wildwood", "src", "render");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "quality.ts"), QUALITY.replace("value)", "value.trim())"));
    const report = await checkTemplateQuality(root);
    expect(report.templates).toEqual(["demo"]);
    expect(report.findings.map((finding) => finding.problem).join("\n")).not.toContain(
      "tier contract drifted",
    );
    expect(report.contractHash).toBe(contractSpanHash(qualityContractSpan(QUALITY)));
  });

  it("should throw when it finds no templates at all", async () => {
    const empty = await makeTempDir("template-quality-empty");
    await mkdir(path.join(empty, "packages", "create-threenative", "templates"), {
      recursive: true,
    });
    await expect(checkTemplateQuality(empty)).rejects.toThrow(/TEMPLATE_QUALITY_NO_TEMPLATES/u);
  });

  it("should fail when a template has no quality module", async () => {
    const root = await fixture();
    const render = path.join(
      root,
      "packages",
      "create-threenative",
      "templates",
      "demo",
      "src",
      "render",
    );
    await writeFile(path.join(render, "quality.ts"), "");
    const report = await checkTemplateQuality(root);
    expect(formatTemplateQualityReport(report)).toContain(
      "demo: quality.ts declares no `high` tier",
    );
  });

  it("should fail when a postprocessing module still holds a preset literal", async () => {
    const root = await fixture({
      post: `${POST}\nconst desktopPreset = { bloomEnabled: true };\n`,
    });
    const report = await checkTemplateQuality(root);
    expect(formatTemplateQualityReport(report)).toContain("`desktopPreset` literal");
  });

  it("should fail when an enabled stage carries no measured cost", async () => {
    const root = await fixture({
      quality: QUALITY.replace("  // Bloom: ~4.6 ms.\n", ""),
    });
    const report = await checkTemplateQuality(root);
    expect(formatTemplateQualityReport(report)).toContain("bloomEnabled");
    expect(formatTemplateQualityReport(report)).toContain("no measured cost");
  });

  it("should accept `unmeasured` as an honest cost comment", () => {
    expect(costCommentGaps("  // unmeasured\n  ssrEnabled: true,\n")).toEqual([]);
    expect(costCommentGaps("  // it looks nice\n  ssrEnabled: true,\n")).toEqual([
      "ssrEnabled (line 2)",
    ]);
  });

  it("should fail when a template's AGENTS.md does not document the tier switch", async () => {
    const report = await checkTemplateQuality(await fixture({ doc: "# AGENTS.md\n" }));
    expect(formatTemplateQualityReport(report)).toContain("AGENTS.md does not name quality.ts");
    expect(formatTemplateQualityReport(report)).toContain("does not show the tier override");
  });

  it("should fail when postprocessing stops reporting the tier", async () => {
    const report = await checkTemplateQuality(
      await fixture({ post: POST.replace("TN_QUALITY_TIER ", "") }),
    );
    expect(formatTemplateQualityReport(report)).toContain("does not report TN_QUALITY_TIER");
  });

  it("should catch a surface node requested eagerly, in either shape", () => {
    // The single-line shape that shipped the black mobile look on seven templates.
    expect(eagerSurfaceNodes('const normal = scenePass.getTextureNode("normal");')).toEqual([
      "normal (line 1)",
    ]);
    // And the wrapped one — the accessors are formatted across two lines, so a line-based check
    // reads the `=>` as absent and calls the fix a defect.
    expect(
      eagerSurfaceNodes('const metal = (): T =>\n      scenePass.getTextureNode("metalness");'),
    ).toEqual([]);
  });

  it("should accept the deferred forms and ignore the ones that are not attachments", () => {
    expect(eagerSurfaceNodes('const normal = (): T => textureNode("normal");')).toEqual([]);
    expect(eagerSurfaceNodes('const node = () => scenePass.getTextureNode("roughness");')).toEqual(
      [],
    );
    // `depth` and `output` are not surface-data attachments: the pass has them either way, so
    // requesting them eagerly costs nothing and the gate must not object.
    expect(
      eagerSurfaceNodes(
        'const depth = scenePass.getTextureNode("depth");\nconst base = scenePass.getTextureNode("output");',
      ),
    ).toEqual([]);
  });

  it("should report every eager request rather than only the first", () => {
    expect(
      eagerSurfaceNodes(
        [
          'const normal = scenePass.getTextureNode("normal");',
          'const metal = scenePass.getTextureNode("metalness");',
          'const rough = scenePass.getTextureNode("roughness");',
        ].join("\n"),
      ),
    ).toEqual(["metalness (line 2)", "normal (line 1)", "roughness (line 3)"]);
  });

  it("should name both incumbent literals", () => {
    expect(presetLiteralsIn("const desktopPreset = {};\nconst mobilePreset = {};\n")).toEqual([
      "desktopPreset",
      "mobilePreset",
    ]);
  });

  it("should list template directories from disk", async () => {
    const root = await fixture();
    await expect(
      templateNames(path.join(root, "packages", "create-threenative", "templates")),
    ).resolves.toEqual(["demo"]);
  });
});
