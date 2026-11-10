// The inventory is derived from disk, so what needs a pin is the derivation itself: a directory
// that ships a kit, a brief or a package is in the list, and a list nobody can empty silently.
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  briefGenres,
  minimumNodeVersion,
  nodeEngineRange,
  templateNames,
  workspacePackageNames,
  workspacePackageNamesFromTree,
} from "../lib/repo-inventory.mjs";

const templates = path.join(REPO_ROOT, "packages", "create-threenative", "templates");
const genres = path.join(REPO_ROOT, "docs", "benchmark", "genres");
const packages = path.join(REPO_ROOT, "packages");

function directories(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe("repo inventory", () => {
  it("should list every kit that ships a kit.json", () => {
    const kits = directories(templates).filter((name) =>
      readdirSync(path.join(templates, name)).includes("kit.json"),
    );
    expect([...templateNames()]).toEqual([...kits].sort());
    // The three kits a hand list had skipped: recall rejected their source pointers outright.
    for (const kit of ["puzzle", "rts", "runner"]) expect(templateNames()).toContain(kit);
  });

  it("should list every brief genre that ships a brief.md", () => {
    const briefs = directories(genres).filter((name) =>
      readdirSync(path.join(genres, name)).includes("brief.md"),
    );
    expect([...briefGenres()]).toEqual([...briefs].sort());
    expect(briefGenres().length).toBeGreaterThan(0);
  });

  it("should list every workspace package directory that carries a manifest", () => {
    const members = directories(packages).filter((name) =>
      readdirSync(path.join(packages, name)).includes("package.json"),
    );
    expect([...workspacePackageNames()]).toEqual([...members].sort());
    expect(workspacePackageNames().length).toBeGreaterThan(0);
  });

  it("should read the Node floor from the one place the repository declares it", () => {
    expect(nodeEngineRange()).toMatch(/^>=?\d+\.\d+\.\d+$/u);
    expect(minimumNodeVersion()).toBe("20.19.0");
  });

  it("reads the same package list from the Git tree a sparse checkout leaves empty", () => {
    // The CI scope job checks out `scripts/` and each `kit.json` only, so the working tree has no
    // package manifest at all; the tree listing is what fails closed on a stale policy name.
    expect(workspacePackageNamesFromTree()).toEqual(workspacePackageNames());
  });

  it("names a package directory that is not in the tree, so a rename cannot pass", () => {
    expect(workspacePackageNamesFromTree()).not.toContain("terrain-that-moved");
  });
});
