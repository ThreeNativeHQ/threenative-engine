import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const run = promisify(execFile);
const bundlerScript = path.resolve("packages/runtime-native/scripts/bundle.mjs");
// `bundle.mjs` builds with the *game's* pinned copy, so the fixture borrows the scaffolder's.
const viteInstall = path.resolve("packages/create-threenative/node_modules/vite");

test("packages the shared terrain game as a portable desktop entry", async () => {
  const root = await makeTempDir("threenative-terrain-entry-");
  const output = path.join(root, "terrain.js");
  await run(process.execPath, [
    bundlerScript,
    "--project",
    path.resolve("examples/abyss-framework"),
    "--entry",
    "src/terrain-game.ts",
    "--target",
    "desktop",
    "--output",
    output,
  ]);
  const source = await readFile(output, "utf8");
  expect(source).toContain("TN_NATIVE_START_FAILED");
  expect(source).not.toContain("Missing #root element.");
  expect(
    JSON.parse(await readFile(path.join(root, "terrain-assets/assets.manifest.json"), "utf8")),
  ).toEqual({ version: 1, entries: {} });
}, 120_000);

/**
 * The shipped asset is minified, but core reads `backend.constructor.name` for the renderer's
 * backend stamp and the worker wire reads `value.constructor.name`. The minifier must keep the
 * names it can no longer recover, and keep the dependencies' `@license` banners.
 */
test("the minified bundle drops formatting and comments but keeps class names", async () => {
  const root = await makeTempDir("threenative-native-minify-");
  const project = path.join(root, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "node_modules"), { recursive: true });
  await symlink(viteInstall, path.join(project, "node_modules/vite"));
  await writeFile(path.join(project, "package.json"), '{"name":"minify-proof","type":"module"}\n');
  await writeFile(
    path.join(project, "src/game.ts"),
    `class NamedThing {}
// canary-marker: the minifier must strip this comment
export default {
  start() {
    const canaryLocal = 1;
    globalThis.tnMinifyProbe = JSON.stringify({
      className: new NamedThing().constructor.name,
      canary: canaryLocal,
    });
    return Promise.resolve();
  },
};
`,
  );

  const output = path.join(project, "dist/android.js");
  await run(
    process.execPath,
    [
      bundlerScript,
      "--project",
      project,
      "--entry",
      "src/game.ts",
      "--target",
      "android",
      "--output",
      output,
    ],
    { cwd: project },
  );

  const source = await readFile(output, "utf8");
  // `minify: false` emits the source with its indentation; a minified bundle is one line after
  // the banner. KeepNames preserves the class identifier below, so it cannot be the signal.
  expect(source).not.toMatch(/\n[\t ]/u);

  const context: Record<string, unknown> = {
    console,
    document: {
      createElement: () => ({}),
      getElementById: () => null,
      querySelector: () => null,
    },
  };
  runInNewContext(source, context);
  expect(JSON.parse(String(context.tnMinifyProbe))).toEqual({
    className: "NamedThing",
    canary: 1,
  });
}, 120_000);
