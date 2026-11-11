import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const coreSrc = join(root, "packages/core/src");

// The native bundler swaps every core import of `./assets.js` for the player's `core-assets.mjs`,
// so a value core imports from there and the shim lacks fails the desktop build at link time.
// Read as text: importing the shim needs the engine's global `tn` and its three classes.
it("the player's core-assets shim exports every value core imports from ./assets.js", () => {
  const shimSource = readFileSync(
    join(root, "packages/runtime-native/src/engine/player/core-assets.mjs"),
    "utf8",
  );
  const shim = new Set(
    [...shimSource.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/gm)].map(
      ([, name]) => name,
    ),
  );
  const wanted = new Set();
  for (const file of readdirSync(coreSrc, { recursive: true })) {
    if (!String(file).endsWith(".ts")) continue;
    const source = readFileSync(join(coreSrc, String(file)), "utf8");
    for (const [, names] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.{1,2}\/(?:[\w-]+\/)*assets\.js"/g))
      for (const name of names.split(",").map((part) => part.trim()))
        if (name && !name.startsWith("type ")) wanted.add(name.split(/\s+as\s+/)[0]);
  }
  expect(wanted.size).toBeGreaterThan(0);
  expect([...wanted].filter((name) => !shim.has(name))).toEqual([]);
});
