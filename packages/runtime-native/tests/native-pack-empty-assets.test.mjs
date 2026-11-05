import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { cookNativeEngineAssets } from "../scripts/bundle-native-engine.mjs";

/**
 * A game with no asset files cooks no pack: `compileAssets` deliberately writes none
 * (TN_ASSETS_NATIVE_PACKAGE_EMPTY) and removes any old one, and the player opens
 * `<bundle dir>/native/assets.tnpk` only when the game asks for an asset. Desktops builds of such
 * a game used to fail on a read of the pack the bake never wrote.
 */
test("cooking a project with no asset files yields no pack instead of failing", async () => {
  const project = await makeTempDir("threenative-native-pack-empty-");
  await mkdir(join(project, "assets"));
  const outfile = join(project, "out", "game.js");
  // A pack a previous, non-empty cook left beside the bundle must not survive this one.
  const stale = join(project, "out", "native", "assets.tnpk");
  await mkdir(join(project, "out", "native"), { recursive: true });
  await writeFile(stale, Buffer.from("stale package left by an earlier cook"));

  assert.equal(await cookNativeEngineAssets({ project, outfile }), undefined);
  assert.equal(existsSync(stale), false, "an empty cook must leave no pack beside the bundle");
});
