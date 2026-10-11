/**
 * No shipped template may configure a compile pass off.
 *
 * `templates/starter` and `templates/sailing` both carried `assets: { models: "none", textures:
 * "none" }`, written for two proof files that grew slightly under compression — the PNG is 150
 * bytes and compresses to 542. Scaffolded games inherit that object verbatim and no game revisits
 * it: one shipped 2,003 MB of manifest output containing 53 PNG, 35 JPG and not one `.ktx2`,
 * where the pipeline emits 10.5 MB for every 38 MB of real game texture. A 392-byte regression on
 * a proof asset bought a 27.5 MB one on every real one.
 *
 * `/AGENTS.md`: *if the engine can measure the right value at the point of use, it decides.* The
 * compile step's default is compression on; the template's job is to leave it alone. This gate
 * holds it there, and proves the default actually compiles what the templates ship.
 *
 * The sweep lives in one module and two spec files because `vitest --shard` divides a list of
 * files, never a file: the thirteen templates in one file measured 317s of test time on CI run
 * 37071464562, and no shard count divided that. `template-assets-compile-1.spec.ts` and
 * `template-assets-compile-2.spec.ts` run the same cases over the two halves of the list, so the
 * heaviest single unit file is one half of the sweep.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import path from "node:path";
import { compileAssets } from "@threenative/assets";
import { expect } from "vitest";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { TEMPLATE_ROOT, allTemplates } from "../../../test-support/templates.js";
import { basisTranscoderPaths } from "../../../test-support/three-basis.js";
import { loadConfig } from "../src/config.js";
import { createProject } from "../src/index.js";

export const templates = allTemplates();

const midpoint = Math.ceil(templates.length / 2);
export const firstHalf = templates.slice(0, midpoint);
export const secondHalf = templates.slice(midpoint);
// A half that empties leaves its spec file asserting one cheap case over nothing, which reads like
// a covered sweep. The count is the only thing that can break it, so it fails here instead.
if (firstHalf.length === 0 || secondHalf.length === 0) {
  throw new Error(
    `TN_TEMPLATE_ASSETS_HALF_EMPTY: ${templates.length} templates cannot split in two.`,
  );
}

export async function reachesTheUncookedBudgetWithAnEligibleSourceProbe(template: string) {
  const root = await makeTempDir(`threenative-template-budget-${template}-`);
  const { target } = await createProject({ install: false, target: template, template }, root);
  const config = await loadConfig(target);
  await mkdir(join(target, "assets"), { recursive: true });
  await writeFile(join(target, "assets/budget-probe.png"), rgbaPng({ width: 16, height: 16 }));
  // Empty and fully cooked templates should pass any uncooked ceiling. The planted raw
  // source makes the negative control meaningful for every scaffold, including empty kits.
  const options = {
    cwd: target,
    transcoder: basisTranscoderPaths(),
    config: { ...config.assets, textures: "none" as const },
  };
  await expect(compileAssets(options)).resolves.toBeDefined();
  await expect(
    compileAssets({ ...options, config: { ...options.config, budget: 1 } }),
  ).rejects.toThrow("TN_ASSETS_BUDGET_EXCEEDED");
}

export async function compilesWithCompressionOnByDefault(template: string) {
  const source = await readFile(join(TEMPLATE_ROOT, template, "threenative.config.ts"), "utf8");

  // Narrow on purpose: an override that *configures* a pass is welcome, and only the "none"
  // shorthand — the one that ships bytes as authored forever — is refused here.
  expect(source).not.toMatch(/\bmodels:\s*"none"/u);
  expect(source).not.toMatch(/\btextures:\s*"none"/u);
}

export async function compilesUnderTheDefaultConfig(template: string) {
  const root = await makeTempDir(`threenative-template-assets-${template}-`);
  const { target } = await createProject({ install: false, target: template, template }, root);
  const config = await loadConfig(target);
  // Defaults everywhere, except per-clip audio declarations: those configure the audio pass
  // (rain ships its baked float storm clips unconditioned, with their loops declared) rather
  // than skipping it, and the compile below runs through them.
  expect(Object.keys(config.assets ?? {}).filter((key) => key !== "audio")).toEqual([]);
  // Exercise the actual scaffold's config seam, including kits with no source assets.
  const result = await compileAssets({
    cwd: target,
    config: config.assets,
    transcoder: basisTranscoderPaths(),
  });
  if (result.written === 0) {
    expect(
      JSON.parse(await readFile(path.join(target, "public", "assets.manifest.json"), "utf8")),
    ).toEqual({ version: 1, entries: {} });
    return;
  }

  const manifest = JSON.parse(
    await readFile(path.join(target, "public", "assets.manifest.json"), "utf8"),
  ) as { entries: Record<string, { output: string }> };
  expect(Object.keys(manifest.entries).length).toBeGreaterThan(0);
}
