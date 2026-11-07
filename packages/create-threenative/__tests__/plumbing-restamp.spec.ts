// The build plumbing is generated, not hand-kept: one source (`src/plumbing.ts`) plus the delta the
// kit's own manifest declares. This holds every kit to that, so an edit to one copy fails here
// instead of shipping a kit that disagrees with its neighbours.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverKitManifests } from "../src/index.js";
import {
  kitMainDelta,
  kitPlumbingDelta,
  kitViteDelta,
  mainText,
  tsconfigText,
  viteConfigText,
} from "../src/plumbing.js";

const TEMPLATES = path.resolve(import.meta.dirname, "../templates");

describe("generated build plumbing", () => {
  it("should hold every kit to the one source", () => {
    const stale = discoverKitManifests(TEMPLATES).filter(({ name }) => {
      const file = path.join(TEMPLATES, name, "tsconfig.json");
      return readFileSync(file, "utf8") !== tsconfigText(kitPlumbingDelta(name, TEMPLATES));
    });
    expect(stale.map(({ name }) => name)).toEqual([]);
  });

  it("should hold every kit's vite config to the one source", () => {
    const stale = discoverKitManifests(TEMPLATES).filter(({ name }) => {
      const file = path.join(TEMPLATES, name, "vite.config.ts");
      return readFileSync(file, "utf8") !== viteConfigText(kitViteDelta(name, TEMPLATES));
    });
    expect(stale.map(({ name }) => name)).toEqual([]);
  });

  it("should derive each Vite delta from the kit itself", () => {
    // React and Tailwind by dependency, the second entry by `main.html`: no list to update.
    expect(kitViteDelta("minimal", TEMPLATES)).toMatchObject({
      react: false,
      tailwind: false,
      workerEntry: false,
    });
    expect(kitViteDelta("starter", TEMPLATES)).toMatchObject({
      react: true,
      tailwind: true,
      workerEntry: true,
    });
    expect(viteConfigText({ react: false, tailwind: false, workerEntry: false })).not.toContain(
      "tailwindcss()",
    );
    expect(viteConfigText({ react: true, tailwind: true, workerEntry: true })).toContain(
      'build: { rollupOptions: { input: { index: "index.html", main: "main.html" } } },',
    );
  });

  it("should hold every kit's entry to the one source, except the one that declares its own", () => {
    const stale = discoverKitManifests(TEMPLATES)
      .map(({ name }) => ({ delta: kitMainDelta(name, TEMPLATES), name }))
      .filter(({ delta, name }) => {
        const text = mainText(delta);
        if (text === undefined) return false;
        return readFileSync(path.join(TEMPLATES, name, "src", "main.ts"), "utf8") !== text;
      });
    expect(stale.map(({ name }) => name)).toEqual([]);
    // The exception is declared, not inferred, and it is exactly one kit: a second flag set in a
    // kit.json would stop stamping that entry with nothing failing.
    const handWritten = discoverKitManifests(TEMPLATES)
      .map(({ name }) => name)
      .filter((name) => kitMainDelta(name, TEMPLATES).handWritten);
    expect(handWritten).toEqual(["adventure"]);
    expect(mainText(kitMainDelta("adventure", TEMPLATES))).toBeUndefined();
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
