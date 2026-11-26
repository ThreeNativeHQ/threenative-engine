/** The base-wide alert phase. One value for the whole compound, the way a stealth game runs it. */
export type AlertPhase = "infiltration" | "alert" | "evasion" | "caution";

export type GamePhase = "playing" | "won" | "lost";

/** Player stance, as the HUD and the guards read it. */
export type Stance = "stand" | "crouch" | "wall";

/** One radar contact: a guard or a camera, in metres relative to the player, with its view. */
export type RadarContact = {
  readonly kind: "guard" | "camera";
  /** Metres east (+x) and south (+z) of the player, rounded to centimetres. */
  readonly x: number;
  readonly z: number;
  /** Facing in radians, three.js yaw (0 faces +z). */
  readonly yaw: number;
  /** Half the view cone in radians and its reach in metres; 0 for a guard that cannot see. */
  readonly halfAngle: number;
  readonly range: number;
  /** "patrol", "suspicious", "alert", "search", "held" or "down". */
  readonly state: string;
};

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: GamePhase;
  alertPhase: AlertPhase;
  /** Seconds left in Evasion or Caution; 0 otherwise. */
  phaseTimer: number;
  /** How many times the base went to Alert this run. */
  alerts: number;
  health: number;
  stance: Stance;
  running: number;
  /** Radius in metres of the last footstep or knock, while it is audible; 0 when silent. */
  noise: number;
  knocks: number;
  /** The highest suspicion any guard holds on the player, 0..1. */
  suspicion: number;
  takedowns: number;
  /** Pumps given in the current choke hold, 0 when nobody is held. */
  chokePumps: number;
  bodiesFound: number;
  /** Guards turning to look or walking over to check a sighting or a noise. */
  investigating: number;
  /** Times a security camera called the alert. */
  cameraAlarms: number;
  dragging: number;
  keycard: number;
  doorOpen: number;
  /** 1 while the radar is jammed (Alert and Evasion). */
  radarJammed: number;
  radar: RadarContact[];
  /** The interaction the player can do right now, as a HUD prompt; "" for none. */
  prompt: string;
  /** A short message the HUD shows for a moment, such as "Keycard acquired". */
  message: string;
  playerX: number;
  playerZ: number;
  /** Seconds since the mission began. */
  missionTime: number;
};
