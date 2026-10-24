// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// `palette` is the roles the render layer shares: the two sky bands (also the loading screen's
// track), the horizon distance fades into, the grass, and one saturated `accent`. `C` is the
// per-part colour table for the procedural course, karts and items. Albedo, not light: the sun,
// the sky and the meter bring the brightness.

export const palette = {
  grass: 0x58b03a,
  /** Distance fades into this; also the loading screen's background. */
  horizon: 0xbcdcf0,
  /** The loading screen's progress track. */
  skyHigh: 0x1d62cf,
  skyLow: 0x63a6e8,
  /** The one saturated role: boost pads, the countdown, the HUD's place. */
  accent: 0xffb21f,
} as const;

/** Colours by part. */
export const C = {
  ink: 0x1a1410,
  white: 0xffffff,

  // The course.
  asphalt: 0x56585e,
  asphaltDark: 0x45474c,
  line: 0xf4f1e8,
  kerbRed: 0xd8302a,
  kerbWhite: 0xf2efe6,
  grass: 0x5aae38,
  grassDark: 0x3f8d2a,
  grassLight: 0x7cc548,
  dirt: 0xb48a58,
  sand: 0xdcc48e,
  rock: 0x9a8a78,
  water: 0x2a8cc4,
  bridge: 0xc9b89a,
  bridgeDark: 0x8e7f68,
  pillar: 0xb3a58e,
  // The wall's blocks, in MK64's toy colours (red, yellow, blue, white); the kit's own order.
  blockA: 0xe0412f,
  blockB: 0xf3c32c,
  blockC: 0x2f74d8,
  blockD: 0xf2efe6,
  bark: 0x7e5734,
  canopy: 0x3f9e33,
  canopyLight: 0x62bb3e,
  bloomPink: 0xff8fb8,
  bloomYellow: 0xffd84a,
  banner: 0xe8402e,
  check: 0x161616,

  // Items.
  boxA: 0xff5fa8,
  boxB: 0x4fd0ff,
  boxC: 0xffe14a,
  banana: 0xf2d132,
  bananaTip: 0x5a3c1a,
  shell: 0x2fae3c,
  shellRim: 0xf4f0e0,
  mushroomCap: 0xe23a2e,
  mushroomStem: 0xf6ead2,
  pad: 0xff8a14,
  padGlow: 0xffd23a,

  // Karts and drivers.
  tyre: 0x1d1d20,
  hub: 0xd8d8d8,
  seat: 0x2a2a30,
  metal: 0xa8acb4,
  exhaust: 0x50525a,
  skin: 0xf0b48a,
  visor: 0x14202e,
  glove: 0xf6f2ea,
} as const;
