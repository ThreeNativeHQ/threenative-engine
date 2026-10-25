import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { allTemplates } from "../../../test-support/templates.js";

const root = path.resolve("packages/create-threenative");
describe("generated eye adaptation", () => {
  it.each(allTemplates())("ships game-owned exposure policy in %s", async (name) => {
    const directory = path.join(root, "templates", name);
    const policy = await readFile(path.join(directory, "src/render/exposure.ts"), "utf8");
    const postprocessing = await readFile(
      path.join(directory, "src/render/postprocessing.ts"),
      "utf8",
    );
    const instructions = await readFile(path.join(directory, "AGENTS.md"), "utf8");
    if (policy.includes("coreExposureSettings")) {
      expect(policy).toContain('from "@threenative/core"');
      expect(policy).toContain("exposureSettings as coreExposureSettings");
      expect(policy).toContain("{ ...coreExposureSettings }");
    } else {
      const { exposureSettings } = await import(
        pathToFileURL(path.join(directory, "src/render/exposure.ts")).href
      );
      expect(exposureSettings.enabled).toBe(name === "rts");
      expect(policy).toContain("exposureMeter");
      expect(policy).toContain("rateUp");
      expect(policy).toContain("rateDown");
      expect(policy).not.toContain("@threenative/");
    }
    expect(postprocessing).toMatch(/import[^;]*WorldEnvironment[^;]*from\s+"@threenative\/core"/s);
    expect(existsSync(path.join(directory, "src/render/autoExposure.ts"))).toBe(false);
    expect(instructions).toContain("src/render/exposure.ts");
    expect(instructions).toContain("references/auto-exposure.md");
  });
});
