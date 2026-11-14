import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TERRAIN_KITS } from "../src/biome/kits.js";
import { BIOME_WORDS, biomeWordList } from "../src/request/biome-words.js";

/**
 * The tool's request parser is synchronous, so the aliases a request matches against are a mirror of
 * each starter's `biome.data.json`. This is the check that keeps the mirror honest: the file owns the
 * words, and a row that drifts fails here instead of silently dropping a synonym from the tool.
 */
describe("the biome words the request parser reads", () => {
  it.each(TERRAIN_KITS)("mirror %s's own aliases, in its file's order", async (kit) => {
    const spec = JSON.parse(
      await readFile(new URL(`../starter/${kit}/biome.data.json`, import.meta.url), "utf8"),
    ) as { aliases: string[] };
    expect(BIOME_WORDS[kit]).toEqual(spec.aliases);
    expect(BIOME_WORDS[kit][0]).toBe(kit);
  });

  it("names every biome and its words in the message a failed request prints", () => {
    for (const kit of TERRAIN_KITS) expect(biomeWordList()).toContain(kit);
    expect(biomeWordList()).toContain("woods");
  });
});
