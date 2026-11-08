// The native player bundles a game from `@threenative/core`'s SOURCE files, so every subpath a kit
// imports has to resolve to a file that exists. `render/environment` is re-exported as
// `dist/render-environment.js`, and reading the last path segment as the file name gave
// `src/environment.ts` — a file PRD-833 renamed — which failed the starter's desktop build with
// `Cannot read file: …/@threenative/core/src/environment.ts`.
//
// This walks the package's own `exports` map, so a future subpath is covered the day it is declared.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "vitest";
import { coreSourcePath } from "../scripts/bundle-native-engine.mjs";

const require = createRequire(import.meta.url);

test("every @threenative/core subpath resolves to a shipped source file", () => {
  const root = dirname(require.resolve("@threenative/core/package.json"));
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const subpaths = Object.keys(manifest.exports ?? {})
    .filter((key) => key.startsWith("./") && key !== "./package.json")
    .map((key) => key.slice(2));
  assert.ok(subpaths.includes("render/environment"), "the subpath this test was written for");
  for (const subpath of subpaths) {
    const resolved = coreSourcePath(`@threenative/core/${subpath}`);
    assert.ok(
      existsSync(resolved),
      `@threenative/core/${subpath} resolves to ${resolved}, which does not exist`,
    );
  }
  assert.match(coreSourcePath("@threenative/core/render/environment"), /src[\\/]render-environment\.ts$/u);
});
