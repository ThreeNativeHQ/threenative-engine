import type { IStack } from "./items.js";

export type GamePhase = "playing" | "won" | "lost";
/** What owns the screen: play, the case, the item box, or the black beat of a door. */
export type Menu = "none" | "inventory" | "box" | "door";

/** One slot as the HUD draws it. */
export type SlotView = IStack & { readonly label: string };

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: GamePhase;
  menu: Menu;
  room: string;
  cameraZone: string;
  cameraCuts: number;
  health: number;
  condition: "fine" | "caution" | "danger";
  magazine: number;
  reserve: number;
  aiming: number;
  grabbed: number;
  slots: SlotView[];
  box: SlotView[];
  /** The highlighted row in the case or the box, and which column the box screen is on. */
  cursor: number;
  column: "case" | "box";
  /** The verb for what is in front of the survivor, or "" when nothing is. */
  prompt: string;
  /** The last line of text the game showed, and how long it has left on screen. */
  message: string;
  messageTime: number;
  pickups: number;
  refused: number;
  herbsUsed: number;
  /** Herbs mixed in the case. */
  combined: number;
  /** A typewriter save exists to continue from. */
  hasSave: boolean;
  doorsOpened: number;
  lockedTries: number;
  saveCount: number;
  saveRefused: number;
  shots: number;
  hits: number;
  criticals: number;
  dryFires: number;
  kills: number;
  bites: number;
  escapes: number;
  /** Seconds since the run began, frozen once it ends. */
  time: number;
};
