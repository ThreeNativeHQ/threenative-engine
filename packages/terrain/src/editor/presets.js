import { Mask, Terrain } from "../index.js";
export const PRESETS = [
  {
    id: "alpine",
    name: "Alpine watershed",
    subtitle: "Granite ridges · river valley · conifer forest",
    tag: "ALPINE",
  },
  {
    id: "island",
    name: "Coastal sanctuary",
    subtitle: "Ocean cliffs · sandy coves · inland forest",
    tag: "COASTAL",
  },
  {
    id: "desert",
    name: "Canyon badlands",
    subtitle: "Stratified mesas · eroded gullies · dry wash",
    tag: "ARID",
  },
  {
    id: "blank",
    name: "Empty canvas",
    subtitle: "A clean heightfield for your next world",
    tag: "BLANK",
  },
];
export function createPreset(id = "alpine", { resolution = 257, seed = 73, size = 512 } = {}) {
  const t = new Terrain({ size, resolution, seed });
  const q = size / 512;
  const pt = (x, y, z) => [x * q, y * q, z * q];
  if (id === "blank") return t;
  t.transaction(() => {
    if (id === "alpine") {
      t.noise({
        id: "base",
        label: "Base · domain-warped hills",
        amplitude: 23 * q,
        base: 19 * q,
        scale: 180 * q,
        warp: 35 * q,
        octaves: 5,
      });
      const peaks = [
        [-137, -105, 135, 155, 133],
        [-10, -150, 136, 130, 156],
        [110, -115, 135, 147, 137],
        [155, 55, 128, 118, 115],
        [-155, 105, 105, 124, 114],
      ];
      peaks.forEach(([x, z, rx, rz, h], i) =>
        t.stamp({
          id: `ridge-${i + 1}`,
          label: `Granite massif ${i + 1}`,
          at: [x * q, z * q],
          radius: [rx * q, rz * q],
          amplitude: h * q,
          shape: "mountain",
          rotation: i * 31,
          roughness: 0.22,
        }),
      );
      t.stamp({
        id: "lake-basin",
        label: "Lower valley basin",
        at: [-36 * q, 108 * q],
        radius: [116 * q, 107 * q],
        amplitude: 34 * q,
        shape: "valley",
      });
      t.erode({
        id: "erosion",
        label: "Hydraulic · catchment erosion",
        method: "hydraulic",
        droplets: 3600,
        maxSteps: 44,
      });
      t.erode({
        id: "talus",
        label: "Thermal · scree slopes",
        method: "thermal",
        iterations: 5,
        talus: 37,
      });
      t.materials({
        id: "surface",
        label: "Automatic surface rules",
        rules: [
          { material: "dirt", mask: Mask.noise(36 * q, 0.67, seed, 0.14), strength: 0.55 },
          { material: "rock", mask: Mask.slope(34, 90, 9) },
          { material: "snow", mask: Mask.height(104 * q, 1e6, 15 * q) },
          { material: "sand", mask: Mask.height(-1000, 6 * q, 4 * q) },
        ],
      });
      t.road({
        id: "ridge-road",
        label: "Valley access road",
        points: [
          pt(-246, 22, 196),
          pt(-153, 21, 155),
          pt(-118, 24, 90),
          pt(-104, 23, 22),
          pt(-147, 31, -37),
          pt(-205, 41, -81),
        ],
        width: 9 * q,
        shoulder: 9 * q,
      });
      t.flatten({
        id: "camp-pad",
        label: "Camp · building pad",
        at: [-123 * q, 106 * q],
        radius: 19 * q,
        height: 22 * q,
        falloff: 0.35,
      });
      t.paint({
        id: "camp-surface",
        label: "Camp · compacted dirt",
        at: [-123 * q, 106 * q],
        radius: 19 * q,
        material: "dirt",
        strength: 1,
      });
      t.river({
        id: "river-main",
        label: "Main river · downhill profile",
        points: [
          pt(7, 33, -232),
          pt(30, 22, -150),
          pt(30, 15, -65),
          pt(2, 7, 3),
          pt(-17, 3.7, 67),
          pt(-36, 3.1, 121),
          pt(13, 2.8, 199),
          pt(62, 2.2, 255),
        ],
        width: 16 * q,
        shoulder: 12 * q,
        depth: 5 * q,
        enforceDownhill: true,
      });
      t.water({
        id: "lake",
        label: "Lake · connected flood fill",
        kind: "lake",
        at: [-36 * q, 108 * q],
        radius: 98 * q,
        level: 3.7 * q,
      });
      t.biome({
        id: "forest-zone",
        label: "Biome · conifer belt",
        name: "forest",
        mask: Mask.and(
          Mask.height(10 * q, 91 * q, 9 * q),
          Mask.slope(0, 35, 6),
          Mask.not(Mask.material("road")),
        ),
      });
      t.scatter({
        id: "forest",
        label: "Scatter · alpine conifers",
        asset: "pine",
        count: 1450,
        minDistance: 5.5 * q,
        maxSlope: 37,
        scale: [0.62 * q, 1.3 * q],
        mask: Mask.biome("forest"),
      });
      t.scatter({
        id: "boulders",
        label: "Scatter · granite outcrops",
        asset: "boulder",
        count: 330,
        minDistance: 7 * q,
        minHeight: 5 * q,
        scale: [1.2 * q, 3.5 * q],
        mask: Mask.and(Mask.slope(15, 72, 10), Mask.not(Mask.material("road"))),
        alignToNormal: true,
      });
      t.clear({
        id: "camp-clear",
        label: "Camp · vegetation exclusion",
        target: "scatter",
        mask: Mask.circle([-123 * q, 106 * q], 23 * q, 0.25),
      });
    } else if (id === "island") {
      t.noise({
        id: "base",
        label: "Island · coastline falloff",
        amplitude: 27 * q,
        base: 13 * q,
        scale: 150 * q,
        warp: 42 * q,
        octaves: 6,
        island: true,
        coastDepth: 23 * q,
      });
      t.stamp({
        id: "volcanic-core",
        label: "Central volcanic massif",
        at: [-23 * q, -12 * q],
        radius: [159 * q, 154 * q],
        amplitude: 94 * q,
        shape: "mountain",
        roughness: 0.24,
      });
      t.stamp({
        id: "crater",
        label: "Caldera depression",
        at: [-25 * q, -17 * q],
        radius: 46 * q,
        amplitude: 46 * q,
        shape: "crater",
      });
      t.erode({
        id: "erosion",
        label: "Weathered island slopes",
        method: "hydraulic",
        droplets: 3300,
      });
      t.materials({
        id: "surface",
        label: "Coastal auto-material",
        rules: [
          { material: "moss", mask: Mask.noise(55 * q, 0.4, seed), strength: 0.7 },
          { material: "rock", mask: Mask.slope(35, 90, 10) },
          { material: "sand", mask: Mask.height(-1000, 6 * q, 4 * q) },
        ],
      });
      t.water({
        id: "ocean",
        label: "Ocean · boundary flood fill",
        kind: "ocean",
        level: 1.5 * q,
        radius: size,
      });
      t.scatter({
        id: "forest",
        label: "Forest · coastal pines",
        asset: "pine",
        count: 1300,
        minDistance: 6 * q,
        minHeight: 7 * q,
        maxSlope: 34,
        scale: [0.65 * q, 1.15 * q],
      });
      t.scatter({
        id: "rocks",
        label: "Coast · boulders",
        asset: "boulder",
        count: 250,
        minDistance: 8 * q,
        minHeight: 2 * q,
        maxHeight: 35 * q,
        scale: [1.5 * q, 4 * q],
      });
    } else if (id === "desert") {
      t.noise({
        id: "base",
        label: "Dry eroded plateau",
        base: 24 * q,
        amplitude: 39 * q,
        scale: 105 * q,
        warp: 55 * q,
        octaves: 5,
        mode: "ridged",
      });
      for (const [i, x, z] of [
        [1, -140, -110],
        [2, 83, -86],
        [3, 150, 140],
      ])
        t.stamp({
          id: `mesa-${i}`,
          label: `Mesa ${i}`,
          at: [x * q, z * q],
          radius: [100 * q, 84 * q],
          amplitude: (60 + i * 12) * q,
          shape: "mesa",
          roughness: 0.18,
          rotation: i * 33,
        });
      t.terrace({
        id: "strata",
        label: "Geological strata",
        step: 10 * q,
        softness: 0.2,
        strength: 0.75,
      });
      t.erode({
        id: "erosion",
        label: "Thermal cliff weathering",
        method: "thermal",
        iterations: 9,
        talus: 48,
      });
      t.materials({
        id: "surface",
        label: "Desert sandstone rules",
        base: "sand",
        rules: [
          { material: "dirt", mask: Mask.slope(18, 90, 10), strength: 0.76 },
          { material: "rock", mask: Mask.slope(48, 90, 8), strength: 0.55 },
        ],
      });
      t.river({
        id: "dry-wash",
        label: "Dry seasonal wash",
        points: [
          pt(-180, 12, -250),
          pt(-60, 10, -120),
          pt(-32, 7, 15),
          pt(69, 5, 125),
          pt(103, 2, 253),
        ],
        width: 22 * q,
        shoulder: 22 * q,
        depth: 9 * q,
        water: false,
        material: "sand",
      });
      t.scatter({
        id: "rocks",
        label: "Talus and boulders",
        asset: "boulder",
        count: 550,
        minDistance: 6 * q,
        scale: [0.6 * q, 2.7 * q],
        mask: Mask.slope(12, 70, 7),
      });
    } else throw Error(`Unknown preset '${id}'`);
  });
  return t;
}
