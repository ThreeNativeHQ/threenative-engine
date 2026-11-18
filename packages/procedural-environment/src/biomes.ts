/**
 * Where each element belongs. A biome lists the trees, cover, debris and rock forms that read as
 * that place, and names the Outcrop rock surface its rocks wear. Ids match the Strata terrain kits
 * (forest, coastal, alpine, desert, tundra) where they overlap. A spec fails when an element has no
 * biome, so a new preset gets one here.
 */
export interface IEnvironmentBiome {
  readonly id: string;
  readonly name: string;
  /** Other words a request uses for this place ("jungle", "swamp"); `environmentElements` searches them. */
  readonly words: readonly string[];
  /** The Outcrop biome whose colours, weathering and cover (moss, snow, sand, algae) the rocks take. */
  readonly rock: string;
  /** Element ids: Arbor and forest-kit presets, and Outcrop rock forms. */
  readonly elements: readonly string[];
}

const FLOOR = ["log", "stump", "twig", "branch", "leaflitter", "rock"];

export const BIOMES: readonly IEnvironmentBiome[] = [
  {
    id: "forest",
    name: "Temperate forest",
    words: ["woods", "woodland", "broadleaf", "conifer", "boreal", "taiga"],
    rock: "hills",
    elements: [
      ...["oak", "beech", "birch", "spruce", "scotspine", "douglasfir", "redcedar", "bigleafmaple"],
      ...["aspen", "hazel", "salal", "bluebell", "forestgrass", "bracken", "swordfern"],
      ...["treefernling", "clover", "dock", "seedgrass", ...FLOOR, "boulder", "slab", "cliff"],
    ],
  },
  {
    id: "hills",
    name: "Meadow hills",
    words: ["meadow", "grassland", "countryside", "pasture", "field", "rolling", "prairie"],
    rock: "hills",
    elements: [
      ...["oak", "birch", "hazel", "meadowgrass", "lushgrass", "daisy", "poppy", "fireweed"],
      ...["clover", "dock", "seedgrass", "plume", "tussock", "rock", "boulder", "slab", "cliff"],
    ],
  },
  {
    id: "coastal",
    name: "Coast",
    words: ["coast", "beach", "sea", "shore", "island", "ocean", "seaside", "fjord"],
    rock: "coastal",
    elements: [
      ...["stonepine", "scotspine", "cypress", "coconut", "drygrass", "tussock", "seedgrass"],
      ...["plume", "branch", "boulder", "slab", "cliff", "stack", "arch"],
    ],
  },
  {
    id: "alpine",
    name: "Alpine",
    words: ["mountain", "mountains", "peaks", "alps", "highland", "highlands"],
    rock: "alpine",
    elements: [
      ...["spruce", "scotspine", "douglasfir", "birch", "tundragrass", "meadowgrass", "fireweed"],
      ...["blueberry", "azalea", "tussock", "log", "stump", "rock", "boulder", "slab", "cliff"],
      ...["spire", "mountain"],
    ],
  },
  {
    id: "desert",
    name: "Desert",
    words: ["canyon", "mesa", "dune", "dunes", "butte", "arid", "badlands", "wasteland"],
    rock: "desert",
    elements: [
      ...["saguaro", "joshua", "fanpalm", "bunchgrass", "marigold", "creosote", "agave"],
      ...["drygrass", "thornbush", "boulder", "slab", "cliff", "spire", "hoodoo", "mesa", "arch"],
    ],
  },
  {
    id: "tundra",
    name: "Tundra",
    words: ["arctic", "polar", "subarctic", "frozen", "snowfield"],
    rock: "tundra",
    elements: [
      ...["blackspruce", "birch", "tundragrass", "blueberry", "fireweed", "tussock", "seedgrass"],
      ...["rock", "boulder", "slab", "cliff", "mountain"],
    ],
  },
  {
    id: "volcanic",
    name: "Volcanic",
    words: ["volcano", "lava", "basalt", "ash", "caldera"],
    rock: "volcanic",
    elements: ["fireweed", "drygrass", "tussock", "boulder", "slab", "cliff", "spire", "mountain"],
  },
  {
    id: "savanna",
    name: "Savanna",
    words: ["safari", "veld", "bush", "bushland", "plains"],
    rock: "desert",
    elements: [
      ...["acacia", "baobab", "savannagrass", "drygrass", "thornbush", "bunchgrass", "boulder"],
      "slab",
    ],
  },
  {
    id: "tropical",
    name: "Tropical rainforest",
    words: ["jungle", "rainforest", "tropics", "tropic", "amazon"],
    rock: "hills",
    elements: [
      ...["kapok", "coconut", "banana", "bamboo", "ipe", "jacaranda", "araucaria", "lushgrass"],
      ...["bromeliad", "elephantear", "treefernling", "sasa", "log", "stump", "leaflitter"],
      ...["boulder", "cliff"],
    ],
  },
  {
    id: "mediterranean",
    name: "Mediterranean",
    words: ["olive", "grove", "maquis", "garrigue", "chaparral", "scrubland"],
    rock: "hills",
    elements: [
      ...["olive", "cypress", "stonepine", "rosemary", "lavender", "poppy", "drygrass"],
      ...["thornbush", "agave", "boulder", "slab", "cliff"],
    ],
  },
  {
    id: "wetland",
    name: "Wetland",
    words: ["swamp", "marsh", "bog", "pond", "lake", "river", "fen"],
    rock: "hills",
    elements: [
      ...["birch", "blackspruce", "redcedar", "reeds", "tussock", "blueberry", "lushgrass"],
      ...["dock", "plume", "clover", "log", "stump", "boulder"],
    ],
  },
  {
    id: "garden",
    name: "East Asian garden",
    words: ["park", "japanese", "zen", "temple", "shrine", "orchard"],
    rock: "hills",
    elements: [
      ...["sakura", "jmaple", "ginkgo", "bamboo", "sasa", "azalea", "lavender", "bluebell"],
      ...["lushgrass", "meadowgrass", "boulder", "slab"],
    ],
  },
];
