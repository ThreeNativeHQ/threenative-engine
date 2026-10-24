export type GameState = {
  /** Which checkpoint the hero respawns at, as an index into the course's checkpoints. */
  checkpoint: number;
  coins: number;
  /** Walkers defeated by a stomp, a ground pound or a dive. */
  defeated: number;
  /** Red gems collected; the eighth one awards a Sunseed. */
  gems: number;
  gemTotal: number;
  grounded: boolean;
  /** True while a Sunseed sits under the HUD pill: the pill fades so the goal shows through. */
  hudFaded: boolean;
  /** The hero's action, as `Hero.ts` names it: "run", "triple", "longJump", "ledgeHang"… */
  action: string;
  /** How many times the hero has landed, which a scenario waits on to press inside a window. */
  landings: number;
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  respawns: number;
  /** Sunseeds collected, out of three: the summit, the eight red gems, the wall-kick shaft. */
  seeds: number;
  seedTotal: number;
  /** A short line under the HUD — "RED GEM 3/8", "SUNSEED!". */
  toast: string;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  /** Wall contacts that opened the wall-kick window, which a scenario waits on. */
  wallHits: number;
  /** The health meter, out of eight wedges. */
  wedges: number;
};

/** The HUD pill's box in CSS pixels from the top-left: `Hud.tsx` draws it here and `Play.ts` fades it when a Sunseed projects inside. */
export const HUD_PILL = { left: 16, top: 16, width: 336, height: 44 } as const;
