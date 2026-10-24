import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allTemplates } from "../../../test-support/templates.js";

const root = path.resolve("packages/create-threenative");
// A kit whose post chain is core's `WorldEnvironment` takes core's metered auto exposure (the
// default Unreal look) and vendors no exposure source of its own.
const coreLook = (name: string): boolean => {
  const post = path.join(root, "templates", name, "src/render/postprocessing.ts");
  return (
    existsSync(post) &&
    /import\s*\{[^}]*\bWorldEnvironment\b[^}]*\}\s*from\s*"@threenative\/core"/u.test(
      readFileSync(post, "utf8"),
    )
  );
};
const vendored = allTemplates().filter((name) => !coreLook(name));
const takesCore = allTemplates().filter(coreLook);

describe("generated eye adaptation", () => {
  it.each(vendored)("ships opt-in, game-owned exposure source in %s", async (name) => {
    const directory = path.join(root, "templates", name);
    const policy = await readFile(path.join(directory, "src/render/exposure.ts"), "utf8");
    const node = await readFile(path.join(directory, "src/render/autoExposure.ts"), "utf8");
    const instructions = await readFile(path.join(directory, "AGENTS.md"), "utf8");
    expect(policy).toContain("enabled: false");
    expect(policy).toContain("exposureMeter");
    expect(policy).toContain("rateUp");
    expect(policy).toContain("rateDown");
    expect(policy + node).not.toContain("@threenative/");
    expect(node).toBe(await readFile(path.join(root, "template-assets/autoExposure.ts"), "utf8"));
    expect(instructions).toContain("src/render/exposure.ts");
    expect(instructions).toContain("references/auto-exposure.md");
  });

  it.each(takesCore)("takes core's auto exposure and vendors no meter in %s", (name) => {
    const directory = path.join(root, "templates", name, "src/render");
    expect(existsSync(path.join(directory, "exposure.ts"))).toBe(false);
    expect(existsSync(path.join(directory, "autoExposure.ts"))).toBe(false);
  });
});
