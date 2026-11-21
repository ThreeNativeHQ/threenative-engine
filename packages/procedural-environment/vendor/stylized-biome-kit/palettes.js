// palettes.js — every colour in the kit lives here. Add a palette to add a biome.

export const ROCK = {
  alpine: { base: 0xa2a8b6, light: 0xd9dbe0, dark: 0x66708f, cap: 0x78c644, capDark: 0x4a9a3a },
  snow: { base: 0xc2d2ea, light: 0xf6faff, dark: 0x90a6d0, cap: 0xffffff, capDark: 0xdce8f8 },
  desert: { base: 0xc8705a, light: 0xe5a182, dark: 0x9d4d46, cap: 0xe6a876, capDark: 0xd9925f },
};

export const STRATA = {
  desert: {
    bands: [0xb95c4a, 0xc96d58, 0xd17b66, 0xc2625c, 0xd88e7c, 0xaf5348],
    streaks: [0xf1cbb9, 0xe9b3a6, 0xf6dccb],
    top: 0xe8ab7a, topDark: 0xdb9865,
  },
};

export const PINE = {
  forest: { low: 0x0f4a3a, mid: 0x26863f, tip: 0x86d047, trunk: 0x6b4433 },
  teal: { low: 0x0d4648, mid: 0x1c7a68, tip: 0x5cc692, trunk: 0x5d4038 },
  olive: { low: 0x3c5c2a, mid: 0x86a034, tip: 0xd6d452, trunk: 0x6e4a30 },
  snow: { low: 0x5a8ccc, mid: 0xb4d0f2, tip: 0xffffff, trunk: 0x5a4a52 },
};

export const LEAF = {
  green: { dark: 0x2f8f3c, light: 0x7fd04a },
  deep: { dark: 0x1f6b45, light: 0x3fa860 },
  autumn: { dark: 0xd0702a, light: 0xf5b648 },
  frost: { dark: 0xa9c8ef, light: 0xffffff },
  desert: { dark: 0xb89a2e, light: 0xe7cf52 },
  palm: { dark: 0x3f9a32, light: 0xa9d83e },
};

export const GRASS = {
  green: { base: 0x4fb03c, tip: 0xa2e658 },
  dry: { base: 0xd9a871, tip: 0xf6dc9c },
  frost: { base: 0xa5c4ea, tip: 0xf5faff },
};

export const GROUND = {
  grass: { a: 0x55b93e, b: 0x7fd24c, path: 0xd9c9a0 },
  snow: { a: 0xdfeafb, b: 0xffffff, path: 0xc7d8f2 },
  sand: { a: 0xe8b089, b: 0xf2c79c, path: 0xd99a78, wet: 0xc98f7c },
};

export const WATER = {
  river: { shallow: 0x9af0e2, deep: 0x33a2e6, foam: 0xffffff },
  ice: { shallow: 0xd9f1ff, deep: 0x7fb7ec, foam: 0xffffff },
  alpine: { shallow: 0x8fe3d2, deep: 0x2f7fc4, foam: 0xffffff },
};

export const BARK = { brown: 0x6b4433, dark: 0x3a2f3d, grey: 0x7c6f72, palm: 0x8a6a4c };
