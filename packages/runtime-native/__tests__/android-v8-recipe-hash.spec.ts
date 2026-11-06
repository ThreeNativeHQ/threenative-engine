/**
 * The published Android V8 payload is named by a recipe hash, and every run that computes the same
 * hash reuses the same payload instead of building V8 for two hours.
 *
 * Hashing all of `download-deps.mjs` made that hash a hash of the whole dependency provisioner. On
 * PR #493 an unrelated `download-deps.mjs` edit (+29/-11) changed the key, missed the published
 * `ci-v8-android` asset, and cold-built V8 in run 39184795139. So the key covers the `v8-android`
 * entry alone plus the three files that build the payload, and an edit anywhere else in the
 * provisioner keeps it.
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

import {
  V8_RECIPE_FILES,
  androidV8RecipeHash,
  v8AndroidDependencyEntry,
} from "../scripts/v8-recipe-hash.mjs";

const runtimeRoot = new URL("..", import.meta.url).pathname;
const action = readFileSync(
  new URL("../../../.github/actions/android-v8-source/action.yml", import.meta.url),
  "utf8",
);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** A throwaway copy of the four files that decide the payload, so a test can edit one of them. */
function recipeRoot(): string {
  const root = makeTempDirSync("tn-v8-recipe-");
  roots.push(root);
  for (const relative of [...V8_RECIPE_FILES, "scripts/download-deps.mjs"]) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(runtimeRoot, relative), target);
  }
  return root;
}

function edit(root: string, relative: string, replace: [string, string]): void {
  const path = join(root, relative);
  const before = readFileSync(path, "utf8");
  const after = before.replace(replace[0], replace[1]);
  assert.notEqual(after, before, `the fixture edit ${JSON.stringify(replace[0])} matched nothing`);
  writeFileSync(path, after);
}

describe("the Android V8 recipe hash", () => {
  it("is stable for the tree that is checked in, and carries no absolute path", () => {
    const hash = androidV8RecipeHash(runtimeRoot);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(androidV8RecipeHash(runtimeRoot)).toBe(hash);
    // Two copies of the same bytes under different directories are the same recipe: a key that
    // moved with the checkout path would miss on every self-hosted runner.
    expect(androidV8RecipeHash(recipeRoot())).toBe(hash);
  });

  it("reads only the v8-android entry out of the provisioner", () => {
    const source = readFileSync(join(runtimeRoot, "scripts/download-deps.mjs"), "utf8");
    const entry = v8AndroidDependencyEntry(source);
    expect(entry.startsWith("'v8-android': {")).toBe(true);
    expect(entry.endsWith("}")).toBe(true);
    expect(entry).toContain("11.110.1");
    // The entry is balanced: a scanner reading raw braces stops inside its own comment block.
    expect(entry).not.toContain("wgpu-android");
    expect(entry).not.toContain("'sdl3-android'");
  });

  it("keeps the key when an unrelated dependency changes", () => {
    const root = recipeRoot();
    const before = androidV8RecipeHash(root);
    // The PR #493 shape: a version bump of a dependency that is not V8.
    edit(root, "scripts/download-deps.mjs", ["version: 'v25.0.2.2',", "version: 'v25.0.2.3',"]);
    expect(androidV8RecipeHash(root)).toBe(before);
  });

  it("keeps the key when a file outside the recipe changes", () => {
    const root = recipeRoot();
    const before = androidV8RecipeHash(root);
    edit(root, "scripts/download-deps.mjs", [
      "extractTo: 'wgpu-android'",
      "extractTo: 'wgpu-android-renamed'",
    ]);
    expect(androidV8RecipeHash(root)).toBe(before);
  });

  it("changes the key for every input that decides the payload", () => {
    const before = androidV8RecipeHash(recipeRoot());
    const edits: Array<[string, [string, string]]> = [
      // The V8 version the provisioner pins.
      ["scripts/download-deps.mjs", ["version: '11.110.1'", "version: '11.110.2'"]],
      // The source commit, GN args and patch set the builder pins.
      ["scripts/build-android-v8.mjs", ["\trecipe: 6,", "\trecipe: 7,"]],
      ["scripts/build-android-v8.mjs", ['"v8_enable_sandbox=false"', '"v8_enable_sandbox=true"']],
      // The 16 KB LOAD-alignment check decides whether a payload is accepted at all.
      ["scripts/check-android-16kb-alignment.mjs", ["export function", "export function  "]],
      // Gradle's Android build inputs.
      ["android/gradle.properties", ["org.gradle.jvmargs=", "org.gradle.jvmargs= "]],
    ];
    for (const [relative, replace] of edits) {
      const root = recipeRoot();
      edit(root, relative, replace);
      expect(androidV8RecipeHash(root), `${relative} ${replace[0]} kept the key`).not.toBe(before);
    }
  });

  it("refuses an entry that is code, because a brace scanner cannot follow it", () => {
    // The real entry is plain data, which is what makes the brace count safe.
    const real = readFileSync(join(runtimeRoot, "scripts/download-deps.mjs"), "utf8");
    expect(() => v8AndroidDependencyEntry(real)).not.toThrow();
    expect(v8AndroidDependencyEntry(real)).not.toContain("`");

    const template = "const DEPS = {\n  'v8-android': {\n    version: `11.${major}.1`,\n  },\n};\n";
    expect(() => v8AndroidDependencyEntry(template)).toThrow("TN_V8_RECIPE_ENTRY_NOT_PLAIN");
    // A regex literal may hold a brace or a quote, and its `}` ends the scan inside the entry.
    const regex =
      "const DEPS = {\n  'v8-android': {\n    version: '11.110.1',\n    tag: /^v8}-/u,\n  },\n};\n";
    expect(() => v8AndroidDependencyEntry(regex)).toThrow("TN_V8_RECIPE_ENTRY_NOT_PLAIN");
  });

  it("takes the recipe hash from the script rather than hashing whole files", () => {
    const recipe = action.slice(
      action.indexOf("- name: Compute the pinned V8 recipe hash"),
      action.indexOf("- name: Download the published Android V8 payload"),
    );
    // `hashFiles('…/download-deps.mjs')` is the whole-file hash this key must never go back to: an
    // unrelated edit in that file then throws away a built V8.
    expect(recipe).not.toContain("hashFiles(");
    // A failing node must fail the step: an `echo "hash=$(node …)"` wrote an empty name instead.
    expect(recipe).toMatch(/^ {8}hash=\$\(node .+\)$/mu);
    expect(recipe).toMatch(/^ {8}\[ -n "\$hash" \] \|\|/mu);
    expect(recipe).not.toMatch(/echo "hash=\$\(/u);
  });
});
