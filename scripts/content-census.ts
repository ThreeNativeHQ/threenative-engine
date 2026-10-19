/**
 * What a merge could collapse in a directory of glTF models, before and after an atlas.
 *
 * `pnpm census:content <dir>` — the number to read before promising that fewer objects will make a
 * game faster. A runtime per-material merge on the reference game replaced 246 of 1,561 meshes and
 * moved no frame time, because the buckets it found were singletons; this prints those buckets, and
 * prints them again with every atlasable texture repointed at a page, so the atlas hypothesis can
 * be checked instead of assumed.
 *
 * It reads geometry and materials only. No GPU, no game, no runtime — which is why it is the part
 * of the content pipeline that can be run anywhere.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  type IContentCensus,
  censusDocument,
  totalCensus,
} from "../packages/assets/src/content/census.js";

function row(entry: IContentCensus): string {
  return [
    entry.model.padEnd(34),
    `meshes ${String(entry.meshes).padStart(4)}`,
    `mats ${String(entry.materials).padStart(4)}`,
    `tex ${String(entry.textureSources).padStart(4)}`,
    `buckets ${String(entry.before.buckets).padStart(4)} -> ${String(entry.after.buckets).padStart(4)}`,
    `singletons ${String(entry.before.singletons).padStart(4)} -> ${String(entry.after.singletons).padStart(4)}`,
    `pages ${String(entry.atlasPages).padStart(3)}`,
    `tiling ${String(entry.excluded).padStart(4)}`,
  ].join("  ");
}

export async function main(argv: readonly string[]): Promise<number> {
  const directory = argv.find((argument) => !argument.startsWith("--"));
  if (directory === undefined) {
    console.error("usage: pnpm census:content <directory of .glb files> [--json]");
    return 2;
  }
  const json = argv.includes("--json");
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".glb")).sort();
  const results: IContentCensus[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    try {
      results.push(censusDocument(file, await io.read(path.join(directory, file))));
    } catch (error) {
      // Named, never skipped silently: a model the census could not read is a hole in the number.
      unreadable.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const total = totalCensus(results);
  // A model the census could not read is a hole in the number, so the run fails closed.
  const exitCode = unreadable.length > 0 ? 1 : 0;
  if (json) {
    console.log(JSON.stringify({ models: results, total, unreadable }, null, 2));
    return exitCode;
  }
  for (const entry of [...results].sort((left, right) => right.materials - left.materials))
    console.log(row(entry));
  console.log(
    `\n${String(results.length)} models: ${String(total.meshes)} meshes, ${String(total.materials)} materials, ${String(total.textureSources)} texture sources`,
  );
  console.log(
    `buckets ${String(total.before.buckets)} -> ${String(total.after.buckets)}, singletons ${String(total.before.singletons)} -> ${String(total.after.singletons)}, ${String(total.excluded)} sources excluded as tiling`,
  );
  for (const failure of unreadable) console.error(`unreadable ${failure}`);
  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = await main(process.argv.slice(2));
