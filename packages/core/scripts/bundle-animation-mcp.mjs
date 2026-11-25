#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The animation server rides inside core the way the Blender and engine servers do, and for one
// reason more: `threenative-animation-mcp` has never been published, so `launch.mjs`'s
// `npx <name>@<version>` fallback is an E404 rather than a fallback. Declaring it as a dependency
// would be worse — a published package that names an unpublished one cannot be installed at all.
// So core devDepends on it and carries this exact built copy, committed.
const coreRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const source = path.resolve(coreRoot, "..", "animation-mcp", "dist", "index.js");
const target = path.join(coreRoot, "mcp", "animation-server.mjs");

if (!existsSync(source)) {
  throw new Error(
    `TN_ANIMATION_MCP_BUNDLE: build threenative-animation-mcp before core; missing ${source}`,
  );
}
copyFileSync(source, target);
// Pose Lab rides along (PRD-915): the Asset Library mounts `pose-lab.mjs` at `/__assets/pose/`, and
// both it and `animation_open_view` serve the prebuilt client from `mcp/client/app.js` beside them.
const dist = path.dirname(source);
for (const [from, to] of [
  ["pose-lab.js", "pose-lab.mjs"],
  ["client/app.js", "client/app.js"],
]) {
  const file = path.join(dist, from);
  if (!existsSync(file))
    throw new Error(
      `TN_ANIMATION_MCP_BUNDLE: build threenative-animation-mcp before core; missing ${file}`,
    );
  mkdirSync(path.dirname(path.join(coreRoot, "mcp", to)), { recursive: true });
  copyFileSync(file, path.join(coreRoot, "mcp", to));
}
