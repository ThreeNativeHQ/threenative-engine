// Which baked world files the game fetches, read from the bake's own output rather than listed here.
//
// `scripts/props.mjs` writes one `<world>.props.json` per world and names every streamed container,
// reach array and ID list inside it, so this list follows a bake change with no edit. A file the
// manifest names and the bake did not write stops the build by name, never a half-shipped world.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every baked file under `dir` that the game fetches, relative to `dir`.
 *
 * Throws `TN_STRATA_BUILD_MISSING <file>` when one is absent.
 */
export function worldFiles(dir) {
  const files = ["baked.json", "horizon.json"];
  const worlds = readdirSync(dir)
    .filter((entry) => entry.endsWith(".props.json"))
    .sort();
  for (const entry of worlds) {
    const world = entry.slice(0, -".props.json".length);
    const { buckets } = JSON.parse(readFileSync(join(dir, entry), "utf8"));
    // The bake writes `<world>.json` only for a world it keeps out of `baked.json`.
    if (existsSync(join(dir, `${world}.json`))) files.push(`${world}.json`);
    files.push(
      entry,
      `${world}.canopy.bin`,
      `${world}.sky.bin`,
      `${world}.world.json`,
      `${world}.layers.json`,
      `${world}.splat.rgba8`,
    );
    for (const bucket of buckets) files.push(bucket.placements, bucket.reach, bucket.ids);
  }
  const missing = files.find((file) => !existsSync(join(dir, file)));
  if (missing !== undefined) throw new Error(`TN_STRATA_BUILD_MISSING ${missing}`);
  return files;
}
