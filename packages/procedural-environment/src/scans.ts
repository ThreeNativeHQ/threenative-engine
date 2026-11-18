import { readFile } from "node:fs/promises";

/**
 * Poly Haven CC0 scans (scans/credits.json) that replace a generated texture by default. Bark scans
 * are tiled to Arbor's 1:2 bark aspect; a detail scan is a grey multiplier with a linear mean of 0.5,
 * so a forest-kit piece keeps its own palette in COLOR_0 (doubled) and gains the scan's relief.
 * A profile or preset missing here (birch, aspen, bamboo, banana, cactus, flower stems, shrub twigs,
 * cover, leaf litter) has no fitting scan and keeps its generated texture.
 */
const BARK: Readonly<Record<string, string>> = {
  acacia: "japanese_camphor_bark",
  araucaria: "knotted_pine_bark",
  baobab: "chinese_hackberry_bark",
  beech: "chinese_hackberry_bark",
  cedar: "japanese_cedar_bark",
  cherry: "sakura_bark",
  cypress: "japanese_cedar_bark",
  fir: "metasequoia_bark",
  ginkgo: "bark_brown_01",
  ipe: "bark_brown_01",
  jacaranda: "japanese_camphor_bark",
  joshua: "palm_bark",
  kapok: "chinese_hackberry_bark",
  mossy: "tree_bark_03",
  oak: "jolcham_oak_bark_01",
  olive: "bark_willow_02",
  palm: "palm_bark",
  pine: "pine_bark",
  smoothgray: "chinese_hackberry_bark",
  spruce: "knotted_pine_bark",
  stonepine: "pine_bark",
};
const DETAIL: Readonly<Record<string, string>> = {
  branch: "bark_brown_02",
  log: "bark_brown_02",
  rock: "rock_boulder_dry",
  stump: "bark_brown_02",
  twig: "bark_brown_02",
};

export interface IScan {
  readonly id: string;
  readonly color: Uint8Array;
  readonly normal: Uint8Array;
}

async function load(id: string, color: "color" | "detail"): Promise<IScan> {
  const dir = new URL("../scans/", import.meta.url);
  const [colorBytes, normal] = await Promise.all([
    readFile(new URL(`${id}-${color}.webp`, dir)),
    readFile(new URL(`${id}-normal.webp`, dir)),
  ]);
  return { color: colorBytes, id, normal };
}

/** The bark scan for an Arbor bark profile, or undefined when none fits. */
export function barkScan(profile: string): Promise<IScan> | undefined {
  const id = BARK[profile];
  return id === undefined ? undefined : load(id, "color");
}

/** The detail scan for a forest-kit preset, or undefined when none fits. */
export function detailScan(preset: string): Promise<IScan> | undefined {
  const id = DETAIL[preset];
  return id === undefined ? undefined : load(id, "detail");
}
