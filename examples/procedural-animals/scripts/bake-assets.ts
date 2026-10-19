import { fileURLToPath } from "node:url";
import { compileAssets } from "@threenative/assets";
import { animalBakePass, bakeWolfToFile } from "@threenative/procedural-animals/build";
const cwd = fileURLToPath(new URL("../", import.meta.url));
for (const tier of ["high", "crowd"] as const)
  await bakeWolfToFile({ seed: 7, tier }, `${cwd}/assets/wolf-${tier}.animal`);
await compileAssets({
  cwd,
  source: "assets",
  output: "public",
  concurrency: 1,
  passes: [animalBakePass()],
});
