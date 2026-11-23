import * as prop from "../dungeon/props.js";
import * as building from "./buildings.js";
import { home, inn, shop } from "./interiors.js";
import { type VillagePart, villageMesh } from "./kit.js";
import * as part from "./parts.js";
import * as village from "./props.js";
import * as wall from "./walls.js";

type Entry = [id: string, name: string, build: VillagePart];

const sections: Record<string, Entry[]> = {
  Buildings: [
    ["cottage", "Cottage", building.cottage],
    ["townhouse", "Two-storey house", building.townhouse],
    ["tavern", "Tavern", building.tavern],
    ["barn", "Barn", building.barn],
    ["watchtower", "Watchtower", building.watchtower],
    ["windmill", "Windmill", building.windmill],
    ["forge", "Blacksmith forge", building.forge],
    ["market-stall", "Market stall", building.marketStall],
    ["well", "Well", building.well],
  ],
  "Enterable buildings": [
    ["home", "House", (m) => home(m)],
    ["home-cutaway", "House interior (cutaway)", (m) => home(m, true)],
    ["inn", "Inn", (m) => inn(m)],
    ["inn-cutaway", "Inn interior (cutaway)", (m) => inn(m, true)],
    ["shop", "Shop", (m) => shop(m)],
    ["shop-cutaway", "Shop interior (cutaway)", (m) => shop(m, true)],
  ],
  "City walls": [
    ["city-wall", "City wall", wall.cityWall],
    ["wall-tower", "Wall tower", wall.wallTower],
    ["gatehouse", "Gatehouse", wall.gatehouse],
  ],
  "Walls and fences": [
    ["timber-wall", "Timber-framed wall", part.timberWall],
    ["window-wall", "Wall with window", part.windowWall],
    ["door-wall", "Wall with door", part.doorWall],
    ["garden-wall", "Dry-stone wall", part.gardenWall],
    ["picket-fence", "Picket fence", part.picketFence],
    ["rail-fence", "Rail fence", part.railFence],
    ["gate", "Stone gateposts and gate", part.gate],
  ],
  Paths: [
    ["cobble-path", "Cobblestone path", part.cobblePath],
    ["stepping-stones", "Stepping stones", part.steppingStones],
  ],
  Props: [
    ["cart", "Hay cart", village.cart],
    ["haystack", "Haystack", village.haystack],
    ["woodpile", "Woodpile", village.woodpile],
    ["lamp-post", "Lamp post", village.lampPost],
    ["signpost", "Signpost", village.signpost],
    ["planter", "Flower planter", village.planter],
    ["pumpkins", "Pumpkin patch", village.pumpkins],
    ["laundry-line", "Laundry line", village.laundryLine],
    ["scarecrow", "Scarecrow", village.scarecrow],
    ["campfire", "Campfire", village.campfire],
    ["trough", "Water trough", village.trough],
    ["crate", "Crate", prop.crate],
    ["barrel", "Barrel", prop.barrel],
    ["sack", "Sack", prop.sack],
    ["table", "Table", (m) => prop.furniture(m)],
    ["bench", "Bench", (m) => prop.furniture(m, true)],
  ],
};

export const villageEntries = Object.entries(sections).flatMap(([category, entries]) =>
  entries.map(([id, name, build]) => ({ id, name, category, build })),
);
const recipes = new Map(villageEntries.map(({ id, build }) => [id, build]));

export function buildVillagePart(id: string, seed: number, theme: number) {
  const make = recipes.get(id);
  if (!make) throw new Error(`Unknown village asset "${id}"`);
  const mesh = villageMesh(seed, theme);
  make(mesh);
  return mesh.finish(`village-${id}`);
}
