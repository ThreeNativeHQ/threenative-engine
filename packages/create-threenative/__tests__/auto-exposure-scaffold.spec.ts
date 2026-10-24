import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allTemplates } from "../../../test-support/templates.js";

const root = path.resolve("packages/create-threenative");
describe("generated eye adaptation", () => {
  it.each(allTemplates())("ships opt-in, game-owned exposure source in %s", async (name) => {
    const directory = path.join(root, "templates", name);
    const policy = await readFile(path.join(directory, "src/render/exposure.ts"), "utf8");
    const postprocessing = await readFile(
      path.join(directory, "src/render/postprocessing.ts"),
      "utf8",
    );
    const instructions = await readFile(path.join(directory, "AGENTS.md"), "utf8");
    expect(policy).toContain("enabled: false");
    expect(policy).toContain("exposureMeter");
    expect(policy).toContain("rateUp");
    expect(policy).toContain("rateDown");
    expect(policy).not.toContain("@threenative/");
    expect(postprocessing).toMatch(/import[^;]*WorldEnvironment[^;]*from\s+"@threenative\/core"/s);
    expect(existsSync(path.join(directory, "src/render/autoExposure.ts"))).toBe(false);
    expect(instructions).toContain("src/render/exposure.ts");
    expect(instructions).toContain("references/auto-exposure.md");
  });
});
