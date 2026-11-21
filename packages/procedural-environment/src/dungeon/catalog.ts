import * as feature from "./features.js";
import * as stone from "./masonry.js";
import { DungeonMesh, type DungeonPart } from "./mesh.js";
import * as prop from "./props.js";

type Entry = [id: string, name: string, build: DungeonPart];

const sections: Record<string, Entry[]> = {
  Walls: [
    ["wall", "Straight wall", stone.wall],
    ["corner", "Corner wall", stone.corner],
    ["tee", "T-junction wall", stone.tee],
    ["cross", "Cross-junction wall", stone.cross],
    ["archway", "Stone archway", stone.archway],
    ["door-frame", "Door frame", stone.doorFrame],
    ["barred-window", "Barred window", stone.barredWindow],
    ["collapsed-wall", "Collapsed wall", stone.collapsedWall],
  ],
  "Floors and stairs": [
    ["floor", "Flagstone floor", stone.floor],
    ["cracked-floor", "Cracked flagstones", stone.crackedFloor],
    ["mossy-floor", "Mossy flagstones", stone.mossyFloor],
    ["grate", "Floor grate", (m) => stone.grate(m)],
    ["stairs", "Straight stairs", (m) => stone.stairs(m)],
    ["corner-stairs", "Corner stairs", (m) => stone.stairs(m, true)],
    ["ramp", "Stone ramp", stone.ramp],
    ["platform", "Raised platform", stone.platform],
  ],
  Structure: [
    ["pillar", "Pillar", (m) => stone.pillar(m)],
    ["broken-column", "Broken column", (m) => stone.pillar(m, true)],
    ["large-arch", "Large arch", stone.largeArch],
    ["ruined-arch", "Ruined arch", stone.ruinedArch],
    ["vault", "Vaulted ceiling", stone.vault],
    ["beam", "Ceiling beam", stone.beam],
  ],
  Props: [
    ["crate", "Crate", prop.crate],
    ["barrel", "Barrel", prop.barrel],
    ["sack", "Sack", prop.sack],
    ["locked-chest", "Locked chest", (m) => prop.chest(m)],
    ["open-chest", "Open treasure chest", (m) => prop.chest(m, true)],
    ["cage", "Iron cage", prop.cage],
    ["table", "Table", (m) => prop.furniture(m)],
    ["bench", "Bench", (m) => prop.furniture(m, true)],
    ["shelves", "Shelves", prop.shelves],
    ["weapon-rack", "Weapon rack", (m) => prop.weaponStand(m, true)],
    ["weapon-stand", "Weapon stand", (m) => prop.weaponStand(m)],
    ["banner", "Banner", prop.banner],
    ["wall-torch", "Wall torch", prop.wallTorch],
    ["brazier", "Brazier", prop.brazier],
    ["hanging-lamp", "Hanging lamp", prop.hangingLamp],
    ["candles", "Candle cluster", prop.candles],
    ["rubble", "Stone debris", prop.rubble],
    ["bones", "Bones and skull", prop.bones],
  ],
  Features: [
    ["portcullis", "Portcullis", feature.portcullis],
    ["lever", "Lever", feature.lever],
    ["spike-trap", "Floor spike trap", feature.spikeTrap],
    ["pressure-plate", "Pressure plate", feature.pressurePlate],
    ["wooden-bridge", "Wooden bridge", feature.woodenBridge],
    ["stone-bridge", "Stone bridge", feature.stoneBridge],
    ["statue", "Hooded statue", feature.statue],
    ["altar", "Candlelit altar", feature.altar],
    ["sarcophagus", "Sarcophagus", feature.sarcophagus],
  ],
};

export const dungeonEntries = Object.entries(sections).flatMap(([category, entries]) =>
  entries.map(([id, name, build]) => ({ id, name, category, build })),
);
const recipes = new Map(dungeonEntries.map(({ id, build }) => [id, build]));

export function buildDungeonPart(id: string, seed: number, theme: number) {
  const make = recipes.get(id);
  if (!make) throw new Error(`Unknown dungeon asset "${id}"`);
  const mesh = new DungeonMesh(seed, theme);
  make(mesh);
  return mesh.finish(id);
}
