// The dependency patches a scaffold applies are named in three places that must agree: each kit's
// `pnpm.patchedDependencies`, the copies the tarball ships, and the sources in this repository. The
// list itself lives once, in `template-assets/patches/manifest.json`; this holds the other three to
// it, so a three-version bump cannot leave a kit naming a patch nobody ships.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverTemplateNames } from "../src/index.js";

const PACKAGE = path.resolve(import.meta.dirname, "..");
const REPOSITORY = path.resolve(PACKAGE, "..", "..");
const DIRECTORY = path.join(PACKAGE, "template-assets", "patches");

interface IFrameworkPatch {
  readonly name: string;
  readonly source: string;
}

function manifest(): readonly IFrameworkPatch[] {
  const parsed = JSON.parse(readFileSync(path.join(DIRECTORY, "manifest.json"), "utf8")) as {
    version: number;
    patches: readonly IFrameworkPatch[];
  };
  expect(parsed.version).toBe(1);
  return parsed.patches;
}

describe("framework patches", () => {
  it("should name every patch a kit applies", () => {
    const names = new Set(manifest().map((patch) => patch.name));
    const unknown: string[] = [];
    for (const kit of discoverTemplateNames()) {
      const file = path.join(PACKAGE, "templates", kit, "package.json");
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        pnpm?: { patchedDependencies?: Record<string, string> };
      };
      for (const relative of Object.values(parsed.pnpm?.patchedDependencies ?? {})) {
        const name = path.basename(relative);
        if (relative !== `patches/${name}` || !names.has(name)) {
          unknown.push(`${kit}: ${relative}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("should point every manifest entry at a source that exists", () => {
    const missing = manifest()
      .filter((patch) => !existsSync(path.resolve(REPOSITORY, patch.source)))
      .map((patch) => `${patch.name} -> ${patch.source}`);
    expect(missing).toEqual([]);
  });

  it("should ship exactly the manifest's patches, byte for byte", () => {
    const patches = manifest();
    const shipped = readdirSync(DIRECTORY).filter((file) => file !== "manifest.json");
    expect([...shipped].sort()).toEqual(patches.map((patch) => patch.name).sort());
    for (const patch of patches) {
      expect(readFileSync(path.join(DIRECTORY, patch.name)), patch.name).toEqual(
        readFileSync(path.resolve(REPOSITORY, patch.source)),
      );
    }
  });
});
