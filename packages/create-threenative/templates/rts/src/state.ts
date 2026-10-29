/**
 * Everything the HUD reads, and nothing it can derive for itself.
 *
 * The simulation owns the rules; the UI is a mirror. Two rules follow. First, the *rules table*
 * (`TYPES` in `src/sim/types.ts`) is not published: the panel imports it and reads a unit's name,
 * role and cost from the same source the pathfinder does, so a rebalance cannot leave the HUD
 * quoting last season's numbers. Second, a value that changes every frame is counted or rounded
 * here rather than sent raw, because the store is cloned whole for every playtest observation and
 * a per-frame vector of sixty positions would cost more than the game it measures.
 */
export type GameState = {
  /** Ore, gas, and the supply the built structures grant. */
  gas: number;
  ore: number;
  supplyCap: number;
  supplyUsed: number;
  /** What the commander has spent and banked. */
  gathered: number;
  kills: number;
  /** Whole 0.05 s steps since the match started. */
  simTime: number;
  /** "victory", "defeat", or "" while the match runs. */
  result: string;
  /** The last thing the simulation reported, for the toast. */
  notice: string;
  /**
   * The selection. `primaryType` is a key of the rules table and "" for an empty selection; the
   * panel reads the rest of the unit's card out of that table rather than being told twice.
   */
  primaryType: string;
  primaryTeam: number;
  primaryHp: number;
  primaryMaxHp: number;
  primaryBuilt: boolean;
  primaryProgress: number;
  /** How many are selected, and how many distinct factions they belong to. */
  selection: number;
  selectionTeams: number;
  /** Distinct order kinds across the selection, comma-joined, so the panel can say "3 mining". */
  selectionOrder: string;
  /** The primary selected entity's position, for the panel's readout and for a scenario. */
  selectionX: number;
  selectionZ: number;
  /** The selected producer's queue, as `"<type>:<progress 0..1>"` strings. */
  queue: string[];
  /** The pending order mode: "", "build:<type>", "move", "attack", "garrison", "repair", "rally". */
  mode: string;
  /** Camera focus and zoom, so the minimap can draw the view rectangle. */
  cameraX: number;
  cameraZoom: number;
  cameraZ: number;
  /**
   * The tactical overview, as one coarse raster plus one flat run of quads.
   *
   * `minimapFog` is `minimapSize²` characters, row-major: `.` never seen, `,` remembered, `#` in
   * sight. `minimapDots` is `[x, z, team, kind, …]` in minimap pixels. Strings and numbers rather
   * than an object per entity, because this is the one part of the state big enough to notice.
   */
  minimapDots: number[];
  minimapFog: string;
  /** The ground under the frame's four corners, `[x, z, …]` in the same units as `minimapDots`. */
  minimapView: number[];
  /** The rubber band, in client pixels, or null. Drawn by the UI, not the scene. */
  dragBox: number[] | null;
  /** Units a release would take under the band right now, for the badge above it. */
  dragCount: number;
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  /** The selection card: summed health, how many fly, distinct types, and the roster tiles. */
  groupHp: number;
  groupMaxHp: number;
  airborne: number;
  selectionTypes: string[];
  /** Up to 16 `"<id>:<type>:<hp tenths 0..10>"` entries, in selection order. */
  roster: string[];
  /** The objective panel: a Skyport built, aircraft in the field, rivals eliminated (of 2). */
  skyport: boolean;
  airWing: number;
  defeated: number;
  /** One line per rival commander: "NO CONTACT", "<n> CONTACTS" or "DEFEATED". */
  rivals: string[];
  /** Surveyors with no order, for the IDLE button. */
  idleWorkers: number;
  /** Unit count in control groups 1-5. */
  groups: number[];
  /** Game speed multiplier: 1, 1.5 or 2. */
  speed: number;
};

export const INITIAL_STATE: GameState = {
  airborne: 0,
  airWing: 0,
  defeated: 0,
  groupHp: 0,
  groupMaxHp: 0,
  groups: [0, 0, 0, 0, 0],
  idleWorkers: 0,
  rivals: ["NO CONTACT", "NO CONTACT"],
  roster: [],
  selectionTypes: [],
  skyport: false,
  speed: 1,
  cameraX: 0,
  cameraZoom: 30,
  cameraZ: 0,
  dragBox: null,
  dragCount: 0,
  gathered: 0,
  gas: 0,
  kills: 0,
  minimapDots: [],
  minimapFog: "",
  minimapView: [],
  mode: "",
  notice: "",
  ore: 0,
  paused: false,
  primaryBuilt: true,
  primaryHp: 0,
  primaryMaxHp: 0,
  primaryProgress: 0,
  primaryTeam: 0,
  primaryType: "",
  queue: [],
  result: "",
  selection: 0,
  selectionOrder: "",
  selectionTeams: 0,
  selectionX: 0,
  selectionZ: 0,
  simTime: 0,
  supplyCap: 0,
  supplyUsed: 0,
  uiReady: false,
};
