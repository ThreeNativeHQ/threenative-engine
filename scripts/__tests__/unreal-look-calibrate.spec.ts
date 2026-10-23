import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import {
  type IRegistry,
  familyOf,
  registry,
  sceneDir,
  sceneKey,
  sceneNames,
  validateShadowRegistry,
} from "../unreal-look/gi.js";

const L5 = {
  name: "L5",
  cvars: { "r.DynamicGlobalIlluminationMethod": 0, "r.AmbientOcclusionLevels": 0, "r.Fog": 1 },
};

function shadowRegistry(variantCvars: Record<string, number>): IRegistry {
  return {
    resolution: [1280, 720],
    scenes: [{ name: "lab", owner: "PRD-649", poses: ["heights"] }],
    variants: [{ name: "L5", layer: "L5", cvars: variantCvars, expect: {}, kinds: ["png"] }],
  };
}

function folderWith(criteria: boolean): string {
  const dir = makeTempDirSync("tn-shadow-registry-");
  mkdirSync(path.join(dir, "lab"));
  if (criteria) writeFileSync(path.join(dir, "lab", "criteria.md"), "# lab\n");
  return dir;
}

describe("PRD-649 shadow scene family", () => {
  it("resolves shadow ids beside unchanged GI names", () => {
    expect(familyOf("shadow:penumbra-lab")).toBe("shadow");
    expect(familyOf("gi:cornell")).toBe("gi");
    expect(sceneNames("shadow:penumbra-lab", ["penumbra-lab"])).toEqual(["shadow:penumbra-lab"]);
    expect(sceneNames("gi:cornell", ["cornell"])).toEqual(["cornell"]);
    expect(sceneDir("shadow:penumbra-lab")).toMatch(
      /tools\/unreal-reference\/shadow\/penumbra-lab$/,
    );
    expect(sceneDir("cornell")).toMatch(/tools\/unreal-reference\/gi\/cornell$/);
    expect(sceneKey("shadow:penumbra-lab")).toBe("shadow/penumbra-lab");
    expect(sceneKey("cornell")).toBe("cornell");
  });

  it("selects every registered shadow scene, and each has its criteria", () => {
    const names = registry("shadow").scenes.map((s) => s.name);
    expect(names).toContain("penumbra-lab");
    expect(sceneNames("shadow", names)).toContain("shadow:penumbra-lab");
  });

  it("fails closed on an unknown scene, a mixed family and an unknown family", () => {
    expect(() => sceneNames("shadow:nope", ["penumbra-lab"])).toThrow(/unknown shadow scene nope/);
    expect(() => familyOf("shadow:a,gi:b")).toThrow(/one family/);
    expect(() => familyOf("light:a")).toThrow(/one family/);
  });

  it("fails closed on a scene without criteria.md", () => {
    expect(() => validateShadowRegistry(shadowRegistry({}), folderWith(false), [L5])).toThrow(
      /lab has no criteria.md/,
    );
    expect(() => validateShadowRegistry(shadowRegistry({}), folderWith(true), [L5])).not.toThrow();
  });

  it("fails closed on an L5 shadow cell captured with GI or AO on", () => {
    const dir = folderWith(true);
    expect(() =>
      validateShadowRegistry(shadowRegistry({ "r.DynamicGlobalIlluminationMethod": 1 }), dir, [L5]),
    ).toThrow(/r.DynamicGlobalIlluminationMethod 1 must be 0 at L5/);
    expect(() =>
      validateShadowRegistry(shadowRegistry({ "r.AmbientOcclusionLevels": -1 }), dir, [L5]),
    ).toThrow(/r.AmbientOcclusionLevels -1 must be 0 at L5/);
  });
});
