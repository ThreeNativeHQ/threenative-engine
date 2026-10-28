import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
// The PRD-723 kits keep their exposure policy in src/render/exposure.ts; a kit without one runs core's as is.
const ownPolicy = allTemplates().filter((name) =>
  existsSync(path.join(root, "templates", name, "src/render/exposure.ts")),
);
// A kit with its own policy file is covered by the case above, which also forbids a vendored meter.
const takesCore = allTemplates().filter((name) => coreLook(name) && !ownPolicy.includes(name));

describe("generated eye adaptation", () => {
  it.each(ownPolicy)("ships game-owned exposure policy in %s", async (name) => {
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
      expect(policy).toContain("...coreExposureSettings");
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

  it.each(takesCore)("takes core's auto exposure and vendors no meter in %s", (name) => {
    const directory = path.join(root, "templates", name, "src/render");
    expect(existsSync(path.join(directory, "exposure.ts"))).toBe(false);
    expect(existsSync(path.join(directory, "autoExposure.ts"))).toBe(false);
  });
});
