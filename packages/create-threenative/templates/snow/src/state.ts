export type CameraView = "follow" | "surface" | "overhead";

export type GameState = {
  uiReady: boolean;
  paused: boolean;
  /** The explorer walks the glade on its own until a movement key or the stick takes over. */
  autoExplore: boolean;
  blizzard: boolean;
  /** 0 clear .. 1 full blizzard, eased, so the HUD and the weather agree mid-transition. */
  storm: number;
  /** Flake density, 0..1. */
  snowfall: number;
  /** Powder depth in metres. */
  depth: number;
  /** Falling speed of a flake in still air, m/s. */
  fallSpeed: number;
  /** 0..1 snow hardness. */
  hardness: number;
  /** Base wind in m/s before gusts and the storm. */
  wind: number;
  /** The wind actually blowing this frame, m/s. */
  windNow: number;
  /** How many times faster than real time fresh snow refills tracks. */
  recovery: number;
  compaction: boolean;
  muted: boolean;
  view: CameraView;
  /** Contacts the field has taken since the last reset — footsteps and bodies together. */
  contacts: number;
  /** The last footfall's penetration, metres. */
  lastSink: number;
  speed: number;
  /** Indentation under the last footfall, `PROBE_COLUMNS` x `PROBE_ROWS`, row-major, metres. */
  probe: number[];
  /** How far the ball's underside sits above (positive) or in (negative) the snow, metres. */
  ballGap: number;
  /** Indentation under the ball, metres. */
  ballSink: number;
  /** Load the ball's solved contacts pressed into the snow last step, newtons. */
  ballLoad: number;
  toast: string;
  toastId: number;
};

export const PROBE_COLUMNS = 15;
export const PROBE_ROWS = 20;
