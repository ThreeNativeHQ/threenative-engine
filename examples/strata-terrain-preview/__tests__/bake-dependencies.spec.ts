import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("bake script dependencies", () => {
  it("declares every package scripts/bake/bake.mjs imports, tsx included (audit STRATA-11)", () => {
    const manifest = JSON.parse(read("../package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    const imported = [
      ...read("../scripts/bake/bake.mjs").matchAll(/^import .*? from "([^"./][^"]*)";/gmu),
    ]
      .map((match) => match[1] as string)
      .filter((specifier) => !specifier.startsWith("node:"))
      .map((specifier) =>
        specifier
          .split("/")
          .slice(0, specifier.startsWith("@") ? 2 : 1)
          .join("/"),
      );
    expect(imported).toContain("tsx");
    expect(imported.filter((name) => !declared.has(name))).toEqual([]);
  });
});
