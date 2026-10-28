/**
 * What the game publishes. The HUD reads it through the UI bridge and the playtests read it as the
 * `state` resource, so every number a scenario proves is one the player could also see or feel.
 */
/** The doorways Wren respawns at: her start, and the last one she came through. */
export type Checkpoint = "clearing" | "hollow-entry" | "cave-exit" | "warden-door";

export type GameState = {
  /** Hearts left, in hearts: 2.5 is two and a half. One hit costs a half-heart. */
  hearts: number;
  /** Heart capacity, in hearts. The heart vessel adds one. */
  capacity: number;
  /** Where Wren last came back after losing every heart, or "" before the first time. */
  lastRespawn: Checkpoint | "";
  /** Small keys carried. The locked door spends one. */
  keys: number;
  /** True once the Ember Blade is out of the clearing chest. */
  sword: boolean;
  /** The text of the nearest thing `interact` would use, or "" when there is none in reach. */
  prompt: string;
  /** A line under the HUD for a moment: the signpost text, "THE GRATE OPENS", "HEART VESSEL!". */
  toast: string;
  /** Where Wren is: the clearing or the dungeon. The dungeon is walked a little slower. */
  zone: "vale" | "hollow";
  /** The entity the lock-on holds, or "" when nothing is locked. */
  lockTarget: string;
  /** The lock-on marker: whether it shows, and the lowest its tip has floated over a locked
   * target's top (m) — 0 until the first lock. */
  lockMarkerShown: boolean;
  lockMarkerLowest: number;
  /** Fight readability over every tick a fight is on (a lock, the awake Warden, or a hostile
   * within 8 m): the share with Wren and the target both framed (5% margin, 6% at the top), the
   * longest run of ticks without that, and the ticks with Wren's centre behind the target. 0
   * until a fight starts. */
  fightFramedShare: number;
  fightOutRun: number;
  fightOccluded: number;
  /** The same framed share over the Warden's opening only: awake, nothing locked. 0 until then. */
  openingFramedShare: number;
  /** Fight ticks with a toast over Wren or the target; a running count. */
  toastOverlap: number;
  /** The most the view turned in one tick, in degrees (60 ticks a second): the fastest swing. */
  cameraTurnWorst: number;
  /** Unlocked, the most Wren strayed from the middle of the frame (0 middle, 1 edge, 2 behind the lens). */
  lookOffCentreWorst: number;
  /** Locked on the Warden within 5 m once the lock has glided in, its chest rune ring facing the
   * lens: the most of the box round the ring that Wren's on-screen box covers (0-1) while the ring
   * stands 0.4 m or more from her, and the same closer in (shield contact), where no lens clears it. */
  torsoCovered: number;
  torsoContactWorst: number;
  /** While the locked Warden is stunned within 5 m: the least its chest ring's on-screen width
   * reached of its face-on width (0-1, 1 square to the lens); 0 until measured. */
  ringFacingLeast: number;
  /** Every tick: ticks with something solid between Wren's head and the lens, the most of the
   * frame walls within 1.5 m of the lens covered (0-1), and ticks Wren overlapped the controls card. */
  cameraBlocked: number;
  nearWallWorst: number;
  hintOverlap: number;
  /** The closest the camera came to Wren's head while she was drawn (m); 0 until measured. */
  heroViewNearest: number;
  /** Counters the playtests prove the loop with. */
  slashes: number;
  slashHits: number;
  shieldBlocks: number;
  hitsTaken: number;
  respawns: number;
  defeated: number;
  wardenStuns: number;
  wardenHealth: number;
  /** The Warden's state: "dormant", "windup", "charge", "stunned", "recover" or "dead". */
  wardenState: string;
  /** Measured feel: fastest ground speed, last stop time and last 180° turn time, in m/s and s. */
  topSpeed: number;
  stopSeconds: number;
  turnSeconds: number;
  /** While strafing a locked target: the worst drift from the held distance (m), and the time. */
  lockStrafeDrift: number;
  lockStrafeSeconds: number;
  /** The worst angle between Wren's facing and the locked target while locked, in degrees. */
  lockFacingError: number;
  /** Puzzle state. */
  blockSteps: number;
  grateOpen: boolean;
  doorOpen: boolean;
  /** True once the heart vessel is taken: the dungeon is done. */
  cleared: boolean;
  /** The vale's landform, measured once on a 0.5 m grid over the clearing: its height range (m),
   * the share steeper than Wren can climb (45°, the controller's default) and the share under 6°. */
  reliefRange: number;
  reliefSteepShare: number;
  reliefLevelShare: number;
  /** Flagstones laid along the path, and the share of its centre line they cover (0-1). */
  pathStones: number;
  pathCover: number;
  /** Lanterns hanging from the hut's eaves. */
  hutLanterns: number;
  /** Sun shafts standing in the vale, and whether the height mist is on the scene's fog. */
  sunShafts: number;
  heightFog: boolean;
  /** Meshes in a wood, stone or bark tone with no photo on them (`untexturedSurfaces`); 0 is right. */
  untexturedSurfaces: number;
  /** Fireflies and motes sprinkled round Wren so far. */
  motesSpawned: number;
  /** The companion orb: the nearest and farthest it flew from Wren's head (m); 0 until measured. */
  companionNearest: number;
  companionFarthest: number;
  /** Ticks the camera spent under the vale's ground (inside a bank or an outcrop). */
  cameraInGround: number;
  /** Asset files the game asked the loader for: every model, texture and sky is built in code. */
  assetLoads: number;
  paused: boolean;
  uiReady: boolean;
};
