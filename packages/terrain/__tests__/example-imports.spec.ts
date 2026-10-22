import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps terrain package tests independent of example source", () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const importsExample = /\b(?:from\s*|import\s*(?:\(\s*)?)['"][^'"]*examples\//u;
  const violations = readdirSync(root, { recursive: true })
    .filter(
      (name): name is string =>
        typeof name === "string" && /\.(?:[cm]?ts|tsx|[cm]?js)$/u.test(name),
    )
    .filter((name) => importsExample.test(readFileSync(`${root}${name}`, "utf8")));
  expect(violations).toEqual([]);
});
