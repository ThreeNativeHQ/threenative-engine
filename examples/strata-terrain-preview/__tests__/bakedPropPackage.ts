import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IPropPackage } from "@threenative/terrain";
import { loadPropPackage } from "../src/render/props/propWorld.js";

/**
 * Read a baked prop package from disk through the game's own loader.
 *
 * The loader fetches `<world>.props.json` and the three files of every bucket from the roots an
 * asset loader resolves; a test has file URLs, so one `fetch` reads the file it names. The package
 * a test reads is therefore the package the game reads, container for container.
 */
export async function readBakedPropPackage(
  dir: string | URL,
  world: string,
): Promise<IPropPackage> {
  const base = typeof dir === "string" ? dir : fileURLToPath(dir);
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) =>
    new Response(readFileSync(fileURLToPath(input instanceof Request ? input.url : input)));
  try {
    return await loadPropPackage(
      { resolve: async (path: string) => [`file://${base}${path.replace("world/", "")}`] },
      world,
    );
  } finally {
    globalThis.fetch = original;
  }
}
