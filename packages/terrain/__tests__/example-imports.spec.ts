import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL(".", import.meta.url));
// Every test here stays independent of the examples, so any quoted path that reaches into one
// counts: `import … from "…/examples/"` and `import("…/examples/")` alike, and no less a
// `new URL("…/examples/…", import.meta.url)` or `join(root, "…/examples/…")` that only reads a
// file from there, which an import-only match let through.
const referencesExample = /["'`][^"'`]*examples\//u;

// The two tests that read the strata-terrain-preview on purpose: `landforms.spec.ts` measures the
// preview's checked-in USGS DEM crops, `kit-assets.spec.ts` cross-checks kit asset names against
// the preview source. Naming them here is the promise to repoint them when that example moves; a
// test that needs example data joins the package fixtures instead, or this list fails.
const declaredExampleReaders = ["kit-assets.spec.ts", "landforms.spec.ts"];

function exampleReaders(): string[] {
  return readdirSync(root, { recursive: true })
    .filter(
      (name): name is string =>
        typeof name === "string" &&
        // The guard states the matches, so it does not scan itself.
        name !== "example-imports.spec.ts" &&
        /\.(?:[cm]?ts|tsx|[cm]?js)$/u.test(name),
    )
    .filter((name) => referencesExample.test(readFileSync(`${root}${name}`, "utf8")))
    .sort();
}

it("keeps terrain package tests independent of example source", () => {
  expect(exampleReaders()).toEqual(declaredExampleReaders);
});
