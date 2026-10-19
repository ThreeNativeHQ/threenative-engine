// PRD-466 AC-7: an agent that only has the installed capability manifest reaches the real terrain
// authoring API, with constraints that are true, and a fresh scaffold points at the optional addon
// without making it a runtime dependency.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityDetail, searchCapabilities } from "../src/index.js";

const manifest = path.resolve("packages/create-threenative/capabilities.json");
const templates = path.resolve("packages/create-threenative/templates");

/** The first result's import path, so a query that lands on the wrong package fails by name. */
function top(situation: string, scope: "mechanic" | "request", symbol: string) {
  const response = searchCapabilities(situation, manifest, scope);
  expect(response.verdict).toBe("matched");
  const hit = response.results.find((result) => result.symbol === symbol);
  expect(
    hit,
    `${symbol} missing from: ${response.results.map((r) => r.symbol).join(", ")}`,
  ).toBeDefined();
  return hit;
}

describe("terrain authoring discovery", () => {
  it("resolves request and mechanic queries to the public terrain imports", () => {
    expect(
      top(
        "a walkable island with seeded noise hills, rivers and scattered trees",
        "request",
        "Terrain",
      )?.importPath,
    ).toBe("@threenative/terrain");
    expect(
      top("procedural heightmap landscape for the game", "mechanic", "Terrain")?.importPath,
    ).toBe("@threenative/terrain");
    expect(
      top("export the terrain as a glb for another three.js project", "mechanic", "exportWorldGLB")
        ?.importPath,
    ).toBe("@threenative/terrain/export");
    expect(
      top(
        "open the terrain brush and layer GUI around game-owned rendering",
        "mechanic",
        "mountTerrainEditor",
      )?.importPath,
    ).toBe("@threenative/terrain/editor");
  });

  it("states the units, seed, resolution, synchronous evaluation and art ownership", () => {
    const detail = capabilityDetail("Terrain", manifest);
    const text = JSON.stringify(detail);
    expect(text).toContain("metres");
    expect(text).toContain("4294967295");
    expect(text).toContain("17, 33, 65, 129, 257, 513 or 1025");
    expect(text).toContain("synchronous");
    expect(text).toContain("materials, models and texture paths belong to the game");
  });

  it("ships the optional terrain workflow in every template and keeps it out of runtime deps", () => {
    const names = readdirSync(templates, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    expect(names.length).toBeGreaterThan(0);
    for (const { name } of names) {
      for (const file of ["AGENTS.md", "CLAUDE.md"]) {
        expect(readFileSync(path.join(templates, name, file), "utf8"), `${name}/${file}`).toContain(
          "agent-docs/references/terrain-authoring.md",
        );
      }
      const pkg = JSON.parse(readFileSync(path.join(templates, name, "package.json"), "utf8"));
      expect({ ...pkg.dependencies, ...pkg.devDependencies }, name).not.toHaveProperty(
        "@threenative/terrain",
      );
    }
    const guide = readFileSync(
      path.resolve("packages/create-threenative/agent-docs/references/terrain-authoring.md"),
      "utf8",
    );
    for (const required of [
      "npm install --save-dev @threenative/terrain",
      "@threenative/terrain/editor/server",
      "exportWorldGLB",
      "node_modules/@threenative/terrain/AGENT_GUIDE.md",
    ])
      expect(guide).toContain(required);
  });
});
