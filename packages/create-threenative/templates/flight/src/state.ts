export type Phase = "flying" | "landed" | "crashed";
export type Vehicle = "glider" | "belt";
export type RingMark = "pending" | "passed" | "missed";

/** Everything the HUD and the playtests read. The scene rewrites it every tick. */
export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: Phase;
  /** The craft flown. It survives a restart: V swaps it. */
  vehicle: Vehicle;
  /** Seconds since launch. */
  time: number;
  /** Speed through the air, m/s. */
  airspeed: number;
  /** Height of the craft's lowest point over the ground, metres. */
  altitude: number;
  /** Climb rate in the ground frame, m/s. */
  climb: number;
  /** Vertical speed of the air at the craft, m/s: positive in a thermal. */
  airLift: number;
  /** Seconds spent in rising air. */
  thermalTime: number;
  /** Nose attitude and bank, degrees. */
  pitchDeg: number;
  bankDeg: number;
  /** 1 while the wing is stalled. */
  stalled: number;
  /** 0 none, 1 slow and high enough to warn, 2 stalled. */
  stallWarning: number;
  /** Times the wing stalled this attempt. */
  stalls: number;
  windX: number;
  windZ: number;
  windSpeed: number;
  /** Belt: tank 0..1, lever 0..1 and 1 while the engine fires. */
  fuel: number;
  lever: number;
  burning: number;
  lowFuel: number;
  ringsTotal: number;
  ringsPassed: number;
  ringsMissed: number;
  /** The next open ring, or the ring count once the chain is done. */
  activeRing: number;
  ringMarks: RingMark[];
  /** Metres to the pad's centre. */
  padDistance: number;
  /** The touchdown, once there is one; zero until then. */
  landSink: number;
  landDistance: number;
  landPoints: number;
  /** "fast", "inverted", "water" or "". */
  crashReason: string;
  onPad: number;
  ringPoints: number;
  timeBonus: number;
  total: number;
  /** A short message the HUD shows for a moment. */
  message: string;
  playerX: number;
  playerY: number;
  playerZ: number;
  /** Heading, three.js yaw (0 faces +z). */
  playerYaw: number;
};
