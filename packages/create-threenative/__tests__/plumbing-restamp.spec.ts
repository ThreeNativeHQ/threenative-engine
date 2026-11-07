// A kit's `tsconfig.json` is generated, not hand-kept: one source (`src/plumbing.ts`) plus the delta
// the kit's own manifest declares. This holds every kit to that, so an edit to one copy fails here
// instead of shipping a kit whose typecheck disagrees with its neighbours.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverKitManifests } from "../src/index.js";
import { kitPlumbingDelta, tsconfigText } from "../src/plumbing.js";

const TEMPLATES = path.resolve(import.meta.dirname, "../templates");

describe("generated build plumbing", () => {
  it("should hold every kit to the one source", () => {
    const stale = discoverKitManifests(TEMPLATES).filter(({ name }) => {
      const file = path.join(TEMPLATES, name, "tsconfig.json");
      return readFileSync(file, "utf8") !== tsconfigText(kitPlumbingDelta(name, TEMPLATES));
    });
    expect(stale.map(({ name }) => name)).toEqual([]);
  });

  it("should derive the React delta from the kit's own manifest", () => {
    // The one thing that changes the file: a kit that depends on React needs `jsx` and the `.tsx`
    // glob, and one that does not must ship neither.
    expect(kitPlumbingDelta("minimal", TEMPLATES).react).toBe(false);
    expect(kitPlumbingDelta("starter", TEMPLATES).react).toBe(true);
    expect(tsconfigText({ react: false })).not.toContain('"jsx"');
    expect(tsconfigText({ react: false })).not.toContain("src/**/*.tsx");
    expect(tsconfigText({ react: true })).toContain('"jsx": "react-jsx"');
    expect(tsconfigText({ react: true })).toContain("src/**/*.tsx");
  });

  it("should keep the tests glob in every kit, including one with no tests directory yet", () => {
    for (const delta of [{ react: true }, { react: false }])
      expect(tsconfigText(delta)).toContain("tests/**/*.ts");
  });
});
