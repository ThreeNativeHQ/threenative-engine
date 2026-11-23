import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const run = promisify(execFile);
const bundlerScript = path.resolve("packages/runtime-native/scripts/bundle.mjs");
// This package declares no Vite of its own: `bundle.mjs` builds with the *game's* pinned copy,
// so a fixture game borrows the one the scaffolder ships.
const viteInstall = path.resolve("packages/create-threenative/node_modules/vite");
/** A project name a telemetry field has to carry intact, quotes included (PRD-905). */
const GAME_NAME = 'Three "Identity" Proof';

test("native project prelude preserves independent canvases for loading text", () => {
  const bundler = readFileSync(new URL("../scripts/bundle.mjs", import.meta.url), "utf8");
  const prelude = bundler.match(/const nativePrelude = `([\s\S]*?)`;/u)?.[1];
  assert.ok(prelude, "the shipped project prelude must be exercised");
  const surface = { width: 1280, height: 720 };
  const document = {
    getElementById: () => ({}),
    querySelector: () => surface,
    createElement: (_tag: string) => ({ width: 300, height: 150 }),
  };
  runInNewContext(prelude, { document, canvas: surface });
  const text = document.createElement("canvas");
  text.width = 440;
  text.height = 64;
  assert.notEqual(text, surface, "a text canvas must not alias the presentation canvas");
  assert.deepEqual(surface, { width: 1280, height: 720 });
  assert.notEqual(document.createElement("canvas"), text);
});

/**
 * A `three` stand-in whose module scope holds state the way three's TSL node stack does: two
 * physical copies answer `Fn()` with two stacks, and the second one is empty.
 */
async function writeThreeCopy(directory: string, copy: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ main: "index.js", name: "three", type: "module", version: "0.185.1" }),
  );
  await writeFile(
    path.join(directory, "index.js"),
    `export const copy = ${JSON.stringify(copy)};\nexport const nodeStack = [];\n`,
  );
}

test("bundles one copy of three when a linked package resolves its own", async () => {
  const root = await makeTempDir("threenative-native-three-");
  const project = path.join(root, "project");
  const engine = path.join(root, "linked-render");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "node_modules"), { recursive: true });
  await symlink(viteInstall, path.join(project, "node_modules/vite"));
  await symlink(engine, path.join(project, "node_modules/linked-render"));
  await writeThreeCopy(path.join(project, "node_modules/three"), "project");
  await writeThreeCopy(path.join(engine, "node_modules/three"), "linked");
  await writeFile(
    path.join(project, "package.json"),
    '{"name":"three-identity-proof","type":"module"}\n',
  );
  await writeFile(
    path.join(engine, "package.json"),
    '{"main":"index.js","name":"linked-render","type":"module"}\n',
  );
  await writeFile(
    path.join(engine, "index.js"),
    `import { copy, nodeStack } from "three";
export const engineStack = nodeStack;
export function buildFromEngine() {
  nodeStack.push("engine");
  return copy;
}
`,
  );
  await writeFile(
    path.join(project, "src/game.ts"),
    `import { buildFromEngine, engineStack } from "linked-render";
import { copy, nodeStack } from "three";
export default {
  start() {
    nodeStack.push("game");
    globalThis.tnThreeIdentity = JSON.stringify({
      copies: [copy, buildFromEngine()],
      sharedStack: nodeStack === engineStack,
      stack: nodeStack,
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
      "--game-name",
      GAME_NAME,
      "--engine-name",
      "threenative",
    ],
    { cwd: project },
  );

  const context: Record<string, unknown> = {
    console,
    document: {
      createElement: () => ({}),
      getElementById: () => null,
      querySelector: () => null,
    },
  };
  runInNewContext(await readFile(output, "utf8"), context);
  // PRD-905: a native bundle names the game and the engine drawing it, ahead of every game module
  // and with a quote in the name escaped, so an event reported from it is not "unknown".
  expect(context.__TN_GAME__).toBe(GAME_NAME);
  expect(context.__TN_ENGINE__).toBe("threenative");
  expect(JSON.parse(String(context.tnThreeIdentity))).toEqual({
    copies: ["project", "project"],
    sharedStack: true,
    stack: ["game", "engine"],
  });
}, 120_000);
