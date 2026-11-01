#!/usr/bin/env node
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Blender scripts ride inside this package's `dist/`, for the same reason the animation server
// rides inside core: a published package that declares an unpublished dependency cannot be
// installed at all. `pnpm dlx --package <assets tarball>` stops with
//
//   ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@threenative/blender-bridge: Not Found
//   This error happened while installing the dependencies of the assets package
//
// and the scaffold dies before its first build. So `@threenative/blender-bridge` is a devDependency,
// tsup inlines the bridge, and the `.py` files it spawns are copied here.
//
// The GPL boundary is unchanged by the copy: these files keep their `SPDX-License-Identifier:
// GPL-2.0-or-later` header and travel with `LICENSE.GPL`. `packages/blender-bridge/gpl/` remains the
// only place they are edited.
const assetsRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const source = path.resolve(assetsRoot, "..", "blender-bridge", "gpl");
const target = path.join(assetsRoot, "dist", "blender-gpl");

if (!existsSync(source)) {
  throw new Error(
    `TN_ASSETS_BLENDER_GPL: build @threenative/blender-bridge before assets; missing ${source}`,
  );
}
// Refuse to delete anything but the exact generated directory this script owns. A recursive
// remove whose path came out wrong is not a bug you get to find later.
if (path.basename(target) !== "blender-gpl" || path.basename(path.dirname(target)) !== "dist") {
  throw new Error(`TN_ASSETS_BLENDER_GPL: refusing to remove '${target}'.`);
}
rmSync(target, { force: true, recursive: true });
cpSync(source, target, {
  filter: (candidate) => {
    const name = path.basename(candidate);
    return name !== "__pycache__" && !/\.py[co]$/u.test(name);
  },
  recursive: true,
});
if (!existsSync(path.join(target, "convert.py"))) {
  throw new Error(`TN_ASSETS_BLENDER_GPL: copy produced no convert.py at ${target}`);
}
