import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Run on a production bundle whose Vite receipt plugin emits getModuleIds().
// This checks the actual installed graph, never an inferred package export graph.
const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("TN_ANIMAL_EXCLUSION_PROJECT_REQUIRED");
const dist = join(root, "dist");
const graphBytes = readFileSync(join(dist, "module-graph.json"));
const graph = JSON.parse(graphBytes);
if (!Array.isArray(graph) || graph.length === 0 || graph.some((id) => typeof id !== "string"))
  throw new Error("TN_ANIMAL_EXCLUSION_GRAPH_INVALID");
if (
  !graph.some((id) => id.endsWith("/src/game.ts")) ||
  !graph.some((id) => id.includes("/node_modules/@threenative/core/dist/"))
)
  throw new Error("TN_ANIMAL_EXCLUSION_GAME_OR_CORE_MISSING");
const forbidden = /procedural[-_+]?animals|threejs[-_+]?procedural[-_+]?animals|TN_ANIMAL_/i;
const modules = graph.filter((id) => forbidden.test(id));
const packageBytes = readFileSync(join(root, "package.json"));
const lockBytes = readFileSync(join(root, "pnpm-lock.yaml"));
if (
  modules.length > 0 ||
  forbidden.test(packageBytes.toString()) ||
  forbidden.test(lockBytes.toString())
)
  throw new Error(`TN_ANIMAL_EXCLUSION_IMPORT_FOUND: ${modules.join(", ")}`);
const hashes = {};
let scripts = 0;
function inspect(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      inspect(path);
      continue;
    }
    const bytes = readFileSync(path);
    hashes[path.slice(root.length + 1)] = createHash("sha256").update(bytes).digest("hex");
    if (!/\.m?js$/.test(item.name)) continue;
    scripts += 1;
    if (forbidden.test(bytes.toString()))
      throw new Error(`TN_ANIMAL_EXCLUSION_BUNDLE_FOUND: ${path}`);
  }
}
inspect(dist);
if (scripts === 0) throw new Error("TN_ANIMAL_EXCLUSION_SCRIPTS_MISSING");
console.log(
  JSON.stringify(
    {
      result: "pass",
      moduleCount: graph.length,
      scripts,
      excluded: ["animal generator", "animal worker", "animal runtime"],
      packageSha256: createHash("sha256").update(packageBytes).digest("hex"),
      lockSha256: createHash("sha256").update(lockBytes).digest("hex"),
      outputHashes: hashes,
    },
    null,
    2,
  ),
);
