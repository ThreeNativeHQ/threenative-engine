// A Studio model trial (2026-11-18) dressed a street circuit with hand-built palms — a cylinder and six
// planes — because the search never handed it the nature package. "trees" and "swaying trees" matched
// the not-owned entry for procedural-environment, and that entry answered `none` before any export was
// scored, though the manifest indexes the package's own bakeVegetation, vegetationPresets and bakeRock.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { searchCapabilities } from "../src/index.js";

const manifest = path.resolve("packages/core/capabilities.json");

function symbols(situation: string): readonly string[] {
  const response = searchCapabilities(situation, manifest, "mechanic");
  expect(response.verdict, `${situation}: ${response.guidance.slice(0, 120)}`).toBe("matched");
  return response.results.map((result) => result.symbol);
}

describe("nature discovery", () => {
  it("answers a tree query with the nature package's exports, not 'none'", () => {
    expect(symbols("trees")).toContain("bakeVegetation");
    expect(symbols("swaying trees")).toContain("bakeVegetation");
    expect(symbols("palm trees along a street")).toEqual(
      expect.arrayContaining(["bakeVegetation"]),
    );
  });

  it("carries the install line on the export it answers with", () => {
    const response = searchCapabilities("swaying trees", manifest, "mechanic");
    const bake = response.results.find((result) => result.symbol === "bakeVegetation");
    expect(bake?.requires).toContain("npm i -D @threenative/procedural-environment");
  });

  it("answers rocks and cliffs with the rock bake", () => {
    expect(symbols("rocks and cliffs beside the road")).toContain("bakeRock");
  });

  // The words a game brief uses, from the trial's own lane prompts and plans. Each one must reach the
  // nature package within the first three answers: a model reads the top of the list, not the tail.
  it.each([
    "palm trees",
    "palms along the road",
    "street trees",
    "pine forest",
    "foliage",
    "bushes",
    "shrubs",
    "grass tufts",
    "flowers",
    "jungle plants",
    "desert cactus",
    "boulders",
    "cliffs",
    "realistic trees",
    "low poly trees",
    "dead trees and logs",
    "nature props for a level",
    "tropical island vegetation",
  ])("reaches the nature package for '%s' in the top 3", (query) => {
    const response = searchCapabilities(query, manifest, "mechanic");
    const top = response.results.slice(0, 3);
    expect(
      top.some((result) => result.importPath.startsWith("@threenative/procedural-environment")),
      `${query} -> ${response.verdict}: ${top.map((result) => result.symbol).join(", ")}`,
    ).toBe(true);
  });

  it("still answers 'none' for what the engine does not own", () => {
    expect(searchCapabilities("NPC dialogue system", manifest, "mechanic").verdict).toBe("none");
  });
});
